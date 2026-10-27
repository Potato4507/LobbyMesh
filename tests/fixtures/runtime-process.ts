import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createOverlayRuntime } from "../../packages/app-dht/src/runtime.js";
import { signRecord } from "../../packages/security/src/records.js";

const directory = await mkdtemp(path.join(tmpdir(), "lobbymesh-runtime-"));
const runtime = await createOverlayRuntime(directory, {
  bootstrap: [process.argv[2] ?? ""],
});
await runtime.start();
process.send?.({ ready: true, id: runtime.peerId });
process.on("message", (message: { id: number; op: string; key: string }) => {
  void (async () => {
    switch (message.op) {
      case "put":
        return runtime.overlay.put(
          message.key,
          signRecord(
            runtime.identity,
            message.key,
            "automatic bootstrap",
            0,
            Date.now(),
          ),
        );
      case "lookup":
        return runtime.overlay.lookup(message.key);
      case "contacts":
        return runtime.overlay.authenticatedContacts().map((c) => c.id);
      case "stop":
        await runtime.stop();
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
});
