import { cp, lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

export interface ProductionDependencyRow {
  name: string;
  version: string;
  license: string;
  path: string;
  bundled?: boolean;
}

export async function copyProductionDependencies(
  root: string,
  appDirectory: string,
  output: string,
  entries: readonly string[] = ["hyperdht"],
) {
  const packageRows: ProductionDependencyRow[] = [];
  const destinations = new Map<string, string>();
  const dependencyEdges: { parent: string; name: string; source: string }[] =
    [];
  let copied = 0;
  const installedModules = await realpath(path.join(root, "node_modules"));
  async function locate(from: string, name: string): Promise<string> {
    if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name))
      throw new Error("INVALID_DEPENDENCY_NAME");
    for (const search of createRequire(
      path.join(from, "package.json"),
    ).resolve.paths(name) ?? []) {
      try {
        const resolved = await realpath(path.join(search, name));
        if (!resolved.startsWith(`${installedModules}${path.sep}`))
          throw new Error("DEPENDENCY_OUTSIDE_INSTALLED_TREE");
        await stat(path.join(resolved, "package.json"));
        return resolved;
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
        )
          throw error;
      }
    }
    throw new Error(`MISSING_PRODUCTION_DEPENDENCY: ${name}`);
  }
  function installedDestination(
    parent: string,
    name: string,
  ): string | undefined {
    for (const search of createRequire(
      path.join(parent, "package.json"),
    ).resolve.paths(name) ?? []) {
      const candidate = path.join(search, name);
      if (destinations.has(candidate)) return candidate;
    }
    return undefined;
  }
  async function copyPackage(
    source: string,
    parent: string,
    name: string,
    ancestors = new Set<string>(),
  ): Promise<void> {
    dependencyEdges.push({ parent, name, source });
    const existing = installedDestination(parent, name);
    if (existing && destinations.get(existing) === source) return;
    if (ancestors.has(source)) throw new Error("UNRESOLVED_DEPENDENCY_CYCLE");
    const rootDestination = path.join(appDirectory, "node_modules", name);
    const destination =
      !existing && !destinations.has(rootDestination)
        ? rootDestination
        : path.join(parent, "node_modules", name);
    if (destinations.has(destination))
      throw new Error("DEPENDENCY_DESTINATION_CONFLICT");
    try {
      await lstat(destination);
      throw new Error("DEPENDENCY_DESTINATION_EXISTS");
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error;
    }
    if (++copied > 1500 || ancestors.size > 40)
      throw new Error("DEPENDENCY_COPY_QUOTA");
    const info = JSON.parse(
      await readFile(path.join(source, "package.json"), "utf8"),
    );
    destinations.set(destination, source);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination, {
      recursive: true,
      dereference: true,
      errorOnExist: true,
      force: false,
      filter: (file) => path.basename(file) !== "node_modules",
    });
    packageRows.push({
      name: info.name,
      version: info.version,
      license: info.license ?? "UNDECLARED",
      path: path.relative(output, destination).replaceAll(path.sep, "/"),
    });
    const next = new Set([...ancestors, source]);
    const dependencies = { ...info.dependencies, ...info.optionalDependencies };
    for (const name of Object.keys(dependencies ?? {}).sort()) {
      let dependency: string;
      try {
        dependency = await locate(source, name);
      } catch (error) {
        if (
          info.optionalDependencies?.[name] &&
          error instanceof Error &&
          error.message.startsWith("MISSING_PRODUCTION_DEPENDENCY:")
        )
          continue;
        throw error;
      }
      await copyPackage(dependency, destination, name, next);
    }
  }
  for (const name of entries)
    await copyPackage(await locate(root, name), appDirectory, name);
  for (const edge of dependencyEdges) {
    const destination = installedDestination(edge.parent, edge.name);
    if (!destination || destinations.get(destination) !== edge.source)
      throw new Error("DEPENDENCY_RESOLUTION_MISMATCH");
  }
  return { rows: packageRows, copied, locate };
}
