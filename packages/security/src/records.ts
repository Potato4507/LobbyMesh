import {
  type Identity,
  peerIdFromPublicKey,
  verify,
} from "../../identity/src/index.js";
export interface RecordV1 {
  version: 1;
  domain: "app-overlay/v1";
  key: string;
  publicKey: string;
  author: string;
  seq: number;
  createdAt: number;
  expiresAt: number;
  content: string;
  signature: string;
}
function bytes(r: Omit<RecordV1, "signature">): Buffer {
  return Buffer.from(
    JSON.stringify([
      r.version,
      r.domain,
      r.key,
      r.publicKey,
      r.author,
      r.seq,
      r.createdAt,
      r.expiresAt,
      r.content,
    ]),
  );
}
export function signRecord(
  identity: Identity,
  key: string,
  content: string,
  seq: number,
  now: number,
  ttl = 60_000,
): RecordV1 {
  const record: Omit<RecordV1, "signature"> = {
    version: 1,
    domain: "app-overlay/v1",
    key,
    publicKey: identity.publicKey,
    author: identity.peerId,
    seq,
    createdAt: now,
    expiresAt: now + ttl,
    content,
  };
  return {
    ...record,
    signature: identity.sign(bytes(record)).toString("base64"),
  };
}
export function validateRecord(
  value: unknown,
  key: string,
  now: number,
): RecordV1 {
  if (
    !value ||
    typeof value !== "object" ||
    Buffer.byteLength(JSON.stringify(value)) > 8192
  )
    throw new Error("INVALID_RECORD_SIZE");
  const r = value as RecordV1;
  if (
    r.version !== 1 ||
    r.domain !== "app-overlay/v1" ||
    r.key !== key ||
    !/^[a-f0-9]{64}$/.test(r.key) ||
    typeof r.publicKey !== "string" ||
    typeof r.author !== "string" ||
    typeof r.content !== "string" ||
    typeof r.signature !== "string" ||
    !Number.isSafeInteger(r.seq) ||
    r.seq < 0 ||
    !Number.isSafeInteger(r.createdAt) ||
    !Number.isSafeInteger(r.expiresAt) ||
    r.createdAt > now ||
    r.expiresAt <= now ||
    r.expiresAt <= r.createdAt ||
    r.expiresAt - r.createdAt > 120_000
  )
    throw new Error("INVALID_RECORD");
  if (
    peerIdFromPublicKey(r.publicKey) !== r.author ||
    !verify(r.publicKey, bytes(r), Buffer.from(r.signature, "base64"))
  )
    throw new Error("INVALID_SIGNATURE");
  return { ...r };
}
export class RecordStore {
  private records = new Map<string, RecordV1>();
  // High-water marks survive expiry within this process, bounded by capacity.
  private sequences = new Map<string, number>();
  constructor(
    private readonly now: () => number,
    private readonly capacity = 1024,
  ) {}
  put(key: string, value: unknown): void {
    const record = validateRecord(value, key, this.now());
    const slot = `${key}:${record.author}`;
    if (record.seq <= (this.sequences.get(slot) ?? -1))
      throw new Error("REPLAY");
    if (!this.sequences.has(slot) && this.sequences.size >= this.capacity)
      throw new Error("QUOTA");
    this.sequences.set(slot, record.seq);
    this.records.set(slot, record);
  }
  get(key: string): RecordV1[] {
    const result: RecordV1[] = [];
    for (const [slot, record] of this.records) {
      if (record.expiresAt <= this.now()) this.records.delete(slot);
      else if (record.key === key) result.push({ ...record });
    }
    return result;
  }
  clear(): void {
    this.records.clear();
    this.sequences.clear();
  }
  scan(cursor = 0, limit = 16): { records: RecordV1[]; next: number | null } {
    if (
      !Number.isSafeInteger(cursor) ||
      cursor < 0 ||
      cursor > this.capacity ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 64
    )
      throw new Error("INVALID_SCAN");
    const records: RecordV1[] = [];
    let index = 0,
      more = false;
    for (const [slot, record] of this.records) {
      if (record.expiresAt <= this.now()) {
        this.records.delete(slot);
        continue;
      }
      if (index++ < cursor) continue;
      if (records.length === limit) {
        more = true;
        break;
      }
      records.push({ ...record });
    }
    return { records, next: more ? cursor + records.length : null };
  }
}
