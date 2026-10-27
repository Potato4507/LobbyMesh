import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createIdentity,
  loadOrCreateIdentity,
  resetIdentity,
  verify,
} from "../packages/identity/src/index.js";

test("Ed25519 rejects tampering and wrong key; no private key enumerable", () => {
  const a = createIdentity(),
    b = createIdentity(),
    data = Buffer.from("domain/v1 hello");
  const signature = a.sign(data);
  assert.ok(verify(a.publicKey, data, signature));
  assert.ok(!verify(b.publicKey, data, signature));
  assert.ok(!verify(a.publicKey, Buffer.from("changed"), signature));
  assert.ok(!verify("invalid", data, signature));
  assert.ok(!JSON.stringify(a).includes("PRIVATE"));
  assert.notEqual(a.peerId, b.peerId);
});
test("identity persists, resets, rejects corrupt and insecure storage", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "companion-"));
  try {
    const a = await loadOrCreateIdentity(dir);
    assert.equal((await loadOrCreateIdentity(dir)).peerId, a.peerId);
    assert.notEqual((await resetIdentity(dir)).peerId, a.peerId);
    const file = path.join(dir, "identity-v1.json");
    if (process.platform !== "win32") {
      assert.equal((await stat(file)).mode & 0o777, 0o600);
      await chmod(file, 0o644);
      await assert.rejects(loadOrCreateIdentity(dir), /UNSAFE_KEY/);
      await chmod(file, 0o600);
    }
    await writeFile(file, '{"version":2}');
    await assert.rejects(loadOrCreateIdentity(dir), /CORRUPT/);
    await writeFile(file, "bad");
    await assert.rejects(loadOrCreateIdentity(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
