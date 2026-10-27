import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import { lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
export interface Identity {
  readonly publicKey: string;
  readonly peerId: string;
  sign(data: Uint8Array): Buffer;
  fingerprint(): string;
}
export function peerIdFromPublicKey(publicKey: string): string {
  const key = createPublicKey(publicKey);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("WRONG_KEY_TYPE");
  return createHash("sha256")
    .update(key.export({ type: "spki", format: "der" }))
    .digest("hex");
}
function identity(privateKey: KeyObject): Identity {
  if (privateKey.asymmetricKeyType !== "ed25519")
    throw new Error("WRONG_KEY_TYPE");
  const publicKey = createPublicKey(privateKey)
    .export({ type: "spki", format: "pem" })
    .toString();
  const peerId = peerIdFromPublicKey(publicKey);
  return Object.freeze({
    publicKey,
    peerId,
    sign: (data: Uint8Array) => cryptoSign(null, data, privateKey),
    fingerprint: () => peerId.match(/.{4}/g)?.join(" ") ?? peerId,
  });
}
export function createIdentity(): Identity {
  return identity(generateKeyPairSync("ed25519").privateKey);
}
export function verify(
  publicKey: string,
  data: Uint8Array,
  signature: Uint8Array,
): boolean {
  try {
    peerIdFromPublicKey(publicKey);
    return (
      signature.byteLength === 64 &&
      cryptoVerify(null, data, publicKey, signature)
    );
  } catch {
    return false;
  }
}
export async function loadOrCreateIdentity(
  directory: string,
): Promise<Identity> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const dir = await lstat(directory);
  if (
    !dir.isDirectory() ||
    (process.platform !== "win32" && (dir.mode & 0o077) !== 0)
  )
    throw new Error("UNSAFE_DIRECTORY");
  const file = path.join(directory, "identity-v1.json");
  try {
    const stat = await lstat(file);
    if (
      !stat.isFile() ||
      stat.size > 4096 ||
      (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
    )
      throw new Error("UNSAFE_KEY_FILE");
    const stored: unknown = JSON.parse(await readFile(file, "utf8"));
    if (
      !stored ||
      typeof stored !== "object" ||
      !("version" in stored) ||
      stored.version !== 1 ||
      !("privateKey" in stored) ||
      typeof stored.privateKey !== "string"
    )
      throw new Error("CORRUPT_IDENTITY");
    return identity(createPrivateKey(stored.privateKey));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }
  const privateKey = generateKeyPairSync("ed25519").privateKey;
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(
      JSON.stringify({
        version: 1,
        privateKey: privateKey.export({ type: "pkcs8", format: "pem" }),
      }),
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
  return identity(privateKey);
}
// Local reset does not erase records already retained by remote participants.
export async function resetIdentity(directory: string): Promise<Identity> {
  await unlink(path.join(directory, "identity-v1.json"));
  return loadOrCreateIdentity(directory);
}
