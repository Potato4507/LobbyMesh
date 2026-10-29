import { readFile } from "node:fs/promises";
import { inspectLabHost, labSshTarget } from "./lab/doctor.js";

try {
  const target = labSshTarget(process.argv.slice(2));
  const script = await readFile(
    new URL("../labs/pi/host-facts.sh", import.meta.url),
    "utf8",
  );
  const facts = await inspectLabHost(target, script);
  console.log(
    JSON.stringify({
      scenario: "pi-read-only-inventory",
      result: "inventory-read",
      facts,
      topologyVerified: false,
      nativeDependenciesVerified: false,
      privilegeAuthorized: false,
    }),
  );
} catch (error) {
  const reason =
    error instanceof Error &&
    [
      "INVALID_LAB_DOCTOR_OPTIONS",
      "LAB_HOST_UNAVAILABLE",
      "LAB_HOST_FACTS_REJECTED",
    ].includes(error.message)
      ? error.message
      : "LAB_FACTS_SCRIPT_UNAVAILABLE";
  console.log(
    JSON.stringify({
      scenario: "pi-read-only-inventory",
      result: "BLOCKED_EXTERNAL",
      reason,
      topologyVerified: false,
    }),
  );
  process.exitCode = 1;
}
