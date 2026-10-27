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
    // Retain established contacts; eviction requires a future authenticated liveness probe.
    if (!bucket.has(contact.id) && bucket.size >= this.k) return false;
    bucket.delete(contact.id);
    bucket.set(contact.id, {
      ...contact,
      publicKey: Buffer.from(contact.publicKey),
      connectionHints: [],
    });
    return true;
  }
  nearest(target: string, count = 20): PeerContact[] {
    xorDistance(this.self, target);
    if (!Number.isSafeInteger(count) || count < 0 || count > 100)
      throw new Error("INVALID_COUNT");
    return [...this.buckets.values()]
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
