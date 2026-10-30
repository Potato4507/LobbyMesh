export type LabSshAuth = "batch" | "askpass";
export interface LabRemote {
  target: string;
  root: string;
  layout?: "source" | "bundle";
  auth?: LabSshAuth;
}

export function validLabSshTarget(target: string): boolean {
  return /^[a-zA-Z0-9_][a-zA-Z0-9_.@:-]{0,253}$/.test(target);
}

// Passwords never enter application arguments or JSONL stdin. An explicitly
// supplied external askpass provider owns credential retrieval. Changed/unknown
// host keys still fail closed, and password mode gets one bounded prompt.
export function labSshArguments(
  target: string,
  command: readonly string[],
  auth: LabSshAuth = "batch",
  environment: NodeJS.ProcessEnv = process.env,
): string[] {
  if (!validLabSshTarget(target) || !["batch", "askpass"].includes(auth))
    throw new Error("INVALID_LAB_SSH_OPTIONS");
  if (
    auth === "askpass" &&
    (!environment.SSH_ASKPASS ||
      /[\r\n\0]/.test(environment.SSH_ASKPASS) ||
      environment.SSH_ASKPASS_REQUIRE !== "force")
  )
    throw new Error("LAB_ASKPASS_REQUIRED");
  return [
    "-T",
    "-o",
    `BatchMode=${auth === "batch" ? "yes" : "no"}`,
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ConnectTimeout=5",
    ...(auth === "askpass"
      ? [
          "-o",
          "NumberOfPasswordPrompts=1",
          "-o",
          "PreferredAuthentications=password",
          "-o",
          "PubkeyAuthentication=no",
        ]
      : []),
    target,
    ...command,
  ];
}

export function labRemoteArguments(
  remote: LabRemote,
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): string[] {
  if (
    !validLabSshTarget(remote.target) ||
    !remote.root ||
    remote.root.length > 4096 ||
    /[\r\n\0]/.test(remote.root) ||
    !["source", "bundle"].includes(remote.layout ?? "source") ||
    !["batch", "askpass"].includes(remote.auth ?? "batch") ||
    args.length > 32 ||
    args.some((value) => value.length > 4096 || /[\r\n\0]/.test(value))
  )
    throw new Error("INVALID_LAB_REMOTE");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const entry =
    remote.layout === "bundle"
      ? "./runtime/bin/node lab-peer.mjs"
      : "node --import tsx scripts/lab-peer.ts";
  return labSshArguments(
    remote.target,
    [`cd ${quote(remote.root)} && ${entry} ${args.map(quote).join(" ")}`],
    remote.auth ?? "batch",
    environment,
  );
}
