export interface Participant {
  peerId: string;
  displayName: string;
  identityTrust: "app-key-only";
  consent: true;
}
// Input must come from validated companion advertisements, never a Roblox roster.
export class ConsentingRoster {
  private peers = new Map<string, Participant>();
  private blocked = new Set<string>();
  constructor(private readonly capacity = 100) {}
  join(value: Participant): void {
    if (
      value.consent !== true ||
      value.identityTrust !== "app-key-only" ||
      !/^[a-f0-9]{64}$/.test(value.peerId) ||
      typeof value.displayName !== "string" ||
      value.displayName.length > 64 ||
      Array.from(value.displayName).some(
        (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
      )
    )
      throw new Error("INVALID_PARTICIPANT");
    if (this.blocked.has(value.peerId)) throw new Error("BLOCKED");
    if (!this.peers.has(value.peerId) && this.peers.size >= this.capacity)
      throw new Error("ROSTER_QUOTA");
    this.peers.set(value.peerId, {
      peerId: value.peerId,
      displayName: value.displayName,
      identityTrust: "app-key-only",
      consent: true,
    });
  }
  leave(peerId: string): void {
    this.peers.delete(peerId);
  }
  block(peerId: string): void {
    if (this.blocked.size >= 1000 && !this.blocked.has(peerId))
      throw new Error("BLOCK_QUOTA");
    this.blocked.add(peerId);
    this.leave(peerId);
  }
  list(): Participant[] {
    return [...this.peers.values()].map((peer) => ({ ...peer }));
  }
  clear(): void {
    this.peers.clear();
  }
}
