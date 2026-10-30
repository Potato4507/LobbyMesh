import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { copyProductionDependencies } from "../scripts/production-dependencies.js";

async function fixture(t: test.TestContext) {
  const base = await mkdtemp(path.join(tmpdir(), "lobbymesh-dependency-copy-")),
    root = path.join(base, "source"),
    app = path.join(base, "artifact");
  t.after(async () => {
    assert.equal(path.dirname(base), path.resolve(tmpdir()));
    assert.ok(path.basename(base).startsWith("lobbymesh-dependency-copy-"));
    await rm(base, { recursive: true, force: true });
  });
  await mkdir(path.join(root, "node_modules"), { recursive: true });
  await mkdir(app);
  await writeFile(path.join(root, "package.json"), "{}");
  await writeFile(path.join(app, "package.json"), "{}");
  return { base, root, app };
}
async function moduleAt(
  directory: string,
  name: string,
  version: string,
  dependencies: Record<string, string> = {},
  optionalDependencies: Record<string, string> = {},
  body = `module.exports=${JSON.stringify(version)};`,
) {
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "package.json"),
    JSON.stringify({
      name,
      version,
      main: "index.js",
      license: "MIT",
      dependencies,
      optionalDependencies,
    }),
  );
  await writeFile(path.join(directory, "index.js"), body);
  await writeFile(
    path.join(directory, "LICENSE"),
    "fixture license retained\n",
  );
}
test("production copier hoists identical sources, preserves licenses and resolves only copied dependencies", async (t) => {
  const f = await fixture(t);
  for (const name of ["alpha", "beta"])
    await moduleAt(
      path.join(f.root, "node_modules", name),
      name,
      "1.0.0",
      { shared: "1.0.0" },
      {},
      'module.exports=require("shared");',
    );
  await moduleAt(path.join(f.root, "node_modules/shared"), "shared", "1.0.0");
  const copied = await copyProductionDependencies(f.root, f.app, f.app, [
      "alpha",
      "beta",
    ]),
    load = createRequire(path.join(f.app, "package.json"));
  assert.equal(copied.copied, 3);
  assert.equal(load("alpha"), "1.0.0");
  assert.equal(load("beta"), "1.0.0");
  assert.equal(
    await readFile(path.join(f.app, "node_modules/shared/LICENSE"), "utf8"),
    "fixture license retained\n",
  );
  assert.equal((await readdir(path.join(f.app, "node_modules"))).length, 3);
});
test("conflicting production versions stay nested with exact consumer resolution", async (t) => {
  const f = await fixture(t);
  await moduleAt(
    path.join(f.root, "node_modules/alpha"),
    "alpha",
    "1.0.0",
    { shared: "1.0.0" },
    {},
    'module.exports=require("shared");',
  );
  await moduleAt(
    path.join(f.root, "node_modules/alpha/node_modules/shared"),
    "shared",
    "1.0.0",
  );
  await moduleAt(
    path.join(f.root, "node_modules/beta"),
    "beta",
    "1.0.0",
    { shared: "2.0.0" },
    {},
    'module.exports=require("shared");',
  );
  await moduleAt(path.join(f.root, "node_modules/shared"), "shared", "2.0.0");
  const copied = await copyProductionDependencies(f.root, f.app, f.app, [
      "alpha",
      "beta",
    ]),
    load = createRequire(path.join(f.app, "package.json"));
  assert.equal(copied.copied, 4);
  assert.equal(load("alpha"), "1.0.0");
  assert.equal(load("beta"), "2.0.0");
  assert.equal(
    JSON.parse(
      await readFile(
        path.join(f.app, "node_modules/beta/node_modules/shared/package.json"),
        "utf8",
      ),
    ).version,
    "2.0.0",
  );
});
test("resolvable cycles terminate and missing optional packages do not hide required-dependency failures", async (t) => {
  const f = await fixture(t);
  await moduleAt(
    path.join(f.root, "node_modules/alpha"),
    "alpha",
    "1.0.0",
    { beta: "1.0.0" },
    { "lobbymesh-absent-optional": "1.0.0" },
  );
  await moduleAt(path.join(f.root, "node_modules/beta"), "beta", "1.0.0", {
    alpha: "1.0.0",
  });
  assert.equal(
    (await copyProductionDependencies(f.root, f.app, f.app, ["alpha"])).copied,
    2,
  );
  const g = await fixture(t);
  await moduleAt(path.join(g.root, "node_modules/alpha"), "alpha", "1.0.0", {
    "lobbymesh-absent-required": "1.0.0",
  });
  await assert.rejects(
    copyProductionDependencies(g.root, g.app, g.app, ["alpha"]),
    /MISSING_PRODUCTION_DEPENDENCY: lobbymesh-absent-required/,
  );
});
test("production copier refuses invalid names and packages escaping the installed tree", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    copyProductionDependencies(f.root, f.app, f.app, ["../owned"]),
    /INVALID_DEPENDENCY_NAME/,
  );
  const foreign = path.join(f.base, "foreign");
  await moduleAt(foreign, "alpha", "1.0.0");
  await symlink(
    foreign,
    path.join(f.root, "node_modules/alpha"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    copyProductionDependencies(f.root, f.app, f.app, ["alpha"]),
    /DEPENDENCY_OUTSIDE_INSTALLED_TREE/,
  );
  assert.deepEqual(await readdir(f.app), ["package.json"]);
});
test("production copier never merges into or overwrites a preexisting package destination", async (t) => {
  const f = await fixture(t),
    target = path.join(f.app, "node_modules/alpha");
  await moduleAt(path.join(f.root, "node_modules/alpha"), "alpha", "1.0.0");
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, "user-work.txt"), "preserve me");
  await assert.rejects(
    copyProductionDependencies(f.root, f.app, f.app, ["alpha"]),
    /DEPENDENCY_DESTINATION_EXISTS/,
  );
  assert.deepEqual(await readdir(target), ["user-work.txt"]);
  assert.equal(
    await readFile(path.join(target, "user-work.txt"), "utf8"),
    "preserve me",
  );
});
