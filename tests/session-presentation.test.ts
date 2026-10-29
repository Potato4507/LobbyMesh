import assert from "node:assert/strict";
import test from "node:test";
import { sessionPresentation } from "../apps/desktop/src/session-status.js";
import type {
  DetectionState,
  DetectionStatus,
} from "../packages/session/src/windows-logs.js";

test("session presentation distinguishes process absence, pending logs and unverified evidence with fixed local text", () => {
  const status = (
    state: DetectionState,
    reason: DetectionStatus["reason"] = null,
  ): DetectionStatus => ({
    state,
    reason,
    source: "windows-log",
    verification: "self-asserted",
  });
  assert.equal(
    sessionPresentation(status("waiting", "player-not-running")).label,
    "Waiting for Roblox",
  );
  assert.equal(
    sessionPresentation(status("waiting", "player-log-pending")).label,
    "Waiting for player logs",
  );
  assert.equal(
    sessionPresentation(status("waiting")).label,
    "Waiting for session details",
  );
  assert.equal(
    sessionPresentation(status("unavailable", "process-query-failed")).label,
    "Session detection unavailable",
  );
  assert.match(sessionPresentation(status("detected")).detail, /unverified/);
  assert.match(
    sessionPresentation(status("incomplete")).detail,
    /Matching stays paused/,
  );
  for (const state of [
    "disabled",
    "unsupported",
    "waiting",
    "incomplete",
    "scanning",
    "detected",
    "stale",
    "ambiguous",
    "unavailable",
  ] as const) {
    const view = sessionPresentation(status(state));
    assert.ok(view.label && view.detail);
    assert.ok(!view.detail.includes("JobId"));
  }
  assert.equal(sessionPresentation(null).label, "Checking session…");
});
