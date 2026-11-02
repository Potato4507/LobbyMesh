import { randomBytes } from "node:crypto";
import type { Identity } from "../../../packages/identity/src/index.js";
import {
  type ContactInvitation,
  type ContactPreview,
  createContactCode,
  parseContactCode,
} from "../../../packages/protocol/src/pairing.js";
import type { MessagingPolicy } from "./messaging.js";
import type { RobloxProfiles } from "./roblox-profiles.js";

export class DesktopPairing {
  private readonly previews = new Map<
    string,
    { code: string; invitation: ContactInvitation }
  >();
  private active:
    | { ticket: string; controller: AbortController; finished: Promise<void> }
    | undefined;
  private closed = false;
  private revision = 0;
  constructor(
    private readonly identity: Identity,
    private readonly transportKey: string,
    private readonly policy: MessagingPolicy,
    private readonly authenticate: (
      contact: { id: string; transportKey: string },
      signal: AbortSignal,
    ) => Promise<void>,
    private readonly name: () => string,
    private readonly confirmed: (contact: {
      id: string;
      transportKey: string;
    }) => void = () => {},
    private readonly options: {
      now?: () => number;
      timeoutMs?: number;
      profiles?: RobloxProfiles;
    } = {},
  ) {
    if (
      !Number.isSafeInteger(options.timeoutMs ?? 5_000) ||
      (options.timeoutMs ?? 5_000) < 1 ||
      (options.timeoutMs ?? 5_000) > 10_000
    )
      throw new Error("INVALID_PAIRING_TIMEOUT");
  }
  private now(): number {
    return (this.options.now ?? Date.now)();
  }
  private assertOpen(): void {
    if (this.closed) throw new Error("PAIRING_CLOSED");
  }
  create(): { code: string; expiresAt: number } {
    this.assertOpen();
    const now = this.now();
    const code = createContactCode(
      this.identity,
      this.transportKey,
      this.name(),
      now,
      this.options.profiles?.view().roblox ?? undefined,
    );
    return { code, expiresAt: parseContactCode(code, now).expiresAt };
  }
  preview(code: unknown): ContactPreview {
    this.assertOpen();
    for (const [ticket, entry] of this.previews)
      if (entry.invitation.expiresAt <= this.now())
        this.previews.delete(ticket);
    if (this.previews.size >= 8) throw new Error("PAIRING_PREVIEW_QUOTA");
    const invitation = parseContactCode(code, this.now());
    if (
      invitation.peerId === this.identity.peerId ||
      invitation.transportKey === this.transportKey
    )
      throw new Error("PAIRING_SELF");
    if (this.policy.blocked(invitation.peerId))
      throw new Error("PAIRING_BLOCKED");
    const ticket = randomBytes(16).toString("hex");
    this.previews.set(ticket, { code: String(code), invitation });
    return {
      ticket,
      peerId: invitation.peerId,
      displayName: invitation.displayName,
      fingerprint:
        invitation.peerId.match(/.{4}/g)?.join(" ") ?? invitation.peerId,
      expiresAt: invitation.expiresAt,
      identityTrust: "app-key-only",
      alreadyAuthorized: this.policy.authorized(invitation.peerId),
      ...(invitation.roblox ? { roblox: { ...invitation.roblox } } : {}),
    };
  }
  account() {
    if (!this.options.profiles) throw new Error("ACCOUNT_SERVICE_UNAVAILABLE");
    return this.options.profiles;
  }
  async review(code: unknown): Promise<ContactPreview> {
    const preview = this.preview(code);
    const revision = this.revision;
    try {
      if (preview.roblox) {
        await this.account().check(preview.peerId, preview.roblox);
        if (
          this.closed ||
          revision !== this.revision ||
          !this.previews.has(preview.ticket) ||
          this.now() >= preview.expiresAt
        )
          throw new Error("PAIRING_CANCELED");
        preview.profileCheckedAt = this.now();
      }
      return preview;
    } catch (error) {
      this.cancel(preview.ticket);
      throw error;
    }
  }
  cancel(ticket: unknown): void {
    if (typeof ticket !== "string" || !/^[a-f0-9]{32}$/.test(ticket))
      throw new Error("INVALID_PAIRING_TICKET");
    this.previews.delete(ticket);
    if (this.active?.ticket === ticket) {
      this.revision++;
      this.active.controller.abort();
    }
  }
  policyChanged(): void {
    this.revision++;
    this.previews.clear();
    this.active?.controller.abort();
  }
  async approve(
    ticket: unknown,
    save: (peerId: string, guard: () => boolean) => Promise<unknown>,
  ): Promise<void> {
    this.assertOpen();
    if (typeof ticket !== "string" || !/^[a-f0-9]{32}$/.test(ticket))
      throw new Error("INVALID_PAIRING_TICKET");
    if (this.active) throw new Error("PAIRING_BUSY");
    const entry = this.previews.get(ticket);
    this.previews.delete(ticket);
    if (!entry) throw new Error("PAIRING_PREVIEW_EXPIRED");
    const invitation = parseContactCode(entry.code, this.now());
    const revision = this.revision,
      controller = new AbortController();
    const guard = () =>
      !this.closed &&
      !controller.signal.aborted &&
      revision === this.revision &&
      !this.policy.blocked(invitation.peerId) &&
      this.now() < invitation.expiresAt;
    if (!guard()) throw new Error("PAIRING_CANCELED");
    let finish = () => {};
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.active = { ticket, controller, finished };
    let rejectAbort: (error: Error) => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const onAbort = () => rejectAbort(new Error("PAIRING_CANCELED"));
    controller.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs ?? 5_000,
    );
    try {
      const contact = {
        id: invitation.peerId,
        transportKey: invitation.transportKey,
      };
      await Promise.race([
        (async () => {
          if (invitation.roblox)
            await this.account().check(
              invitation.peerId,
              invitation.roblox,
              controller.signal,
            );
          else if (this.options.profiles?.contact(invitation.peerId)?.roblox)
            throw new Error("ROBLOX_CLAIM_DOWNGRADE");
          if (!guard()) throw new Error("PAIRING_CANCELED");
          await this.authenticate(contact, controller.signal);
        })(),
        aborted,
      ]);
      clearTimeout(timer);
      if (!guard()) throw new Error("PAIRING_CANCELED");
      if (this.options.profiles) {
        await this.options.profiles.remember({
          peerId: invitation.peerId,
          displayName: invitation.displayName.replace(/[\p{Cc}\p{Cf}]/gu, ""),
          roblox: invitation.roblox ?? null,
          checkedAt: invitation.roblox ? this.now() : null,
        });
        if (!guard()) throw new Error("PAIRING_CANCELED");
      }
      await save(invitation.peerId, guard);
      if (!guard() || !this.policy.authorized(invitation.peerId))
        throw new Error("PAIRING_CANCELED");
      this.confirmed(contact);
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", onAbort);
      controller.abort();
      this.active = undefined;
      finish();
    }
  }
  close(): Promise<void> {
    this.closed = true;
    this.policyChanged();
    return this.active?.finished ?? Promise.resolve();
  }
}
