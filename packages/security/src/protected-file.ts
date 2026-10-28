import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

export interface SecretProtection {
  available(): Promise<boolean>;
  seal(plaintext: string): Promise<Buffer>;
  open(ciphertext: Buffer): Promise<{ plaintext: string; rotate: boolean }>;
}
interface SecretFormat {
  legacy: string;
  sealed: string;
  create(): string;
  normalize(value: string): string;
  decodeLegacy(value: Buffer): string;
}
async function readSafe(
  filename: string,
  maximum: number,
): Promise<Buffer | null> {
  try {
    const info = await lstat(filename);
    if (
      !info.isFile() ||
      info.size < 1 ||
      info.size > maximum ||
      (process.platform !== "win32" && info.mode & 0o077)
    )
      throw new Error("UNSAFE_CREDENTIAL_FILE");
    return await readFile(filename);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
}
export async function requirePlaintextMode(
  directory: string,
  sealed: string,
): Promise<void> {
  if (await readSafe(path.join(directory, sealed), 16_384))
    throw new Error("OS_PROTECTION_REQUIRED");
}
async function writeExclusive(filename: string, data: Buffer): Promise<void> {
  const handle = await open(filename, "wx", 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function replace(filename: string, data: Buffer): Promise<void> {
  const temporary = `${filename}.${randomBytes(16).toString("hex")}.tmp`;
  try {
    await writeExclusive(temporary, data);
    await rename(temporary, filename);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}
// Private material remains in the trusted main process. No plaintext backup is
// written: verified sealed data replaces legacy content with a non-secret marker.
export async function loadProtectedFile(
  directory: string,
  format: SecretFormat,
  protection: SecretProtection,
): Promise<string> {
  try {
    if (!(await protection.available())) throw new Error();
  } catch {
    throw new Error("CREDENTIAL_PROTECTION_UNAVAILABLE");
  }
  for (const name of [format.legacy, format.sealed])
    if (path.basename(name) !== name || name === "." || name === "..")
      throw new Error("INVALID_CREDENTIAL_PATH");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    (process.platform !== "win32" && info.mode & 0o077)
  )
    throw new Error("UNSAFE_CREDENTIAL_DIRECTORY");
  const sealedFile = path.join(directory, format.sealed),
    legacyFile = path.join(directory, format.legacy);
  const cipher = await readSafe(sealedFile, 16_384),
    legacy = await readSafe(legacyFile, 4096);
  const normalize = (value: string): string => {
    if (typeof value !== "string" || Buffer.byteLength(value) > 4096)
      throw new Error("INVALID_CREDENTIAL_PAYLOAD");
    try {
      return format.normalize(value);
    } catch {
      throw new Error("INVALID_CREDENTIAL_PAYLOAD");
    }
  };
  const decode = async (value: Buffer) => {
    try {
      const opened = await protection.open(value);
      return { plaintext: normalize(opened.plaintext), rotate: opened.rotate };
    } catch {
      throw new Error("CREDENTIAL_DECRYPT_FAILED");
    }
  };
  let marker = false;
  if (legacy) {
    try {
      const value = JSON.parse(legacy.toString("utf8")) as {
        version?: unknown;
        storage?: unknown;
        file?: unknown;
      } | null;
      marker =
        !!value &&
        value.version === 2 &&
        value.storage === "os-protected" &&
        value.file === format.sealed &&
        Object.keys(value).length === 3;
    } catch {
      /* A legacy transport seed is binary. */
    }
  }
  if (marker && !cipher) throw new Error("CREDENTIAL_SEALED_FILE_MISSING");
  let oldPlain: string | null = null;
  if (legacy && !marker) {
    try {
      oldPlain = normalize(format.decodeLegacy(legacy));
    } catch {
      throw new Error("INVALID_CREDENTIAL_PAYLOAD");
    }
  }
  const opened = cipher ? await decode(cipher) : null;
  if (oldPlain !== null && opened && oldPlain !== opened.plaintext)
    throw new Error("CREDENTIAL_CONFLICT");
  const plaintext = opened?.plaintext ?? oldPlain ?? normalize(format.create());
  const sealVerified = async () => {
    let sealed: Buffer;
    try {
      sealed = await protection.seal(plaintext);
    } catch {
      throw new Error("CREDENTIAL_ENCRYPT_FAILED");
    }
    if (
      !Buffer.isBuffer(sealed) ||
      sealed.length < 1 ||
      sealed.length > 16_384 ||
      (await decode(sealed)).plaintext !== plaintext
    )
      throw new Error("CREDENTIAL_ENCRYPT_FAILED");
    return sealed;
  };
  if (!cipher) {
    await writeExclusive(sealedFile, await sealVerified());
    const persisted = await readSafe(sealedFile, 16_384);
    if (!persisted || (await decode(persisted)).plaintext !== plaintext)
      throw new Error("CREDENTIAL_VERIFY_FAILED");
  } else if (opened?.rotate) {
    const sealed = await sealVerified();
    const current = await readSafe(sealedFile, 16_384);
    if (!current?.equals(cipher)) throw new Error("CREDENTIAL_CONFLICT");
    await replace(sealedFile, sealed);
  }
  if (legacy && !marker) {
    const current = await readSafe(legacyFile, 4096);
    if (!current?.equals(legacy)) throw new Error("CREDENTIAL_CONFLICT");
    await replace(
      legacyFile,
      Buffer.from(
        JSON.stringify({
          version: 2,
          storage: "os-protected",
          file: format.sealed,
        }),
      ),
    );
  }
  return plaintext;
}
