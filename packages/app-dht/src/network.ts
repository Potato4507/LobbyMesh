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
import { RoutingTable } from "./index.js";
import {
  type AuthenticatedPeer,
  type NoiseStream,
  type RpcHandler,
  requestRpc,
} from "./rpc.js";

export interface RpcConnector {
  connect(key: Uint8Array): NoiseStream;
}
interface Referral {
  id: string;
  transportKey: string;
}
const hex = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function referrals(value: unknown): Referral[] {
  if (!Array.isArray(value) || value.length > 20)
    throw new Error("INVALID_CONTACTS");
  return value.map((v: Referral) => {
    if (!v || !hex(v.id) || !hex(v.transportKey))
      throw new Error("INVALID_CONTACT");
    return { id: v.id, transportKey: v.transportKey };
  });
}
export class NetworkOverlay {
  readonly routing: RoutingTable;
  private readonly store: RecordStore;
  private running = false;
  private readonly pendingJoins = new Map<string, Promise<void>>();
  private readonly controller = new AbortController();
  constructor(
    private readonly identity: Identity,
    private readonly connector: RpcConnector,
    private readonly options: {
      discovery?: BootstrapDiscovery;
      now?: () => number;
      blocked?: (id: string) => boolean;
      timeoutMs?: number;
    } = {},
  ) {
    this.routing = new RoutingTable(identity.peerId);
    this.store = new RecordStore(options.now ?? Date.now);
  }
  async start(): Promise<void> {
    if (this.controller.signal.aborted) throw new Error("OVERLAY_CLOSED");
    if (this.running) return;
    if (this.options.discovery) {
      await this.options.discovery.start();
      try {
        await this.options.discovery.announceAppEntrypoint();
      } catch (error) {
        await this.options.discovery.stop();
        throw error;
      }
    }
    this.running = true;
  }
  private assertRunning(): void {
    if (!this.running) throw new Error("NOT_STARTED");
  }
  private remember(peer: AuthenticatedPeer): void {
    this.assertRunning();
    if (this.options.blocked?.(peer.id)) throw new Error("BLOCKED_PEER");
    this.routing.add({
      id: peer.id,
      publicKey: Buffer.from(peer.transportKey, "hex"),
      connectionHints: [],
    });
  }
  private contacts(target: string): Referral[] {
    return this.routing.nearest(target).map((c) => ({
      id: c.id,
      transportKey: Buffer.from(c.publicKey).toString("hex"),
    }));
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
  private async call(
    key: Uint8Array,
    request: unknown,
    expectedPeerId?: string,
  ): Promise<unknown> {
    this.assertRunning();
    if (expectedPeerId && this.options.blocked?.(expectedPeerId))
      throw new Error("BLOCKED_PEER");
    const response = await requestRpc(
      this.connector.connect(key),
      this.identity,
      request,
      {
        signal: this.controller.signal,
        timeoutMs: this.options.timeoutMs ?? 5000,
        ...(expectedPeerId ? { expectedPeerId } : {}),
      },
    );
    this.remember(response.peer);
    return response.result;
  }
  join(key: Uint8Array): Promise<void> {
    this.assertRunning();
    if (key.byteLength !== 32)
      return Promise.reject(new Error("INVALID_TRANSPORT_KEY"));
    const address = Buffer.from(key).toString("hex");
    const pending = this.pendingJoins.get(address);
    if (pending) return pending;
    if (this.pendingJoins.size >= 32)
      return Promise.reject(new Error("JOIN_QUOTA"));
    const joining = this.introduce(Buffer.from(key)).finally(() =>
      this.pendingJoins.delete(address),
    );
    this.pendingJoins.set(address, joining);
    return joining;
  }
  private async introduce(key: Uint8Array): Promise<void> {
    const response = (await this.call(key, {
      op: "find-node",
      target: this.identity.peerId,
    })) as { contacts?: unknown } | null;
    const candidates = referrals(response?.contacts);
    for (const candidate of candidates) {
      if (
        candidate.id === this.identity.peerId ||
        this.options.blocked?.(candidate.id)
      )
        continue;
      try {
        await this.call(
          Buffer.from(candidate.transportKey, "hex"),
          { op: "find-node", target: this.identity.peerId },
          candidate.id,
        );
      } catch {
        /* A referral is an untrusted hint, never routing membership on its own. */
      }
    }
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
    let replicas = 0,
      failures = 0;
    for (const contact of this.routing.nearest(key, 3)) {
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
    for (const contact of this.routing.nearest(key)) {
      let cursor = 0;
      for (let page = 0; page < 32; page++) {
        let response: { records?: unknown; next?: unknown } | null;
        try {
          response = (await this.call(
            contact.publicKey,
            { op: "find-value", key, cursor },
            contact.id,
          )) as typeof response;
        } catch {
          break;
        }
        if (
          !response ||
          !Array.isArray(response.records) ||
          response.records.length > 2
        )
          break;
        for (const record of response.records) accept(record);
        if (response.next === null) break;
        if (response.next !== cursor + 2) throw new Error("INVALID_CURSOR");
        cursor += 2;
        if (page === 31) throw new Error("RESULT_QUOTA");
      }
    }
    return [...found.values()].sort((a, b) => a.author.localeCompare(b.author));
  }
  async leave(): Promise<void> {
    this.running = false;
    this.controller.abort();
    this.routing.clear();
    this.store.clear();
    await Promise.allSettled(this.pendingJoins.values());
    await this.options.discovery?.stop();
  }
  authenticatedContacts(): PeerContact[] {
    return this.routing.nearest(this.identity.peerId, 100);
  }
}
