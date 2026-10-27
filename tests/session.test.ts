import assert from "node:assert/strict";
import test from "node:test";
import { MockSessionProvider } from "../packages/session/src/index.js";

test("mock session changes, unsubscribe, isolation and production evidence rejection", async () => {
  const provider = new MockSessionProvider();
  let changes = 0;
  const off = provider.subscribe(() => changes++);
  const session = {
    universeId: "1",
    placeId: "2",
    jobId: "job",
    evidenceSource: "test",
    verification: "mock",
  } as const;
  provider.set(session);
  const read = await provider.current();
  if (read) read.jobId = "changed";
  assert.equal((await provider.current())?.jobId, "job");
  provider.set(null);
  assert.equal(changes, 2);
  off();
  provider.set(session);
  assert.equal(changes, 2);
  assert.throws(() =>
    provider.set({ ...session, verification: "externally-verified" }),
  );
});
