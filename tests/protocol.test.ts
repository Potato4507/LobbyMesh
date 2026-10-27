import assert from "node:assert/strict";
import test from "node:test";
import {
  parseStatusRequest,
  requireVersion,
} from "../packages/protocol/src/index.js";

test("protocol rejects incompatible versions and IPC arguments", () => {
  requireVersion(1);
  parseStatusRequest(undefined);
  for (const v of [0, 2, "1", null, {}]) assert.throws(() => requireVersion(v));
  assert.throws(() => parseStatusRequest({ command: "exec" }));
});
