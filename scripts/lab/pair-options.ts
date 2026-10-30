import { parseLabOptions } from "./options.js";

export function parseLabPairOptions(args: string[]) {
  const fields = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i],
      value = args[i + 1];
    if (
      !key ||
      ![
        "--bootstrap",
        "--ssh-target",
        "--remote-root",
        "--count",
        "--scenario",
      ].includes(key) ||
      !value ||
      fields.has(key)
    )
      throw new Error("INVALID_LAB_PAIR_OPTIONS");
    fields.set(key, value);
  }
  const options = parseLabOptions([
    "--bootstrap",
    fields.get("--bootstrap") ?? "",
  ]);
  const text = fields.get("--count") ?? "4",
    count = Number(text),
    scenario = fields.get("--scenario") ?? "baseline";
  if (
    !/^\d+$/.test(text) ||
    count < 1 ||
    count > 8 ||
    fields.has("--ssh-target") !== fields.has("--remote-root") ||
    !["baseline", "restart"].includes(scenario)
  )
    throw new Error("INVALID_LAB_PAIR_OPTIONS");
  return {
    bootstrap: options.bootstrap,
    count,
    scenario: scenario as "baseline" | "restart",
    target: fields.get("--ssh-target"),
    root: fields.get("--remote-root"),
  };
}
