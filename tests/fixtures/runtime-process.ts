import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createOverlayRuntime } from "../../packages/app-dht/src/runtime.js";
import { signRecord } from "../../packages/security/src/records.js";
import { SessionCoordinator } from "../../packages/session/src/coordinator.js";
import { MockSessionProvider } from "../../packages/session/src/index.js";
import { SessionMembership } from "../../packages/session/src/matching.js";

const directory = await mkdtemp(path.join(tmpdir(), "lobbymesh-runtime-"));
const runtime = await createOverlayRuntime(directory, {
  bootstrap: [process.argv[2] ?? ""],
});
await runtime.start();
const provider = new MockSessionProvider();
const membership = new SessionMembership(runtime.identity, runtime.overlay, {
  transportKey: runtime.transportKey,
  displayName: "synthetic fixture",
});
const sessions = new SessionCoordinator(provider, membership);
await sessions.start();
process.send?.({ ready: true, id: runtime.peerId });
process.on(
  "message",
  (message: { id: number; op: string; key: string; room?: string }) => {
    void (async () => {
      switch (message.op) {
        case "session":
          provider.set({
            universeId: "1",
            placeId: "2",
            jobId: message.room ?? "fixture",
            evidenceSource: "test",
            verification: "mock",
          });
          await sessions.setConsent(true);
          return sessions.status();
        case "matches": {
          const session = await provider.current();
          return session ? membership.find(session, true) : [];
        }
        case "leave-session":
          provider.set(null);
          await sessions.settled();
          return sessions.status();
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
          await sessions.stop();
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
  },
);
