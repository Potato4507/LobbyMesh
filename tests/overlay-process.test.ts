import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { NetworkOverlay } from "../packages/app-dht/src/network.js";
import { createIdentity } from "../packages/identity/src/index.js";
import type { ContactPreview } from "../packages/protocol/src/pairing.js";
import { createContactCode } from "../packages/protocol/src/pairing.js";
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
    // Exercise real bidirectional connection setup plus each sender's bounded
    // queue. A failed attempt is evidence, not an excuse to retry this assertion.
    const burst = await Promise.all([
      ...Array.from({ length: 8 }, (_, index) =>
        a.command("put", { key: (index + 1).toString(16).padStart(64, "0") }),
      ),
      ...Array.from({ length: 8 }, () => b.command("lookup", { key })),
    ]);
    const diagnosticA = (await a.command("diagnostics")) as ReturnType<
      NetworkOverlay["diagnostics"]
    >;
    const diagnosticB = (await b.command("diagnostics")) as ReturnType<
      NetworkOverlay["diagnostics"]
    >;
    for (const result of burst.slice(0, 8))
      assert.deepEqual(
        result,
        { replicas: 1, failures: 0 },
        JSON.stringify({ diagnosticA, diagnosticB }),
      );
    for (const result of burst.slice(8)) {
      const lookup = result as {
        records: RecordV1[];
        routing: { state: string; failures: number };
      };
      assert.equal(
        lookup.routing.state,
        "exhausted",
        JSON.stringify({ diagnosticA, diagnosticB }),
      );
      assert.equal(
        lookup.routing.failures,
        0,
        JSON.stringify({ diagnosticA, diagnosticB }),
      );
      assert.equal(lookup.records[0]?.content, "automatic bootstrap");
    }
    t.diagnostic(
      JSON.stringify({
        nativeBurst: { puts: 8, reverseLookups: 8 },
        a: diagnosticA.outcomes,
        b: diagnosticB.outcomes,
        failedAttempts: {
          a: diagnosticA.recentFailures,
          b: diagnosticB.recentFailures,
        },
      }),
    );
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
    const codeB = (await b.command("pairing-code")) as { code: string };
    const impostor = createIdentity();
    const wrongTarget = createContactCode(
      impostor,
      infoB.key,
      "synthetic wrong endpoint",
    );
    const rejectedPreview = (await a.command("pairing-preview", {
      code: wrongTarget,
    })) as ContactPreview;
    await assert.rejects(
      a.command("pairing-approve", { ticket: rejectedPreview.ticket }),
      /PEER_ID_MISMATCH/,
    );
    await assert.rejects(
      a.command("direct-history", { peerId: impostor.peerId }),
      /CONTACT_NOT_AUTHORIZED/,
    );
    const previewB = (await a.command("pairing-preview", {
      code: codeB.code,
    })) as ContactPreview;
    assert.equal(previewB.fingerprint.replaceAll(" ", ""), infoB.id);
    await a.command("pairing-approve", { ticket: previewB.ticket });
    // One local approval never overrides the other participant's deny policy.
    await assert.rejects(
      a.command("direct-send", {
        peerId: infoB.id,
        text: "must remain undelivered",
      }),
      /DELIVERY_UNCONFIRMED/,
    );
    const codeA = (await a.command("pairing-code")) as { code: string };
    const previewA = (await b.command("pairing-preview", {
      code: codeA.code,
    })) as ContactPreview;
    await b.command("pairing-approve", { ticket: previewA.ticket });
    const acknowledgement = (await a.command("direct-send", {
      peerId: infoB.id,
      key: infoB.key,
      text: "synthetic encrypted text",
    })) as { status: string };
    assert.equal(acknowledgement.status, "acknowledged");
    const history = (await b.command("direct-history", {
      peerId: infoA.id,
    })) as { text: string; peerId: string; direction: string }[];
    assert.equal(history.length, 1);
    assert.equal(history[0]?.text, "synthetic encrypted text");
    assert.equal(history[0]?.peerId, infoA.id);
    assert.equal(history[0]?.direction, "incoming");
    // Real encrypted control transport, synthetic SDP/ICE only: no media device.
    await assert.rejects(
      a.command("voice-offer", { peerId: infoB.id, key: infoB.key }),
      /VOICE_DISABLED/,
    );
    await a.command("voice-enable");
    await assert.rejects(
      a.command("voice-offer", { peerId: infoB.id, key: infoB.key }),
      /REMOTE_RPC_REJECTED/,
    );
    await b.command("voice-enable");
    const callId = await a.command("voice-offer", {
      peerId: infoB.id,
      key: infoB.key,
    });
    assert.equal(
      ((await b.command("voice-status")) as { phase: string }).phase,
      "ringing",
    );
    assert.equal(
      ((await b.command("voice-events")) as { op: string }[])[0]?.op,
      "offer",
    );
    await b.command("voice-answer", { callId });
    assert.equal(
      ((await a.command("voice-status")) as { phase: string }).phase,
      "negotiating",
    );
    await a.command("voice-ice", { callId });
    assert.equal(
      ((await b.command("voice-events")) as { op: string }[])[0]?.op,
      "ice",
    );
    await a.command("voice-hangup", { callId });
    assert.equal(
      ((await b.command("voice-status")) as { phase: string }).phase,
      "idle",
    );
    const revokedCall = await a.command("voice-offer", {
      peerId: infoB.id,
      key: infoB.key,
    });
    await b.command("direct-deny", { peerId: infoA.id });
    assert.equal(
      ((await b.command("voice-status")) as { phase: string }).phase,
      "idle",
    );
    assert.deepEqual(await b.command("voice-events"), []);
    await assert.rejects(
      b.command("voice-answer", { callId: revokedCall }),
      /VOICE_STATE_MISMATCH/,
    );
    await a.command("voice-hangup", { callId: revokedCall }).catch(() => {});
    await assert.rejects(
      a.command("direct-send", { peerId: infoB.id, key: infoB.key }),
      /DELIVERY_UNCONFIRMED/,
    );
    await b.command("direct-allow", { peerId: infoA.id });
    assert.equal(
      ((await b.command("direct-history", { peerId: infoA.id })) as unknown[])
        .length,
      1,
    );
    for (const peer of [b, a])
      assert.equal(await peer.command("stop"), "stopped");
    await bootstrap.command("stop").catch(() => {});
  },
);
