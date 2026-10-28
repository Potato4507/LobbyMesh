export const PROTOCOL_VERSION = 1;
export type PeerId = string;
export interface PeerContact {
  id: PeerId;
  publicKey: Uint8Array;
  connectionHints: unknown[];
}
export interface SessionIdentity {
  universeId: string;
  placeId: string;
  jobId: string;
  evidenceSource: "test" | "authorized-sdk" | "official-api" | "windows-log";
  verification: "mock" | "self-asserted" | "externally-verified";
}
export interface SessionProvider {
  current(): Promise<SessionIdentity | null>;
  subscribe(handler: (session: SessionIdentity | null) => void): () => void;
}
export interface SignedRecord {
  protocolVersion: number;
  author: PeerId;
  seq: number;
  createdAt: number;
  expiresAt: number;
  content: Uint8Array;
  signature: Uint8Array;
}
export interface BootstrapDiscovery {
  start(): Promise<void>;
  findAppEntrypoints(): AsyncIterable<PeerContact>;
  announceAppEntrypoint(): Promise<void>;
  stop(): Promise<void>;
}
export interface ApplicationDHT {
  start(): Promise<void>;
  join(contact: PeerContact): Promise<void>;
  put(key: Uint8Array, record: SignedRecord): Promise<void>;
  get(key: Uint8Array): Promise<SignedRecord[]>;
  leave(): Promise<void>;
}
export function requireVersion(version: unknown): asserts version is 1 {
  if (version !== 1) throw new Error("INCOMPATIBLE_VERSION");
}
export function parseStatusRequest(value: unknown): void {
  if (value !== undefined) throw new Error("INVALID_REQUEST");
}
