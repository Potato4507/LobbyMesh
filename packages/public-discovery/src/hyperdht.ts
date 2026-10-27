import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { DiscoveryBackend, DiscoveryQuery } from "./index.js";

interface KeyPair {
  publicKey: Buffer;
  secretKey: Buffer;
}
interface Server {
  listen(keyPair: KeyPair): Promise<void>;
  close(): Promise<void>;
}
interface Node {
  createServer(callback: (stream: { destroy(): void }) => void): Server;
  lookup(topic: Buffer): DiscoveryQuery;
  announce(topic: Buffer, keys: KeyPair): DiscoveryQuery;
  unannounce(topic: Buffer, keys: KeyPair): Promise<void>;
  destroy(options: { force: boolean }): Promise<void>;
}
// Narrow declarations checked against installed 6.35.0 source; upstream ships no TS declarations.
const DHT = createRequire(import.meta.url)("hyperdht") as {
  new (options?: { bootstrap?: string[] }): Node;
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
  constructor(
    private readonly keys: KeyPair,
    options: { bootstrap?: string[] } = {},
  ) {
    this.node = new DHT(options);
  }
  async listen(): Promise<void> {
    if (this.server) return;
    // M04 only: deny incoming streams until an authenticated overlay handler exists.
    this.server = this.node.createServer((stream) => stream.destroy());
    await this.server.listen(this.keys);
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
    await this.node.destroy({ force: true });
    this.server = null;
  }
}
