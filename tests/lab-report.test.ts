import assert from "node:assert/strict";
import test from "node:test";
import { labRunReport } from "../scripts/lab/report.js";

test("lab evidence identifies cleanup-only failure and preserves the original operation failure", () => {
  assert.deepEqual(labRunReport("revocation", true, false), {
    result: "failed",
    failureReason: "LAB_CLEANUP_UNCONFIRMED",
    failureStage: "cleanup",
  });
  assert.deepEqual(
    labRunReport("second-start", false, false, new Error("LAB_PROCESS_EXIT")),
    {
      result: "failed",
      failureReason: "LAB_PROCESS_EXIT",
      failureStage: "second-start",
    },
  );
  assert.deepEqual(labRunReport("revocation", true, true), {
    result: "passed",
    failureReason: null,
    failureStage: null,
  });
});

test("unknown native and SSH exceptions never enter exported lab evidence", () => {
  for (const error of [
    new Error("private peer address, invitation and SSH provider path"),
    new Error("LAB_PROCESS_EXIT\nprivate diagnostic"),
    "private non-Error exception",
    { message: "LAB_PROCESS_EXIT", secret: "private" },
    undefined,
  ]) {
    const report = labRunReport("pairing", false, true, error);
    assert.equal(report.failureStage, "pairing");
    assert.equal(report.failureReason, "LAB_RUN_FAILED");
    assert.equal(JSON.stringify(report).includes("private"), false);
  }
});
