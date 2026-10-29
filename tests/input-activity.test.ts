import assert from "node:assert/strict";
import test from "node:test";
import {
  readInputActivity,
  unknownInputActivity,
  validInputActivity,
} from "../packages/voice/src/input-activity.js";
import { validMediaResult } from "../packages/voice/src/media-host-protocol.js";

test("input activity uses a fixed post-gain window, preserves zero and never reads samples while PTT is off", () => {
  let reads = 0;
  const analyser = {
    getFloatTimeDomainData(samples: Float32Array) {
      reads++;
      assert.equal(samples.length, 512);
      samples.fill(0.25);
    },
  };
  assert.deepEqual(readInputActivity(analyser, false), {
    inputLevel: 0,
    inputClipping: false,
  });
  assert.equal(reads, 0);
  assert.deepEqual(readInputActivity(analyser, true), {
    inputLevel: 0.25,
    inputClipping: false,
  });
  assert.equal(reads, 1);
  assert.deepEqual(
    readInputActivity({ getFloatTimeDomainData: (s) => s.fill(0) }, true),
    { inputLevel: 0, inputClipping: false },
  );
  assert.deepEqual(
    readInputActivity({ getFloatTimeDomainData: (s) => s.fill(1.5) }, true),
    { inputLevel: 1, inputClipping: true },
  );
});
test("optional input analysis failures return unknown and cannot export samples or arbitrary errors", () => {
  for (const value of [NaN, Infinity, -Infinity])
    assert.deepEqual(
      readInputActivity({ getFloatTimeDomainData: (s) => s.fill(value) }, true),
      unknownInputActivity(),
    );
  assert.deepEqual(
    readInputActivity(
      {
        getFloatTimeDomainData: () => {
          throw new Error("private device detail");
        },
      },
      true,
    ),
    unknownInputActivity(),
  );
  assert.deepEqual(
    Object.keys(
      readInputActivity({ getFloatTimeDomainData: (s) => s.fill(0.2) }, true),
    ).sort(),
    ["inputClipping", "inputLevel"],
  );
});
test("input status scalars are exact, finite, bounded and consistently nullable", () => {
  const status = {
    phase: "connected",
    capturing: true,
    transmitting: true,
    outputLevel: null,
  };
  for (const input of [
    unknownInputActivity(),
    { inputLevel: 0, inputClipping: false },
    { inputLevel: 1, inputClipping: true },
  ]) {
    assert.equal(validInputActivity(input), true);
    assert.equal(validMediaResult("status", { ...status, ...input }), true);
  }
  for (const input of [
    { inputLevel: NaN, inputClipping: false },
    { inputLevel: 1.01, inputClipping: false },
    { inputLevel: -1, inputClipping: false },
    { inputLevel: null, inputClipping: false },
    { inputLevel: 0, inputClipping: null },
    { inputLevel: "0", inputClipping: false },
    { inputLevel: 0, inputClipping: 1 },
    {},
  ])
    assert.equal(validMediaResult("status", { ...status, ...input }), false);
  assert.equal(
    validMediaResult("status", {
      ...status,
      ...unknownInputActivity(),
      samples: [0.1, 0.2],
    }),
    false,
  );
});
