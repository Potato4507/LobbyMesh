import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from "node:crypto";
import { performance } from "node:perf_hooks";
import { OverlayMaintenance } from "../../packages/app-dht/src/maintenance.js";
import { NetworkOverlay } from "../../packages/app-dht/src/network.js";
import { serveRpc } from "../../packages/app-dht/src/rpc.js";
import {
  type Identity,
  peerIdFromPublicKey,
} from "../../packages/identity/src/index.js";
import { signRecord } from "../../packages/security/src/records.js";
import { pair } from "./noise-pair.js";

// Publicly reproducible TEST keys only. Standard Node Ed25519 key import/signing;
// this fixture must never supply installation credentials to the desktop.
function fixtureIdentity(seed: number, index: number): Identity {
  const bytes = createHash("sha256")
    .update(`LobbyMesh simulation ${seed}/${index}`)
    .digest();
  const privateKey = createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      bytes,
    ]),
    type: "pkcs8",
    format: "der",
  });
  const publicKey = createPublicKey(privateKey)
    .export({ type: "spki", format: "pem" })
    .toString();
  const peerId = peerIdFromPublicKey(publicKey);
  return {
    publicKey,
    peerId,
    sign: (value) => sign(null, value, privateKey),
    fingerprint: () => peerId,
  };
}
export async function simulateOverlay(size: number, seed = 4507) {
  if (![1, 2, 10, 100, 500].includes(size))
    throw new Error("INVALID_SIMULATION_SIZE");
  const started = performance.now(),
    split = Math.ceil(size / 2);
  let now = 1000,
    partitioned = true,
    attempts = 0,
    wireBytes = 0,
    dispatched = 0;
  let randomState = seed >>> 0;
  const random = () => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState;
  };
  const serving = new Set<Promise<void>>();
  const cleanup: { routingEntriesAfterClose: number | null } = {
    routingEntriesAfterClose: null,
  };
  const byKey = new Map<string, number>();
  const nodes: {
    identity: Identity;
    overlay: NetworkOverlay;
    key: Buffer;
    live: boolean;
  }[] = [];
  for (let index = 0; index < size; index++) {
    const identity = fixtureIdentity(seed, index);
    const key = createHash("sha256")
      .update(`transport fixture ${seed}/${index}`)
      .digest();
    byKey.set(key.toString("hex"), index);
    const overlay = new NetworkOverlay(
      identity,
      {
        connect(address) {
          attempts++;
          const destination = byKey.get(Buffer.from(address).toString("hex"));
          const remote =
            destination === undefined ? undefined : nodes[destination];
          if (
            !remote?.live ||
            (partitioned && index < split !== (destination ?? 0) < split)
          )
            throw new Error("SIMULATED_UNREACHABLE");
          const [client, server] = pair();
          Object.assign(client, {
            publicKey: key,
            remotePublicKey: remote.key,
          });
          Object.assign(server, {
            publicKey: remote.key,
            remotePublicKey: key,
          });
          client.on("data", (chunk: Buffer) => {
            wireBytes += chunk.length;
          });
          server.on("data", (chunk: Buffer) => {
            wireBytes += chunk.length;
          });
          const task = serveRpc(server, remote.identity, async (...args) => {
            dispatched++;
            return remote.overlay.handle(...args);
          }).catch(() => {});
          serving.add(task);
          void task.finally(() => serving.delete(task));
          return client;
        },
      },
      { now: () => now },
    );
    nodes.push({ identity, overlay, key, live: true });
  }
  const node = (index: number) => {
    const value = nodes[index];
    if (!value) throw new Error("MISSING_FIXTURE_NODE");
    return value;
  };
  const signal = new AbortController().signal;
  const maintenance: OverlayMaintenance[] = [];
  const scheduled = new Map<number, () => void>();
  try {
    for (const peer of nodes) await peer.overlay.start();
    // Inject bounded already-authenticated topology hints within each partition.
    // Subsequent RPCs still run the real signed handshake and record protocol.
    for (let index = 0; index < size; index++) {
      const start = index < split ? 0 : split,
        end = index < split ? split : size;
      const count = end - start;
      for (const candidate of [
        start + ((index - start + 1) % count),
        start + ((index - start + count - 1) % count),
        ...Array.from({ length: 4 }, () => start + (random() % count)),
      ]) {
        const remote = node(candidate);
        node(index).overlay.routing.add({
          id: remote.identity.peerId,
          publicKey: remote.key,
          connectionHints: [],
        });
      }
    }
    const key = createHash("sha256")
      .update(`record fixture ${seed}`)
      .digest("hex");
    const authors = size === 1 ? [0] : [0, split];
    const records = authors.map((index) =>
      signRecord(
        node(index).identity,
        key,
        `partition ${index}`,
        0,
        now,
        120_000,
      ),
    );
    for (const [index, record] of records.entries())
      await node(authors[index] ?? 0).overlay.put(key, record);
    // Abruptly unreachable members retain their state but accept no new streams.
    const stopped: number[] = [];
    for (let index = 1; index < size; index++) {
      if (!authors.includes(index) && random() % 10 === 0) {
        node(index).live = false;
        stopped.push(index);
      }
    }
    partitioned = false;
    if (size > 1) await node(0).overlay.join(node(split).key);
    for (let index = 0; index < size; index++) {
      maintenance.push(
        new OverlayMaintenance(
          {
            async start() {},
            async stop() {},
            async announceAppEntrypoint() {},
            async *findAppEntrypoints() {
              // Model periodic shared bootstrap discovery, not a real public DHT.
              // The production cycle authenticates every hint before admission.
              for (
                let candidate = 0;
                candidate < Math.min(size, 3);
                candidate++
              ) {
                const remote = node(random() % size);
                if (remote.live && remote !== node(index))
                  yield {
                    id: "transport:simulation",
                    publicKey: remote.key,
                    connectionHints: [],
                  };
              }
            },
          },
          node(index).overlay,
          {
            now: () => now,
            schedule(run) {
              scheduled.set(index, run);
              return () => {
                scheduled.delete(index);
              };
            },
          },
        ),
      );
    }
    const latencies: number[] = [];
    const rounds: {
      round: number;
      live: number;
      available: number;
      incompleteLookups: number;
      recordAvailability: number[];
      storedCopies: number[];
    }[] = [];
    for (let round = 1; round <= 3; round++) {
      now += 1000;
      for (const [index, peer] of nodes.entries()) {
        if (!peer.live) continue;
        scheduled.get(index)?.();
        await maintenance[index]?.start();
      }
      let available = 0,
        incompleteLookups = 0;
      const recordAvailability = records.map(() => 0),
        storedCopies = records.map(() => 0);
      for (const peer of nodes) {
        if (!peer.live) continue;
        const before = performance.now(),
          result = await peer.overlay.lookup(key);
        latencies.push(performance.now() - before);
        const local = (await peer.overlay.handle(
          {
            id: peer.identity.peerId,
            publicKey: peer.identity.publicKey,
            transportKey: peer.key.toString("hex"),
          },
          { op: "find-value", key },
          signal,
        )) as { records: { signature: string }[] };
        records.forEach((record, index) => {
          if (
            result.records.some((found) => found.signature === record.signature)
          )
            recordAvailability[index] = (recordAvailability[index] ?? 0) + 1;
          if (
            local.records.some((found) => found.signature === record.signature)
          )
            storedCopies[index] = (storedCopies[index] ?? 0) + 1;
        });
        if (result.routing.state !== "exhausted" || result.routing.failures)
          incompleteLookups++;
        if (
          records.every((record) =>
            result.records.some(
              (found) =>
                found.signature === record.signature &&
                found.expiresAt === record.expiresAt,
            ),
          )
        )
          available++;
      }
      rounds.push({
        round,
        live: size - stopped.length,
        available,
        incompleteLookups,
        recordAvailability,
        storedCopies,
      });
      if (available === size - stopped.length) break;
    }
    latencies.sort((a, b) => a - b);
    const tables = nodes.map((peer) => peer.overlay.routing.stats());
    const final = rounds.at(-1);
    return {
      size,
      cleanup,
      seed,
      transport: "synthetic-stream-metadata",
      admission: "injected-authenticated-topology",
      recovery: "production-maintenance-with-synthetic-shared-bootstrap",
      publicDht: false,
      crossNat: false,
      abruptlyUnreachable: stopped.length,
      rounds,
      convergedInFixture: final?.available === final?.live,
      attempts,
      dispatched,
      framedBytes: wireBytes,
      routing: {
        maxActive: Math.max(...tables.map((table) => table.active)),
        maxReplacements: Math.max(...tables.map((table) => table.replacements)),
        maxBuckets: Math.max(...tables.map((table) => table.buckets)),
      },
      lookupMs: {
        p50: latencies[Math.floor(latencies.length * 0.5)] ?? 0,
        p95: latencies[Math.floor(latencies.length * 0.95)] ?? 0,
        max: latencies.at(-1) ?? 0,
      },
      wallMs: performance.now() - started,
      // Serialized routing state is a reproducible size proxy, not process RSS.
      routingJsonBytes: Buffer.byteLength(
        JSON.stringify(nodes.map((peer) => peer.overlay.routing.oldest(100))),
      ),
    };
  } finally {
    for (const service of maintenance) await service.stop();
    for (const peer of nodes) await peer.overlay.leave();
    await Promise.all(serving);
    cleanup.routingEntriesAfterClose = nodes.reduce((sum, peer) => {
      const stats = peer.overlay.routing.stats();
      return sum + stats.active + stats.replacements;
    }, 0);
  }
}
