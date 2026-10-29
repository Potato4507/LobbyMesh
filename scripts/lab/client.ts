import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { LabCommand } from "./options.js";

export interface LabReady {
  ready: true;
  role: "peer" | "bootstrap";
  peerId?: string;
}
export function launchLabPeer(
  args: string[],
  remote?: { target: string; root: string },
) {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  if (
    remote &&
    (!/^[a-zA-Z0-9_][a-zA-Z0-9_.@:-]{0,253}$/.test(remote.target) ||
      !remote.root ||
      /[\r\n\0]/.test(remote.root))
  )
    throw new Error("INVALID_LAB_REMOTE");
  const script = fileURLToPath(new URL("../lab-peer.ts", import.meta.url));
  const child = remote
    ? spawn(
        "ssh",
        [
          "-T",
          "-o",
          "BatchMode=yes",
          "-o",
          "StrictHostKeyChecking=yes",
          "-o",
          "ConnectTimeout=5",
          remote.target,
          `cd ${quote(remote.root)} && node --import tsx scripts/lab-peer.ts ${args.map(quote).join(" ")}`,
        ],
        { stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
      )
    : spawn(process.execPath, ["--import", "tsx", script, ...args], {
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      });
  let cleanupConfirmed = false;
  let seq = 0,
    buffer = "",
    exited = false;
  const pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let readyResolve: (value: LabReady) => void,
    readyReject: (error: Error) => void;
  const ready = new Promise<LabReady>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  // Observe rejection immediately, even while the caller is starting another peer.
  void ready.catch(() => {});
  const readyTimer = setTimeout(() => {
    readyReject(new Error("LAB_READY_TIMEOUT"));
    child.kill();
  }, 25000);
  const exit = new Promise<number | null>((resolve) =>
    child.once("exit", (code) => {
      exited = true;
      resolve(code);
    }),
  );
  const fail = () => {
    clearTimeout(readyTimer);
    readyReject(new Error("LAB_PROCESS_EXIT"));
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("LAB_PROCESS_EXIT"));
    }
    pending.clear();
  };
  child.once("error", fail);
  child.once("exit", fail);
  child.stdin.on("error", fail);
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > 512 * 1024) {
      fail();
      child.kill();
      return;
    }
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n");
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const message = JSON.parse(line);
        if (message.ready === true) {
          clearTimeout(readyTimer);
          readyResolve(message);
          continue;
        }
        const p = pending.get(message.id);
        if (!p) continue;
        pending.delete(message.id);
        clearTimeout(p.timer);
        if (message.error) p.reject(new Error("LAB_REMOTE_REJECTED"));
        else p.resolve(message.result);
      } catch {
        fail();
        child.kill();
      }
    }
  });
  const request = (op: LabCommand["op"], value?: string): Promise<unknown> => {
    if (exited || pending.size >= 8)
      return Promise.reject(new Error("LAB_CLIENT_UNAVAILABLE"));
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("LAB_COMMAND_TIMEOUT"));
      }, 15000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(
        `${JSON.stringify({ id, op, ...(value === undefined ? {} : { value }) })}\n`,
      );
    }).catch(() => {
      throw new Error(`LAB_COMMAND_${op.toUpperCase()}_FAILED`);
    });
  };
  return {
    ready,
    request,
    exit,
    async stop() {
      if (exited) {
        if (!cleanupConfirmed) throw new Error("LAB_CLEANUP_UNCONFIRMED");
        return;
      }
      const force = setTimeout(() => child.kill(), 4000);
      try {
        const result = (await request("stop")) as {
          stopped?: unknown;
          cleanupVerified?: unknown;
        };
        if (result?.stopped !== true || result.cleanupVerified !== true)
          throw new Error("LAB_CLEANUP_UNCONFIRMED");
        if ((await exit) !== 0) throw new Error("LAB_CLEANUP_FAILED");
        cleanupConfirmed = true;
      } finally {
        clearTimeout(force);
        if (!exited) child.kill();
      }
    },
  };
}
