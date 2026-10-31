import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { NetworkLifecycle } from "../packages/app-dht/src/lifecycle.js";
import { createIdentity } from "../packages/identity/src/index.js";
import type { KeyPair } from "../packages/public-discovery/src/hyperdht.js";
import { createLabNetwork, type LabNetwork } from "./lab/network.js";
import { parseLabCommand, parseLabOptions } from "./lab/options.js";
import { restartLabNetwork } from "./lab/restart.js";

// JSONL control channel, suitable for local pipes or an authorized SSH stdio
// connection. Never write this channel to evidence: invitations are transferable.
const DHT = createRequire(import.meta.url)("hyperdht") as {
  keyPair(seed: Buffer): KeyPair;
  bootstrapper(
    port: number,
    host: string,
  ): {
    ready(): Promise<void>;
    destroy(options: { force: boolean }): Promise<void>;
  };
};
const options = parseLabOptions(process.argv.slice(2));
const controller = new AbortController();
let cleanup: (() => Promise<void>) | undefined;
let closing: Promise<void> | undefined;
let stopped = false;
const write = (value: unknown, flushed?: () => void) => {
  if (process.stdout.writableLength > 256 * 1024) {
    finish();
    return;
  }
  if (!process.stdout.destroyed)
    process.stdout.write(`${JSON.stringify(value)}\n`, (error) => {
      if (error) {
        if (flushed) process.exit(1);
        else finish();
      } else flushed?.();
    });
};
const stop = () => {
  closing ??= (async () => {
    stopped = true;
    controller.abort();
    await cleanup?.();
  })();
  return closing;
};
const finish = () => {
  void stop().then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
const deadline = setTimeout(finish, options.durationMs);
process.once("SIGTERM", finish);
process.once("SIGINT", finish);
process.stdin.once("end", finish);
process.stdout.once("error", finish);

try {
  let command: (op: string, value?: string) => Promise<unknown>;
  if (options.mode === "bootstrap") {
    const node = DHT.bootstrapper(options.port, options.host);
    cleanup = () => node.destroy({ force: true });
    await node.ready();
    command = async (op) => {
      if (op !== "status") throw new Error("LAB_OPERATION_DENIED");
      return { role: "bootstrap" };
    };
    write({ ready: true, role: "bootstrap" });
  } else {
    const identity = createIdentity();
    const seed = randomBytes(32);
    const keys = DHT.keyPair(seed);
    seed.fill(0);
    const authorized = new Set<string>();
    const policy = {
      authorized: (id: string) => authorized.has(id),
      blocked: () => false,
      allowed: () => [...authorized],
    };
    const lifecycle = new NetworkLifecycle(
      (signal) =>
        createLabNetwork(
          identity,
          keys,
          policy,
          options,
          AbortSignal.any([controller.signal, signal]),
        ),
      { startupMs: 10000, shutdownMs: 3000, maxAttempts: 1 },
    );
    cleanup = async () => {
      try {
        await lifecycle.close();
      } finally {
        keys.secretKey.fill(0);
      }
    };
    const online = () => {
      if (lifecycle.status().state !== "online")
        throw new Error("LAB_NETWORK_UNAVAILABLE");
      return lifecycle.using((runtime) => runtime as LabNetwork);
    };
    lifecycle.setEnabled(true);
    await lifecycle.settled();
    online();
    command = async (op, value) => {
      if (op === "restart") {
        await restartLabNetwork(
          lifecycle,
          () => !stopped && !controller.signal.aborted,
        );
        const fresh = online();
        return {
          networkRestarted: true,
          processRestart: false,
          identityPreserved: fresh.runtime.peerId === identity.peerId,
          transportPreserved:
            fresh.runtime.transportKey === keys.publicKey.toString("hex"),
          approved: authorized.size,
          voiceAvailable: fresh.voice.status().available,
          microphone: "off",
        };
      }
      const { runtime, messaging, voice, pairing } = online();
      switch (op) {
        case "voice-enable":
        case "voice-disable":
          voice.setConsent(op === "voice-enable");
          return voice.status();
        case "voice-status":
          return voice.status();
        case "voice-events":
          return voice.drainEvents();
        case "voice-offer": {
          const peers = [...authorized];
          if (peers.length !== 1) throw new Error("LAB_EXPECTS_ONE_CONTACT");
          return voice.offer(
            messaging.resolveContact(peers[0] ?? ""),
            "synthetic lab SDP offer; no media",
          );
        }
        case "voice-answer":
          await voice.answer(value ?? "", "synthetic lab SDP answer; no media");
          return voice.status();
        case "voice-ice":
          await voice.ice(value ?? "", {
            candidate: "synthetic lab ICE; no media",
            sdpMid: "0",
            sdpMLineIndex: 0,
          });
          return true;
        case "voice-hangup":
          await voice.hangup(value ?? "");
          return voice.status();
        case "status":
          return {
            bootstrapMode: options.network,
            peers: runtime.overlay.authenticatedContacts().length,
            approved: authorized.size,
            microphone: "off",
            diagnostics: runtime.overlay.diagnostics(),
            inbound: runtime.inboundDiagnostics(),
          };
        case "code":
          return pairing.create();
        case "preview":
          return pairing.preview(value);
        case "approve":
          await pairing.approve(value, async (id, guard) => {
            if (!guard() || stopped) throw new Error("LAB_OPERATION_DENIED");
            if (authorized.size >= 20) throw new Error("LAB_QUOTA");
            authorized.add(id);
          });
          return true;
        case "revoke":
          authorized.delete(value ?? "");
          pairing.policyChanged();
          messaging.policyChanged(value ?? "");
          voice.policyChanged();
          return true;
        case "send": {
          const peer = [...authorized];
          if (peer.length !== 1) throw new Error("LAB_EXPECTS_ONE_CONTACT");
          return messaging.send(peer[0] ?? "", value ?? "");
        }
        case "history":
          return messaging.history(value ?? "");
        default:
          throw new Error("LAB_OPERATION_DENIED");
      }
    };
    write({ ready: true, role: "peer", peerId: identity.peerId });
  }
  let input = Buffer.alloc(0),
    busy = false;
  // Process one command at a time; reject bursts rather than accumulating work.
  process.stdin.on("data", (chunk: Buffer) => {
    if (stopped) return;
    if (input.length + chunk.length > 8192) {
      finish();
      return;
    }
    input = Buffer.concat([input, chunk]);
    while (input.includes(10)) {
      const end = input.indexOf(10);
      const line = input.subarray(0, end).toString("utf8");
      input = input.subarray(end + 1);
      let request: ReturnType<typeof parseLabCommand>;
      try {
        request = parseLabCommand(JSON.parse(line));
      } catch {
        write({ error: "INVALID_LAB_COMMAND" });
        continue;
      }
      if (request.op === "stop") {
        void stop().then(
          () => {
            clearTimeout(deadline);
            // stdout is asynchronous on some pipe/SSH transports. Exiting
            // before its callback can discard the cleanup acknowledgement.
            const flushDeadline = setTimeout(() => process.exit(1), 1000);
            write(
              {
                id: request.id,
                result: { stopped: true, cleanupVerified: true },
              },
              () => {
                clearTimeout(flushDeadline);
                process.exit(0);
              },
            );
          },
          () => process.exit(1),
        );
        return;
      }
      if (busy) {
        write({ id: request.id, error: "LAB_BUSY" });
        continue;
      }
      busy = true;
      void command(request.op, request.value)
        .then(
          (result) => {
            if (!stopped) write({ id: request.id, result });
          },
          () => {
            if (!stopped)
              write({ id: request.id, error: "LAB_OPERATION_FAILED" });
          },
        )
        .finally(() => {
          busy = false;
        });
    }
  });
  process.stdin.resume();
} catch {
  write({ error: "LAB_START_FAILED" });
  await stop().catch(() => {});
  clearTimeout(deadline);
  process.exit(1);
}
