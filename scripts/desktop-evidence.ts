import path from "node:path";

// The driver provisions a fresh output directory, or explicitly opts into
// updating canonical screenshots. Fixtures can write only known PNG names.
export function desktopEvidencePath(directory: string, source: string): string {
  const filename = path.basename(source);
  if (
    !path.isAbsolute(directory) ||
    path.dirname(path.resolve(source)) !== path.resolve("docs/evidence") ||
    !/^lobbymesh-[a-z0-9-]+\.png$/.test(filename)
  )
    throw new Error("INVALID_DESKTOP_EVIDENCE_PATH");
  return path.join(directory, filename);
}
