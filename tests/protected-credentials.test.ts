import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  loadOrCreateIdentity,
  resetIdentity,
  verify,
} from "../packages/identity/src/index.js";
import { loadTransportKeys } from "../packages/public-discovery/src/hyperdht.js";
import type { SecretProtection } from "../packages/security/src/protected-file.js";

// Serialization/fault fixture only; this codec is deliberately NOT encryption.
function codec() {
  let generation = 0;
  const protection: SecretProtection = {
    available: async () => true,
    seal: async (value) =>
      Buffer.from(`TEST${generation}:${Buffer.from(value).toString("base64")}`),
    open: async (value) => {
      const match = /^TEST([0-9]+):(.+)$/.exec(value.toString());
      if (!match?.[1] || !match[2]) throw new Error("invalid test fixture");
      return {
        plaintext: Buffer.from(match[2], "base64").toString(),
        rotate: Number(match[1]) !== generation,
      };
    },
  };
  return {
    protection,
    rotate() {
      generation++;
    },
  };
}
test("concurrent protected creators never overwrite the winning identity", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "lobbymesh-protected-")),
    fixture = codec();
  let arrivals = 0,
    release: () => void = () => {};
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const protection: SecretProtection = {
    ...fixture.protection,
    seal: async (value) => {
      if (++arrivals === 2) release();
      await barrier;
      return fixture.protection.seal(value);
    },
  };
  try {
    const outcomes = await Promise.allSettled([
      loadOrCreateIdentity(directory, protection),
      loadOrCreateIdentity(directory, protection),
    ]);
    const successes = outcomes.filter(
      (outcome) => outcome.status === "fulfilled",
    );
    assert.equal(successes.length, 1);
    const winner = successes[0];
    assert.ok(winner?.status === "fulfilled");
    const loser = outcomes.find((outcome) => outcome.status === "rejected");
    assert.ok(loser?.status === "rejected");
    assert.equal(loser.reason.code, "EEXIST");
    assert.equal(
      (await loadOrCreateIdentity(directory, protection)).peerId,
      winner.value.peerId,
    );
    assert.deepEqual(await readdir(directory), ["identity-os-v1.bin"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("protected credential fresh load/reopen and legacy migration retain app and transport identity", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "lobbymesh-protected-")),
    fixture = codec();
  try {
    const identityDir = path.join(directory, "identity"),
      transportDir = path.join(directory, "transport");
    const original = await loadOrCreateIdentity(identityDir),
      keys = await loadTransportKeys(transportDir);
    const oldSeed = await readFile(
      path.join(transportDir, "transport-seed-v1"),
    );
    const migrated = await loadOrCreateIdentity(
        identityDir,
        fixture.protection,
      ),
      migratedKeys = await loadTransportKeys(transportDir, fixture.protection);
    assert.equal(migrated.peerId, original.peerId);
    assert.deepEqual(migratedKeys.publicKey, keys.publicKey);
    assert.ok(
      verify(
        original.publicKey,
        Buffer.from("migration"),
        migrated.sign(Buffer.from("migration")),
      ),
    );
    assert.equal(
      JSON.parse(
        await readFile(path.join(identityDir, "identity-v1.json"), "utf8"),
      ).storage,
      "os-protected",
    );
    assert.equal(
      JSON.parse(
        await readFile(path.join(transportDir, "transport-seed-v1"), "utf8"),
      ).storage,
      "os-protected",
    );
    assert.equal(
      (await readFile(path.join(transportDir, "transport-seed-v1"))).equals(
        oldSeed,
      ),
      false,
    );
    assert.equal(
      (await loadOrCreateIdentity(identityDir, fixture.protection)).peerId,
      original.peerId,
    );
    assert.deepEqual(
      (await loadTransportKeys(transportDir, fixture.protection)).publicKey,
      keys.publicKey,
    );
    await assert.rejects(
      loadOrCreateIdentity(identityDir),
      /OS_PROTECTION_REQUIRED/,
    );
    await assert.rejects(
      loadTransportKeys(transportDir),
      /OS_PROTECTION_REQUIRED/,
    );
    await assert.rejects(resetIdentity(identityDir), /OS_PROTECTION_REQUIRED/);
    const fresh = path.join(directory, "fresh");
    const created = await loadOrCreateIdentity(fresh, fixture.protection);
    assert.equal(
      (await loadOrCreateIdentity(fresh, fixture.protection)).peerId,
      created.peerId,
    );
    assert.deepEqual(await readdir(fresh), ["identity-os-v1.bin"]);
    oldSeed.fill(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("unavailable protection and failed encryption never replace legacy plaintext or regenerate keys", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "lobbymesh-protected-")),
    fixture = codec();
  try {
    const original = await loadOrCreateIdentity(directory),
      filename = path.join(directory, "identity-v1.json"),
      before = await readFile(filename);
    await assert.rejects(
      loadOrCreateIdentity(directory, {
        ...fixture.protection,
        available: async () => false,
      }),
      /CREDENTIAL_PROTECTION_UNAVAILABLE/,
    );
    await assert.rejects(
      loadOrCreateIdentity(directory, {
        ...fixture.protection,
        seal: async () => {
          throw new Error("must not expose plaintext");
        },
      }),
      /^Error: CREDENTIAL_ENCRYPT_FAILED$/,
    );
    assert.deepEqual(await readFile(filename), before);
    assert.equal(
      (await loadOrCreateIdentity(directory)).peerId,
      original.peerId,
    );
    assert.deepEqual(await readdir(directory), ["identity-v1.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("conflicting or corrupt sealed data fails closed; verified pre-marker interruption rolls forward", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "lobbymesh-protected-")),
    fixture = codec();
  try {
    const original = await loadOrCreateIdentity(directory),
      legacy = await readFile(path.join(directory, "identity-v1.json")),
      sealed = path.join(directory, "identity-os-v1.bin");
    await writeFile(sealed, "corrupt", { mode: 0o600 });
    await assert.rejects(
      loadOrCreateIdentity(directory, fixture.protection),
      /CREDENTIAL_DECRYPT_FAILED/,
    );
    assert.deepEqual(
      await readFile(path.join(directory, "identity-v1.json")),
      legacy,
    );
    const otherDirectory = path.join(directory, "other");
    await loadOrCreateIdentity(otherDirectory);
    const other = await readFile(
      path.join(otherDirectory, "identity-v1.json"),
      "utf8",
    );
    await writeFile(sealed, await fixture.protection.seal(other));
    await assert.rejects(
      loadOrCreateIdentity(directory, fixture.protection),
      /CREDENTIAL_CONFLICT/,
    );
    assert.deepEqual(
      await readFile(path.join(directory, "identity-v1.json")),
      legacy,
    );
    // Simulate a flushed sealed write before the legacy retirement step.
    await writeFile(sealed, await fixture.protection.seal(legacy.toString()));
    assert.equal(
      (await loadOrCreateIdentity(directory, fixture.protection)).peerId,
      original.peerId,
    );
    assert.equal(
      JSON.parse(
        await readFile(path.join(directory, "identity-v1.json"), "utf8"),
      ).version,
      2,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("key-provider rotation reseals without changing identity and missing sealed state never resets", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "lobbymesh-protected-")),
    fixture = codec();
  try {
    const identity = await loadOrCreateIdentity(directory, fixture.protection),
      filename = path.join(directory, "identity-os-v1.bin"),
      old = await readFile(filename);
    fixture.rotate();
    assert.equal(
      (await loadOrCreateIdentity(directory, fixture.protection)).peerId,
      identity.peerId,
    );
    assert.equal((await readFile(filename)).equals(old), false);
    await writeFile(
      path.join(directory, "identity-v1.json"),
      JSON.stringify({
        version: 2,
        storage: "os-protected",
        file: "identity-os-v1.bin",
      }),
      { mode: 0o600 },
    );
    await rm(filename);
    await assert.rejects(
      loadOrCreateIdentity(directory, fixture.protection),
      /CREDENTIAL_SEALED_FILE_MISSING/,
    );
    assert.deepEqual(await readdir(directory), ["identity-v1.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
