import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { app } from "electron";
import { createDesktop } from "../../apps/desktop/src/desktop.js";
import { DesktopMessaging } from "../../apps/desktop/src/messaging.js";
import { DesktopPairing } from "../../apps/desktop/src/pairing.js";
import { RobloxProfiles } from "../../apps/desktop/src/roblox-profiles.js";
import { createIdentity } from "../../packages/identity/src/index.js";
import { createContactCode } from "../../packages/protocol/src/pairing.js";
import { accountProof } from "../../packages/protocol/src/roblox-account.js";

async function run() {
  const directory = process.argv[2],
    evidence = process.argv[3];
  assert.ok(directory && evidence);
  await mkdir(path.join(directory, "profile"), { recursive: true });
  app.setPath("userData", path.join(directory, "profile"));
  app.on("window-all-closed", () => {});
  await app.whenReady();
  const self = createIdentity(),
    friend = createIdentity(),
    attacker = createIdentity();
  let posted = false,
    saves = 0;
  const claim = { userId: 123, username: "Fixture_User" };
  const request: typeof fetch = async (input) => {
    if (String(input).endsWith("usernames/users"))
      return Response.json({ data: [{ id: 123, name: "Fixture_User" }] });
    return Response.json({
      id: 123,
      name: "Fixture_User",
      isBanned: false,
      description: posted
        ? `${accountProof(self.peerId, 123)} ${accountProof(friend.peerId, 123)}`
        : "",
    });
  };
  let profiles: RobloxProfiles | undefined;
  const desktop = await createDesktop(
    path.join(directory, "preferences"),
    path.resolve("dist"),
    false,
    {
      networkFactory: async (_signal, policy, sessions) => {
        profiles = await RobloxProfiles.open(directory, self.peerId, request);
        const messaging = new DesktopMessaging(
          self.peerId,
          async () => {
            throw new Error("NO_REAL_MESSAGES");
          },
          policy,
          () => [],
        );
        const pairing = new DesktopPairing(
          self,
          "ab".repeat(32),
          policy,
          async () => {
            saves++;
          },
          () => sessions?.preferences().displayName ?? "Fixture",
          undefined,
          { profiles },
        );
        return {
          messaging,
          pairing,
          start: async () => {},
          status: () => undefined,
          peerCount: () => 0,
          stop: async () => {
            await pairing.close();
            await profiles?.close();
            messaging.close();
          },
        };
      },
    },
  );
  const contents = desktop.window.webContents;
  const execute = <T>(code: string): Promise<T> =>
    contents.executeJavaScript(code);
  const until = async (code: string) => {
    const deadline = Date.now() + 4000;
    while (!(await execute<boolean>(code))) {
      if (Date.now() > deadline) throw new Error(`IDENTITY_UI_WAIT ${code}`);
      await delay(25);
    }
  };
  const input = async (id: string, value: string, textarea = false) => {
    await execute(
      `(() => {const element=document.getElementById(${JSON.stringify(id)});Object.getOwnPropertyDescriptor(${textarea ? "HTMLTextAreaElement" : "HTMLInputElement"}.prototype,'value').set.call(element,${JSON.stringify(value)});element.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    await delay(30);
  };
  try {
    await until("window.companion.preferences().then(p => !!p)");
    await execute("document.querySelector('[data-view=preferences]').click()");
    await input("displayName", "Morgan · UI fixture");
    await execute(
      "document.querySelector('#displayName').closest('form').requestSubmit()",
    );
    await until(
      "window.companion.preferences().then(p => p.displayName === 'Morgan · UI fixture')",
    );
    await execute("window.companion.network(true)");
    await until("document.querySelector('#robloxUsername') !== null");
    await input("robloxUsername", "Fixture_User");
    await execute("document.querySelector('#beginAccountLink').click()");
    await until("document.querySelector('#accountProof') !== null");
    assert.equal(
      await execute("document.querySelector('#accountProof').value"),
      accountProof(self.peerId, 123),
    );
    await execute("document.querySelector('#confirmAccountLink').click()");
    await until(
      "document.querySelector('.identity-card output').textContent.includes('could not be confirmed')",
    );
    assert.equal(profiles?.view().roblox, null);
    posted = true;
    await execute("document.querySelector('#confirmAccountLink').click()");
    await until(
      "document.querySelector('.identity-card .trust-chip')?.textContent === 'Profile linked'",
    );
    assert.equal(profiles?.view().roblox?.username, "Fixture_User");
    const ownCode = await execute<{ code: string }>(
      "window.companion.createPairingCode()",
    );
    assert.ok(ownCode.code.startsWith("LM1."));
    const forged = createContactCode(
      attacker,
      "cc".repeat(32),
      "Morgan",
      Date.now(),
      claim,
    );
    assert.equal(
      await execute(
        `window.companion.previewPairingCode(${JSON.stringify(forged)}).then(()=>false,()=>true)`,
      ),
      true,
    );
    assert.equal(saves, 0);
    const friendCode = createContactCode(
      friend,
      "dd".repeat(32),
      "Jamie · UI fixture",
      Date.now(),
      claim,
    );
    await input("pairingCode", friendCode, true);
    await execute("document.querySelector('#previewPairingCode').click()");
    await until(
      "document.querySelector('#pairingPreview .trust-chip')?.textContent === 'Public profile checked'",
    );
    assert.equal(
      await execute("document.querySelector('#approvePairingCode').disabled"),
      true,
    );
    assert.ok(
      (
        await execute<string>(
          "document.querySelector('#pairingPreview').textContent",
        )
      ).includes(friend.peerId),
    );
    await execute(
      "document.querySelector('.identity-key').open=true;window.scrollTo(0,0)",
    );
    desktop.window.showInactive();
    await delay(100);
    await writeFile(
      path.join(evidence, "identity-preferences.png"),
      (await contents.capturePage()).toPNG(),
    );
    desktop.window.setSize(760, 720);
    await delay(100);
    assert.equal(
      await execute(
        "document.documentElement.scrollWidth <= window.innerWidth",
      ),
      true,
    );
    await writeFile(
      path.join(evidence, "identity-preferences-compact.png"),
      (await contents.capturePage()).toPNG(),
    );
    console.log(
      JSON.stringify({
        result: "identity-ui-passed",
        syntheticProfiles: true,
        externalRobloxOwnership: false,
        publicNetwork: false,
        microphone: "off",
        forgedProfileDenied: true,
        explicitConsentRequired: true,
        compactNoHorizontalOverflow: true,
        evidence,
      }),
    );
  } finally {
    await desktop.close();
    desktop.window.destroy();
    app.quit();
  }
}
run().catch((error) => {
  console.error(error);
  app.exit(1);
});
