import { createHash } from "node:crypto";

export const officialNativeServerSha256 =
  "cdff91aee9ee1ce8aeab4daeed550ac7130f44c2750cebb794c605254b31a276";

export const productionNativeServerSha256 =
  "1decf578fa2e8ca5e98f5eaaf89164959922a27d36d0a5cf1de359ed7a6eba34";
const before = "if (!stable) return this._abort(h)";
function guard(instrumented: boolean) {
  return `if (!stable) {
          const pendingLan = h.replyFromPuncher === false && h.prepunching != null &&
            h.relayToken === null && h.aborted === false && h.encryptedSocket === null &&
            h.rawStream && h.rawStream.destroyed === false && h.rawStream.connected === false
          if (!pendingLan) return this._abort(h)
${instrumented ? "          this._lobbymeshLanAbortDeferrals = (this._lobbymeshLanAbortDeferrals || 0) + 1\n" : ""}        }`;
}

// Source transforms for patch preparation and controls, never runtime imports.
function transform(source: Buffer, instrumented: boolean): Buffer {
  if (
    createHash("sha256").update(source).digest("hex") !==
    officialNativeServerSha256
  )
    throw new Error("NATIVE_CANDIDATE_SOURCE_MISMATCH");
  const text = source.toString("utf8");
  if (text.split(before).length !== 2)
    throw new Error("NATIVE_CANDIDATE_GUARD_MISMATCH");
  return Buffer.from(text.replace(before, guard(instrumented)));
}

export const nativeLanCandidate = (source: Buffer) => transform(source, true);
export const nativeLanPatch = (source: Buffer) => transform(source, false);

export function nativeLanUpstream(source: Buffer): Buffer {
  const digest = createHash("sha256").update(source).digest("hex");
  if (digest === officialNativeServerSha256) return Buffer.from(source);
  if (digest !== productionNativeServerSha256)
    throw new Error("NATIVE_INSTALLED_SOURCE_MISMATCH");
  const original = Buffer.from(
    source.toString("utf8").replace(guard(false), before),
  );
  if (
    createHash("sha256").update(original).digest("hex") !==
    officialNativeServerSha256
  )
    throw new Error("NATIVE_UPSTREAM_RECONSTRUCTION_FAILED");
  return original;
}
