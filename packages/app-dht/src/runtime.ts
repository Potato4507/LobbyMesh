import path from "node:path";
import { loadOrCreateIdentity } from "../../identity/src/index.js";
import {
  HyperDHTBackend,
  loadTransportKeys,
} from "../../public-discovery/src/hyperdht.js";
import { PublicDiscovery } from "../../public-discovery/src/index.js";
import { type MaintenanceReport, OverlayMaintenance } from "./maintenance.js";
import { NetworkOverlay } from "./network.js";
import { serveRpc } from "./rpc.js";

export async function createOverlayRuntime(
  directory: string,
  options: {
    bootstrap?: string[];
    port?: number;
    blocked?: (id: string) => boolean;
    intervalMs?: number;
  } = {},
) {
  if (
    options.intervalMs !== undefined &&
    (!Number.isSafeInteger(options.intervalMs) ||
      options.intervalMs < 30_000 ||
      options.intervalMs > 600_000)
  )
    throw new Error("INVALID_MAINTENANCE_LIMITS");
  const identity = await loadOrCreateIdentity(path.join(directory, "identity"));
  const keys = await loadTransportKeys(path.join(directory, "transport"));
  let overlay: NetworkOverlay;
  const backend = new HyperDHTBackend(keys, {
    ...(options.bootstrap ? { bootstrap: options.bootstrap } : {}),
    ...(options.port === undefined ? {} : { port: options.port }),
    inbound: (stream) => serveRpc(stream, identity, overlay.handle),
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
      try {
        await overlay.leave();
      } finally {
        await maintenance.stop();
        await backend.close();
      }
    })();
    return stopping;
  };
  return {
    overlay,
    identity,
    peerId: identity.peerId,
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
    stop,
  };
}
