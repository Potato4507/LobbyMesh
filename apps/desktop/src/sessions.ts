import type { Identity } from "../../../packages/identity/src/index.js";
import type { SessionProvider } from "../../../packages/protocol/src/index.js";
import type { Preferences } from "../../../packages/protocol/src/preferences.js";
import {
  SessionCoordinator,
  type SessionMatchStatus,
} from "../../../packages/session/src/coordinator.js";
import {
  type SessionDirectory,
  SessionMembership,
} from "../../../packages/session/src/matching.js";

export interface DesktopSessionStatus {
  state: SessionMatchStatus["state"] | "offline";
  participants: number;
}
export interface DesktopSessionOptions {
  provider: SessionProvider;
  preferences: () => Pick<Preferences, "displayName" | "sessionConsent">;
}

// Session matches never grant contact permission or start audio. Only a redacted count reaches UI.
export class DesktopSessions {
  private readonly membership: SessionMembership;
  private readonly coordinator: SessionCoordinator;
  private closed = false;
  constructor(
    private readonly identity: Identity,
    directory: SessionDirectory,
    transportKey: string,
    private readonly options: DesktopSessionOptions,
    private readonly blocked: (id: string) => boolean,
  ) {
    this.membership = new SessionMembership(identity, directory, {
      transportKey,
      displayName: options.preferences().displayName,
      blocked,
    });
    this.coordinator = new SessionCoordinator(
      options.provider,
      this.membership,
    );
  }
  async start(): Promise<void> {
    if (this.closed) throw new Error("DESKTOP_SESSIONS_CLOSED");
    await this.settingsChanged();
    await this.coordinator.start();
  }
  settingsChanged(): Promise<void> {
    if (this.closed) return Promise.resolve();
    const preferences = this.options.preferences();
    this.membership.setDisplayName(preferences.displayName);
    return this.coordinator.setConsent(preferences.sessionConsent);
  }
  status(): DesktopSessionStatus {
    if (this.closed) return { state: "offline", participants: 0 };
    const status = this.coordinator.status();
    return {
      state: status.state,
      participants: status.participants.filter(
        (peer) =>
          peer.peerId !== this.identity.peerId && !this.blocked(peer.peerId),
      ).length,
    };
  }
  async stop(): Promise<void> {
    this.closed = true;
    await this.coordinator.stop();
  }
}
