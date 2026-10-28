import assert from "node:assert/strict";
import { mkdirSync, renameSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { DesktopPairing } from "../apps/desktop/src/pairing.js";
import { createIdentity } from "../packages/identity/src/index.js";
import {
  createContactCode,
  parseContactCode,
} from "../packages/protocol/src/pairing.js";
import { PreferenceStore } from "../packages/security/src/preferences.js";

test("contact codes bind app identity, transport, chosen name and expiry with strict bounded decoding", () => {
  const identity = createIdentity(),
    now = 100_000;
  const code = createContactCode(
    identity,
    "ab".repeat(32),
    "Contact <script>",
    now,
  );
  const value = parseContactCode(` ${code}\n`, now);
  assert.equal(value.peerId, identity.peerId);
  assert.equal(value.displayName, "Contact <script>");
  assert.throws(() => parseContactCode(code, value.expiresAt));
  assert.throws(() => parseContactCode(code, now - 5_001));
  assert.throws(() => parseContactCode("x".repeat(4097), now));
  assert.throws(() => parseContactCode(`${code}=`, now));
  for (const patch of [
    { peerId: "00".repeat(32) },
    { transportKey: "cd".repeat(32) },
    { displayName: "Changed" },
    { signature: "00".repeat(64) },
    { nonce: "00".repeat(16) },
    { expiresAt: now + 120_001 },
    { version: 2 },
    { extra: true },
  ]) {
    const forged = `LM1.${Buffer.from(JSON.stringify({ ...value, ...patch })).toString("base64url")}`;
    assert.throws(() => parseContactCode(forged, now));
  }
  assert.throws(() =>
    createContactCode(identity, "ab".repeat(32), "name\ncontrol", now),
  );
  assert.throws(() => createContactCode(identity, "bad", "name", now));
});

test("preview is offline and grants nothing; authenticated approval persists only one local side and tickets are single use", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "lobbymesh-pair-policy-"),
  );
  let store: PreferenceStore | undefined;
  const self = createIdentity(),
    other = createIdentity();
  let auth = 0,
    confirmed = 0;
  try {
    store = await PreferenceStore.open(directory);
    const policy = store;
    const pairing = new DesktopPairing(
      self,
      "aa".repeat(32),
      {
        authorized: policy.isAuthorized,
        blocked: policy.isBlocked,
        allowed: () => policy.snapshot().allowedPeers,
      },
      async (contact) => {
        auth++;
        assert.equal(contact.id, other.peerId);
        assert.equal(policy.isAuthorized(other.peerId), false);
      },
      () => "Self",
      () => {
        confirmed++;
      },
    );
    const own = pairing.create();
    assert.throws(() => pairing.preview(own.code), /SELF/);
    const preview = pairing.preview(
      createContactCode(other, "bb".repeat(32), "Other"),
    );
    assert.equal(auth, 0);
    assert.equal(policy.isAuthorized(other.peerId), false);
    assert.equal(preview.identityTrust, "app-key-only");
    assert.equal(JSON.stringify(preview).includes("transportKey"), false);
    preview.displayName = "tampered renderer projection";
    await pairing.approve(preview.ticket, (id, guard) =>
      policy.allow(id, guard),
    );
    assert.equal(auth, 1);
    assert.equal(confirmed, 1);
    assert.equal(policy.isAuthorized(other.peerId), true);
    await assert.rejects(
      pairing.approve(preview.ticket, (id) => policy.allow(id)),
      /EXPIRED/,
    );
    pairing.close();
    await store.close();
    store = await PreferenceStore.open(directory);
    assert.equal(store.isAuthorized(other.peerId), true);
  } finally {
    await store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("blocked, failed, expired, canceled and late authentication cannot grant contact permission", async () => {
  const self = createIdentity(),
    other = createIdentity();
  for (const mode of [
    "failure",
    "cancel",
    "close",
    "policy",
    "expired",
    "timeout",
  ] as const) {
    let now = 10_000,
      saves = 0,
      release: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pairing = new DesktopPairing(
      self,
      "aa".repeat(32),
      { authorized: () => false, blocked: () => false, allowed: () => [] },
      async () => {
        if (mode === "failure") throw new Error("identity mismatch");
        await pending;
      },
      () => "Self",
      undefined,
      { now: () => now, timeoutMs: 30 },
    );
    const preview = pairing.preview(
      createContactCode(other, "bb".repeat(32), "Other", now),
    );
    const approval = pairing.approve(preview.ticket, async () => {
      saves++;
    });
    const rejected = assert.rejects(approval);
    await setImmediate();
    if (mode === "cancel") pairing.cancel(preview.ticket);
    if (mode === "close") pairing.close();
    if (mode === "policy") pairing.policyChanged();
    if (mode === "expired") now += 120_000;
    if (mode !== "timeout") release();
    await rejected;
    release();
    await setImmediate();
    assert.equal(saves, 0, mode);
    pairing.close();
  }
  const blocked = new DesktopPairing(
    self,
    "aa".repeat(32),
    { authorized: () => false, blocked: () => true, allowed: () => [] },
    async () => {},
    () => "Self",
  );
  assert.throws(
    () => blocked.preview(createContactCode(other, "bb".repeat(32), "Other")),
    /BLOCKED/,
  );
  blocked.close();
});

test("preview and in-flight approval quotas are bounded and cancellation releases the operation", async () => {
  const self = createIdentity(),
    other = createIdentity();
  const pairing = new DesktopPairing(
    self,
    "aa".repeat(32),
    { authorized: () => false, blocked: () => false, allowed: () => [] },
    async () => new Promise(() => {}),
    () => "Self",
  );
  const code = createContactCode(other, "bb".repeat(32), "Other");
  const previews = Array.from({ length: 8 }, () => pairing.preview(code));
  assert.throws(() => pairing.preview(code), /QUOTA/);
  const first = previews[0],
    second = previews[1];
  assert.ok(first && second);
  const approval = pairing.approve(first.ticket, async () => {});
  const rejected = assert.rejects(approval, /CANCELED/);
  await assert.rejects(
    pairing.approve(second.ticket, async () => {}),
    /BUSY/,
  );
  pairing.cancel(first.ticket);
  await rejected;
  pairing.close();
});

test("revocation queued during a fresh grant denies immediately, and a canceled committed grant is compensated before returning", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "lobbymesh-pair-race-"));
  let store: PreferenceStore | undefined;
  const peer = "ab".repeat(32);
  try {
    store = await PreferenceStore.open(directory);
    const policy = store;
    const grant = policy.allow(peer),
      revoke = policy.revoke(peer);
    await grant;
    assert.equal(policy.isAuthorized(peer), false);
    await revoke;
    await assert.rejects(
      policy.allow(peer, () => {
        throw new Error("guard unavailable");
      }),
      /APPROVAL_CANCELED/,
    );
    await assert.rejects(
      policy.allow(peer, () => !policy.snapshot().allowedPeers.includes(peer)),
      /APPROVAL_CANCELED/,
    );
    assert.equal(policy.isAuthorized(peer), false);
    assert.deepEqual(policy.snapshot().allowedPeers, []);
    await policy.close();
    store = await PreferenceStore.open(directory);
    assert.deepEqual(store.snapshot().allowedPeers, []);
  } finally {
    await store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an older unblock cannot clear the immediate denial of a newer block", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "lobbymesh-pair-block-order-"),
  );
  const policy = await PreferenceStore.open(directory),
    peer = "cd".repeat(32);
  try {
    await policy.block(peer);
    const unblocking = policy.unblock(peer),
      blocking = policy.block(peer);
    await unblocking;
    assert.equal(policy.isBlocked(peer), true);
    await blocking;
    assert.equal(policy.isBlocked(peer), true);
    await policy.unblock(peer);
    assert.equal(policy.isBlocked(peer), false);
    assert.equal(policy.isAuthorized(peer), false);
  } finally {
    await policy.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("pairing shutdown waits for an owned save to settle before releasing persistent policy", async () => {
  const self = createIdentity(),
    other = createIdentity();
  let saveStarted = false,
    release: () => void = () => {};
  const saving = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pairing = new DesktopPairing(
    self,
    "aa".repeat(32),
    { authorized: () => false, blocked: () => false, allowed: () => [] },
    async () => {},
    () => "Self",
  );
  const preview = pairing.preview(
    createContactCode(other, "bb".repeat(32), "Other"),
  );
  const approval = pairing.approve(preview.ticket, async () => {
    saveStarted = true;
    await saving;
  });
  const rejected = assert.rejects(approval, /CANCELED/);
  await setImmediate();
  assert.equal(saveStarted, true);
  let stopped = false;
  const closing = pairing.close().then(() => {
    stopped = true;
  });
  await setImmediate();
  assert.equal(stopped, false);
  release();
  await rejected;
  await closing;
  assert.equal(stopped, true);
});

test("failed compensating revoke stays denied and explicitly reports that rollback was not persisted", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "lobbymesh-pair-rollback-fault-"),
  );
  const policy = await PreferenceStore.open(directory),
    peer = "ef".repeat(32);
  let faulted = false;
  try {
    await assert.rejects(
      policy.allow(peer, () => {
        if (!policy.snapshot().allowedPeers.includes(peer)) return true;
        if (!faulted) {
          faulted = true;
          renameSync(
            path.join(directory, "preferences-v1.json"),
            path.join(directory, "committed-before-fault.json"),
          );
          mkdirSync(path.join(directory, "preferences-v1.json"));
        }
        return false;
      }),
      /ROLLBACK_FAILED/,
    );
    assert.equal(policy.isAuthorized(peer), false);
    assert.deepEqual(policy.snapshot().allowedPeers, [peer]);
  } finally {
    await policy.close();
    await rm(directory, { recursive: true, force: true });
  }
});
