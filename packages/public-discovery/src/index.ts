import { createHash } from "node:crypto";
import type {
  BootstrapDiscovery,
  PeerContact,
} from "../../protocol/src/index.js";
export const ENTRYPOINT_TOPIC = createHash("sha256")
  .update("companion/public-discovery/v1")
  .digest();
export interface DiscoveryQuery extends AsyncIterable<unknown> {
  destroy(): void;
}
export interface DiscoveryBackend {
  listen(): Promise<void>;
  lookup(topic: Buffer): DiscoveryQuery;
  announce(topic: Buffer): DiscoveryQuery;
  unannounce(topic: Buffer): Promise<void>;
  close(): Promise<void>;
}
// Discovery identity is a transport-key hint only, never an authenticated app PeerId.
export function entrypoint(publicKey: unknown): PeerContact | null {
  if (!(publicKey instanceof Uint8Array) || publicKey.byteLength !== 32)
    return null;
  const key = Buffer.from(publicKey);
  return {
    id: `transport:${key.toString("hex")}`,
    publicKey: key,
    connectionHints: [],
  };
}
export class PublicDiscovery implements BootstrapDiscovery {
  private running = false;
  private queries = new Set<DiscoveryQuery>();
  private lastLookup = -Infinity;
  private lastAnnounce = -Infinity;
  constructor(
    private readonly backend: DiscoveryBackend,
    private readonly now = Date.now,
    private readonly timeoutMs = 10_000,
  ) {}
  async start(): Promise<void> {
    if (this.running) return;
    await this.backend.listen();
    this.running = true;
  }
  private async *consume(query: DiscoveryQuery): AsyncIterable<PeerContact> {
    this.queries.add(query);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      query.destroy();
    }, this.timeoutMs);
    const seen = new Set<string>();
    try {
      for await (const value of query) {
        if (
          !value ||
          typeof value !== "object" ||
          !("peers" in value) ||
          !Array.isArray(value.peers)
        )
          continue;
        for (const peer of value.peers.slice(0, 256)) {
          if (!peer || typeof peer !== "object") continue;
          const contact = entrypoint(peer.publicKey);
          if (!contact || seen.has(contact.id)) continue;
          seen.add(contact.id);
          yield contact;
          if (seen.size >= 256) return;
        }
      }
      if (timedOut) throw new Error("DISCOVERY_TIMEOUT");
    } finally {
      clearTimeout(timer);
      query.destroy();
      this.queries.delete(query);
    }
  }
  async *findAppEntrypoints(): AsyncIterable<PeerContact> {
    if (!this.running) throw new Error("NOT_STARTED");
    if (this.now() - this.lastLookup < 1000) throw new Error("RATE_LIMIT");
    this.lastLookup = this.now();
    yield* this.consume(this.backend.lookup(ENTRYPOINT_TOPIC));
  }
  async announceAppEntrypoint(): Promise<void> {
    if (!this.running) throw new Error("NOT_STARTED");
    if (this.now() - this.lastAnnounce < 30_000) throw new Error("RATE_LIMIT");
    this.lastAnnounce = this.now();
    for await (const _contact of this.consume(
      this.backend.announce(ENTRYPOINT_TOPIC),
    )) {
      /* drain documented announce query */
    }
  }
  async stop(): Promise<void> {
    this.running = false;
    for (const query of this.queries) query.destroy();
    try {
      await this.backend.unannounce(ENTRYPOINT_TOPIC);
    } finally {
      await this.backend.close();
    }
  }
}
export class MemoryDiscoveryBackend implements DiscoveryBackend {
  private listening = false;
  constructor(
    private readonly network: Map<string, Uint8Array>,
    private readonly key: Uint8Array,
  ) {}
  async listen(): Promise<void> {
    this.listening = true;
  }
  lookup(_topic: Buffer): DiscoveryQuery {
    let destroyed = false;
    const peers = [...this.network.values()].map((publicKey) => ({
      publicKey: Buffer.from(publicKey),
    }));
    return {
      destroy() {
        destroyed = true;
      },
      async *[Symbol.asyncIterator]() {
        if (!destroyed) yield { peers };
      },
    };
  }
  announce(topic: Buffer): DiscoveryQuery {
    if (!this.listening) throw new Error("NOT_LISTENING");
    this.network.set(
      Buffer.from(this.key).toString("hex"),
      Buffer.from(this.key),
    );
    return this.lookup(topic);
  }
  async unannounce(_topic: Buffer): Promise<void> {
    this.network.delete(Buffer.from(this.key).toString("hex"));
  }
  async close(): Promise<void> {
    this.listening = false;
  }
}
