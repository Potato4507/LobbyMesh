import { createSocket } from "node:dgram";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { NetworkOverlay } from "../../packages/app-dht/src/network.js";
import { serveRpc } from "../../packages/app-dht/src/rpc.js";
import { createIdentity } from "../../packages/identity/src/index.js";
import {
  HyperDHTBackend,
  loadTransportKeys,
} from "../../packages/public-discovery/src/hyperdht.js";
import { PublicDiscovery } from "../../packages/public-discovery/src/index.js";
import { signRecord } from "../../packages/security/src/records.js";

const DHT = createRequire(import.meta.url)("hyperdht") as {
  bootstrapper(
    port: number,
    host: string,
  ): {
    ready(): Promise<void>;
    destroy(options: { force: boolean }): Promise<void>;
  };
};
if (process.argv[2] === "bootstrap") {
  const socket = createSocket("udp4");
  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const node = DHT.bootstrapper(port, "127.0.0.1");
  await node.ready();
  process.send?.({ ready: true, address: `127.0.0.1:${port}` });
  process.on("message", () => {
    void node.destroy({ force: true }).then(() => process.disconnect());
  });
} else {
  const directory = await mkdtemp(path.join(tmpdir(), "lobbymesh-process-"));
  const keys = await loadTransportKeys(directory),
    identity = createIdentity();
  let overlay: NetworkOverlay;
  const backend = new HyperDHTBackend(keys, {
    bootstrap: [process.argv[2] ?? ""],
    port: 0,
    inbound: (stream) => {
      return serveRpc(stream, identity, overlay.handle).catch(
        (error: Error) => {
          console.error(
            `inbound: ${error.message}; hash length ${stream.handshakeHash?.length}`,
          );
          throw error;
        },
      );
    },
  });
  overlay = new NetworkOverlay(identity, backend, {
    discovery: new PublicDiscovery(backend),
  });
  await overlay.start();
  process.send?.({
    ready: true,
    id: identity.peerId,
    key: keys.publicKey.toString("hex"),
  });
  process.on(
    "message",
    (message: {
      id: number;
      op: string;
      key?: string;
      content?: string;
      seq?: number;
    }) => {
      void (async () => {
        switch (message.op) {
          case "join":
            await Promise.all([
              overlay.join(Buffer.from(message.key ?? "", "hex")),
              overlay.join(Buffer.from(message.key ?? "", "hex")),
            ]);
            return overlay.authenticatedContacts().map((c) => c.id);
          case "put":
            return overlay.put(
              message.key ?? "",
              signRecord(
                identity,
                message.key ?? "",
                message.content ?? "fixture",
                message.seq ?? 0,
                Date.now(),
              ),
            );
          case "get":
            return overlay.get(message.key ?? "");
          case "lookup":
            return overlay.lookup(message.key ?? "");
          case "contacts":
            return overlay.authenticatedContacts().map((c) => c.id);
          case "stop":
            await overlay.leave();
            await backend.close();
            await rm(directory, { recursive: true, force: true });
            return "stopped";
          default:
            throw new Error("UNKNOWN_COMMAND");
        }
      })()
        .then((result) => {
          process.send?.({ id: message.id, result });
          if (message.op === "stop") process.disconnect();
        })
        .catch((error: Error) =>
          process.send?.({ id: message.id, error: error.message }),
        );
    },
  );
}
