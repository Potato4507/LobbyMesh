import type { EventEmitter } from "node:events";
import {
  type Identity,
  peerIdFromPublicKey,
  verify,
} from "../../identity/src/index.js";

export const RPC_NAMESPACE = "companion/app-overlay/rpc/v1";
export const MAX_FRAME_BYTES = 24 * 1024;
export type RpcPhase = "hello" | "proof" | "request" | "response" | "complete";
type PhaseObserver = (phase: RpcPhase) => void;
function observe(observer: PhaseObserver | undefined, phase: RpcPhase): void {
  try {
    observer?.(phase);
  } catch {
    /* Diagnostics cannot alter authentication or dispatch. */
  }
}
export interface NoiseStream extends EventEmitter {
  publicKey: Buffer;
  remotePublicKey: Buffer;
  handshakeHash: Buffer;
  write(data: Buffer, callback?: (error?: Error | null) => void): boolean;
  end(): void;
  destroy(error?: Error): void;
}
export interface AuthenticatedPeer {
  id: string;
  publicKey: string;
  transportKey: string;
}
export type RpcHandler = (
  peer: AuthenticatedPeer,
  request: unknown,
  signal: AbortSignal,
) => Promise<unknown>;

// One bounded transaction per Noise stream. No persistent multiplexing or unbounded queue.
export class FrameChannel {
  private buffer: Buffer = Buffer.alloc(0);
  private queue: unknown[] = [];
  private waiter:
    | { resolve(value: unknown): void; reject(error: Error): void }
    | undefined;
  private error: Error | undefined;
  private frames = 0;
  constructor(private readonly stream: NoiseStream) {
    stream.on("data", this.data);
    stream.on("error", this.fail);
    stream.on("close", this.closed);
    stream.on("end", this.closed);
  }
  private closed = () => this.fail(new Error("RPC_CLOSED"));
  private fail = (error: Error) => {
    this.error ??= error;
    this.waiter?.reject(this.error);
    this.waiter = undefined;
  };
  private data = (chunk: Buffer) => {
    try {
      if (this.error) return;
      // Bound allocation before concatenation, even if the sender coalesces frames.
      if (chunk.length + this.buffer.length > MAX_FRAME_BYTES + 4)
        throw new Error("FRAME_TOO_LARGE");
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (this.buffer.length >= 4) {
        const size = this.buffer.readUInt32BE(0);
        if (size === 0 || size > MAX_FRAME_BYTES)
          throw new Error("FRAME_TOO_LARGE");
        if (this.buffer.length < size + 4) break;
        if (++this.frames > 4) throw new Error("FRAME_QUOTA");
        const value: unknown = JSON.parse(
          this.buffer.subarray(4, size + 4).toString("utf8"),
        );
        this.buffer = this.buffer.subarray(size + 4);
        if (this.waiter) {
          this.waiter.resolve(value);
          this.waiter = undefined;
        } else this.queue.push(value);
      }
    } catch (error) {
      this.queue = [];
      this.fail(error instanceof Error ? error : new Error("INVALID_FRAME"));
      this.stream.destroy();
    }
  };
  read(): Promise<unknown> {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    if (this.error) return Promise.reject(this.error);
    if (this.waiter) return Promise.reject(new Error("CONCURRENT_READ"));
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }
  async write(value: unknown): Promise<void> {
    const body = Buffer.from(JSON.stringify(value));
    if (body.length === 0 || body.length > MAX_FRAME_BYTES)
      throw new Error("FRAME_TOO_LARGE");
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length);
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        this.stream.removeListener("drain", drained);
        this.stream.removeListener("error", failed);
        this.stream.removeListener("close", closed);
      };
      const drained = () => {
        cleanup();
        resolve();
      };
      const failed = (error: Error) => {
        cleanup();
        reject(error);
      };
      const closed = () => failed(new Error("RPC_CLOSED"));
      this.stream.once("drain", drained);
      this.stream.once("error", failed);
      this.stream.once("close", closed);
      try {
        // HyperDHT uses streamx: write callbacks are not supported. Honor drain instead.
        if (this.stream.write(Buffer.concat([header, body]))) drained();
      } catch (error) {
        failed(error instanceof Error ? error : new Error("RPC_WRITE_FAILED"));
      }
    });
  }
  dispose(): void {
    this.fail(new Error("RPC_CLOSED"));
    this.stream.removeListener("data", this.data);
    this.stream.removeListener("end", this.closed);
    this.stream.removeListener("close", this.closed);
    // Keep the error sink until stream destruction completes (streamx emits asynchronously).
    this.stream.once("close", () =>
      this.stream.removeListener("error", this.fail),
    );
    this.queue = [];
    this.buffer = Buffer.alloc(0);
  }
}
interface Hello {
  namespace: typeof RPC_NAMESPACE;
  version: 1;
  capability: "overlay-rpc";
  publicKey: string;
  id: string;
}
function hello(identity: Identity): Hello {
  return {
    namespace: RPC_NAMESPACE,
    version: 1,
    capability: "overlay-rpc",
    publicKey: identity.publicKey,
    id: identity.peerId,
  };
}
function parseHello(value: unknown): Hello {
  const h = value as Hello | null;
  if (
    !h ||
    h.namespace !== RPC_NAMESPACE ||
    h.version !== 1 ||
    h.capability !== "overlay-rpc"
  )
    throw new Error("INCOMPATIBLE_PROTOCOL");
  if (
    typeof h.publicKey !== "string" ||
    h.publicKey.length > 512 ||
    peerIdFromPublicKey(h.publicKey) !== h.id
  )
    throw new Error("INVALID_IDENTITY");
  return {
    namespace: RPC_NAMESPACE,
    version: 1,
    capability: "overlay-rpc",
    publicKey: h.publicKey,
    id: h.id,
  };
}
function transcript(
  stream: NoiseStream,
  signer: Hello,
  recipient: Hello,
  sending: boolean,
): Buffer {
  if (
    stream.publicKey?.length !== 32 ||
    stream.remotePublicKey?.length !== 32 ||
    stream.handshakeHash?.length !== 64
  )
    throw new Error("UNAUTHENTICATED_TRANSPORT");
  return Buffer.from(
    JSON.stringify([
      "companion/app-overlay/identity-binding/v1",
      stream.handshakeHash.toString("hex"),
      (sending ? stream.publicKey : stream.remotePublicKey).toString("hex"),
      (sending ? stream.remotePublicKey : stream.publicKey).toString("hex"),
      signer,
      recipient,
    ]),
  );
}
export async function authenticate(
  channel: FrameChannel,
  stream: NoiseStream,
  identity: Identity,
  observer?: PhaseObserver,
): Promise<AuthenticatedPeer> {
  observe(observer, "hello");
  const local = hello(identity);
  await channel.write(local);
  const remote = parseHello(await channel.read());
  if (remote.id === local.id) throw new Error("SELF_CONNECTION");
  const signature = identity
    .sign(transcript(stream, local, remote, true))
    .toString("hex");
  observe(observer, "proof");
  await channel.write({ signature });
  const proof = (await channel.read()) as { signature?: unknown } | null;
  if (
    !proof ||
    typeof proof.signature !== "string" ||
    !/^[a-f0-9]{128}$/.test(proof.signature) ||
    !verify(
      remote.publicKey,
      transcript(stream, remote, local, false),
      Buffer.from(proof.signature, "hex"),
    )
  )
    throw new Error("INVALID_HANDSHAKE_SIGNATURE");
  return Object.freeze({
    id: remote.id,
    publicKey: remote.publicKey,
    transportKey: stream.remotePublicKey.toString("hex"),
  });
}
async function transaction<T>(
  stream: NoiseStream,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  run: (channel: FrameChannel, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    stream.on("error", () => {});
    stream.destroy();
    throw new Error("INVALID_TIMEOUT");
  }
  const channel = new FrameChannel(stream);
  const controller = new AbortController();
  let rejectDeadline: (error: Error) => void = () => {};
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const abort = () => {
    controller.abort();
    rejectDeadline(new Error("RPC_ABORTED"));
    stream.destroy();
  };
  const timer = setTimeout(() => {
    controller.abort();
    rejectDeadline(new Error("RPC_TIMEOUT"));
    stream.destroy();
  }, timeoutMs);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted) throw new Error("RPC_ABORTED");
    return await Promise.race([deadline, run(channel, controller.signal)]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    controller.abort();
    channel.dispose();
    stream.destroy();
  }
}
export function requestRpc(
  stream: NoiseStream,
  identity: Identity,
  request: unknown,
  options: {
    timeoutMs?: number;
    signal?: AbortSignal;
    expectedPeerId?: string;
    onPhase?: PhaseObserver;
  } = {},
): Promise<{ peer: AuthenticatedPeer; result: unknown }> {
  return transaction(
    stream,
    options.timeoutMs ?? 5000,
    options.signal,
    async (channel) => {
      const peer = await authenticate(
        channel,
        stream,
        identity,
        options.onPhase,
      );
      if (options.expectedPeerId && peer.id !== options.expectedPeerId)
        throw new Error("PEER_ID_MISMATCH");
      observe(options.onPhase, "request");
      await channel.write({ type: "request", body: request });
      observe(options.onPhase, "response");
      const response = (await channel.read()) as {
        type?: unknown;
        body?: unknown;
      } | null;
      if (response?.type === "error") throw new Error("REMOTE_RPC_REJECTED");
      if (response?.type !== "response")
        throw new Error("INVALID_RPC_RESPONSE");
      observe(options.onPhase, "complete");
      return { peer, result: response.body };
    },
  );
}
export function serveRpc(
  stream: NoiseStream,
  identity: Identity,
  handler: RpcHandler,
  timeoutMs = 5000,
): Promise<void> {
  return transaction(stream, timeoutMs, undefined, async (channel, signal) => {
    const peer = await authenticate(channel, stream, identity);
    const request = (await channel.read()) as {
      type?: unknown;
      body?: unknown;
    } | null;
    if (request?.type !== "request") throw new Error("INVALID_RPC_REQUEST");
    try {
      const result = await handler(peer, request.body, signal);
      if (signal.aborted) return;
      await channel.write({ type: "response", body: result });
    } catch {
      if (!signal.aborted) await channel.write({ type: "error" });
    }
    // Let the client acknowledge receipt by closing; bounded by the transaction deadline.
    stream.end();
    await new Promise<void>((resolve) => stream.once("close", resolve));
  });
}
