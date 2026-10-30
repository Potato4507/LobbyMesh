import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { labDoctorOptions } from "../scripts/lab/doctor.js";
import { parseLabPairOptions } from "../scripts/lab/pair-options.js";
import {
  type LabRemote,
  labRemoteArguments,
  labSshArguments,
} from "../scripts/lab/ssh.js";

const execute = promisify(execFile),
  target = "lab-user@host.invalid";
test("SSH defaults retain batch, strict host verification and fixed connect bounds", () => {
  assert.deepEqual(labSshArguments(target, ["bash", "-s"]), [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ConnectTimeout=5",
    target,
    "bash",
    "-s",
  ]);
  const env = {
    SSH_ASKPASS: "/private/secure-provider",
    SSH_ASKPASS_REQUIRE: "force",
    PASSWORD: "must-never-enter-arguments",
  };
  const args = labSshArguments(target, ["bash", "-s"], "askpass", env);
  for (const option of [
    "BatchMode=no",
    "StrictHostKeyChecking=yes",
    "ConnectTimeout=5",
    "NumberOfPasswordPrompts=1",
    "PreferredAuthentications=password",
    "PubkeyAuthentication=no",
  ])
    assert.ok(args.includes(option));
  assert.equal(JSON.stringify(args).includes(env.SSH_ASKPASS), false);
  assert.equal(JSON.stringify(args).includes(env.PASSWORD), false);
  for (const environment of [
    {},
    { SSH_ASKPASS: "provider" },
    { SSH_ASKPASS: "provider", SSH_ASKPASS_REQUIRE: "prefer" },
    { SSH_ASKPASS: "bad\nprovider", SSH_ASKPASS_REQUIRE: "force" },
  ])
    assert.throws(
      () => labSshArguments(target, [], "askpass", environment),
      /LAB_ASKPASS_REQUIRED/,
    );
});
test("remote launch allows only explicit source or bundled entry points and rejects unsafe fields", () => {
  assert.ok(
    labRemoteArguments({ target, root: "/lab" }, ["--duration-ms", "10000"])
      .at(-1)
      ?.includes("node --import tsx scripts/lab-peer.ts"),
  );
  assert.ok(
    labRemoteArguments({ target, root: "/lab", layout: "bundle" }, [])
      .at(-1)
      ?.includes("./runtime/bin/node lab-peer.mjs"),
  );
  for (const patch of [
    { target: "-oProxyCommand=bad" },
    { root: "bad\ncommand" },
    { root: "" },
    { layout: "shell" },
    { auth: "password-in-args" },
  ])
    assert.throws(
      () =>
        labRemoteArguments({ target, root: "/lab", ...patch } as LabRemote, []),
      /INVALID_LAB_REMOTE/,
    );
  assert.throws(
    () => labRemoteArguments({ target, root: "/lab" }, ["bad\0arg"]),
    /INVALID_LAB_REMOTE/,
  );
});
test("pair and doctor options explicitly select askpass/bundle without enabling it for local peers", () => {
  const args = ["--bootstrap", "127.0.0.1:1234"];
  const defaults = parseLabPairOptions(args);
  assert.equal(defaults.auth, "batch");
  assert.equal(defaults.layout, "source");
  const options = parseLabPairOptions([
    ...args,
    "--ssh-target",
    target,
    "--remote-root",
    "/lab",
    "--remote-layout",
    "bundle",
    "--ssh-auth",
    "askpass",
  ]);
  assert.equal(options.layout, "bundle");
  assert.equal(options.auth, "askpass");
  assert.deepEqual(
    labDoctorOptions(["--ssh-auth", "askpass", "--ssh-target", target]),
    { target, auth: "askpass" },
  );
  for (const tail of [
    ["--remote-layout", "bundle"],
    ["--ssh-auth", "askpass"],
    [
      "--ssh-target",
      target,
      "--remote-root",
      "/lab",
      "--remote-layout",
      "arbitrary",
    ],
  ])
    assert.throws(
      () => parseLabPairOptions([...args, ...tail]),
      /INVALID_LAB_PAIR_OPTIONS/,
    );
  for (const bad of [
    ["--ssh-auth", "askpass"],
    ["--ssh-target", target, "--ssh-auth", "password"],
    ["--ssh-target", target, "--ssh-auth", "askpass", "--ssh-auth", "batch"],
  ])
    assert.throws(() => labDoctorOptions(bad), /INVALID_LAB_DOCTOR_OPTIONS/);
});
test("missing askpass provider fails pair preflight without starting a peer or leaking environment", async () => {
  const env = { ...process.env };
  delete env.SSH_ASKPASS;
  delete env.SSH_ASKPASS_REQUIRE;
  await assert.rejects(
    execute(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/lab-pair.ts",
        "--bootstrap",
        "127.0.0.1:1234",
        "--ssh-target",
        target,
        "--remote-root",
        "/lab",
        "--remote-layout",
        "bundle",
        "--ssh-auth",
        "askpass",
      ],
      { env, timeout: 5000, maxBuffer: 16384 },
    ),
    (error: unknown) => {
      assert.ok(
        error instanceof Error &&
          "stdout" in error &&
          typeof error.stdout === "string",
      );
      const result = JSON.parse(error.stdout.trim());
      assert.equal(result.result, "failed");
      assert.equal(result.failureReason, "LAB_ASKPASS_REQUIRED");
      assert.equal(result.attempted, 0);
      assert.equal(result.cleanupVerified, true);
      assert.equal(error.stdout.includes(target), false);
      return true;
    },
  );
});
test(
  "POSIX bundle launch preserves quoted root and arguments without shell execution",
  { skip: process.platform === "win32" },
  async (t) => {
    const base = await mkdtemp(path.join(tmpdir(), "lobbymesh-ssh-quote-")),
      root = path.join(base, "peer's directory");
    t.after(async () => {
      assert.equal(path.dirname(base), path.resolve(tmpdir()));
      assert.ok(path.basename(base).startsWith("lobbymesh-ssh-quote-"));
      await rm(base, { recursive: true, force: true });
    });
    await mkdir(path.join(root, "runtime/bin"), { recursive: true });
    const node = path.join(root, "runtime/bin/node");
    await writeFile(node, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
    await chmod(node, 0o700);
    const args = ["--bootstrap", "127.0.0.1:1234", "'; touch unexpected; #"];
    const command = labRemoteArguments(
      { target, root, layout: "bundle" },
      args,
    ).at(-1);
    assert.ok(command);
    const result = await execute("/bin/sh", ["-c", command], { timeout: 5000 });
    assert.deepEqual(result.stdout.trimEnd().split("\n"), [
      "lab-peer.mjs",
      ...args,
    ]);
    await assert.rejects(access(path.join(root, "unexpected")));
  },
);
