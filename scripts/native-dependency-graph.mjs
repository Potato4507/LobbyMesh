import { readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

// Metadata-only comparison. Never loads dependency code or reports local paths.
async function graph(root) {
  const packages = [],
    edges = [],
    seen = new Map();
  async function visit(from, name) {
    if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name))
      throw new Error("INVALID_DEPENDENCY_NAME");
    const load = createRequire(path.join(from, "package.json"));
    let file;
    try {
      file = load.resolve(`${name}/package.json`);
    } catch {
      file = load.resolve(name);
    }
    let directory = path.dirname(await realpath(file));
    let manifest;
    for (;;) {
      try {
        const content = await readFile(
          path.join(directory, "package.json"),
          "utf8",
        );
        if (content.length > 1024 * 1024) throw new Error("MANIFEST_TOO_LARGE");
        const candidate = JSON.parse(content);
        if (candidate.name === name) {
          manifest = candidate;
          break;
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const parent = path.dirname(directory);
      if (parent === directory) throw new Error("DEPENDENCY_MANIFEST_MISSING");
      directory = parent;
    }
    if (seen.has(directory)) return seen.get(directory);
    if (packages.length >= 256) throw new Error("DEPENDENCY_GRAPH_QUOTA");
    const id = `n${packages.length}`;
    seen.set(directory, id);
    packages.push({ id, name: manifest.name, version: manifest.version });
    for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
      if (edges.length >= 1024) throw new Error("DEPENDENCY_EDGE_QUOTA");
      const target = await visit(directory, dependency);
      edges.push({ from: id, to: target, name: dependency });
    }
    return id;
  }
  await visit(root, "hyperdht");
  return { packages, edges };
}
const roots = [process.cwd()];
if (process.env.LOBBYMESH_HANDOFF_MODULE_ROOT)
  roots.push(process.env.LOBBYMESH_HANDOFF_MODULE_ROOT);
const graphs = await Promise.all(roots.map(graph));
const versions = graphs.map(
  ({ packages }) => new Set(packages.map((p) => `${p.name}@${p.version}`)),
);
console.log(
  JSON.stringify({
    coverage: "declared-dependencies-only; optional dependencies excluded",
    graphs,
    differences:
      versions.length === 2
        ? {
            repositoryOnly: [...versions[0]]
              .filter((value) => !versions[1].has(value))
              .sort(),
            comparisonOnly: [...versions[1]]
              .filter((value) => !versions[0].has(value))
              .sort(),
          }
        : null,
  }),
);
