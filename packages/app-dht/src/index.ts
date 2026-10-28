import type {
  BootstrapDiscovery,
  PeerContact,
} from "../../protocol/src/index.js";
import { RecordStore, type RecordV1 } from "../../security/src/records.js";
export const OVERLAY_NAMESPACE = "companion/app-overlay/v1";
export function xorDistance(a: string, b: string): bigint {
  if (!/^[a-f0-9]{64}$/.test(a) || !/^[a-f0-9]{64}$/.test(b))
    throw new Error("INVALID_NODE_ID");
  return BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
}
export class RoutingTable {
  private buckets = new Map<number, Map<string, PeerContact>>();
  private replacements = new Map<number, Map<string, PeerContact>>();
  private activity = new Map<string, number>();
  private tick = 0;
  constructor(
    private readonly self: string,
    private readonly k = 20,
  ) {
    xorDistance(self, self);
    if (!Number.isSafeInteger(k) || k < 1 || k > 100)
      throw new Error("INVALID_K");
  }
  add(contact: PeerContact): boolean {
    const distance = xorDistance(this.self, contact.id);
    if (distance === 0n) return false;
    if (contact.publicKey.byteLength !== 32) throw new Error("INVALID_CONTACT");
    const bucketIndex = distance.toString(2).length - 1;
    let bucket = this.buckets.get(bucketIndex);
    if (!bucket) {
      bucket = new Map();
      this.buckets.set(bucketIndex, bucket);
    }
    if (!bucket.has(contact.id) && bucket.size >= this.k) {
      const cache =
        this.replacements.get(bucketIndex) ?? new Map<string, PeerContact>();
      cache.delete(contact.id);
      cache.set(contact.id, {
        ...contact,
        publicKey: Buffer.from(contact.publicKey),
        connectionHints: [],
      });
      if (cache.size > this.k) {
        const oldest = cache.keys().next().value;
        if (oldest) cache.delete(oldest);
      }
      this.replacements.set(bucketIndex, cache);
      return false;
    }
    this.replacements.get(bucketIndex)?.delete(contact.id);
    bucket.delete(contact.id);
    bucket.set(contact.id, {
      ...contact,
      publicKey: Buffer.from(contact.publicKey),
      connectionHints: [],
    });
    this.activity.set(contact.id, ++this.tick);
    return true;
  }
  oldest(count: number): PeerContact[] {
    if (!Number.isSafeInteger(count) || count < 0 || count > 100)
      throw new Error("INVALID_COUNT");
    return [...this.buckets.values()]
      .flatMap((bucket) => [...bucket.values()])
      .sort(
        (a, b) =>
          (this.activity.get(a.id) ?? 0) - (this.activity.get(b.id) ?? 0),
      )
      .slice(0, count)
      .map((contact) => ({
        ...contact,
        publicKey: Buffer.from(contact.publicKey),
        connectionHints: [],
      }));
  }
  nearest(
    target: string,
    count = 20,
    includeReplacements = false,
  ): PeerContact[] {
    xorDistance(this.self, target);
    if (!Number.isSafeInteger(count) || count < 0 || count > 100)
      throw new Error("INVALID_COUNT");
    return [
      ...this.buckets.values(),
      ...(includeReplacements ? this.replacements.values() : []),
    ]
      .flatMap((bucket) => [...bucket.values()])
      .sort((a, b) => {
        const x = xorDistance(a.id, target),
          y = xorDistance(b.id, target);
        return x < y ? -1 : x > y ? 1 : 0;
      })
      .slice(0, count)
      .map((c) => ({
        ...c,
        publicKey: Buffer.from(c.publicKey),
        connectionHints: [],
      }));
  }
  clear(): void {
    this.buckets.clear();
    this.replacements.clear();
    this.activity.clear();
    this.tick = 0;
  }
  has(id: string): boolean {
    const distance = xorDistance(this.self, id);
    return (
      distance !== 0n &&
      (this.buckets.get(distance.toString(2).length - 1)?.has(id) ?? false)
    );
  }
  revision(id: string): number | undefined {
    return this.activity.get(id);
  }
  stats(): { buckets: number; active: number; replacements: number } {
    return {
      buckets: this.buckets.size,
      active: [...this.buckets.values()].reduce(
        (sum, bucket) => sum + bucket.size,
        0,
      ),
      replacements: [...this.replacements.values()].reduce(
        (sum, bucket) => sum + bucket.size,
        0,
      ),
    };
  }
  remove(id: string, allowed: (id: string) => boolean = () => true): boolean {
    const distance = xorDistance(this.self, id);
    if (distance === 0n) return false;
    const index = distance.toString(2).length - 1,
      bucket = this.buckets.get(index);
    const removed = bucket?.delete(id) ?? false;
    this.activity.delete(id);
    const cache = this.replacements.get(index);
    cache?.delete(id);
    if (removed && cache) {
      for (const contact of [...cache.values()].reverse()) {
        cache.delete(contact.id);
        if (!allowed(contact.id)) continue;
        this.add(contact);
        break;
      }
    }
    if (cache?.size === 0) this.replacements.delete(index);
    if (bucket?.size === 0) this.buckets.delete(index);
    return removed;
  }
}
// Single-node stage only: no network RPC, join, replication or partition-healing claims.
export class LocalOverlay {
  readonly routing: RoutingTable;
  private readonly store: RecordStore;
  private running = false;
  constructor(
    self: string,
    private readonly discovery: BootstrapDiscovery,
    now = Date.now,
  ) {
    this.routing = new RoutingTable(self);
    this.store = new RecordStore(now);
  }
  async start(): Promise<void> {
    if (this.running) return;
    await this.discovery.start();
    try {
      await this.discovery.announceAppEntrypoint();
      this.running = true;
    } catch (error) {
      await this.discovery.stop();
      throw error;
    }
  }
  put(key: string, record: unknown): void {
    if (!this.running) throw new Error("NOT_STARTED");
    this.store.put(key, record);
  }
  get(key: string): RecordV1[] {
    if (!this.running) throw new Error("NOT_STARTED");
    return this.store.get(key);
  }
  async leave(): Promise<void> {
    this.running = false;
    this.store.clear();
    this.routing.clear();
    await this.discovery.stop();
  }
}
