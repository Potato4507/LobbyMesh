import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  defaultOverlayPreferences,
  overlayBounds,
  parseOverlayPreferences,
} from "../packages/protocol/src/overlay.js";
import {
  defaultPreferences,
  parsePreferences,
} from "../packages/protocol/src/preferences.js";
import { PreferenceStore } from "../packages/security/src/preferences.js";

test("overlay layout validates bounded options and stays inside negative-origin and small work areas", () => {
  const value = defaultOverlayPreferences();
  assert.equal(value.enabled, false);
  for (const patch of [
    { widgets: [] },
    { widgets: ["chat", "chat"] },
    { widgets: ["microphone"] },
    { opacity: NaN },
    { opacity: 0.1 },
    { corner: "offscreen" },
    { enabled: "true" },
    { arbitrary: true },
  ])
    assert.throws(
      () => parseOverlayPreferences({ ...value, ...patch }),
      /INVALID/,
    );
  for (const area of [
    { x: -1920, y: -800, width: 1920, height: 1080 },
    { x: 0, y: 0, width: 320, height: 480 },
  ]) {
    for (const corner of [
      "top-left",
      "top-right",
      "bottom-left",
      "bottom-right",
    ] as const) {
      const bounds = overlayBounds(area, { ...value, corner });
      assert.ok(bounds.x >= area.x && bounds.y >= area.y);
      assert.ok(bounds.x + bounds.width <= area.x + area.width);
      assert.ok(bounds.y + bounds.height <= area.y + area.height);
    }
  }
  const parsed = parseOverlayPreferences(value);
  parsed.widgets.pop();
  assert.equal(value.widgets.length, 3);
});
test("legacy settings migrate overlay defaults without changing identity/contact policy; layout persists and snapshots are isolated", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "lobbymesh-overlay-settings-"),
  );
  let store: PreferenceStore | undefined;
  try {
    const { overlay: _overlay, ...legacy } = defaultPreferences();
    const peer = "ab".repeat(32);
    legacy.allowedPeers = [peer];
    await writeFile(
      path.join(directory, "preferences-v1.json"),
      JSON.stringify(legacy),
      { mode: 0o600 },
    );
    assert.deepEqual(
      parsePreferences(legacy).overlay,
      defaultOverlayPreferences(),
    );
    assert.throws(() => parsePreferences({ ...legacy, overlay: undefined }));
    store = await PreferenceStore.open(directory);
    assert.ok(store.isAuthorized(peer));
    const value = {
      ...defaultOverlayPreferences(),
      enabled: true,
      widgets: ["chat", "session"] as ("chat" | "session")[],
      corner: "bottom-left" as const,
      opacity: 0.7,
    };
    const updated = store.update({ overlay: value });
    value.widgets.pop();
    await updated;
    assert.equal(store.snapshot().overlay.widgets.length, 2);
    store.snapshot().overlay.widgets.pop();
    assert.equal(store.snapshot().overlay.widgets.length, 2);
    await store.close();
    store = await PreferenceStore.open(directory);
    assert.equal(store.snapshot().overlay.enabled, true);
    assert.equal(store.snapshot().overlay.corner, "bottom-left");
    assert.deepEqual(store.snapshot().overlay.widgets, ["chat", "session"]);
    assert.ok(store.isAuthorized(peer));
  } finally {
    await store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
