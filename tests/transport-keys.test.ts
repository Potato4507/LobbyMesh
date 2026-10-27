import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  HyperDHTBackend,
  loadTransportKeys,
} from "../packages/public-discovery/src/hyperdht.js";

test("installed HyperDHT derives stable keys from restricted persisted seed; corrupt seed fails closed", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "transport-"));
  try {
    const a = await loadTransportKeys(directory),
      b = await loadTransportKeys(directory);
    assert.deepEqual(a.publicKey, b.publicKey);
    assert.equal(a.publicKey.length, 32);
    const node = new HyperDHTBackend(a, { bootstrap: [] });
    await node.close();
    await writeFile(path.join(directory, "transport-seed-v1"), "corrupt");
    await assert.rejects(loadTransportKeys(directory), /UNSAFE_SEED/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
