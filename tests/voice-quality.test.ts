import assert from "node:assert/strict";
import test from "node:test";
import {
  readMediaQuality,
  unknownMediaQuality,
  validMediaQuality,
} from "../packages/voice/src/quality.js";

const report = (
  audio: Record<string, unknown> = {},
  pair: Record<string, unknown> = {},
) =>
  new Map<string, unknown>([
    ["transport", { type: "transport", selectedCandidatePairId: "selected" }],
    [
      "other",
      { type: "candidate-pair", state: "succeeded", currentRoundTripTime: 40 },
    ],
    [
      "selected",
      {
        type: "candidate-pair",
        state: "succeeded",
        currentRoundTripTime: 0.0125,
        ...pair,
      },
    ],
    [
      "audio",
      {
        type: "inbound-rtp",
        kind: "audio",
        jitter: 0.002,
        packetsLost: 3,
        ...audio,
      },
    ],
    [
      "video",
      { type: "inbound-rtp", kind: "video", jitter: 40, packetsLost: 100 },
    ],
  ]);
test("quality reads only the selected pair and one inbound audio stream, retaining no private stats fields", () => {
  const source = report();
  source.set("private", {
    type: "local-candidate",
    address: "private address",
    port: 123,
  });
  const q = readMediaQuality(source);
  assert.deepEqual(q, { roundTripMs: 12.5, jitterMs: 2, packetsLost: 3 });
  assert.equal(JSON.stringify(q).includes("private"), false);
  source.delete("transport");
  assert.equal(readMediaQuality(source).roundTripMs, null);
  source.set("transport", {
    type: "transport",
    selectedCandidatePairId: "selected",
  });
  source.set("extraTransport", {
    type: "transport",
    selectedCandidatePairId: "other",
  });
  assert.equal(readMediaQuality(source).roundTripMs, null);
  source.set("extraAudio", {
    type: "inbound-rtp",
    kind: "audio",
    jitter: 0,
    packetsLost: 0,
  });
  assert.deepEqual(readMediaQuality(source), unknownMediaQuality());
});
test("invalid, absent and ambiguous quality is unknown rather than invented zero", () => {
  assert.deepEqual(readMediaQuality([]), unknownMediaQuality());
  for (const value of [-1, NaN, Infinity, "0", undefined, 61]) {
    const q = readMediaQuality(
      report({ jitter: value }, { currentRoundTripTime: value }),
    );
    assert.equal(q.jitterMs, null);
    assert.equal(q.roundTripMs, null);
  }
  for (const packetsLost of [
    -1,
    0.1,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    assert.equal(readMediaQuality(report({ packetsLost })).packetsLost, null);
  assert.deepEqual(
    readMediaQuality(
      report({ jitter: 0, packetsLost: 0 }, { currentRoundTripTime: 0 }),
    ),
    { roundTripMs: 0, jitterMs: 0, packetsLost: 0 },
  );
  const tooMany = new Map(
    Array.from({ length: 129 }, (_, index) => [String(index), {}]),
  );
  assert.deepEqual(readMediaQuality(tooMany), unknownMediaQuality());
  assert.deepEqual(
    readMediaQuality({
      [Symbol.iterator]() {
        throw new Error("stats unavailable");
      },
    }),
    unknownMediaQuality(),
  );
});
test("quality IPC validates exact bounded numeric-or-null fields", () => {
  const q = { roundTripMs: 12, jitterMs: 2, packetsLost: 0 };
  assert.ok(validMediaQuality(q));
  assert.ok(validMediaQuality(unknownMediaQuality()));
  for (const value of [
    null,
    [],
    {},
    { ...q, address: "private" },
    { ...q, jitterMs: undefined },
    { ...q, roundTripMs: 60_001 },
    { ...q, packetsLost: 0.1 },
  ])
    assert.equal(validMediaQuality(value), false);
});
