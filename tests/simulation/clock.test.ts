import assert from "node:assert/strict";
import test from "node:test";
export class FakeClock {
  now = 0;
  advance(ms: number) {
    if (!Number.isSafeInteger(ms) || ms < 0) throw new Error("INVALID_TIME");
    this.now += ms;
  }
}
test("deterministic simulator clock rejects backwards time", () => {
  const clock = new FakeClock();
  clock.advance(100);
  assert.equal(clock.now, 100);
  assert.throws(() => clock.advance(-1));
});
