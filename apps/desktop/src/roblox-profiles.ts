import { randomBytes } from "node:crypto";
import { lstat, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import {
  type AccountContact,
  accountProof,
  type RobloxClaim,
  validRobloxClaim,
} from "../../../packages/protocol/src/roblox-account.js";

// Only public Roblox user APIs. No cookies, passwords, arbitrary URLs or redirects.
export class RobloxProfiles {
  private own: RobloxClaim | null = null;
  private contacts: AccountContact[] = [];
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private readonly controller = new AbortController();
  private constructor(
    private readonly directory: string,
    readonly peerId: string,
    private readonly request: typeof fetch,
  ) {}
  static async open(directory: string, peerId: string, request = fetch) {
    accountProof(peerId, 1);
    const service = new RobloxProfiles(directory, peerId, request);
    try {
      const filename = path.join(directory, "account-links-v1.json");
      const stat = await lstat(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 131072)
        throw new Error("UNSAFE_ACCOUNT_LINKS");
      const data = JSON.parse(await readFile(filename, "utf8"));
      if (
        data.version !== 1 ||
        data.peerId !== peerId ||
        !(data.own === null || validRobloxClaim(data.own)) ||
        !Array.isArray(data.contacts) ||
        data.contacts.length > 256
      )
        throw new Error("INVALID_ACCOUNT_LINKS");
      for (const item of data.contacts) {
        if (
          !item ||
          !/^[a-f0-9]{64}$/.test(item.peerId) ||
          typeof item.displayName !== "string" ||
          item.displayName.length > 64 ||
          /[\p{Cc}\p{Cf}]/u.test(item.displayName) ||
          !(item.roblox === null || validRobloxClaim(item.roblox)) ||
          !(
            item.checkedAt === null ||
            (Number.isSafeInteger(item.checkedAt) && item.checkedAt >= 0)
          )
        )
          throw new Error("INVALID_ACCOUNT_CONTACT");
      }
      if (
        new Set(data.contacts.map((c: AccountContact) => c.peerId)).size !==
        data.contacts.length
      )
        throw new Error("DUPLICATE_ACCOUNT_CONTACT");
      service.own = data.own;
      service.contacts = data.contacts;
    } catch (error) {
      if (
        !(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        )
      )
        throw error;
    }
    return service;
  }
  view() {
    return { peerId: this.peerId, roblox: this.own ? { ...this.own } : null };
  }
  contact(peerId: string) {
    const item = this.contacts.find((c) => c.peerId === peerId);
    return item ? structuredClone(item) : null;
  }
  private async api(
    endpoint: string,
    body?: object,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const response = await this.request(
      `https://users.roblox.com/v1/${endpoint}`,
      {
        method: body ? "POST" : "GET",
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.any([
          this.controller.signal,
          AbortSignal.timeout(3500),
          ...(signal ? [signal] : []),
        ]),
      },
    );
    if (!response.ok || !response.body)
      throw new Error("ROBLOX_PROFILE_UNAVAILABLE");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 16384) throw new Error("ROBLOX_PROFILE_TOO_LARGE");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  async begin(username: unknown) {
    if (typeof username !== "string" || !/^[A-Za-z0-9_]{3,20}$/.test(username))
      throw new Error("INVALID_ROBLOX_USERNAME");
    const body = (await this.api("usernames/users", {
      usernames: [username],
      excludeBannedUsers: true,
    })) as { data?: unknown[] };
    const found = body.data?.[0] as
      | { id?: unknown; name?: unknown }
      | undefined;
    const claim = { userId: found?.id, username: found?.name };
    if (
      !validRobloxClaim(claim) ||
      claim.username.toLowerCase() !== username.toLowerCase()
    )
      throw new Error("ROBLOX_USERNAME_NOT_FOUND");
    return { ...claim, proof: accountProof(this.peerId, claim.userId) };
  }
  async check(
    peerId: string,
    claim: RobloxClaim,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!validRobloxClaim(claim)) throw new Error("INVALID_ROBLOX_CLAIM");
    const proof = accountProof(peerId, claim.userId);
    const profile = (await this.api(
      `users/${claim.userId}`,
      undefined,
      signal,
    )) as {
      id?: unknown;
      name?: unknown;
      description?: unknown;
      isBanned?: unknown;
    };
    if (
      profile.id !== claim.userId ||
      profile.name !== claim.username ||
      profile.isBanned !== false ||
      typeof profile.description !== "string" ||
      !profile.description.split(/\s+/).includes(proof)
    )
      throw new Error("ROBLOX_PROFILE_PROOF_MISSING");
    this.assertPin(peerId, claim);
  }
  private assertPin(peerId: string, claim: RobloxClaim) {
    if (
      this.contacts.some(
        (c) => c.roblox?.userId === claim.userId && c.peerId !== peerId,
      )
    )
      throw new Error("ROBLOX_ACCOUNT_KEY_CHANGED");
    const prior = this.contacts.find((c) => c.peerId === peerId);
    if (prior?.roblox && prior.roblox.userId !== claim.userId)
      throw new Error("APP_ACCOUNT_CHANGED");
  }
  private mutate(change: () => void): Promise<void> {
    const task = this.tail.then(async () => {
      if (this.closed) throw new Error("ACCOUNT_SERVICE_CLOSED");
      const previous = { own: this.own, contacts: this.contacts };
      change();
      const temporary = path.join(
        this.directory,
        `.account-links-${randomBytes(16).toString("hex")}.tmp`,
      );
      try {
        const file = await open(temporary, "wx", 0o600);
        try {
          await file.writeFile(
            JSON.stringify({
              version: 1,
              peerId: this.peerId,
              own: this.own,
              contacts: this.contacts,
            }),
          );
          await file.sync();
        } finally {
          await file.close();
        }
        if (this.closed) throw new Error("ACCOUNT_SERVICE_CLOSED");
        await rename(
          temporary,
          path.join(this.directory, "account-links-v1.json"),
        );
      } catch (error) {
        this.own = previous.own;
        this.contacts = previous.contacts;
        await unlink(temporary).catch(() => {});
        throw error;
      }
    });
    this.tail = task.catch(() => {});
    return task;
  }
  async confirm(claim: unknown) {
    if (!validRobloxClaim(claim)) throw new Error("INVALID_ROBLOX_CLAIM");
    await this.check(this.peerId, claim);
    await this.mutate(() => {
      if (this.own && this.own.userId !== claim.userId)
        throw new Error("APP_ACCOUNT_CHANGED");
      this.own = { ...claim };
    });
    return this.view();
  }
  async remember(contact: AccountContact) {
    await this.mutate(() => {
      if (contact.roblox) this.assertPin(contact.peerId, contact.roblox);
      else if (this.contacts.find((c) => c.peerId === contact.peerId)?.roblox)
        throw new Error("ROBLOX_CLAIM_DOWNGRADE");
      if (!this.contact(contact.peerId) && this.contacts.length >= 256)
        throw new Error("ACCOUNT_CONTACT_QUOTA");
      this.contacts = [
        ...this.contacts.filter((c) => c.peerId !== contact.peerId),
        structuredClone(contact),
      ];
    });
  }
  close() {
    this.closed = true;
    this.controller.abort();
    return this.tail;
  }
}
