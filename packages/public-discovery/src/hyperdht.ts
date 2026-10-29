import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import HyperDHT from "hyperdht";
import type { NoiseStream } from "../../app-dht/src/rpc.js";
import {
  loadProtectedFile,
  requirePlaintextMode,
  type SecretProtection,
} from "../../security/src/protected-file.js";
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
const DHT = HyperDHT as {
  new (options?: { bootstrap?: string[]; port?: number }): Node;
  keyPair(seed: Buffer): KeyPair;
};
export async function loadTransportKeys(
  directory: string,
  protection?: SecretProtection,
): Promise<KeyPair> {
  const sealed = "transport-os-v1.bin";
  if (protection) {
    const normalize = (value: string) => {
      const stored = JSON.parse(value) as {
        version?: unknown;
        seed?: unknown;
      } | null;
      if (
        !stored ||
        stored.version !== 1 ||
        typeof stored.seed !== "string" ||
        !/^[A-Za-z0-9+/]{43}=$/.test(stored.seed)
      )
        throw new Error("INVALID_SEED");
      const seed = Buffer.from(stored.seed, "base64");
      try {
        if (seed.length !== 32 || seed.toString("base64") !== stored.seed)
          throw new Error("INVALID_SEED");
      } finally {
        seed.fill(0);
      }
      return JSON.stringify({ version: 1, seed: stored.seed });
    };
    const payload = await loadProtectedFile(
      directory,
      {
        legacy: "transport-seed-v1",
        sealed,
        normalize,
        decodeLegacy: (seed) => {
          if (seed.length !== 32) throw new Error("UNSAFE_SEED");
          return JSON.stringify({ version: 1, seed: seed.toString("base64") });
        },
        create: () => {
          const seed = randomBytes(32);
          try {
            return JSON.stringify({
              version: 1,
              seed: seed.toString("base64"),
            });
          } finally {
            seed.fill(0);
          }
        },
      },
      protection,
    );
    const seed = Buffer.from(
      (JSON.parse(payload) as { seed: string }).seed,
      "base64",
    );
    try {
      return DHT.keyPair(seed);
    } finally {
      seed.fill(0);
    }
  }
  await requirePlaintextMode(directory, sealed);
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
  private closing: Promise<void> | undefined;
  private readonly inboundAdmission = {
    accepted: 0,
    disabled: 0,
    closed: 0,
    quota: 0,
  };
  inboundDiagnostics() {
    return { ...this.inboundAdmission };
  }
  private admitted(reason: keyof typeof this.inboundAdmission): void {
    this.inboundAdmission[reason] = Math.min(
      Number.MAX_SAFE_INTEGER,
      this.inboundAdmission[reason] + 1,
    );
  }
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
      const denied = this.closed
        ? "closed"
        : !this.options.inbound
          ? "disabled"
          : this.streams.size >= (this.options.maxConnections ?? 32)
            ? "quota"
            : null;
      if (denied) {
        this.admitted(denied);
        stream.destroy();
        return;
      }
      this.admitted("accepted");
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
    if (this.closed) return;
    await this.node.unannounce(topic, this.keys);
  }
  close(): Promise<void> {
    this.closed = true;
    this.closing ??= (async () => {
      for (const stream of this.streams) stream.destroy();
      await this.node.destroy({ force: true });
      this.server = null;
    })();
    return this.closing;
  }
}
