import { randomInt } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Identity } from "../../identity/src/index.js";
import type {
  BootstrapDiscovery,
  PeerContact,
} from "../../protocol/src/index.js";
import {
  RecordStore,
  type RecordV1,
  validateRecord,
} from "../../security/src/records.js";
import {
  RpcDiagnostics,
  type RpcMeasurement,
  rpcNativeDetail,
  rpcOperation,
  rpcOutcome,
} from "./diagnostics.js";
import { RoutingTable, xorDistance } from "./index.js";
import {
  iterativeLookup,
  type LookupResult,
  parseReferrals,
  type Referral,
} from "./lookup.js";
import {
  type AuthenticatedPeer,
  type NoiseStream,
  type RpcHandler,
  type RpcPhase,
  requestRpc,
} from "./rpc.js";

export interface RpcConnector {
  connect(key: Uint8Array): NoiseStream;
}
const hex = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export class NetworkOverlay {
  readonly routing: RoutingTable;
  private readonly store: RecordStore;
  private running = false;
  private readonly pendingJoins = new Map<string, Promise<void>>();
  private readonly controller = new AbortController();
  private rpcTail: Promise<void> = Promise.resolve();
  private queuedRpc = 0;
  private readonly rpcMetrics = new RpcDiagnostics();
  diagnostics() {
    return this.rpcMetrics.snapshot(this.queuedRpc);
  }
  private readonly failures = new Map<string, number>();
  constructor(
    private readonly identity: Identity,
    private readonly connector: RpcConnector,
    private readonly options: {
      discovery?: BootstrapDiscovery;
      now?: () => number;
      blocked?: (id: string) => boolean;
      timeoutMs?: number;
      lookupTimeoutMs?: number;
      synchronizationMs?: number;
      selfTransportKey?: string;
    } = {},
  ) {
    const synchronizationMs = options.synchronizationMs ?? 2000;
    if (
      !Number.isSafeInteger(synchronizationMs) ||
      synchronizationMs < 1 ||
      synchronizationMs > 10_000
    )
      throw new Error("INVALID_SYNCHRONIZATION_LIMIT");
    this.routing = new RoutingTable(identity.peerId);
    this.store = new RecordStore(options.now ?? Date.now);
  }
  async start(): Promise<void> {
    if (this.controller.signal.aborted) throw new Error("OVERLAY_CLOSED");
    if (this.running) return;
    if (this.options.discovery) {
      await this.options.discovery.start();
      try {
        if (this.controller.signal.aborted) throw new Error("OVERLAY_CLOSED");
        await this.options.discovery.announceAppEntrypoint();
        if (this.controller.signal.aborted) throw new Error("OVERLAY_CLOSED");
      } catch (error) {
        await this.options.discovery.stop();
        throw error;
      }
    }
    this.running = true;
  }
  private syncCursor = 0;
  private syncReplicaOffset = 0;
  async synchronize(signal: AbortSignal): Promise<{
    records: number;
    replicas: number;
    failures: number;
    state: "complete" | "budget" | "aborted";
  }> {
    this.assertRunning();
    const controller = new AbortController();
    const combined = AbortSignal.any([
      signal,
      this.controller.signal,
      controller.signal,
    ]);
    const timer = setTimeout(
      () => controller.abort(),
      this.options.synchronizationMs ?? 2000,
    );
    const batch = this.store.scan(this.syncCursor, 16);
    let records = 0,
      replicas = 0,
      failures = 0;
    try {
      for (const record of batch.records) {
        if (combined.aborted) break;
        records++;
        if (this.options.blocked?.(record.author)) continue;
        const resolution = new AbortController();
        // Reserve time for actual replica writes even when target resolution
        // stalls. Its partial authenticated discoveries remain useful next time.
        const resolutionTimer = setTimeout(
          () => resolution.abort(),
          Math.max(
            1,
            Math.min(
              500,
              Math.floor((this.options.synchronizationMs ?? 2000) / 2),
            ),
          ),
        );
        let resolved: LookupResult;
        try {
          resolved = await this.findNodes(
            record.key,
            this.contacts(record.key),
            AbortSignal.any([combined, resolution.signal]),
          );
        } finally {
          clearTimeout(resolutionTimer);
          resolution.abort();
        }
        if (combined.aborted) break;
        const contacts = this.replicaContacts(record.key, resolved);
        const offset = this.syncReplicaOffset % (contacts.length || 1);
        for (const contact of [
          ...contacts.slice(offset),
          ...contacts.slice(0, offset),
        ]) {
          if (combined.aborted) break;
          try {
            const response = (await this.call(
              contact.publicKey,
              { op: "put", key: record.key, record },
              contact.id,
              combined,
            )) as { stored?: unknown } | null;
            if (response?.stored !== true)
              throw new Error("INVALID_PUT_RESPONSE");
            replicas++;
          } catch {
            if (!combined.aborted) failures++;
          }
        }
      }
      // A slow record must not starve the rest of the store. Visit the next
      // record after a budget stop and rotate replica order on each full sweep,
      // so a consistently slow closest peer cannot starve a reachable replica.
      if (!signal.aborted && !this.controller.signal.aborted) {
        if (records === batch.records.length && batch.next === null) {
          this.syncCursor = 0;
          this.syncReplicaOffset = (this.syncReplicaOffset + 1) % 3;
        } else this.syncCursor += records;
      }
      return {
        records,
        replicas,
        failures,
        state:
          signal.aborted || this.controller.signal.aborted
            ? "aborted"
            : controller.signal.aborted || batch.next !== null
              ? "budget"
              : "complete",
      };
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  private assertRunning(): void {
    if (!this.running) throw new Error("NOT_STARTED");
  }
  private remember(peer: AuthenticatedPeer): void {
    this.assertRunning();
    if (this.options.blocked?.(peer.id)) throw new Error("BLOCKED_PEER");
    this.failures.delete(peer.id);
    this.routing.add({
      id: peer.id,
      publicKey: Buffer.from(peer.transportKey, "hex"),
      connectionHints: [],
    });
  }
  private contacts(target: string): Referral[] {
    return this.routing
      .nearest(target, 20, true)
      .filter((c) => !this.options.blocked?.(c.id))
      .map((c) => ({
        id: c.id,
        transportKey: Buffer.from(c.publicKey).toString("hex"),
      }));
  }
  private replicaContacts(
    target: string,
    resolved: LookupResult,
  ): PeerContact[] {
    const candidates = new Map(
      this.routing.nearest(target, 20).map((contact) => [contact.id, contact]),
    );
    for (const contact of resolved.authenticated) {
      if (
        contact.id === this.identity.peerId ||
        this.options.blocked?.(contact.id)
      )
        continue;
      candidates.set(contact.id, {
        id: contact.id,
        publicKey: Buffer.from(contact.transportKey, "hex"),
        connectionHints: [],
      });
    }
    return [...candidates.values()]
      .filter((contact) => !this.options.blocked?.(contact.id))
      .sort((a, b) => {
        const x = xorDistance(a.id, target),
          y = xorDistance(b.id, target);
        return x < y ? -1 : x > y ? 1 : 0;
      })
      .slice(0, 3);
  }
  readonly handle: RpcHandler = async (peer, value, signal) => {
    this.assertRunning();
    if (signal.aborted) throw new Error("RPC_ABORTED");
    const request = value as {
      op?: unknown;
      target?: unknown;
      key?: unknown;
      record?: unknown;
      cursor?: unknown;
    } | null;
    if (
      !request ||
      !["find-node", "find-value", "put"].includes(String(request.op))
    )
      throw new Error("INVALID_RPC");
    if (request.op === "find-node") {
      if (!hex(request.target)) throw new Error("INVALID_TARGET");
      this.remember(peer);
      return { contacts: this.contacts(request.target) };
    }
    if (!hex(request.key)) throw new Error("INVALID_KEY");
    if (this.options.blocked?.(peer.id)) throw new Error("BLOCKED_PEER");
    if (request.op === "put") {
      const record = validateRecord(
        request.record,
        request.key,
        (this.options.now ?? Date.now)(),
      );
      if (this.options.blocked?.(record.author))
        throw new Error("BLOCKED_AUTHOR");
      // Exact signed duplicates are idempotent for replication; conflicts/replays still fail.
      const existing = this.store
        .get(request.key)
        .find((r) => r.author === record.author);
      if (!existing || existing.signature !== record.signature)
        this.store.put(request.key, record);
      this.remember(peer);
      return { stored: true };
    }
    const cursor = request.cursor ?? 0;
    if (
      !Number.isSafeInteger(cursor) ||
      (cursor as number) < 0 ||
      (cursor as number) > 1024
    )
      throw new Error("INVALID_CURSOR");
    this.remember(peer);
    const records = this.store
      .get(request.key)
      .filter((r) => !this.options.blocked?.(r.author))
      .sort((a, b) => a.author.localeCompare(b.author));
    const offset = cursor as number;
    return {
      records: records.slice(offset, offset + 2),
      next: offset + 2 < records.length ? offset + 2 : null,
      contacts: this.contacts(request.key),
    };
  };
  private call(
    key: Uint8Array,
    request: unknown,
    expectedPeerId?: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    this.assertRunning();
    const combined = signal
      ? AbortSignal.any([signal, this.controller.signal])
      : this.controller.signal;
    if (combined.aborted) return Promise.reject(new Error("RPC_ABORTED"));
    if (this.queuedRpc >= 64) {
      this.rpcMetrics.record({
        operation: rpcOperation(request),
        outcome: "queue-quota",
        phase: "queue",
        queueMs: 0,
        transactionMs: 0,
      });
      return Promise.reject(new Error("RPC_QUEUE_QUOTA"));
    }
    this.queuedRpc++;
    // Pinned native transport stalls one same-host connection when setup overlaps.
    // Keep transaction scheduling conservative until that path has separate proof.
    const enqueued = performance.now();
    let started: number | undefined;
    let retrying = false;
    let phase: RpcMeasurement["phase"] = "queue";
    const task = this.rpcTail.then(async () => {
      if (!combined.aborted) {
        started = performance.now();
        phase = "connect";
      }
      try {
        const result = await this.performCall(
          key,
          request,
          expectedPeerId,
          combined,
          (value) => {
            phase = value;
          },
          (error) => {
            this.rpcMetrics.record({
              operation: rpcOperation(request),
              outcome: rpcOutcome(error),
              ...rpcNativeDetail(error),
              phase,
              queueMs: (started ?? performance.now()) - enqueued,
              transactionMs:
                started === undefined ? 0 : performance.now() - started,
            });
            retrying = true;
            started = performance.now();
            phase = "connect";
          },
        );
        this.rpcMetrics.record({
          operation: rpcOperation(request),
          outcome: "success",
          phase,
          queueMs: retrying ? 0 : (started ?? performance.now()) - enqueued,
          transactionMs:
            started === undefined ? 0 : performance.now() - started,
        });
        return result;
      } catch (error) {
        this.rpcMetrics.record({
          operation: rpcOperation(request),
          outcome: rpcOutcome(error),
          ...rpcNativeDetail(error),
          phase,
          queueMs: retrying ? 0 : (started ?? performance.now()) - enqueued,
          transactionMs:
            started === undefined ? 0 : performance.now() - started,
        });
        throw error;
      }
    });
    this.rpcTail = task.then(
      () => {},
      () => {},
    );
    const completion = task.finally(() => {
      this.queuedRpc--;
    });
    // Cancel the caller promptly even while a previous native transaction owns
    // the queue. The queued task retains its slot until drained and checks the
    // signal before opening a socket.
    return new Promise((resolve, reject) => {
      const abort = () => reject(new Error("RPC_ABORTED"));
      const cleanup = () => combined.removeEventListener("abort", abort);
      combined.addEventListener("abort", abort, { once: true });
      completion.then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (error: unknown) => {
          cleanup();
          reject(error);
        },
      );
      if (combined.aborted) abort();
    });
  }
  private async performCall(
    key: Uint8Array,
    request: unknown,
    expectedPeerId?: string,
    signal?: AbortSignal,
    onPhase?: (phase: RpcPhase) => void,
    onRetry?: (error: unknown) => void,
  ): Promise<unknown> {
    if (signal?.aborted) throw new Error("RPC_ABORTED");
    this.assertRunning();
    if (expectedPeerId && this.options.blocked?.(expectedPeerId))
      throw new Error("BLOCKED_PEER");
    let response: Awaited<ReturnType<typeof requestRpc>>;
    const revision = expectedPeerId
      ? this.routing.revision(expectedPeerId)
      : undefined;
    try {
      for (let attempt = 0; ; attempt++) {
        if (signal?.aborted || this.controller.signal.aborted)
          throw new Error("RPC_ABORTED");
        if (expectedPeerId && this.options.blocked?.(expectedPeerId))
          throw new Error("BLOCKED_PEER");
        let phase: RpcPhase | undefined;
        try {
          response = await requestRpc(
            this.connector.connect(key),
            this.identity,
            request,
            {
              signal: signal
                ? AbortSignal.any([this.controller.signal, signal])
                : this.controller.signal,
              timeoutMs: this.options.timeoutMs ?? 1500,
              ...(expectedPeerId ? { expectedPeerId } : {}),
              onPhase(value) {
                phase = value;
                onPhase?.(value);
              },
            },
          );
          break;
        } catch (error) {
          // An authenticated/pinned known contact gets one setup retry only
          // before request transmission. Identity/protocol errors never retry;
          // reads and writes after transmission remain caller-owned policies.
          // CI observed HOLEPUNCH_ABORTED before Noise establishment. Only that
          // exact native code in transport may consume the same single retry.
          if (
            attempt !== 0 ||
            !expectedPeerId ||
            signal?.aborted ||
            this.controller.signal.aborted ||
            (phase !== "transport" && phase !== "hello" && phase !== "proof") ||
            !(error instanceof Error) ||
            (error.message !== "RPC_TIMEOUT" &&
              error.message !== "RPC_CLOSED" &&
              !(
                phase === "transport" &&
                rpcNativeDetail(error).nativeCode === "HOLEPUNCH_ABORTED"
              ))
          )
            throw error;
          onRetry?.(error);
          await delay(randomInt(25, 75), undefined, {
            signal: signal ?? this.controller.signal,
          });
        }
      }
    } catch (error) {
      if (
        expectedPeerId &&
        !signal?.aborted &&
        !this.controller.signal.aborted &&
        revision === this.routing.revision(expectedPeerId) &&
        this.routing.has(expectedPeerId)
      ) {
        const count = (this.failures.get(expectedPeerId) ?? 0) + 1;
        if (count >= 2) {
          this.routing.remove(
            expectedPeerId,
            (id) => !this.options.blocked?.(id),
          );
          this.failures.delete(expectedPeerId);
        } else this.failures.set(expectedPeerId, count);
      }
      throw error;
    }
    this.remember(response.peer);
    return response.result;
  }
  join(key: Uint8Array): Promise<void> {
    this.assertRunning();
    if (key.byteLength !== 32)
      return Promise.reject(new Error("INVALID_TRANSPORT_KEY"));
    const address = Buffer.from(key).toString("hex");
    if (address === this.options.selfTransportKey)
      return Promise.reject(new Error("SELF_CONNECTION"));
    const pending = this.pendingJoins.get(address);
    if (pending) return pending;
    if (this.pendingJoins.size >= 32)
      return Promise.reject(new Error("JOIN_QUOTA"));
    const joining = this.joinWithRetry(Buffer.from(key)).finally(() =>
      this.pendingJoins.delete(address),
    );
    this.pendingJoins.set(address, joining);
    return joining;
  }
  private async joinWithRetry(key: Uint8Array): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.introduce(key);
        return;
      } catch (error) {
        if (
          attempt >= 2 ||
          this.controller.signal.aborted ||
          !(error instanceof Error) ||
          !/RPC_TIMEOUT|RPC_CLOSED|connection reset|ETIMEDOUT|CONNECTION/.test(
            error.message,
          )
        )
          throw error;
        await delay(randomInt(100, 400) * (attempt + 1), undefined, {
          signal: this.controller.signal,
        });
      }
    }
  }
  private async introduce(key: Uint8Array): Promise<void> {
    const response = (await this.call(key, {
      op: "find-node",
      target: this.identity.peerId,
    })) as { contacts?: unknown } | null;
    await this.findNodes(
      this.identity.peerId,
      parseReferrals(response?.contacts),
    );
  }
  async findNodes(
    target: string,
    seeds = this.contacts(target),
    signal?: AbortSignal,
  ): Promise<LookupResult> {
    this.assertRunning();
    return iterativeLookup(
      target,
      this.identity.peerId,
      seeds,
      async (candidate, signal) => {
        const response = (await this.call(
          Buffer.from(candidate.transportKey, "hex"),
          { op: "find-node", target },
          candidate.id,
          signal,
        )) as { contacts?: unknown } | null;
        return parseReferrals(response?.contacts).filter(
          (c) => !this.options.blocked?.(c.id),
        );
      },
      {
        signal: signal
          ? AbortSignal.any([signal, this.controller.signal])
          : this.controller.signal,
        timeoutMs: this.options.lookupTimeoutMs ?? 3000,
      },
    );
  }
  async probe(
    contact: PeerContact,
    signal: AbortSignal,
  ): Promise<{ version: number; authenticated: boolean }> {
    if (
      Buffer.from(contact.publicKey).toString("hex") ===
      this.options.selfTransportKey
    )
      throw new Error("SELF_CONNECTION");
    const result = (await this.call(
      contact.publicKey,
      { op: "find-node", target: this.identity.peerId },
      undefined,
      signal,
    )) as { contacts?: unknown } | null;
    parseReferrals(result?.contacts);
    return { version: 1, authenticated: true };
  }
  async authenticateContact(
    contact: { id: string; transportKey: string },
    signal: AbortSignal,
  ): Promise<void> {
    const result = (await this.directRequest(
      contact,
      { op: "find-node", target: this.identity.peerId },
      signal,
    )) as { contacts?: unknown } | null;
    parseReferrals(result?.contacts);
  }
  async maintainRouting(signal: AbortSignal): Promise<{
    checked: number;
    failed: number;
    state: "complete" | "budget" | "aborted";
  }> {
    this.assertRunning();
    const deadline = new AbortController();
    const combined = AbortSignal.any([
      signal,
      this.controller.signal,
      deadline.signal,
    ]);
    const timer = setTimeout(() => deadline.abort(), 2000);
    let checked = 0,
      failed = 0;
    try {
      for (const contact of this.routing.oldest(4)) {
        if (combined.aborted) break;
        if (this.options.blocked?.(contact.id)) {
          this.routing.remove(contact.id, (id) => !this.options.blocked?.(id));
          continue;
        }
        checked++;
        try {
          await this.call(
            contact.publicKey,
            { op: "find-node", target: this.identity.peerId },
            contact.id,
            combined,
          );
        } catch {
          if (!combined.aborted) failed++;
        }
      }
      return {
        checked,
        failed,
        state:
          signal.aborted || this.controller.signal.aborted
            ? "aborted"
            : deadline.signal.aborted
              ? "budget"
              : "complete",
      };
    } finally {
      clearTimeout(timer);
      deadline.abort();
    }
  }
  async refresh(signal: AbortSignal): Promise<LookupResult> {
    await this.maintainRouting(signal);
    return this.findNodes(
      this.identity.peerId,
      this.contacts(this.identity.peerId),
      signal,
    );
  }
  directRequest(
    contact: { id: string; transportKey: string },
    request: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (!hex(contact.id) || !hex(contact.transportKey))
      return Promise.reject(new Error("INVALID_CONTACT"));
    return this.call(
      Buffer.from(contact.transportKey, "hex"),
      request,
      contact.id,
      signal,
    );
  }
  async put(
    key: string,
    record: unknown,
  ): Promise<{ replicas: number; failures: number }> {
    this.assertRunning();
    const valid = validateRecord(record, key, (this.options.now ?? Date.now)());
    if (this.options.blocked?.(valid.author)) throw new Error("BLOCKED_AUTHOR");
    const existing = this.store.get(key).find((r) => r.author === valid.author);
    if (!existing || existing.signature !== valid.signature)
      this.store.put(key, valid);
    const resolved = await this.findNodes(key);
    let replicas = 0,
      failures = 0;
    for (const contact of this.replicaContacts(key, resolved)) {
      try {
        const result = (await this.call(
          contact.publicKey,
          { op: "put", key, record: valid },
          contact.id,
        )) as { stored?: unknown } | null;
        if (result?.stored !== true) throw new Error("INVALID_PUT_RESPONSE");
        replicas++;
      } catch {
        failures++;
      }
    }
    return { replicas, failures };
  }
  async get(key: string): Promise<RecordV1[]> {
    const result = await this.lookup(key);
    if (
      !result.records.length &&
      (result.routing.state !== "exhausted" || result.routing.failures)
    )
      throw new Error("LOOKUP_INCOMPLETE");
    return result.records;
  }
  async lookup(
    key: string,
  ): Promise<{ records: RecordV1[]; routing: LookupResult }> {
    this.assertRunning();
    if (!hex(key)) throw new Error("INVALID_KEY");
    const found = new Map<string, RecordV1>();
    const accept = (record: unknown) => {
      const valid = validateRecord(
        record,
        key,
        (this.options.now ?? Date.now)(),
      );
      if (this.options.blocked?.(valid.author)) return;
      if (valid.seq > (found.get(valid.author)?.seq ?? -1))
        found.set(valid.author, valid);
      if (found.size > 64) throw new Error("RESULT_QUOTA");
    };
    for (const record of this.store.get(key)) accept(record);
    const routing = await iterativeLookup(
      key,
      this.identity.peerId,
      this.contacts(key),
      async (contact, signal) => {
        let cursor = 0;
        let contacts: Referral[] = [];
        for (let page = 0; page < 32; page++) {
          const response = (await this.call(
            Buffer.from(contact.transportKey, "hex"),
            { op: "find-value", key, cursor },
            contact.id,
            signal,
          )) as {
            records?: unknown;
            next?: unknown;
            contacts?: unknown;
          } | null;
          if (
            !response ||
            !Array.isArray(response.records) ||
            response.records.length > 2
          )
            throw new Error("INVALID_VALUE_RESPONSE");
          if (signal.aborted) return [];
          contacts = parseReferrals(response.contacts).filter(
            (c) => !this.options.blocked?.(c.id),
          );
          for (const record of response.records) accept(record);
          if (response.next === null) break;
          if (response.next !== cursor + 2) throw new Error("INVALID_CURSOR");
          cursor += 2;
          if (page === 31) throw new Error("RESULT_QUOTA");
        }
        return contacts;
      },
      {
        signal: this.controller.signal,
        timeoutMs: this.options.lookupTimeoutMs ?? 3000,
      },
    );
    return {
      records: [...found.values()].sort((a, b) =>
        a.author.localeCompare(b.author),
      ),
      routing,
    };
  }
  async leave(): Promise<void> {
    this.running = false;
    this.controller.abort();
    this.routing.clear();
    this.store.clear();
    this.failures.clear();
    await this.rpcTail;
    await Promise.allSettled(this.pendingJoins.values());
    await this.options.discovery?.stop();
  }
  authenticatedContacts(): PeerContact[] {
    return this.routing
      .nearest(this.identity.peerId, 100)
      .filter((c) => !this.options.blocked?.(c.id));
  }
}
