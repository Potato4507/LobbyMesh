import { createRequire } from "node:module";
import { isIP } from "node:net";
import path from "node:path";

// Explicit private-LAN diagnostic only. Raw JSONL contains ephemeral transport
// keys; keep it on the controller pipe, never in evidence. No application RPC,
// user text, microphone, public bootstrap, profiles or OS changes.
const [flag, address, ...extra] = process.argv.slice(2);
const [host, port] = (address ?? "").split(":");
if (
  flag !== "--bootstrap" ||
  extra.length ||
  address?.split(":").length !== 2 ||
  isIP(host ?? "") !== 4 ||
  !/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(host) ||
  !/^\d+$/.test(port ?? "") ||
  Number(port) < 1 ||
  Number(port) > 65535
)
  throw new Error("PRIVATE_NATIVE_BOOTSTRAP_REQUIRED");
const load = createRequire(path.join(process.cwd(), "package.json"));
const DHT = load("hyperdht");
const version = load("hyperdht/package.json").version;
const node = new DHT({ bootstrap: [address] });
const keys = DHT.keyPair();
const request = Buffer.from("lobbymesh-native-lan/v1");
const response = Buffer.from("lobbymesh-native-lan-reply/v1");
const streams = new Set();
const counts = { accepted: 0, replies: 0, invalid: 0 };
let closing,
  busy = false,
  commands = 0,
  input = "";
const lifetime = setTimeout(() => void close(), 60000);
const output = (value, callback) => {
  if (process.stdout.destroyed || process.stdout.writableLength > 65536) {
    void close();
    return;
  }
  process.stdout.write(`${JSON.stringify(value)}\n`, callback);
};
function close(id) {
  closing ??= (async () => {
    clearTimeout(lifetime);
    for (const stream of streams) stream.destroy();
    await node.destroy({ force: true });
    keys.secretKey.fill(0);
    if (!Number.isSafeInteger(id)) {
      process.exitCode = 1;
      process.stdin.destroy();
      return;
    }
    const flush = setTimeout(() => process.exit(1), 1000);
    output(
      { id, result: { stopped: true, cleanupVerified: streams.size === 0 } },
      (error) => {
        clearTimeout(flush);
        process.exit(error ? 1 : 0);
      },
    );
  })().catch(() => process.exit(1));
  return closing;
}
process.stdin.once("end", () => void close());
process.stdin.once("error", () => void close());
process.stdout.once("error", () => void close());
process.once("SIGTERM", () => void close());
function track(stream) {
  if (streams.size >= 8) {
    stream.destroy();
    return stream;
  }
  streams.add(stream);
  stream.on("error", () => {});
  const timer = setTimeout(() => stream.destroy(), 3000);
  stream.once("close", () => {
    clearTimeout(timer);
    streams.delete(stream);
  });
  return stream;
}
const server = node.createServer((incoming) => {
  counts.accepted++;
  const stream = track(incoming);
  let bytes = Buffer.alloc(0),
    replied = false;
  stream.on("data", (chunk) => {
    if (replied || bytes.length + chunk.length > request.length) {
      counts.invalid++;
      stream.destroy();
      return;
    }
    bytes = Buffer.concat([bytes, chunk]);
    if (bytes.length !== request.length) return;
    if (!bytes.equals(request)) {
      counts.invalid++;
      stream.destroy();
      return;
    }
    replied = true;
    counts.replies++;
    stream.end(response);
  });
});
async function trial(value) {
  const options = JSON.parse(value);
  if (
    !options ||
    Object.keys(options).sort().join(",") !== "key,reusableSocket" ||
    typeof options.key !== "string" ||
    !/^[a-f0-9]{64}$/.test(options.key) ||
    typeof options.reusableSocket !== "boolean"
  )
    throw new Error("INVALID_NATIVE_TRIAL");
  const started = performance.now();
  const stream = track(
    node.connect(Buffer.from(options.key, "hex"), {
      keyPair: keys,
      reusableSocket: options.reusableSocket,
    }),
  );
  return new Promise((resolve) => {
    let settled = false,
      phase = "transport",
      received = Buffer.alloc(0);
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        outcome,
        phase,
        elapsedMs: Math.round(performance.now() - started),
        reusableSocket: options.reusableSocket,
      });
      stream.destroy();
    };
    const timer = setTimeout(() => finish("timeout"), 1500);
    stream.once("connect", () => {
      phase = "reply";
    });
    stream.once("error", () => finish("transport-error"));
    stream.once("close", () => finish("closed"));
    stream.on("data", (chunk) => {
      if (received.length + chunk.length > response.length)
        return finish("invalid");
      received = Buffer.concat([received, chunk]);
      if (received.length === response.length)
        finish(received.equals(response) ? "success" : "invalid");
    });
    stream.write(request);
  });
}
try {
  await server.listen(keys);
  output({
    ready: true,
    role: "native-probe",
    transportKey: keys.publicKey.toString("hex"),
  });
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    if (closing) return;
    input += chunk;
    if (Buffer.byteLength(input) > 8192) {
      void close();
      return;
    }
    while (input.includes("\n")) {
      const end = input.indexOf("\n"),
        line = input.slice(0, end);
      input = input.slice(end + 1);
      let message;
      try {
        message = JSON.parse(line);
        if (
          !message ||
          !Number.isSafeInteger(message.id) ||
          message.id < 1 ||
          ++commands > 64 ||
          Object.keys(message).sort().join(",") !==
            (message.op === "send" ? "id,op,value" : "id,op") ||
          !["status", "send", "stop"].includes(message.op)
        )
          throw new Error("INVALID_CONTROL");
      } catch {
        void close();
        return;
      }
      if (message.op === "stop") {
        void close(message.id);
        return;
      }
      if (busy) {
        output({ id: message.id, error: "NATIVE_PROBE_BUSY" });
        continue;
      }
      if (message.op === "status") {
        output({
          id: message.id,
          result: { hyperdht: version, active: streams.size, ...counts },
        });
        continue;
      }
      busy = true;
      void trial(message.value)
        .then(
          (result) => output({ id: message.id, result }),
          () => output({ id: message.id, error: "INVALID_NATIVE_TRIAL" }),
        )
        .finally(() => {
          busy = false;
        });
    }
  });
} catch {
  await close();
}
