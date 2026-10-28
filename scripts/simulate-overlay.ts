import { writeFile } from "node:fs/promises";
import { simulateOverlay } from "../tests/fixtures/overlay-simulation.js";

const results = [];
for (const size of process.argv[3]
  ? process.argv[3].split(",").map(Number)
  : [1, 2, 10, 100, 500]) {
  const result = await simulateOverlay(size);
  results.push(result);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
if (process.argv[2])
  await writeFile(
    process.argv[2],
    `${JSON.stringify({ version: 1, results }, null, 2)}\n`,
    { flag: "wx" },
  );
if (
  results.some(
    (result) =>
      !result.convergedInFixture ||
      result.cleanup.routingEntriesAfterClose !== 0,
  )
)
  process.exitCode = 1;
