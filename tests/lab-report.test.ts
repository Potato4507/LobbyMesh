import assert from "node:assert/strict";
import test from "node:test";
import { labRunReport, labTransportSummary } from "../scripts/lab/report.js";

test("transport failure summaries copy only nonnegative integer counters", () => {
  const summary = labTransportSummary({
    diagnostics: {
      total: 4,
      queued: -1,
      outcomes: { success: 3, timeout: 1, private: "secret" },
      recent: ["secret"],
      recentFailures: [
        {
          outcome: "timeout",
          phase: "hello",
          queueMs: 1.234,
          transactionMs: 1500,
          secret: "secret",
        },
        { outcome: "secret", phase: "hello" },
        { outcome: "timeout", phase: "secret" },
      ],
    },
    inbound: {
      active: Infinity,
      total: 3,
      outcomes: { success: 3, timeout: "secret" },
      admission: {
        accepted: 3,
        disabled: 0,
        closed: 0,
        quota: NaN,
        address: "secret",
      },
    },
    peerId: "secret",
  });
  assert.equal(summary.outgoing.total, 4);
  assert.equal(summary.outgoing.queued, null);
  assert.equal(summary.outgoing.outcomes.timeout, 1);
  assert.deepEqual(summary.outgoing.recentFailures, [
    { outcome: "timeout", phase: "hello", queueMs: 1.23, transactionMs: 1500 },
  ]);
  assert.equal(summary.inbound.active, null);
  assert.equal(summary.inbound.outcomes.timeout, null);
  assert.equal(summary.inbound.admission.accepted, 3);
  assert.equal(summary.inbound.admission.quota, null);
  assert.equal(JSON.stringify(summary).includes("secret"), false);
  for (const value of [null, [], "secret", 42])
    assert.equal(labTransportSummary(value).outgoing.total, null);
});

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
