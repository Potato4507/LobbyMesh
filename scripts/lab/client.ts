import { type ChildProcess, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { LabCommand } from "./options.js";
import { type LabRemote, labRemoteArguments } from "./ssh.js";

export interface LabReady {
  ready: true;
  role: "peer" | "bootstrap" | "native-probe";
  peerId?: string;
  transportKey?: string;
}
export function launchLabPeer(args: string[], remote?: LabRemote) {
  const remoteArgs = remote ? labRemoteArguments(remote, args) : undefined;
  const script = fileURLToPath(new URL("../lab-peer.ts", import.meta.url));
  const child = remote
    ? spawn("ssh", remoteArgs ?? [], {
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      })
    : spawn(process.execPath, ["--import", "tsx", script, ...args], {
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      });
  return controlLabPeer(child);
}

// Also used by fault fixtures. Only a valid stop reply followed by exit 0
// establishes cleanup; losing the pipe or killing a child never does.
export function controlLabPeer(
  child: Pick<ChildProcess, "once" | "kill"> & {
    stdin: Writable;
    stdout: Readable;
  },
) {
  let cleanupConfirmed = false;
  let seq = 0,
    buffer = "",
    exited = false,
    failed = false,
    readySeen = false;
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
    terminate();
  }, 25000);
  const exit = new Promise<number | null>((resolve) =>
    child.once("close", (code) => {
      exited = true;
      resolve(code);
    }),
  );
  const fail = () => {
    failed = true;
    clearTimeout(readyTimer);
    readyReject(new Error("LAB_PROCESS_EXIT"));
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("LAB_PROCESS_EXIT"));
    }
    pending.clear();
  };
  const terminate = () => {
    fail();
    child.kill("SIGKILL");
  };
  child.once("error", terminate);
  child.once("exit", fail);
  child.stdin.on("error", terminate);
  child.stdout.once("error", terminate);
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (failed) return;
    buffer += chunk;
    if (buffer.length > 512 * 1024) {
      terminate();
      return;
    }
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n");
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const message = JSON.parse(line);
        if (!message || typeof message !== "object" || Array.isArray(message))
          throw new Error("LAB_INVALID_REPLY");
        if (message.ready === true) {
          if (
            readySeen ||
            !(
              (message.role === "bootstrap" &&
                Object.keys(message).sort().join(",") === "ready,role") ||
              (message.role === "peer" &&
                Object.keys(message).sort().join(",") === "peerId,ready,role" &&
                typeof message.peerId === "string" &&
                /^[a-f0-9]{64}$/.test(message.peerId)) ||
              (message.role === "native-probe" &&
                Object.keys(message).sort().join(",") ===
                  "ready,role,transportKey" &&
                typeof message.transportKey === "string" &&
                /^[a-f0-9]{64}$/.test(message.transportKey))
            )
          )
            throw new Error("LAB_INVALID_REPLY");
          readySeen = true;
          clearTimeout(readyTimer);
          readyResolve(message);
          continue;
        }
        if (
          !readySeen ||
          !Number.isSafeInteger(message.id) ||
          message.id < 1 ||
          !["id,result", "error,id"].includes(
            Object.keys(message).sort().join(","),
          ) ||
          ("error" in message && typeof message.error !== "string")
        )
          throw new Error("LAB_INVALID_REPLY");
        const p = pending.get(message.id);
        if (!p) continue;
        pending.delete(message.id);
        clearTimeout(p.timer);
        if (message.error) p.reject(new Error("LAB_REMOTE_REJECTED"));
        else p.resolve(message.result);
      } catch {
        terminate();
        return;
      }
    }
  });
  const request = (op: LabCommand["op"], value?: string): Promise<unknown> => {
    if (exited || failed || !readySeen || pending.size >= 8)
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
  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= (async () => {
      if (exited) {
        if (!cleanupConfirmed) throw new Error("LAB_CLEANUP_UNCONFIRMED");
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          terminate();
          reject(new Error("LAB_CLEANUP_TIMEOUT"));
        }, 4000);
      });
      try {
        const result = (await Promise.race([request("stop"), deadline])) as {
          stopped?: unknown;
          cleanupVerified?: unknown;
        };
        if (result?.stopped !== true || result.cleanupVerified !== true)
          throw new Error("LAB_CLEANUP_UNCONFIRMED");
        if ((await Promise.race([exit, deadline])) !== 0)
          throw new Error("LAB_CLEANUP_FAILED");
        cleanupConfirmed = true;
      } finally {
        clearTimeout(timer);
        if (!exited) terminate();
      }
    })();
    return stopping;
  };
  return {
    ready,
    request,
    exit,
    stop,
  };
}
