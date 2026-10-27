import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { NoiseStream } from "../../app-dht/src/rpc.js";
import type { DiscoveryBackend, DiscoveryQuery } from "./index.js";

export interface KeyPair {
  publicKey: Buffer;
  secretKey: Buffer;
}
interface Server {
  listen(keyPair: KeyPair): Promise<void>;
  close(): Promise<void>;
}
interface Node {
  createServer(callback: (stream: NoiseStream) => void): Server;
  connect(key: Buffer, options: { keyPair: KeyPair }): NoiseStream;
  lookup(topic: Buffer): DiscoveryQuery;
  announce(topic: Buffer, keys: KeyPair): DiscoveryQuery;
  unannounce(topic: Buffer, keys: KeyPair): Promise<void>;
  destroy(options: { force: boolean }): Promise<void>;
}
// Narrow declarations checked against installed 6.35.0 source; upstream ships no TS declarations.
const DHT = createRequire(import.meta.url)("hyperdht") as {
  new (options?: { bootstrap?: string[]; port?: number }): Node;
  keyPair(seed: Buffer): KeyPair;
};
export async function loadTransportKeys(directory: string): Promise<KeyPair> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const dir = await lstat(directory);
  if (!dir.isDirectory() || (process.platform !== "win32" && dir.mode & 0o077))
    throw new Error("UNSAFE_DIRECTORY");
  const filename = path.join(directory, "transport-seed-v1");
  let seed: Buffer;
  try {
    const info = await lstat(filename);
    if (
      !info.isFile() ||
      info.size !== 32 ||
      (process.platform !== "win32" && info.mode & 0o077)
    )
      throw new Error("UNSAFE_SEED");
    seed = await readFile(filename);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
    seed = randomBytes(32);
    const handle = await open(filename, "wx", 0o600);
    try {
      await handle.writeFile(seed);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  if (seed.length !== 32) throw new Error("INVALID_SEED");
  const keys = DHT.keyPair(seed);
  seed.fill(0);
  return keys;
}
export class HyperDHTBackend implements DiscoveryBackend {
  private readonly node: Node;
  private server: Server | null = null;
  private readonly streams = new Set<NoiseStream>();
  private closed = false;
  constructor(
    private readonly keys: KeyPair,
    private readonly options: {
      bootstrap?: string[];
      port?: number;
      inbound?: (stream: NoiseStream) => Promise<void>;
      maxConnections?: number;
      streamTimeoutMs?: number;
    } = {},
  ) {
    const cap = options.maxConnections ?? 32;
    const timeout = options.streamTimeoutMs ?? 10_000;
    if (
      !Number.isSafeInteger(cap) ||
      cap < 1 ||
      cap > 128 ||
      !Number.isSafeInteger(timeout) ||
      timeout < 1 ||
      timeout > 60_000
    )
      throw new Error("INVALID_STREAM_LIMITS");
    this.node = new DHT({
      ...(options.bootstrap ? { bootstrap: options.bootstrap } : {}),
      ...(options.port === undefined ? {} : { port: options.port }),
    });
  }
  private track(stream: NoiseStream): NoiseStream {
    stream.on("error", () => {});
    this.streams.add(stream);
    const timer = setTimeout(
      () => stream.destroy(),
      this.options.streamTimeoutMs ?? 10_000,
    );
    stream.once("close", () => {
      clearTimeout(timer);
      this.streams.delete(stream);
    });
    return stream;
  }
  connect(key: Uint8Array): NoiseStream {
    if (this.closed) throw new Error("BACKEND_CLOSED");
    if (key.byteLength !== 32) throw new Error("INVALID_TRANSPORT_KEY");
    if (this.streams.size >= (this.options.maxConnections ?? 32))
      throw new Error("CONNECTION_QUOTA");
    return this.track(
      this.node.connect(Buffer.from(key), { keyPair: this.keys }),
    );
  }
  async listen(): Promise<void> {
    if (this.closed) throw new Error("BACKEND_CLOSED");
    if (this.server) return;
    this.server = this.node.createServer((stream) => {
      stream.on("error", () => {});
      if (
        !this.options.inbound ||
        this.closed ||
        this.streams.size >= (this.options.maxConnections ?? 32)
      ) {
        stream.destroy();
        return;
      }
      this.track(stream);
      void Promise.resolve()
        .then(() => this.options.inbound?.(stream))
        .catch(() => {})
        .finally(() => stream.destroy());
    });
    try {
      await this.server.listen(this.keys);
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  lookup(topic: Buffer): DiscoveryQuery {
    return this.node.lookup(topic);
  }
  announce(topic: Buffer): DiscoveryQuery {
    return this.node.announce(topic, this.keys);
  }
  async unannounce(topic: Buffer): Promise<void> {
    await this.node.unannounce(topic, this.keys);
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const stream of this.streams) stream.destroy();
    await this.node.destroy({ force: true });
    this.server = null;
  }
}
