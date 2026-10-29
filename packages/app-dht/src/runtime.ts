import path from "node:path";
import {
  type Identity,
  loadOrCreateIdentity,
} from "../../identity/src/index.js";
import {
  HyperDHTBackend,
  type KeyPair,
  loadTransportKeys,
} from "../../public-discovery/src/hyperdht.js";
import { PublicDiscovery } from "../../public-discovery/src/index.js";
import {
  RpcDiagnostics,
  type RpcOperation,
  rpcNativeDetail,
  rpcOperation,
  rpcOutcome,
} from "./diagnostics.js";
import { type MaintenanceReport, OverlayMaintenance } from "./maintenance.js";
import { NetworkOverlay } from "./network.js";
import { type RpcHandler, type RpcPhase, serveRpc } from "./rpc.js";

export async function createOverlayRuntime(
  directory: string,
  options: {
    bootstrap?: string[];
    port?: number;
    blocked?: (id: string) => boolean;
    intervalMs?: number;
    directHandler?: RpcHandler;
    signal?: AbortSignal;
    credentials?: { identity: Identity; transportKeys: KeyPair };
  } = {},
) {
  options.signal?.throwIfAborted();
  if (
    options.intervalMs !== undefined &&
    (!Number.isSafeInteger(options.intervalMs) ||
      options.intervalMs < 30_000 ||
      options.intervalMs > 600_000)
  )
    throw new Error("INVALID_MAINTENANCE_LIMITS");
  const identity =
    options.credentials?.identity ??
    (await loadOrCreateIdentity(path.join(directory, "identity")));
  options.signal?.throwIfAborted();
  const keys =
    options.credentials?.transportKeys ??
    (await loadTransportKeys(path.join(directory, "transport")));
  options.signal?.throwIfAborted();
  let overlay: NetworkOverlay;
  const inboundMetrics = new RpcDiagnostics();
  let activeInbound = 0;
  const backend = new HyperDHTBackend(keys, {
    ...(options.bootstrap ? { bootstrap: options.bootstrap } : {}),
    ...(options.port === undefined ? {} : { port: options.port }),
    inbound: async (stream) => {
      const started = performance.now();
      let phase: RpcPhase = "transport";
      let operation: RpcOperation = "unknown";
      let handlerRejected = false;
      activeInbound++;
      try {
        await serveRpc(
          stream,
          identity,
          async (peer, request, signal) => {
            operation = rpcOperation(request);
            try {
              if (
                request &&
                typeof request === "object" &&
                "namespace" in request &&
                request.namespace === "companion/direct/v1"
              ) {
                if (!options.directHandler) throw new Error("DIRECT_DISABLED");
                return await options.directHandler(peer, request, signal);
              }
              return await overlay.handle(peer, request, signal);
            } catch (error) {
              handlerRejected = true;
              throw error;
            }
          },
          5000,
          (value) => {
            phase = value;
          },
        );
        inboundMetrics.record({
          operation,
          phase,
          outcome: handlerRejected ? "handler-rejected" : "success",
          queueMs: 0,
          transactionMs: performance.now() - started,
        });
      } catch (error) {
        inboundMetrics.record({
          operation,
          phase,
          outcome: rpcOutcome(error),
          ...rpcNativeDetail(error),
          queueMs: 0,
          transactionMs: performance.now() - started,
        });
        throw error;
      } finally {
        activeInbound--;
      }
    },
  });
  const discovery = new PublicDiscovery(backend);
  overlay = new NetworkOverlay(identity, backend, {
    discovery,
    selfTransportKey: keys.publicKey.toString("hex"),
    ...(options.blocked ? { blocked: options.blocked } : {}),
  });
  const maintenance = new OverlayMaintenance(
    discovery,
    overlay,
    options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs },
  );
  let starting: Promise<MaintenanceReport> | undefined,
    closed = false;
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      closed = true;
      options.signal?.removeEventListener("abort", abort);
      // Revoke overlay work immediately, then give directory cleanup a bounded
      // grace period. A stopped app must not leave a native server listening.
      const force = setTimeout(() => {
        void backend.close().catch(() => {});
      }, 1000);
      try {
        await Promise.allSettled([overlay.leave(), maintenance.stop()]);
      } finally {
        clearTimeout(force);
        await backend.close();
      }
    })();
    return stopping;
  };
  const abort = () => {
    void stop().catch(() => {});
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) {
    await stop();
    throw new Error("RUNTIME_ABORTED");
  }
  return {
    overlay,
    identity,
    peerId: identity.peerId,
    transportKey: keys.publicKey.toString("hex"),
    start(): Promise<MaintenanceReport> {
      if (closed) return Promise.reject(new Error("RUNTIME_CLOSED"));
      starting ??= overlay
        .start()
        .then(() => maintenance.start())
        .catch(async (error: unknown) => {
          await stop();
          throw error;
        });
      return starting;
    },
    status: () => maintenance.status(),
    // Developer/local API only. No endpoint, peer identity or payload is retained.
    inboundDiagnostics: () => ({
      active: activeInbound,
      admission: backend.inboundDiagnostics(),
      ...inboundMetrics.snapshot(0),
    }),
    stop,
  };
}
