import assert from "node:assert/strict";
import test from "node:test";
import {
  InputRegistry,
  validInputOptions,
} from "../packages/voice/src/inputs.js";

const mic = (deviceId: string, label = "Microphone") => ({
  kind: "audioinput",
  deviceId,
  label,
});
function tokens() {
  let next = 0;
  return () => (++next).toString(16).padStart(32, "0");
}
test("device choices hide raw IDs, bound labels and list size, rotate tokens and track selection", async () => {
  const registry = new InputRegistry(
    async () => [
      mic("private-id", "\u0000 \u202e Mic\n"),
      mic("private-id"),
      { ...mic("speaker"), kind: "audiooutput" },
      ...Array.from({ length: 60 }, (_, n) =>
        mic(`hardware-${n}`, "x".repeat(100)),
      ),
    ],
    tokens(),
  );
  const first = await registry.refresh();
  assert.ok(validInputOptions(first));
  assert.equal(first.choices.length, 32);
  assert.equal(first.choices[1]?.label, "Mic");
  assert.equal(first.choices[2]?.label.length, 80);
  assert.ok(!JSON.stringify(first).includes("private-id"));
  const choice = first.choices[1]?.id;
  assert.ok(choice);
  assert.equal(registry.resolve(choice), "private-id");
  registry.select("private-id");
  const second = await registry.refresh();
  assert.notEqual(second.selected, choice);
  assert.throws(() => registry.resolve(choice), /EXPIRED/);
  assert.equal(registry.resolve(second.selected ?? ""), "private-id");
  registry.invalidate();
  assert.throws(() => registry.resolve(second.selected ?? ""), /EXPIRED/);
  assert.equal(registry.resolve("system-default"), undefined);
  registry.close();
  assert.throws(() => registry.resolve("system-default"), /EXPIRED/);
});
test("stalled enumeration stays single-flight and late results cannot revive closed or invalidated choices", async () => {
  let jobs = 0,
    finish: (v: ReturnType<typeof mic>[]) => void = () => {};
  const registry = new InputRegistry(
    () => {
      jobs++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    tokens(),
    10,
  );
  assert.equal((await registry.refresh()).available, false);
  assert.equal((await registry.refresh()).available, false);
  assert.equal(jobs, 1);
  registry.invalidate();
  finish([mic("late")]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const pending = registry.refresh();
  await Promise.resolve();
  registry.close();
  finish([mic("after-close")]);
  assert.equal((await pending).available, false);
  assert.equal(jobs, 2);
});
test("enumeration failure and invalid tokens return bounded unavailable state and revoke old choices", async () => {
  let fail = false;
  const registry = new InputRegistry(
    async () => {
      if (fail) throw new Error("device-specific details");
      return [mic("raw")];
    },
    () => "a".repeat(32),
  );
  const first = await registry.refresh();
  fail = true;
  const failed = await registry.refresh();
  assert.equal(failed.available, false);
  assert.ok(validInputOptions(failed));
  assert.throws(() => registry.resolve(first.choices[1]?.id ?? ""), /EXPIRED/);
  const invalid = new InputRegistry(
    async () => [mic("one"), mic("two")],
    () => "a".repeat(32),
  );
  assert.equal((await invalid.refresh()).available, false);
  for (const value of [
    null,
    {},
    { ...failed, extra: true },
    { ...failed, choices: [{ id: "system-default", label: "bad\n" }] },
    { ...failed, selected: "b".repeat(32) },
  ])
    assert.equal(validInputOptions(value), false);
});

test("closing or invalidating an owner before queued enumeration prevents device access and allows a fresh refresh", async () => {
  for (const closing of [false, true]) {
    let calls = 0;
    const registry = new InputRegistry(async () => {
      calls++;
      return [mic("private-device")];
    }, tokens());
    const pending = registry.refresh();
    if (closing) registry.close();
    else registry.invalidate();
    const result = await pending;
    assert.equal(calls, 0, "a stale owner must not enumerate devices");
    assert.equal(result.available, false);
    assert.ok(validInputOptions(result));
    const fresh = await registry.refresh();
    assert.equal(fresh.available, !closing);
    assert.equal(calls, closing ? 0 : 1);
    registry.close();
  }
});
