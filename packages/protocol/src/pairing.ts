import { randomBytes } from "node:crypto";
import {
  type Identity,
  peerIdFromPublicKey,
  verify,
} from "../../identity/src/index.js";
import { type RobloxClaim, validRobloxClaim } from "./roblox-account.js";

const DOMAIN = "companion/contact-invite/v1";
export const PAIRING_LIFETIME_MS = 120_000;
export const MAX_PAIRING_CODE_BYTES = 4096;
export interface ContactInvitation {
  version: 1;
  publicKey: string;
  peerId: string;
  transportKey: string;
  displayName: string;
  roblox?: RobloxClaim;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  signature: string;
}
const hex = (value: unknown, length: number): value is string =>
  typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
function validName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 64 &&
    !Array.from(value).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  );
}
function transcript(invitation: Omit<ContactInvitation, "signature">): Buffer {
  return Buffer.from(
    JSON.stringify([
      DOMAIN,
      invitation.version,
      invitation.publicKey,
      invitation.peerId,
      invitation.transportKey,
      invitation.displayName,
      invitation.nonce,
      invitation.issuedAt,
      invitation.expiresAt,
      ...(invitation.roblox
        ? [invitation.roblox.userId, invitation.roblox.username]
        : []),
    ]),
  );
}
export function createContactCode(
  identity: Identity,
  transportKey: string,
  displayName: string,
  now = Date.now(),
  roblox?: RobloxClaim,
): string {
  if (
    !hex(transportKey, 64) ||
    (roblox !== undefined && !validRobloxClaim(roblox)) ||
    !validName(displayName) ||
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !Number.isSafeInteger(now + PAIRING_LIFETIME_MS)
  )
    throw new Error("INVALID_PAIRING_OPTIONS");
  const body = {
    version: 1 as const,
    publicKey: identity.publicKey,
    peerId: identity.peerId,
    transportKey,
    displayName,
    nonce: randomBytes(16).toString("hex"),
    issuedAt: now,
    expiresAt: now + PAIRING_LIFETIME_MS,
    ...(roblox ? { roblox: { ...roblox } } : {}),
  };
  const value = {
    ...body,
    signature: identity.sign(transcript(body)).toString("hex"),
  };
  return `LM1.${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
}
export function parseContactCode(
  code: unknown,
  now = Date.now(),
): ContactInvitation {
  try {
    if (
      typeof code !== "string" ||
      Buffer.byteLength(code) > MAX_PAIRING_CODE_BYTES ||
      !Number.isSafeInteger(now) ||
      now < 0
    )
      throw new Error();
    const encoded = code.trim();
    if (!/^LM1\.[A-Za-z0-9_-]+$/.test(encoded)) throw new Error();
    const bytes = Buffer.from(encoded.slice(4), "base64url");
    if (bytes.toString("base64url") !== encoded.slice(4)) throw new Error();
    const value = JSON.parse(bytes.toString("utf8")) as ContactInvitation;
    if (
      !value ||
      ![
        "displayName,expiresAt,issuedAt,nonce,peerId,publicKey,signature,transportKey,version",
        "displayName,expiresAt,issuedAt,nonce,peerId,publicKey,roblox,signature,transportKey,version",
      ].includes(Object.keys(value).sort().join(",")) ||
      ("roblox" in value && !validRobloxClaim(value.roblox)) ||
      value.version !== 1 ||
      typeof value.publicKey !== "string" ||
      value.publicKey.length > 512 ||
      !hex(value.peerId, 64) ||
      !hex(value.transportKey, 64) ||
      !hex(value.nonce, 32) ||
      !hex(value.signature, 128) ||
      !validName(value.displayName) ||
      !Number.isSafeInteger(value.issuedAt) ||
      value.issuedAt < 0 ||
      !Number.isSafeInteger(value.expiresAt) ||
      value.expiresAt <= value.issuedAt ||
      value.expiresAt - value.issuedAt > PAIRING_LIFETIME_MS ||
      value.issuedAt > now + 5_000 ||
      value.expiresAt <= now ||
      peerIdFromPublicKey(value.publicKey) !== value.peerId ||
      !verify(
        value.publicKey,
        transcript(value),
        Buffer.from(value.signature, "hex"),
      )
    )
      throw new Error();
    return { ...value };
  } catch {
    throw new Error("INVALID_OR_EXPIRED_CONTACT_CODE");
  }
}
export interface ContactPreview {
  ticket: string;
  displayName: string;
  fingerprint: string;
  expiresAt: number;
  identityTrust: "app-key-only";
  alreadyAuthorized: boolean;
  peerId: string;
  roblox?: RobloxClaim;
  profileCheckedAt?: number;
}
