import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { RecordV1 } from "../packages/security/src/records.js";

function child(argument: string, fixture = "overlay-process.ts") {
  const processChild: ChildProcess = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(new URL(`./fixtures/${fixture}`, import.meta.url)),
      argument,
    ],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  let diagnostics = "",
    seq = 0;
  processChild.stderr?.on("data", (chunk) => {
    diagnostics = (diagnostics + String(chunk)).slice(-16_384);
  });
  const pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  let readyResolve: (value: {
    address: string;
    id: string;
    key: string;
  }) => void;
  let readyReject: (error: Error) => void;
  const ready = new Promise<{ address: string; id: string; key: string }>(
    (resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    },
  );
  const timer = setTimeout(
    () => readyReject(new Error(`PROCESS_READY_TIMEOUT ${diagnostics}`)),
    25_000,
  );
  processChild.on(
    "message",
    (
      message: {
        ready?: boolean;
        id: number;
        result: unknown;
        error?: string;
      } & { address: string; key: string },
    ) => {
      if (message.ready) {
        clearTimeout(timer);
        readyResolve(
          message as unknown as { address: string; id: string; key: string },
        );
        return;
      }
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error)
        entry?.reject(new Error(`${message.error}; ${diagnostics}`));
      else entry?.resolve(message.result);
    },
  );
  processChild.on("exit", (code) => {
    clearTimeout(timer);
    const error = new Error(`PROCESS_EXIT ${code}: ${diagnostics}`);
    readyReject(error);
    for (const entry of pending.values()) entry.reject(error);
  });
  return {
    process: processChild,
    diagnostics: () => diagnostics,
    ready,
    command(op: string, args: object = {}): Promise<unknown> {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        processChild.send({ id, op, ...args });
      });
    },
  };
}
test(
  "three independent app processes join over real local HyperDHT Noise and exchange signed records",
  { timeout: 60_000 },
  async (t) => {
    const children: ReturnType<typeof child>[] = [];
    t.after(async () => {
      for (const entry of children)
        if (entry.diagnostics()) t.diagnostic(entry.diagnostics());
      await Promise.all(
        children.map(async (entry) => {
          if (entry.process.exitCode !== null || entry.process.signalCode)
            return;
          const exited = new Promise<void>((resolve) =>
            entry.process.once("exit", () => resolve()),
          );
          entry.process.kill();
          await exited;
        }),
      );
    });
    const bootstrap = child("bootstrap");
    children.push(bootstrap);
    const address = (await bootstrap.ready).address;
    const a = child(address);
    children.push(a);
    const infoA = await a.ready;
    const b = child(address);
    children.push(b);
    const infoB = await b.ready;
    const [, contactsB] = await Promise.all([
      a.command("join", { key: infoB.key }),
      b.command("join", { key: infoA.key }),
    ]);
    assert.ok((contactsB as string[]).includes(infoA.id));
    const c = child(address);
    children.push(c);
    const infoC = await c.ready;
    const contactsC = await c.command("join", { key: infoB.key });
    assert.ok((contactsC as string[]).includes(infoA.id));
    assert.ok((contactsC as string[]).includes(infoB.id));
    assert.ok(((await a.command("contacts")) as string[]).includes(infoC.id));
    const key = "ab".repeat(32);
    assert.deepEqual(
      await a.command("put", {
        key,
        content: "real Noise / synthetic session",
      }),
      { replicas: 2, failures: 0 },
    );
    const records = (await c.command("get", { key })) as RecordV1[];
    assert.equal(records.length, 1);
    assert.equal(records[0]?.author, infoA.id);
    assert.equal(records[0]?.content, "real Noise / synthetic session");
    const lookup = (await c.command("lookup", { key })) as {
      routing: { state: string; failures: number };
    };
    assert.equal(lookup.routing.state, "exhausted");
    assert.equal(lookup.routing.failures, 0);
    for (const peer of [c, b, a])
      assert.equal(await peer.command("stop"), "stopped");
    await bootstrap.command("stop").catch(() => {});
  },
);

test(
  "runtime discovers and authenticates another process through local bootstrap without peer-key input",
  { timeout: 45_000 },
  async (t) => {
    const children: ReturnType<typeof child>[] = [];
    t.after(async () => {
      await Promise.all(
        children.map(async (entry) => {
          if (entry.process.exitCode !== null || entry.process.signalCode)
            return;
          const exited = new Promise<void>((resolve) =>
            entry.process.once("exit", () => resolve()),
          );
          entry.process.kill();
          await exited;
        }),
      );
    });
    const bootstrap = child("bootstrap");
    children.push(bootstrap);
    const address = (await bootstrap.ready).address;
    const a = child(address, "runtime-process.ts");
    children.push(a);
    const infoA = await a.ready;
    const b = child(address, "runtime-process.ts");
    children.push(b);
    const infoB = await b.ready;
    assert.ok(((await b.command("contacts")) as string[]).includes(infoA.id));
    assert.ok(((await a.command("contacts")) as string[]).includes(infoB.id));
    const key = "cd".repeat(32);
    assert.deepEqual(await a.command("put", { key }), {
      replicas: 1,
      failures: 0,
    });
    const result = (await b.command("lookup", { key })) as {
      records: RecordV1[];
      routing: { state: string; failures: number };
    };
    assert.equal(result.records[0]?.content, "automatic bootstrap");
    assert.equal(result.routing.state, "exhausted");
    assert.equal(result.routing.failures, 0);
    await a.command("session", { room: "same-room" });
    await b.command("session", { room: "same-room" });
    const matched = (await b.command("matches")) as {
      peerId: string;
      verification: string;
    }[];
    assert.deepEqual(
      matched.map((p) => p.peerId).sort(),
      [infoA.id, infoB.id].sort(),
    );
    assert.ok(matched.every((p) => p.verification === "mock"));
    await b.command("session", { room: "other-room" });
    assert.deepEqual(
      ((await a.command("matches")) as { peerId: string }[]).map(
        (p) => p.peerId,
      ),
      [infoA.id],
    );
    await a.command("leave-session");
    assert.deepEqual(await a.command("matches"), []);
    await assert.rejects(
      a.command("direct-send", { peerId: infoB.id, key: infoB.key }),
      /CONTACT_NOT_AUTHORIZED/,
    );
    await a.command("direct-allow", { peerId: infoB.id });
    await b.command("direct-allow", { peerId: infoA.id });
    const acknowledgement = (await a.command("direct-send", {
      peerId: infoB.id,
      key: infoB.key,
      text: "synthetic encrypted text",
    })) as { status: string };
    assert.equal(acknowledgement.status, "acknowledged");
    const history = (await b.command("direct-history", {
      peerId: infoA.id,
    })) as { envelope: { text: string; from: string } }[];
    assert.equal(history.length, 1);
    assert.equal(history[0]?.envelope.text, "synthetic encrypted text");
    assert.equal(history[0]?.envelope.from, infoA.id);
    await b.command("direct-deny", { peerId: infoA.id });
    await assert.rejects(
      a.command("direct-send", { peerId: infoB.id, key: infoB.key }),
      /REMOTE_RPC_REJECTED/,
    );
    for (const peer of [b, a])
      assert.equal(await peer.command("stop"), "stopped");
    await bootstrap.command("stop").catch(() => {});
  },
);
