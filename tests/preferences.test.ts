import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  defaultPreferences,
  parsePreferencePatch,
  parsePreferences,
} from "../packages/protocol/src/preferences.js";
import { PreferenceStore } from "../packages/security/src/preferences.js";

const peer = "a".repeat(64);
test("preferences default to offline/no-consent, persist atomic serialized changes and block overrides allow", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "lobbymesh-preferences-"),
  );
  let store: PreferenceStore | undefined;
  try {
    store = await PreferenceStore.open(directory);
    assert.deepEqual(store.snapshot(), defaultPreferences());
    await assert.rejects(
      PreferenceStore.open(directory),
      (error: NodeJS.ErrnoException) => error.code === "EEXIST",
    );
    await Promise.all([
      store.update({ displayName: "Local name" }),
      store.update({ sessionConsent: true }),
    ]);
    assert.equal(store.snapshot().displayName, "Local name");
    assert.equal(store.snapshot().sessionConsent, true);
    await store.allow(peer);
    assert.ok(store.isAuthorized(peer));
    await store.block(peer);
    assert.equal(store.isAuthorized(peer), false);
    assert.ok(store.isBlocked(peer));
    await assert.rejects(store.allow(peer), /PEER_BLOCKED/);
    await store.unblock(peer);
    assert.equal(store.isAuthorized(peer), false);
    await store.allow(peer);
    const snapshot = store.snapshot();
    snapshot.allowedPeers.splice(0);
    assert.ok(store.isAuthorized(peer));
    await store.close();
    assert.equal(store.isAuthorized(peer), false);
    await assert.rejects(
      store.update({ networkEnabled: true }),
      /PREFERENCES_CLOSED/,
    );
    store = await PreferenceStore.open(directory);
    assert.equal(store.snapshot().displayName, "Local name");
    assert.ok(store.isAuthorized(peer));
    const onDisk = JSON.parse(
      await readFile(path.join(directory, "preferences-v1.json"), "utf8"),
    );
    assert.equal(onDisk.sessionConsent, true);
    assert.equal(onDisk.networkEnabled, false);
    assert.equal(onDisk.voiceMode, "off");
    assert.ok(
      !(await readdir(directory)).some((name) => name.endsWith(".tmp")),
    );
  } finally {
    await store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test("corrupt/future settings fail closed without replacement and release only the acquired lock", async () => {
  const directory = await mkdtemp(
      path.join(tmpdir(), "lobbymesh-preferences-"),
    ),
    filename = path.join(directory, "preferences-v1.json");
  try {
    for (const content of [
      "corrupt",
      JSON.stringify({ ...defaultPreferences(), version: 2 }),
    ]) {
      await writeFile(filename, content, { mode: 0o600 });
      await assert.rejects(PreferenceStore.open(directory));
      assert.equal(await readFile(filename, "utf8"), content);
      assert.ok(!(await readdir(directory)).includes("preferences.lock"));
    }
    const normalized = parsePreferences({
      ...defaultPreferences(),
      allowedPeers: [peer],
      blockedPeers: [peer],
    });
    assert.deepEqual(normalized.allowedPeers, []);
    assert.deepEqual(normalized.blockedPeers, [peer]);
    for (const invalid of [
      { networkEnabled: "true" },
      { unexpected: true },
      { displayName: "bad\0name" },
      { voiceMode: "always-on" },
      [],
    ])
      assert.throws(() => parsePreferencePatch(invalid));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("failed atomic replacement leaves snapshot unchanged and cleans temporary files", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "lobbymesh-preferences-"),
  );
  const store = await PreferenceStore.open(directory),
    destination = path.join(directory, "preferences-v1.json");
  try {
    await mkdir(destination);
    await assert.rejects(store.update({ networkEnabled: true }));
    assert.equal(store.snapshot().networkEnabled, false);
    assert.ok(
      !(await readdir(directory)).some((name) => name.endsWith(".tmp")),
    );
    await rm(destination, { recursive: true });
    await store.update({ displayName: "recovered after storage failure" });
    assert.equal(
      store.snapshot().displayName,
      "recovered after storage failure",
    );
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("block takes effect before storage completes and remains denied after a disk failure", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "lobbymesh-preferences-"),
  );
  const store = await PreferenceStore.open(directory),
    destination = path.join(directory, "preferences-v1.json");
  try {
    await store.allow(peer);
    assert.ok(store.isAuthorized(peer));
    await rm(destination);
    await mkdir(destination);
    const blocking = store.block(peer);
    assert.ok(store.isBlocked(peer));
    assert.equal(store.isAuthorized(peer), false);
    await assert.rejects(blocking);
    assert.ok(store.isBlocked(peer));
    assert.equal(store.isAuthorized(peer), false);
    await assert.rejects(store.allow(peer), /PEER_BLOCKED/);
    await rm(destination, { recursive: true });
    await store.unblock(peer);
    assert.equal(store.isAuthorized(peer), false);
    await store.allow(peer);
    assert.ok(store.isAuthorized(peer));
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
