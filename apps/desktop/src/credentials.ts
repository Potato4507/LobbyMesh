import path from "node:path";
import { safeStorage } from "electron";
import { loadOrCreateIdentity } from "../../../packages/identity/src/index.js";
import { loadTransportKeys } from "../../../packages/public-discovery/src/hyperdht.js";
import type { SecretProtection } from "../../../packages/security/src/protected-file.js";

// Only the Windows provider is currently accepted/tested. In particular, never
// opt into Linux's basic-text fallback or silently revert to plaintext files.
export const desktopProtection: SecretProtection = {
  available: async () =>
    process.platform === "win32" &&
    (await safeStorage.isAsyncEncryptionAvailable()),
  seal: (plaintext) => safeStorage.encryptStringAsync(plaintext),
  open: async (ciphertext) => {
    const value = await safeStorage.decryptStringAsync(ciphertext);
    return { plaintext: value.result, rotate: value.shouldReEncrypt };
  },
};
export async function loadDesktopCredentials(
  directory: string,
  signal?: AbortSignal,
) {
  try {
    signal?.throwIfAborted();
    const identity = await loadOrCreateIdentity(
      path.join(directory, "identity"),
      desktopProtection,
    );
    signal?.throwIfAborted();
    const transportKeys = await loadTransportKeys(
      path.join(directory, "transport"),
      desktopProtection,
    );
    signal?.throwIfAborted();
    return { identity, transportKeys };
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error("CREDENTIALS_UNAVAILABLE");
  }
}
