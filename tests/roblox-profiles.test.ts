import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DesktopPairing } from "../apps/desktop/src/pairing.js";
import { RobloxProfiles } from "../apps/desktop/src/roblox-profiles.js";
import { createIdentity } from "../packages/identity/src/index.js";
import {
  createContactCode,
  parseContactCode,
} from "../packages/protocol/src/pairing.js";
import { accountProof } from "../packages/protocol/src/roblox-account.js";

test("Roblox claims are signed with the unique app ID; identical names do not share identity", () => {
  const a = createIdentity(),
    b = createIdentity(),
    claim = { userId: 123, username: "Real_Name" };
  assert.notEqual(a.peerId, b.peerId);
  const code = createContactCode(a, "aa".repeat(32), "Same name", 1000, claim);
  const value = parseContactCode(code, 1000);
  assert.deepEqual(value.roblox, claim);
  for (const patch of [
    { roblox: { ...claim, username: "Impostor" } },
    { roblox: { ...claim, userId: 456 } },
    { roblox: undefined },
    { peerId: b.peerId },
  ]) {
    const forged = `LM1.${Buffer.from(JSON.stringify({ ...value, ...patch })).toString("base64url")}`;
    assert.throws(() => parseContactCode(forged, 1000));
  }
});

test("public-profile proof binds numeric account and full app ID, pins key and persists canonical username", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "lobbymesh-account-"));
  const self = createIdentity(),
    other = createIdentity(),
    impostor = createIdentity();
  const claim = { userId: 123, username: "Real_Name" };
  let description = accountProof(other.peerId, claim.userId);
  const calls: string[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).has("cookie"), false);
    return Response.json(
      url.endsWith("usernames/users")
        ? { data: [{ id: 123, name: "Real_Name" }] }
        : { id: 123, name: "Real_Name", isBanned: false, description },
    );
  };
  try {
    let profiles = await RobloxProfiles.open(directory, self.peerId, request);
    const challenge = await profiles.begin("real_name");
    assert.equal(challenge.username, "Real_Name");
    assert.equal(profiles.view().roblox, null);
    await profiles.check(other.peerId, claim);
    await assert.rejects(
      profiles.check(impostor.peerId, claim),
      /PROOF_MISSING/,
    );
    await assert.rejects(
      profiles.check(other.peerId, { ...claim, username: "real_name" }),
      /PROOF_MISSING/,
    );
    description = accountProof(self.peerId, claim.userId);
    await profiles.confirm(claim);
    assert.equal(profiles.view().roblox?.userId, 123);
    description = accountProof(other.peerId, claim.userId);
    await profiles.remember({
      peerId: other.peerId,
      displayName: "Friend",
      roblox: claim,
      checkedAt: 1000,
    });
    description = accountProof(impostor.peerId, claim.userId);
    await assert.rejects(profiles.check(impostor.peerId, claim), /KEY_CHANGED/);
    await assert.rejects(
      profiles.remember({
        peerId: other.peerId,
        displayName: "Spoof",
        roblox: null,
        checkedAt: null,
      }),
      /DOWNGRADE/,
    );
    await profiles.close();
    profiles = await RobloxProfiles.open(directory, self.peerId, request);
    assert.equal(profiles.contact(other.peerId)?.displayName, "Friend");
    assert.equal(profiles.view().roblox?.username, "Real_Name");
    await assert.rejects(profiles.check(impostor.peerId, claim), /KEY_CHANGED/);
    assert.ok(
      calls.every((url) => url.startsWith("https://users.roblox.com/v1/")),
    );
    await profiles.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("forged account ownership cannot grant permission, even via unverified preview or lost proof after review", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "lobbymesh-account-pair-"),
  );
  const self = createIdentity(),
    friend = createIdentity(),
    attacker = createIdentity();
  const claim = { userId: 123, username: "Real_Name" };
  let description = accountProof(friend.peerId, claim.userId),
    saves = 0,
    auth = 0,
    authorized = false;
  const request: typeof fetch = async () =>
    Response.json({ id: 123, name: "Real_Name", isBanned: false, description });
  try {
    const profiles = await RobloxProfiles.open(directory, self.peerId, request);
    const pairing = new DesktopPairing(
      self,
      "aa".repeat(32),
      { authorized: () => authorized, blocked: () => false, allowed: () => [] },
      async () => {
        auth++;
      },
      () => "Self",
      undefined,
      { profiles },
    );
    const forged = createContactCode(
      attacker,
      "bb".repeat(32),
      "Friend",
      Date.now(),
      claim,
    );
    await assert.rejects(pairing.review(forged), /PROOF_MISSING/);
    const unchecked = pairing.preview(forged);
    await assert.rejects(
      pairing.approve(unchecked.ticket, async () => {
        saves++;
      }),
      /PROOF_MISSING/,
    );
    assert.equal(auth, 0);
    assert.equal(saves, 0);
    const reviewed = await pairing.review(
      createContactCode(friend, "cc".repeat(32), "Friend", Date.now(), claim),
    );
    assert.ok(reviewed.profileCheckedAt);
    description = "Proof removed";
    await assert.rejects(
      pairing.approve(reviewed.ticket, async () => {
        saves++;
      }),
      /PROOF_MISSING/,
    );
    assert.equal(auth, 0);
    assert.equal(saves, 0);
    description = accountProof(friend.peerId, claim.userId);
    const legitimate = await pairing.review(
      createContactCode(friend, "cc".repeat(32), "Friend", Date.now(), claim),
    );
    await pairing.approve(legitimate.ticket, async () => {
      saves++;
      authorized = true;
    });
    assert.equal(auth, 1);
    assert.equal(saves, 1);
    assert.equal(profiles.contact(friend.peerId)?.roblox?.userId, 123);
    description = accountProof(attacker.peerId, claim.userId);
    await assert.rejects(pairing.review(forged), /KEY_CHANGED/);
    await pairing.close();
    await profiles.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unavailable, oversized, banned and canceled Roblox checks fail closed", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "lobbymesh-account-deny-"),
  );
  const self = createIdentity(),
    claim = { userId: 123, username: "Real_Name" };
  try {
    for (const request of [
      async () => new Response("unavailable", { status: 503 }),
      async () => new Response("x".repeat(16385)),
      async () =>
        Response.json({
          id: 123,
          name: "Real_Name",
          isBanned: true,
          description: accountProof(self.peerId, 123),
        }),
    ]) {
      const profiles = await RobloxProfiles.open(
        directory,
        self.peerId,
        request,
      );
      await assert.rejects(profiles.confirm(claim));
      assert.equal(profiles.view().roblox, null);
      await profiles.close();
    }
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const profiles = await RobloxProfiles.open(
      directory,
      self.peerId,
      async () => {
        await held;
        return Response.json({
          id: 123,
          name: "Real_Name",
          isBanned: false,
          description: accountProof(self.peerId, 123),
        });
      },
    );
    const confirmation = profiles.confirm(claim);
    await profiles.close();
    release();
    await assert.rejects(confirmation, /CLOSED/);
    assert.equal(profiles.view().roblox, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
