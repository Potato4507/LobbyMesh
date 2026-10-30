import { type ChildProcess, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { type LabSshAuth, labSshArguments, validLabSshTarget } from "./ssh.js";

export function labSshTarget(args: string[]): string {
  return labDoctorOptions(args).target;
}
export function labDoctorOptions(args: string[]) {
  const fields = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i],
      value = args[i + 1];
    if (
      !key ||
      !["--ssh-target", "--ssh-auth"].includes(key) ||
      !value ||
      fields.has(key)
    )
      throw new Error("INVALID_LAB_DOCTOR_OPTIONS");
    fields.set(key, value);
  }
  const target = fields.get("--ssh-target") ?? "",
    auth = fields.get("--ssh-auth") ?? "batch";
  if (!validLabSshTarget(target) || !["batch", "askpass"].includes(auth))
    throw new Error("INVALID_LAB_DOCTOR_OPTIONS");
  return { target, auth: auth as LabSshAuth };
}

// Deliberately discard raw model/OS/kernel strings and unrecognized output.
// Inventory cannot establish topology, permission to elevate, or native ABI support.
export function labHostFacts(output: string) {
  if (Buffer.byteLength(output) > 8192) throw new Error("INVALID_LAB_FACTS");
  const fields = new Map<string, string>();
  const keys = [
    "Kernel",
    "Architecture",
    "OS",
    "Model",
    "Memory",
    "ip",
    "nft",
    "tc",
    "node",
    "pnpm",
    "Net namespaces supported",
  ];
  for (const line of output.trim().split(/\r?\n/)) {
    const split = line.indexOf(": ");
    const key = line.slice(0, split),
      value = line.slice(split + 2);
    if (split < 0 || !keys.includes(key) || fields.has(key))
      throw new Error("INVALID_LAB_FACTS");
    fields.set(key, value);
  }
  for (const key of keys.filter((k) => !["Model", "Memory"].includes(k)))
    if (!fields.has(key)) throw new Error("INVALID_LAB_FACTS");
  const tool = (key: string) => {
    const value = fields.get(key);
    if (value !== "present" && value !== "missing")
      throw new Error("INVALID_LAB_FACTS");
    return value === "present";
  };
  const version = (key: string) => {
    const value = fields.get(key) ?? "";
    if (value === "missing") return null;
    if (!/^v?\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value))
      throw new Error("INVALID_LAB_FACTS");
    return value.replace(/^v/, "");
  };
  const architecture = fields.get("Architecture");
  if (
    !architecture ||
    !["aarch64", "armv7l", "x86_64"].includes(architecture) ||
    !/^Linux \d[\w.+-]{0,100}$/.test(fields.get("Kernel") ?? "")
  )
    throw new Error("INVALID_LAB_FACTS");
  const namespaces = fields.get("Net namespaces supported");
  if (namespaces !== "yes" && namespaces !== "no")
    throw new Error("INVALID_LAB_FACTS");
  const memory = fields.get("Memory");
  if (memory && !/^\d{1,8} MiB$/.test(memory))
    throw new Error("INVALID_LAB_FACTS");
  const node = version("node"),
    pnpm = version("pnpm");
  const ip = tool("ip"),
    nft = tool("nft"),
    tc = tool("tc");
  return {
    architecture,
    osFamily: /debian/i.test(fields.get("OS") ?? "")
      ? "debian"
      : /ubuntu/i.test(fields.get("OS") ?? "")
        ? "ubuntu"
        : "other-linux",
    modelClass: /raspberry pi/i.test(fields.get("Model") ?? "")
      ? "raspberry-pi"
      : "unclassified",
    memoryMiB: memory ? Number(memory.split(" ")[0]) : null,
    node,
    pnpm,
    ip,
    nft,
    tc,
    namespaces: namespaces === "yes",
    pinnedToolchain: node?.startsWith("24.") === true && pnpm === "11.25.0",
    namespaceTools: ip && nft && tc && namespaces === "yes",
  };
}

export async function inspectLabHost(
  target: string,
  script: string,
  auth: LabSshAuth = "batch",
) {
  labSshTarget(["--ssh-target", target]);
  return collectLabFacts(
    spawn("ssh", labSshArguments(target, ["bash", "-s"], auth), {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    }),
    script,
  );
}

export function collectLabFacts(
  child: Pick<ChildProcess, "once" | "kill"> & {
    stdin: Writable;
    stdout: Readable;
  },
  script: string,
  timeoutMs = 10000,
) {
  return new Promise<ReturnType<typeof labHostFacts>>((resolve, reject) => {
    let output = "",
      invalid = false;
    const fail = () => {
      invalid = true;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(fail, timeoutMs);
    child.once("error", fail);
    child.stdin.once("error", fail);
    child.stdout.once("error", fail);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (invalid) return;
      if (Buffer.byteLength(output) + Buffer.byteLength(chunk) > 8192) fail();
      else output += chunk;
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (invalid || code !== 0) {
        reject(new Error("LAB_HOST_UNAVAILABLE"));
        return;
      }
      try {
        resolve(labHostFacts(output));
      } catch {
        reject(new Error("LAB_HOST_FACTS_REJECTED"));
      }
    });
    child.stdin.end(script.replaceAll("\r\n", "\n"));
  });
}
