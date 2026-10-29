import assert from "node:assert/strict";
import test from "node:test";
import {
  deliveryFailure,
  unconfirmedLabel,
} from "../packages/protocol/src/delivery.js";

test("delivery reasons project exact local facts without exposing raw exception strings", () => {
  for (const [code, reason] of [
    ["DIRECT_TIMEOUT", "timeout"],
    ["RPC_TIMEOUT", "timeout"],
    ["REMOTE_RPC_REJECTED", "peer-rejected"],
    ["INVALID_ACK", "invalid-response"],
    ["INVALID_HEARTBEAT", "invalid-response"],
    ["INCOMPATIBLE_DIRECT_PROTOCOL", "invalid-response"],
    ["PEER_ID_MISMATCH", "invalid-response"],
    ["RPC_ABORTED", "unknown"],
  ])
    assert.equal(
      deliveryFailure(new Error(code), "connection", false, false).reason,
      reason,
    );
  for (const error of [
    new Error("private endpoint:123 user payload"),
    new Error("DIRECT_TIMEOUT private detail"),
    "DIRECT_TIMEOUT",
    { message: "RPC_TIMEOUT" },
    null,
  ]) {
    const failure = deliveryFailure(error, "delivery", false, false);
    assert.deepEqual(failure, { reason: "unknown", stage: "delivery" });
    assert.equal(unconfirmedLabel(failure), "Delivery unconfirmed");
  }
  assert.equal(
    deliveryFailure(new Error("REMOTE_RPC_REJECTED"), "delivery", true, false)
      .reason,
    "canceled",
  );
  assert.equal(
    deliveryFailure(null, "delivery", true, true).reason,
    "permission-changed",
  );
  assert.match(
    unconfirmedLabel(
      deliveryFailure(new Error("DIRECT_TIMEOUT"), "connection", false, false),
    ),
    /Connection timed out/,
  );
  assert.match(
    unconfirmedLabel(
      deliveryFailure(new Error("DIRECT_TIMEOUT"), "delivery", false, false),
    ),
    /Send timed out/,
  );
  for (const reason of [
    "canceled",
    "permission-changed",
    "timeout",
    "peer-rejected",
    "invalid-response",
    "unknown",
  ] as const)
    assert.match(
      unconfirmedLabel({ reason, stage: "delivery" }),
      /unconfirmed/i,
    );
  assert.equal(unconfirmedLabel(undefined), "Delivery unconfirmed");
});
