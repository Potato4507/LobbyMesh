export interface InputChoice {
  id: string;
  label: string;
}
export interface InputOptions {
  available: boolean;
  choices: InputChoice[];
  selected: string | null;
}
export const validInputChoice = (value: unknown): value is string =>
  typeof value === "string" &&
  (value === "system-default" || /^[a-f0-9]{32}$/.test(value));
export function validInputOptions(value: unknown): value is InputOptions {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "available,choices,selected"
  )
    return false;
  const o = value as InputOptions;
  return (
    typeof o.available === "boolean" &&
    Array.isArray(o.choices) &&
    o.choices.length >= 1 &&
    o.choices.length <= 32 &&
    new Set(o.choices.map((v) => v?.id)).size === o.choices.length &&
    o.choices.every(
      (v) =>
        v &&
        typeof v === "object" &&
        Object.keys(v).sort().join(",") === "id,label" &&
        validInputChoice(v.id) &&
        typeof v.label === "string" &&
        v.label.length > 0 &&
        v.label.length <= 80 &&
        !/[\p{Cc}\p{Cf}]/u.test(v.label),
    ) &&
    (o.selected === null || o.choices.some((v) => v.id === o.selected))
  );
}
// Per-media-owner only. Device IDs never cross IPC or survive this owner.
export class InputRegistry {
  private devices = new Map<string, string>();
  private selected: string | undefined;
  private pending = false;
  private epoch = 0;
  private closed = false;
  constructor(
    private readonly enumerate: () => Promise<
      readonly { kind: string; deviceId: string; label: string }[]
    >,
    private readonly token: () => string,
    private readonly timeoutMs = 1000,
  ) {}
  invalidate() {
    this.epoch++;
    this.devices.clear();
  }
  close() {
    this.closed = true;
    this.invalidate();
  }
  resolve(id: string): string | undefined {
    if (this.closed || !validInputChoice(id))
      throw new Error("MEDIA_INPUT_CHOICE_EXPIRED");
    if (id === "system-default") return undefined;
    const value = this.devices.get(id);
    if (!value) throw new Error("MEDIA_INPUT_CHOICE_EXPIRED");
    return value;
  }
  select(raw: string | undefined) {
    this.selected = raw;
  }
  async refresh(): Promise<InputOptions> {
    const fallback = (): InputOptions => ({
      available: false,
      choices: [{ id: "system-default", label: "System default" }],
      selected: this.selected === undefined ? "system-default" : null,
    });
    if (this.closed || this.pending) return fallback();
    this.invalidate();
    this.pending = true;
    const epoch = this.epoch;
    const work = Promise.resolve()
      .then(this.enumerate)
      .finally(() => {
        this.pending = false;
      });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const values = await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("INPUT_ENUM_TIMEOUT")),
            this.timeoutMs,
          );
        }),
      ]);
      if (
        this.closed ||
        epoch !== this.epoch ||
        !Array.isArray(values) ||
        values.length > 128
      )
        return fallback();
      const next = new Map<string, string>();
      const choices: InputChoice[] = [
        { id: "system-default", label: "System default" },
      ];
      const seen = new Set<string>();
      let selected: string | null =
        this.selected === undefined ? "system-default" : null;
      for (const value of values) {
        if (choices.length >= 32) break;
        if (
          !value ||
          value.kind !== "audioinput" ||
          typeof value.deviceId !== "string" ||
          !value.deviceId ||
          value.deviceId.length > 1024 ||
          seen.has(value.deviceId)
        )
          continue;
        seen.add(value.deviceId);
        const id = this.token();
        if (!validInputChoice(id) || id === "system-default" || next.has(id))
          throw new Error("INPUT_TOKEN_FAILED");
        const label =
          typeof value.label === "string"
            ? value.label
                .replace(/[\p{Cc}\p{Cf}]/gu, "")
                .trim()
                .slice(0, 80)
            : "";
        next.set(id, value.deviceId);
        choices.push({ id, label: label || `Microphone ${choices.length}` });
        if (value.deviceId === this.selected) selected = id;
      }
      this.devices = next;
      return { available: true, choices, selected };
    } catch {
      return fallback();
    } finally {
      clearTimeout(timer);
    }
  }
}
