import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { friendInstallerScript } from "../scripts/friend-installer.js";

const options = {
  packageDirectory: path.resolve("dist/example"),
  outputExecutable: path.resolve("dist/setup.exe"),
  instructions: path.resolve("docs/start.txt"),
  notices: path.resolve("docs/notices.txt"),
  smokeId: "a".repeat(32),
  files: ["LobbyMesh.exe", "manifest.json", "resources/app/main.cjs"],
};
test("friend setup is per-user and uninstall removes only enumerated files", () => {
  const source = friendInstallerScript(options);
  assert.ok(source.includes("RequestExecutionLevel user"));
  assert.ok(source.includes("CRCCheck force"));
  assert.ok(source.includes('CreateShortCut "$SMPROGRAMS\\LobbyMesh.lnk"'));
  assert.ok(
    source.includes('Delete "$INSTDIR\\App\\resources\\app\\main.cjs"'),
  );
  assert.equal(source.includes("RMDir /r"), false);
  assert.equal(source.includes("HKLM"), false);
  assert.equal(source.includes("MUI_PAGE_DIRECTORY"), false);
  assert.equal(source.includes("$APPDATA"), false);
  assert.ok(
    source.includes('StrCmp $INSTDIR "$TEMP\\lobbymesh-installer-smoke-'),
  );
  assert.ok(
    source.includes(
      '!define MUI_FINISHPAGE_RUN "$INSTDIR\\App\\LobbyMesh.exe"',
    ),
  );
});
test("installer generation rejects path traversal, macro injection and duplicate payload paths", () => {
  for (const file of [
    "../outside",
    "C:/outside",
    "/outside",
    "resources/../outside",
    'x"',
    "$INSTDIR/file",
    "a\\b",
    "a\nb",
    "a//b",
  ])
    assert.throws(() => friendInstallerScript({ ...options, files: [file] }));
  assert.throws(
    () => friendInstallerScript({ ...options, files: ["one", "ONE"] }),
    /DUPLICATE/,
  );
  assert.throws(
    () => friendInstallerScript({ ...options, smokeId: "../outside" }),
    /INVALID/,
  );
  assert.throws(
    () => friendInstallerScript({ ...options, packageDirectory: "relative" }),
    /ABSOLUTE/,
  );
});
