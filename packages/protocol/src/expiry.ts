// One unref'd timer per owner, regardless of the number of retained entries.
export class ExpiryTimer {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private due = Infinity;
  private closed = false;
  constructor(private readonly expire: () => void) {}
  schedule(at: number, now: number): void {
    if (!Number.isFinite(now) || (at !== Infinity && !Number.isFinite(at)))
      throw new Error("INVALID_EXPIRY_CLOCK");
    if (this.closed || (this.timer && at === this.due)) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.due = at;
    if (at === Infinity) return;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.due = Infinity;
        this.expire();
      },
      Math.max(1, Math.min(2_147_483_647, at - now)),
    );
    this.timer.unref();
  }
  include(at: number, now: number): void {
    if (at < this.due) this.schedule(at, now);
  }
  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.due = Infinity;
  }
}
