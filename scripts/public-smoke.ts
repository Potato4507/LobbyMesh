import {
  HyperDHTBackend,
  loadTransportKeys,
} from "../packages/public-discovery/src/hyperdht.js";
import { PublicDiscovery } from "../packages/public-discovery/src/index.js";

const directory = process.argv[2];
if (!directory)
  throw new Error(
    "Usage: pnpm exec tsx scripts/public-smoke.ts PRIVATE_STATE_DIR",
  );
const keys = await loadTransportKeys(directory);
const backend = new HyperDHTBackend(keys);
const discovery = new PublicDiscovery(backend);
const deadline = setTimeout(() => {
  console.error(
    JSON.stringify({
      state: "TIMEOUT",
      scope: "public-discovery/v1",
      deadlineMs: 15000,
    }),
  );
  void backend.close().finally(() => process.exit(2));
}, 15000);
try {
  await discovery.start();
  await discovery.announceAppEntrypoint();
  let count = 0;
  for await (const _peer of discovery.findAppEntrypoints()) count++;
  console.log(
    JSON.stringify({
      state: "QUERY_FINISHED",
      candidates: count,
      authenticated: false,
    }),
  );
  await discovery.stop();
} catch (error) {
  console.error(
    JSON.stringify({
      state: "FAILED",
      code: error instanceof Error ? error.message : "UNKNOWN",
    }),
  );
  await backend.close();
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
}
