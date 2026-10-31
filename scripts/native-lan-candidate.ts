import { createHash } from "node:crypto";

export const officialNativeServerSha256 =
  "cdff91aee9ee1ce8aeab4daeed550ac7130f44c2750cebb794c605254b31a276";

// Isolated experiment only. Never imported by production or applied on install.
// Pin the complete upstream file before changing its one unstable-analysis guard.
export function nativeLanCandidate(source: Buffer): Buffer {
  if (
    createHash("sha256").update(source).digest("hex") !==
    officialNativeServerSha256
  )
    throw new Error("NATIVE_CANDIDATE_SOURCE_MISMATCH");
  const before = "if (!stable) return this._abort(h)";
  const after = `if (!stable) {
          const pendingLan = h.replyFromPuncher === false && h.prepunching != null &&
            h.relayToken === null && h.aborted === false && h.encryptedSocket === null &&
            h.rawStream && h.rawStream.destroyed === false && h.rawStream.connected === false
          if (!pendingLan) return this._abort(h)
          this._lobbymeshLanAbortDeferrals = (this._lobbymeshLanAbortDeferrals || 0) + 1
        }`;
  const text = source.toString("utf8");
  if (text.split(before).length !== 2)
    throw new Error("NATIVE_CANDIDATE_GUARD_MISMATCH");
  return Buffer.from(text.replace(before, after));
}
