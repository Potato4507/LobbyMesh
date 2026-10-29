import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import {
  collectLabFacts,
  labHostFacts,
  labSshTarget,
} from "../scripts/lab/doctor.js";

const facts = `Kernel: Linux 6.12.0-v8+
Architecture: aarch64
OS: Debian GNU/Linux 13 (trixie)
Model: Raspberry Pi 5 Model B
Memory: 7936 MiB
ip: present
nft: present
tc: present
node: v24.22.1
pnpm: 11.25.0
Net namespaces supported: yes
`;
test("Pi doctor requires an explicit safe SSH target and never accepts remote commands", () => {
  assert.equal(
    labSshTarget(["--ssh-target", "lab-user@authorized-alias"]),
    "lab-user@authorized-alias",
  );
  for (const args of [
    [],
    ["--ssh-target", "-oProxyCommand=bad"],
    ["--ssh-target", "host\ncommand"],
    ["--ssh-target", "host;command"],
    ["--ssh-target", "host", "--install", "yes"],
  ])
    assert.throws(() => labSshTarget(args), /INVALID_LAB_DOCTOR_OPTIONS/);
});
test("Pi facts project only bounded normalized capabilities without device strings or endpoints", () => {
  const result = labHostFacts(facts);
  assert.equal(result.pinnedToolchain, true);
  assert.equal(result.namespaceTools, true);
  assert.equal(result.memoryMiB, 7936);
  assert.equal(result.modelClass, "raspberry-pi");
  const absent = labHostFacts(
    facts
      .replace("node: v24.22.1", "node: missing")
      .replace("nft: present", "nft: missing"),
  );
  assert.equal(absent.pinnedToolchain, false);
  assert.equal(absent.namespaceTools, false);
  const privateText = "private-device-identifying-text";
  const projected = labHostFacts(
    facts
      .replace("Raspberry Pi 5 Model B", privateText)
      .replace("Debian GNU/Linux 13 (trixie)", privateText),
  );
  assert.equal(JSON.stringify(projected).includes(privateText), false);
  assert.equal(projected.modelClass, "unclassified");
});
test("Pi inventory fails closed on malformed, ambiguous or oversize SSH output", () => {
  for (const output of [
    "",
    `${facts}node: v24.22.1\n`,
    facts.replace("node: v24.22.1", "node: $(private command)"),
    facts.replace("nft: present", "nft: maybe"),
    facts.replace("Architecture: aarch64", "Architecture: unknown"),
    facts.replace("Memory: 7936 MiB", "Memory: Infinity MiB"),
    facts.replace(
      "Net namespaces supported: yes",
      "Net namespaces supported: maybe",
    ),
    facts + "x".repeat(8192),
  ])
    assert.throws(() => labHostFacts(output), /INVALID_LAB_FACTS/);
});

function worker(source: string) {
  return spawn(process.execPath, ["-e", source], {
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
}
test("Pi doctor waits for clean exit before accepting bounded inventory and sends LF script", async () => {
  const child = worker(
    `let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{if(input!=='read-only\\n')process.exit(2);process.stdout.write(${JSON.stringify(facts)})});`,
  );
  const result = await collectLabFacts(child, "read-only\r\n");
  assert.equal(result.pinnedToolchain, true);
  const failed = worker(
    `process.stdout.write(${JSON.stringify(facts)});process.exitCode=1;process.stdin.resume();`,
  );
  await assert.rejects(collectLabFacts(failed, ""), /LAB_HOST_UNAVAILABLE/);
});
test(
  "Pi doctor kills oversized or stalled owned inspection and rejects malformed output",
  { timeout: 5000 },
  async () => {
    for (const source of [
      "process.stdout.write('x'.repeat(9000));setInterval(()=>{},1000)",
      "setInterval(()=>{},1000)",
    ]) {
      await assert.rejects(
        collectLabFacts(worker(source), "", 200),
        /LAB_HOST_UNAVAILABLE/,
      );
    }
    await assert.rejects(
      collectLabFacts(
        worker(
          "process.stdout.write('private unknown text');process.stdin.resume()",
        ),
        "",
      ),
      /LAB_HOST_FACTS_REJECTED/,
    );
  },
);
test("Pi doctor spawn failure settles with a redacted classification", async () => {
  const child = spawn(`lobbymesh-nonexistent-doctor-${process.pid}`, [], {
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
  await assert.rejects(collectLabFacts(child, ""), /LAB_HOST_UNAVAILABLE/);
});
