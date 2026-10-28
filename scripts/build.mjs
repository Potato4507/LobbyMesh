import { copyFile, mkdir } from "node:fs/promises";
import { build } from "esbuild";

await mkdir("dist", { recursive: true });
for (const name of ["main", "preload", "media-preload"])
  await build({
    entryPoints: [`apps/desktop/src/${name}.ts`],
    outfile: `dist/${name}.cjs`,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron", "hyperdht"],
  });
await build({
  entryPoints: ["apps/desktop/src/renderer.tsx"],
  outfile: "dist/renderer.js",
  bundle: true,
  platform: "browser",
  format: "iife",
  jsx: "automatic",
});
await build({
  entryPoints: ["apps/desktop/src/overlay.tsx"],
  outfile: "dist/overlay.js",
  bundle: true,
  platform: "browser",
  format: "iife",
  jsx: "automatic",
});
await build({
  entryPoints: ["apps/desktop/src/media-renderer.ts"],
  outfile: "dist/media-renderer.js",
  bundle: true,
  platform: "browser",
  format: "iife",
});
for (const name of ["index.html", "overlay.html", "media.html", "style.css"])
  await copyFile(`apps/desktop/src/${name}`, `dist/${name}`);
