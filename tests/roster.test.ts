import assert from "node:assert/strict";
import test from "node:test";
import { ConsentingRoster } from "../packages/roster/src/index.js";

for (const count of [0, 2, 30, 100])
  test(`consenting roster ${count} participants, duplicate names and departures`, () => {
    const roster = new ConsentingRoster();
    for (let i = 0; i < count; i++)
      roster.join({
        peerId: i.toString(16).padStart(64, "0"),
        displayName: "same name",
        identityTrust: "app-key-only",
        consent: true,
      });
    assert.equal(roster.list().length, count);
    for (const peer of roster.list()) {
      roster.leave(peer.peerId);
    }
    assert.equal(roster.list().length, 0);
  });
test("roster blocks non-consent, excess participants, bystander fields and rejoin", () => {
  const roster = new ConsentingRoster(1),
    peer = {
      peerId: "a".repeat(64),
      displayName: "name",
      identityTrust: "app-key-only",
      consent: true,
    } as const;
  assert.throws(() => roster.join({ ...peer, consent: false } as never));
  roster.join({ ...peer, robloxUserId: "bystander" } as never);
  assert.ok(!JSON.stringify(roster.list()).includes("bystander"));
  assert.throws(
    () => roster.join({ ...peer, peerId: "b".repeat(64) }),
    /QUOTA/,
  );
  roster.block(peer.peerId);
  assert.equal(roster.list().length, 0);
  assert.throws(() => roster.join(peer), /BLOCKED/);
});
