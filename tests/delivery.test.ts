import assert from "node:assert/strict";
import test from "node:test";
import {
  deliveryFailure,
  parseMessageCancel,
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

test("cancel requests bind an exact local outgoing row ID to one contact without transport fields", () => {
  const valid = { peerId: "a".repeat(64), localId: "b".repeat(32) };
  assert.deepEqual(parseMessageCancel(valid), valid);
  for (const value of [
    null,
    [],
    {},
    { ...valid, peerId: "bad" },
    { ...valid, localId: "wire:id" },
    { ...valid, localId: 32 },
    { ...valid, localId: "c".repeat(64) },
    { ...valid, transportKey: "d".repeat(64) },
    { ...valid, consent: true },
  ])
    assert.throws(() => parseMessageCancel(value), /INVALID_MESSAGE_CANCEL/);
});
test("lookup reasons require exact local connection-stage codes and preserve uncertainty", () => {
  for (const [code, reason, label] of [
    [
      "CONTACT_SEARCH_NOT_LOCATED",
      "contact-not-located",
      "Contact not located in this attempt",
    ],
    [
      "CONTACT_SEARCH_INCOMPLETE",
      "lookup-incomplete",
      "Contact lookup was incomplete",
    ],
    [
      "CONTACT_SEARCH_BUSY",
      "lookup-deferred",
      "Contact lookup unavailable right now; try again shortly",
    ],
    [
      "CONTACT_SEARCH_RATE_LIMIT",
      "lookup-deferred",
      "Contact lookup unavailable right now; try again shortly",
    ],
  ] as const) {
    const error = new Error(code);
    assert.deepEqual(deliveryFailure(error, "connection", false, false), {
      reason,
      stage: "connection",
    });
    assert.equal(
      unconfirmedLabel({ reason, stage: "connection" }),
      `${label} · delivery unconfirmed`,
    );
    assert.deepEqual(deliveryFailure(error, "delivery", false, false), {
      reason: "unknown",
      stage: "delivery",
    });
    assert.equal(
      unconfirmedLabel({ reason, stage: "delivery" }),
      "Delivery unconfirmed",
    );
    for (const invalid of [
      code,
      { message: code },
      new Error(`${code} private endpoint`),
    ])
      assert.equal(
        deliveryFailure(invalid, "connection", false, false).reason,
        "unknown",
      );
    assert.equal(
      deliveryFailure(error, "connection", true, false).reason,
      "canceled",
    );
    assert.equal(
      deliveryFailure(error, "connection", true, true).reason,
      "permission-changed",
    );
  }
});
