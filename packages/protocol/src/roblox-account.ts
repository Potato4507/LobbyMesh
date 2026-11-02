export interface RobloxClaim {
  userId: number;
  username: string;
}
export function validRobloxClaim(value: unknown): value is RobloxClaim {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as RobloxClaim;
  return (
    Object.keys(item).sort().join(",") === "userId,username" &&
    Number.isSafeInteger(item.userId) &&
    item.userId > 0 &&
    typeof item.username === "string" &&
    /^[A-Za-z0-9_]{3,20}$/.test(item.username)
  );
}
export function accountProof(peerId: string, userId: number): string {
  if (
    !/^[a-f0-9]{64}$/.test(peerId) ||
    !Number.isSafeInteger(userId) ||
    userId < 1
  )
    throw new Error("INVALID_ACCOUNT_PROOF");
  return `LobbyMesh-${userId}-${peerId}`;
}
export interface AccountView {
  peerId: string;
  roblox: RobloxClaim | null;
}
export interface AccountContact {
  peerId: string;
  displayName: string;
  roblox: RobloxClaim | null;
  checkedAt: number | null;
}
