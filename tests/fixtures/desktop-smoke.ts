import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { app, BrowserWindow, powerMonitor } from "electron";
import { loadDesktopCredentials } from "../../apps/desktop/src/credentials.js";
import { createDesktop } from "../../apps/desktop/src/desktop.js";
import { DesktopMessaging } from "../../apps/desktop/src/messaging.js";
import type {
  ContactPolicy,
  DesktopNetworkFactory,
} from "../../apps/desktop/src/network.js";
import { DesktopPairing } from "../../apps/desktop/src/pairing.js";
import { DesktopSessions } from "../../apps/desktop/src/sessions.js";
import { createOverlayRuntime } from "../../packages/app-dht/src/runtime.js";
import {
  createIdentity,
  loadOrCreateIdentity,
} from "../../packages/identity/src/index.js";
import {
  DIRECT_NAMESPACE,
  DirectMessenger,
  type TextEnvelope,
} from "../../packages/protocol/src/direct.js";
import { createContactCode } from "../../packages/protocol/src/pairing.js";
import { loadTransportKeys } from "../../packages/public-discovery/src/hyperdht.js";
import { PreferenceStore } from "../../packages/security/src/preferences.js";
import { RecordStore } from "../../packages/security/src/records.js";
import { WindowsLogSessionProvider } from "../../packages/session/src/windows-logs.js";
import { VoiceCalls } from "../../packages/voice/src/calls.js";

async function run() {
  assert.equal(typeof createOverlayRuntime, "function");
  console.log("desktop stage: starting");
  const directory = process.argv[2];
  if (!directory) throw new Error("ISOLATED_DIRECTORY_REQUIRED");
  await mkdir(path.join(directory, "profile"), { recursive: true });
  app.setPath("userData", path.join(directory, "profile"));
  app.on("window-all-closed", () => {});
  const preferencesPath = path.join(directory, "preferences"),
    allowed = "ab".repeat(32);
  const logsPath = path.join(directory, "synthetic-player-logs");
  await mkdir(logsPath, { recursive: true });
  const logPrefix = `${new Date().toISOString()},1,abcd,6,Info `;
  await writeFile(
    path.join(logsPath, "0.1_Player_ABCD_last.log"),
    [
      "[FLog::Output] ! Joining game '12345678-abcd-1234-abcd-123456789abc' place 123 at 127.0.0.1",
      "[FLog::GameJoinLoadTime] Report game_join_loadtime: universeid:456, userid:999",
      "[FLog::Network] Replicator created: serverId: 127.0.0.1|1",
    ]
      .map((entry) => `${logPrefix}${entry}\n`)
      .join(""),
  );
  const seed = await PreferenceStore.open(preferencesPath);
  await seed.allow(allowed);
  await seed.close();
  await app.whenReady();
  if (process.argv[3] === "credentials-only") {
    const credentials = await loadDesktopCredentials(
      path.join(directory, "native-runtime"),
    );
    const expected = JSON.parse(
      await readFile(path.join(directory, "credentials-proof.json"), "utf8"),
    ) as { peerId: string; transportKey: string };
    assert.equal(credentials.identity.peerId, expected.peerId);
    assert.equal(
      credentials.transportKeys.publicKey.toString("hex"),
      expected.transportKey,
    );
    console.log(
      JSON.stringify({
        result: "credential-reload-passed",
        independentProcess: true,
      }),
    );
    app.quit();
    return;
  }
  console.log("desktop stage: ready");
  let desktop: Awaited<ReturnType<typeof createDesktop>> | undefined,
    foreign: BrowserWindow | undefined;
  let starts = 0,
    stops = 0,
    policy: ContactPolicy | undefined;
  const pairingRemote = createIdentity();
  let pairingAuthentications = 0;
  const self = "aa".repeat(32),
    transportKey = "cd".repeat(32);
  let messaging: DesktopMessaging | undefined,
    receiver: DirectMessenger | undefined,
    holdSends = false;
  let remoteVoice: VoiceCalls | undefined,
    localMediaStarts = 0,
    holdVoiceMute = false,
    holdVoiceInput = false;
  let failVoiceClose = false,
    failVoiceQuality = true;
  let mediaConnectionState: ((phase: string) => void) | undefined;
  const networkFactory: DesktopNetworkFactory = async (
    _signal,
    value,
    sessionOptions,
  ) => {
    assert.ok(sessionOptions);
    const records = new RecordStore(Date.now);
    const sessions = new DesktopSessions(
      createIdentity(),
      {
        async put(key, record) {
          records.put(key, record);
        },
        async lookup(key) {
          return { records: records.get(key) };
        },
      },
      transportKey,
      sessionOptions,
      value.blocked,
    );
    policy = value;
    const remote = new DirectMessenger(allowed, async () => null, {
      authorized: (id) => id === self,
    });
    const service = new DesktopMessaging(
      self,
      async (_contact, request, signal) => {
        if (holdSends && (request as { type?: string }).type === "text")
          return new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(new Error("test canceled")),
              { once: true },
            );
          });
        return remote.handle(
          { id: self, publicKey: "synthetic app", transportKey },
          request,
          signal,
        );
      },
      value,
      () => [{ id: allowed, transportKey }],
    );
    messaging = service;
    const makeMedia = (local: boolean) => {
      let phase = "negotiating",
        talking = false,
        closed = false;
      if (local)
        mediaConnectionState = (next) => {
          phase = next;
          talking = false;
        };
      return {
        async offer() {
          if (local) localMediaStarts++;
          return "synthetic offer, no microphone";
        },
        async answer() {
          if (local) localMediaStarts++;
          phase = "connected";
          return "synthetic answer, no microphone";
        },
        async acceptAnswer() {
          phase = "connected";
        },
        async setTalking(value: boolean) {
          if (local && holdVoiceMute && !value)
            await new Promise<void>(() => {});
          talking = value;
        },
        async setOutput(_volume: number, _muted: boolean) {},
        async setInputGain(value: number) {
          if (local && holdVoiceInput && value === 0)
            await new Promise<void>(() => {});
        },
        async quality() {
          if (failVoiceQuality) throw new Error("synthetic stats unavailable");
          return { roundTripMs: 18.25, jitterMs: 2.75, packetsLost: 3 };
        },
        async status() {
          return { phase, capturing: !closed, transmitting: talking };
        },
        close() {
          if (local && failVoiceClose)
            throw new Error("synthetic close failure");
          phase = "closed";
          closed = true;
          talking = false;
        },
      };
    };
    const localVoice: VoiceCalls = new VoiceCalls(
      self,
      (_contact, request, signal) =>
        otherVoice.handle(
          { id: self, publicKey: "synthetic app", transportKey },
          request,
          signal,
        ),
      {
        authorized: (id) => value.authorized(id) && !value.blocked(id),
        createMedia: () => makeMedia(true),
      },
    );
    const otherVoice: VoiceCalls = new VoiceCalls(
      allowed,
      (_contact, request, signal) =>
        localVoice.handle(
          { id: allowed, publicKey: "synthetic app", transportKey },
          request,
          signal,
        ),
      { authorized: (id) => id === self, createMedia: () => makeMedia(false) },
    );
    otherVoice.setConsent(true);
    remoteVoice = otherVoice;
    const pairing = new DesktopPairing(
      createIdentity(),
      transportKey,
      value,
      async (contact) => {
        pairingAuthentications++;
        if (contact.id !== pairingRemote.peerId)
          throw new Error("synthetic mismatch");
      },
      () => sessionOptions.preferences().displayName,
      (contact) => service.rememberContact(contact),
    );
    receiver = remote;
    return {
      messaging: service,
      voice: localVoice,
      pairing,
      sessions,
      async start() {
        starts++;
        await sessions.start();
      },
      async stop() {
        localVoice.close();
        otherVoice.close();
        await pairing.close();
        service.close();
        remote.close();
        await sessions.stop();
        stops++;
      },
      status: () => undefined,
      peerCount: () => 1,
    };
  };
  try {
    desktop = await createDesktop(
      preferencesPath,
      path.resolve("dist"),
      false,
      {
        networkFactory,
        logProvider: new WindowsLogSessionProvider([logsPath]),
      },
    );
    console.log("desktop stage: loaded");
    let contents = desktop.window.webContents;
    const execute = <T>(code: string): Promise<T> =>
      contents.executeJavaScript(code);
    async function until(code: string) {
      for (let n = 0; n < 250; n++) {
        if (await execute<boolean>(code)) return;
        await delay(20);
      }
      throw new Error(`UI_WAIT_TIMEOUT: ${code}`);
    }
    async function navigate(
      view: "overview" | "messages" | "preferences" | "overlay",
    ) {
      await execute(`document.querySelector('[data-view=${view}]').click()`);
      await until(
        `document.querySelector('#view-${view}')?.checkVisibility() && document.activeElement?.id === 'viewTitle'`,
      );
      assert.equal(
        await execute(
          `document.querySelector('[data-view=${view}]').getAttribute('aria-current')`,
        ),
        "page",
      );
      assert.equal(
        await execute(
          "Array.from(document.querySelectorAll('[id^=view-]')).filter(v => v.checkVisibility()).length",
        ),
        1,
      );
    }
    async function captureDesktop(filename: string) {
      const window = desktop?.window;
      assert.ok(window);
      const visible = window.isVisible();
      if (!visible) window.showInactive();
      await delay(100);
      await writeFile(
        path.resolve(filename),
        (await contents.capturePage()).toPNG(),
      );
      if (!visible) window.hide();
    }
    await until(
      "document.querySelector('#displayName')?.value === 'LobbyMesh user'",
    );
    const security = await execute<{
      sandboxed: boolean;
      contextIsolated: boolean;
    }>("window.companion.security()");
    assert.equal(security.sandboxed, true);
    assert.equal(security.contextIsolated, true);
    assert.deepEqual(await execute("[typeof require, typeof process]"), [
      "undefined",
      "undefined",
    ]);
    assert.equal(
      (await execute<{ network: string }>("window.companion.status()")).network,
      "offline",
    );
    assert.deepEqual(
      await execute(
        "window.companion.preferences().then(p => [p.sessionConsent, p.networkEnabled, p.voiceMode])",
      ),
      [false, false, "off"],
    );
    assert.ok(
      await execute(
        "window.companion.contact('allow', 'a'.repeat(64)).then(() => false, () => true)",
      ),
    );
    assert.equal(starts, 0);
    assert.ok(
      await execute(
        "window.companion.createPairingCode().then(() => false, () => true)",
      ),
    );
    assert.ok(
      await execute(
        "window.companion.network('yes').then(() => false, () => true)",
      ),
    );
    assert.ok(
      await execute(
        "window.companion.updatePreferences({networkEnabled:true}).then(() => false, () => true)",
      ),
    );
    await execute("document.querySelector('#networkControl').click()");
    await until(
      "document.querySelector('#networkControl')?.textContent === 'Disconnect'",
    );
    await until("window.companion.status().then(s => s.network === 'online')");
    assert.equal(starts, 1);
    assert.ok(policy?.authorized(allowed));
    assert.equal(
      await execute(
        "window.companion.preferences().then(p => p.networkEnabled)",
      ),
      true,
    );
    powerMonitor.emit("suspend");
    await until(
      "window.companion.status().then(s => s.network === 'suspended')",
    );
    powerMonitor.emit("resume");
    await until("window.companion.status().then(s => s.network === 'online')");
    assert.equal(starts, 2);
    desktop.window.show();
    desktop.window.focus();
    contents.focus();
    await delay(50);
    await execute("document.querySelector('[data-view=preferences]').focus()");
    contents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
    contents.sendInputEvent({ type: "char", keyCode: "\r" });
    contents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
    await until(
      "document.querySelector('#view-preferences')?.checkVisibility() && document.activeElement?.id === 'viewTitle'",
    );
    desktop.window.hide();
    await navigate("preferences");
    await until("!document.querySelector('#createPairingCode')?.disabled");
    await execute("document.querySelector('#createPairingCode').click()");
    await until(
      "document.querySelector('#myPairingCode')?.value.startsWith('LM1.')",
    );
    const pairingCode = createContactCode(
      pairingRemote,
      "ef".repeat(32),
      "<script>Unverified contact</script>",
    );
    await execute(
      `(() => { const input=document.querySelector('#pairingCode'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(pairingCode)}); input.dispatchEvent(new Event('input',{bubbles:true})); })()`,
    );
    await until("!document.querySelector('#previewPairingCode').disabled");
    await execute("document.querySelector('#previewPairingCode').click()");
    await until("document.querySelector('#pairingPreview') !== null");
    assert.equal(pairingAuthentications, 0);
    assert.equal(policy?.authorized(pairingRemote.peerId), false);
    assert.equal(
      await execute("document.querySelector('#approvePairingCode').disabled"),
      true,
    );
    assert.equal(
      await execute(
        "document.querySelector('#pairingPreview script') === null",
      ),
      true,
    );
    const withoutConsent = await execute<{ ticket: string }>(
      `window.companion.previewPairingCode(${JSON.stringify(pairingCode)})`,
    );
    assert.ok(
      await execute(
        `window.companion.approvePairing(${JSON.stringify(withoutConsent.ticket)},false).then(() => false, () => true)`,
      ),
    );
    await execute(
      `window.companion.cancelPairing(${JSON.stringify(withoutConsent.ticket)})`,
    );
    await execute("document.querySelector('#pairingConsent').click()");
    await execute(
      "(() => { const label=document.createElement('p'); label.className='eyebrow'; label.textContent='SYNTHETIC CONTACT · NO LIVE PERSON'; document.querySelector('#pairingPreview').prepend(label); document.querySelector('#pairingPreview').scrollIntoView(); })()",
    );
    await captureDesktop("docs/evidence/lobbymesh-pairing-test.png");
    await execute("document.querySelector('#approvePairingCode').click()");
    await until(
      "document.querySelector('#pairingNotice').textContent.includes('Contact permission saved')",
    );
    assert.equal(pairingAuthentications, 1);
    assert.equal(policy?.authorized(pairingRemote.peerId), true);
    await execute(
      `Array.from(document.querySelectorAll('.contact-row')).find(row=>row.textContent.includes(${JSON.stringify(pairingRemote.peerId.slice(0, 12))})).querySelector('button').click()`,
    );
    await until(
      `window.companion.preferences().then(p=>!p.allowedPeers.includes(${JSON.stringify(pairingRemote.peerId)}))`,
    );
    assert.equal(policy?.authorized(pairingRemote.peerId), false);
    await navigate("overview");
    await until(
      "document.querySelector('.workspace .badge')?.textContent === 'Connected'",
    );
    await execute(
      "(() => { const label = document.createElement('p'); label.id='workspaceFixture'; label.className='eyebrow'; label.textContent='NATIVE UI FIXTURE · SYNTHETIC NETWORK'; document.querySelector('.workspace').prepend(label); })()",
    );
    await delay(100);
    await captureDesktop("docs/evidence/lobbymesh-workspace-test.png");
    await execute("document.querySelector('#workspaceFixture').remove()");
    await navigate("messages");
    await until(
      `document.querySelector('#contactSelect')?.value === ${JSON.stringify(allowed)}`,
    );
    assert.equal(
      (await execute<{ enabled: boolean }>("window.companion.voice()")).enabled,
      false,
    );
    assert.equal(localMediaStarts, 0);
    assert.ok(
      await execute(
        `window.companion.voiceAction({action:'call',peerId:${JSON.stringify(allowed)},consent:true,transportKey:'ignored'}).then(()=>false,()=>true)`,
      ),
    );
    desktop.window.show();
    desktop.window.focus();
    await until("document.hasFocus()");
    await until("!document.querySelector('#voiceConsent').disabled");
    await execute("document.querySelector('#voiceConsent').click()");
    await until(
      "window.companion.voice().then(s=>s.enabled && s.phase==='idle')",
    );
    await until("document.querySelector('#callContact')?.disabled === false");
    await execute("document.querySelector('#callContact').click()");
    await until("window.companion.voice().then(s=>s.phase==='offering')");
    assert.ok(remoteVoice);
    const outbound = remoteVoice.status().callId;
    assert.ok(outbound);
    await remoteVoice.answer(outbound, true);
    await until("document.querySelector('#pushToTalk') !== null");
    await until(
      "document.querySelector('#callQuality')?.textContent.includes('Unavailable')",
    );
    failVoiceQuality = false;
    await until(
      "document.querySelector('#callQuality')?.textContent.includes('18.3 ms') && document.querySelector('#callQuality')?.textContent.includes('2.8 ms')",
    );
    failVoiceQuality = true;
    await until(
      "document.querySelector('#callQuality')?.textContent.includes('Unavailable')",
    );
    assert.equal(
      (await execute<{ phase: string }>("window.companion.voice()")).phase,
      "connected",
    );
    await execute(
      "(() => { const input=document.querySelector('#callVolume'); for(const value of [...Array.from({length:40},(_,i)=>String(i+30)),'25']) { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value); input.dispatchEvent(new Event('input',{bubbles:true})); } })()",
    );
    await until("window.companion.voice().then(s=>s.outputVolume === 0.25)");
    await execute(
      "(() => { const input=document.querySelector('#callInputGain'); for(const value of ['140','90','0','25']) {Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value); input.dispatchEvent(new Event('input',{bubbles:true}));}})()",
    );
    await until("window.companion.voice().then(s=>s.inputGain === 0.25)");
    assert.equal(
      (await execute<{ transmitting: boolean }>("window.companion.voice()"))
        .transmitting,
      false,
    );
    assert.equal(
      await execute(
        "window.companion.voice().then(s=>window.companion.voiceAction({action:'input-gain',callId:'0'.repeat(32),gain:0})).then(()=>false,()=>true)",
      ),
      true,
    );
    await execute("document.querySelector('#muteIncoming').click()");
    await until("window.companion.voice().then(s=>s.outputMuted)");
    assert.equal(
      (await execute<{ capturing: boolean }>("window.companion.voice()"))
        .capturing,
      true,
    );
    await execute("document.querySelector('#muteIncoming').click()");
    await until("window.companion.voice().then(s=>!s.outputMuted)");
    await execute("document.querySelector('#pushToTalk').focus()");
    contents.sendInputEvent({ type: "keyDown", keyCode: "Space" });
    await until("window.companion.voice().then(s=>s.transmitting)");
    await delay(900);
    assert.equal(
      (await execute<{ transmitting: boolean }>("window.companion.voice()"))
        .transmitting,
      true,
    );
    assert.ok(mediaConnectionState);
    mediaConnectionState("reconnecting");
    await until(
      "document.querySelector('#voiceState')?.textContent === 'Reconnecting audio…' && document.querySelector('#pushToTalk') === null && document.querySelector('#hangupCall') !== null",
    );
    await until(
      "window.companion.voice().then(s=>s.capturing && !s.transmitting)",
    );
    mediaConnectionState("connected");
    await until("document.querySelector('#pushToTalk') !== null");
    await delay(300);
    assert.equal(
      (await execute<{ transmitting: boolean }>("window.companion.voice()"))
        .transmitting,
      false,
    );
    contents.sendInputEvent({ type: "keyUp", keyCode: "Space" });
    await execute("document.querySelector('#pushToTalk').focus()");
    contents.sendInputEvent({ type: "keyDown", keyCode: "Space" });
    await until("window.companion.voice().then(s=>s.transmitting)");
    contents.sendInputEvent({ type: "keyUp", keyCode: "Space" });
    console.log("desktop voice: recovered with fresh press and released");
    await until("window.companion.voice().then(s=>!s.transmitting)");
    assert.ok(
      await execute(
        "window.companion.voice().then(s=>window.companion.voiceAction({action:'talk',callId:s.callId,pressed:true,start:false})).then(()=>false,()=>true)",
      ),
    );
    await execute(
      "document.querySelector('#pushToTalk').scrollIntoView({block:'center'})",
    );
    const pttPoint = await execute<{ x: number; y: number }>(
      "(() => { const r=document.querySelector('#pushToTalk').getBoundingClientRect(); return {x:Math.floor(r.left+r.width/2),y:Math.floor(r.top+r.height/2)}; })()",
    );
    contents.sendInputEvent({ type: "mouseMove", ...pttPoint });
    contents.sendInputEvent({
      type: "mouseDown",
      button: "left",
      clickCount: 1,
      ...pttPoint,
    });
    await until("window.companion.voice().then(s=>s.transmitting)");
    contents.sendInputEvent({
      type: "mouseUp",
      button: "left",
      clickCount: 1,
      ...pttPoint,
    });
    await until("window.companion.voice().then(s=>!s.transmitting)");
    contents.sendInputEvent({ type: "keyDown", keyCode: "Space" });
    await until("window.companion.voice().then(s=>s.transmitting)");
    const focusTarget = new BrowserWindow({
      show: true,
      width: 180,
      height: 100,
      skipTaskbar: true,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    focusTarget.focus();
    await until("!document.hasFocus()");
    await until("window.companion.voice().then(s=>!s.transmitting)");
    focusTarget.destroy();
    desktop.window.focus();
    await until("document.hasFocus()");
    contents.sendInputEvent({ type: "keyUp", keyCode: "Space" });
    await execute("document.querySelector('#pushToTalk').focus()");
    contents.sendInputEvent({ type: "keyDown", keyCode: "Space" });
    await until("window.companion.voice().then(s=>s.transmitting)");
    await navigate("overview");
    await until("window.companion.voice().then(s=>!s.transmitting)");
    contents.sendInputEvent({ type: "keyUp", keyCode: "Space" });
    await navigate("messages");
    await execute("document.querySelector('#hangupCall').click()");
    await until("window.companion.voice().then(s=>s.phase==='idle')");
    const beforeIncoming = localMediaStarts;
    const incomingCall = await remoteVoice.dial(
      { id: self, transportKey },
      true,
    );
    await until("document.querySelector('#answerCall') !== null");
    assert.equal(localMediaStarts, beforeIncoming);
    await execute("document.querySelector('#hangupCall').click()");
    await until("window.companion.voice().then(s=>s.phase==='idle')");
    assert.equal(remoteVoice.status().phase, "idle");
    const answered = await remoteVoice.dial({ id: self, transportKey }, true);
    assert.notEqual(answered, incomingCall);
    await until("document.querySelector('#answerCall') !== null");
    await until(
      `document.querySelector('#voicePanel')?.dataset.callId === ${JSON.stringify(answered)}`,
    );
    await execute("document.querySelector('#answerCall').click()");
    await until("document.querySelector('#pushToTalk') !== null");
    assert.equal(localMediaStarts, beforeIncoming + 1);
    assert.equal(
      (await execute<{ inputGain: number }>("window.companion.voice()"))
        .inputGain,
      1,
    );
    const originalVoiceBounds = desktop.window.getBounds();
    desktop.window.setContentSize(720, 600);
    await delay(60);
    assert.ok(
      await execute(
        "document.documentElement.scrollWidth <= document.documentElement.clientWidth",
      ),
      "active call output overflow",
    );
    desktop.window.setBounds(originalVoiceBounds);
    await delay(60);
    await execute(
      "(() => { const label=document.createElement('p'); label.className='eyebrow'; label.textContent='SYNTHETIC VOICE · NO MICROPHONE OR NETWORK'; document.querySelector('#voicePanel').prepend(label); document.querySelector('#voicePanel').scrollIntoView(); })()",
    );
    await captureDesktop("docs/evidence/lobbymesh-voice-test.png");
    await execute("document.querySelector('#pushToTalk').focus()");
    contents.sendInputEvent({ type: "keyDown", keyCode: "Space" });
    await until("window.companion.voice().then(s=>s.transmitting)");
    holdVoiceMute = true;
    contents.sendInputEvent({ type: "keyUp", keyCode: "Space" });
    await until("window.companion.voice().then(s=>s.phase==='idle')");
    holdVoiceMute = false;
    await remoteVoice.hangup();
    const gainCall = await execute<{ callId: string }>(
      `window.companion.voiceAction({action:'call',peerId:${JSON.stringify(allowed)},consent:true})`,
    );
    await remoteVoice.answer(gainCall.callId, true);
    await until("window.companion.voice().then(s=>s.phase==='connected')");
    holdVoiceInput = true;
    assert.equal(
      await execute(
        "window.companion.voice().then(s=>window.companion.voiceAction({action:'input-gain',callId:s.callId,gain:0})).then(()=>false,()=>true)",
      ),
      true,
    );
    await until(
      "window.companion.voice().then(s=>s.capturing===false && s.callId===null)",
    );
    holdVoiceInput = false;
    await execute("document.querySelector('#voicePanel .eyebrow').remove()");
    await execute("document.querySelector('#voiceConsent').click()");
    await until("window.companion.voice().then(s=>!s.enabled)");
    desktop.window.hide();
    const draft = (text: string) =>
      execute(`(() => {
      const input = document.querySelector('#messageDraft');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(text)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await draft("native UI message");
    await navigate("overview");
    await navigate("messages");
    assert.equal(
      await execute("document.querySelector('#messageDraft').value"),
      "native UI message",
    );
    await until("!document.querySelector('#sendMessage').disabled");
    await execute("document.querySelector('#sendMessage').click()");
    await until(
      "document.querySelector('#messageHistory .outgoing[data-status=acknowledged]')?.textContent.includes('native UI message')",
    );
    assert.equal(
      receiver?.history(self)[0]?.envelope.text,
      "native UI message",
    );
    if (process.platform === "win32") {
      await navigate("overlay");
      await execute("document.querySelector('#overlayEnabled').click()");
      await until("window.companion.overlay().then(s => s.state === 'ready')");
      await execute(
        "(() => { const label = document.createElement('p'); label.className='eyebrow'; label.textContent='NATIVE UI FIXTURE'; document.querySelector('#overlaySettings').prepend(label); })()",
      );
      await delay(100);
      await captureDesktop("docs/evidence/lobbymesh-overlay-settings-test.png");
      await execute("document.querySelector('[data-move-up=chat]').click()");
      await until(
        "window.companion.preferences().then(p => p.overlay.widgets.join(',') === 'network,chat,session')",
      );
      const overlayWindow = desktop.overlay.getWindow();
      assert.ok(overlayWindow);
      const overlayExecute = <T>(code: string): Promise<T> =>
        overlayWindow.webContents.executeJavaScript(code);
      const untilOverlay = async (code: string) => {
        for (let n = 0; n < 250; n++) {
          if (await overlayExecute<boolean>(code)) return;
          await delay(20);
        }
        throw new Error(`OVERLAY_UI_WAIT_TIMEOUT: ${code}`);
      };
      await untilOverlay(
        "Array.from(document.querySelectorAll('[data-overlay-widget]')).map(e => e.getAttribute('data-overlay-widget')).join(',') === 'network,chat,session'",
      );
      await untilOverlay(
        "document.querySelector('#contactSelect')?.value.length === 64",
      );
      assert.equal(overlayWindow.isFocusable(), false);
      assert.equal(overlayWindow.isAlwaysOnTop(), true);
      await untilOverlay(
        "document.querySelector('#overlayMicrophoneStatus')?.textContent === 'Microphone off'",
      );
      await execute("document.querySelector('[data-widget=voice]').click()");
      await until(
        "window.companion.preferences().then(p => p.overlay.widgets.includes('voice'))",
      );
      for (let index = 2; index >= 0; index--) {
        await execute("document.querySelector('[data-move-up=voice]').click()");
        await until(
          `window.companion.preferences().then(p => p.overlay.widgets.indexOf('voice') === ${index})`,
        );
      }
      await untilOverlay(
        "document.querySelector('[data-overlay-widget=voice]') !== null",
      );
      assert.deepEqual(
        await overlayExecute(
          "window.companion.overlayVoice().then(s => Object.keys(s).sort())",
        ),
        ["callId", "capturing", "phase", "transmitting"],
      );
      assert.ok(
        await overlayExecute(
          "window.companion.voice().then(()=>false,()=>true)",
        ),
      );
      desktop.window.show();
      desktop.window.focus();
      await until("document.hasFocus()");
      await execute(
        "window.companion.voiceAction({action:'consent',enabled:true})",
      );
      const overlayVoice = await execute<{ callId: string }>(
        `window.companion.voiceAction({action:'call',peerId:${JSON.stringify(allowed)},consent:true})`,
      );
      await remoteVoice.answer(overlayVoice.callId, true);
      await untilOverlay(
        "document.querySelector('#overlayMicrophoneStatus')?.textContent === 'Microphone on'",
      );
      await untilOverlay(
        "document.querySelector('#overlayCallPhase')?.textContent === 'Connected'",
      );
      for (const request of [
        null,
        { callId: null },
        { callId: "00".repeat(16) },
        { callId: overlayVoice.callId, consent: true },
      ]) {
        assert.ok(
          await overlayExecute(
            `window.companion.endOverlayCall(${JSON.stringify(request)}).then(()=>false,()=>true)`,
          ),
        );
      }
      assert.equal(
        (await execute<{ capturing: boolean }>("window.companion.voice()"))
          .capturing,
        true,
      );
      assert.equal(
        await overlayExecute(
          "document.querySelector('#overlayEndCall') === null",
        ),
        true,
      );
      await execute("window.companion.overlayMode(true)");
      await untilOverlay("document.querySelector('#overlayEndCall') !== null");
      await overlayExecute(
        "(() => { const label=document.createElement('p'); label.id='voiceFixture'; label.className='eyebrow'; label.textContent='SYNTHETIC VOICE · NO MICROPHONE OR NETWORK'; document.querySelector('main').prepend(label); })()",
      );
      overlayWindow.showInactive();
      await delay(200);
      await writeFile(
        path.resolve("docs/evidence/lobbymesh-overlay-voice-test.png"),
        (await overlayWindow.webContents.capturePage()).toPNG(),
      );
      overlayWindow.hide();
      await overlayExecute("document.querySelector('#voiceFixture').remove()");
      failVoiceClose = true;
      await overlayExecute("document.querySelector('#overlayEndCall').click()");
      await untilOverlay(
        "document.querySelector('#overlayMicrophoneStatus')?.textContent === 'Microphone state unknown'",
      );
      failVoiceClose = false;
      await execute(
        "window.companion.voiceAction({action:'consent',enabled:false})",
      );
      await untilOverlay(
        "document.querySelector('#overlayMicrophoneStatus')?.textContent === 'Microphone off'",
      );
      // The injected failed local teardown may prevent remote hangup delivery.
      // Explicitly end the owned remote fixture before starting a new call.
      await assert.rejects(remoteVoice.hangup(), /VOICE_DISABLED/);
      assert.equal(remoteVoice.status().callId, null);
      await execute(
        "window.companion.voiceAction({action:'consent',enabled:true})",
      );
      const replacementCall = await execute<{ callId: string }>(
        `window.companion.voiceAction({action:'call',peerId:${JSON.stringify(allowed)},consent:true})`,
      );
      await remoteVoice.answer(replacementCall.callId, true);
      await untilOverlay(
        "document.querySelector('#overlayCallPhase')?.textContent === 'Connected'",
      );
      assert.ok(
        await overlayExecute(
          `window.companion.endOverlayCall({callId:${JSON.stringify(overlayVoice.callId)}}).then(()=>false,()=>true)`,
        ),
      );
      assert.equal(
        (await execute<{ callId: string }>("window.companion.voice()")).callId,
        replacementCall.callId,
      );
      await overlayExecute("document.querySelector('#overlayEndCall').click()");
      await untilOverlay(
        "window.companion.overlayVoice().then(s => s.callId === null && s.capturing === false && s.transmitting === false)",
      );
      await execute("window.companion.overlayMode(false)");
      desktop.window.hide();
      assert.deepEqual(
        await overlayExecute("[typeof require, typeof process]"),
        ["undefined", "undefined"],
      );
      assert.ok(
        await overlayExecute(
          "window.companion.preferences().then(() => false, () => true)",
        ),
      );
      assert.ok(
        await overlayExecute(
          "window.companion.createPairingCode().then(() => false, () => true)",
        ),
      );
      assert.ok(
        await overlayExecute(
          "window.companion.voiceAction({action:'consent',enabled:true}).then(()=>false,()=>true)",
        ),
      );
      assert.ok(
        await overlayExecute(
          "window.companion.voiceAction({action:'input-gain',callId:'a'.repeat(32),gain:0}).then(()=>false,()=>true)",
        ),
      );
      assert.ok(
        await overlayExecute(
          "window.companion.network(true).then(() => false, () => true)",
        ),
      );
      await execute("window.companion.overlayMode(true)");
      assert.equal(overlayWindow.isFocusable(), true);
      await untilOverlay("document.querySelector('#overlayLock') !== null");
      await overlayExecute(`(() => {
        const input = document.querySelector('#messageDraft');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'native overlay message');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await untilOverlay("!document.querySelector('#sendMessage').disabled");
      await overlayExecute("document.querySelector('#sendMessage').click()");
      await untilOverlay(
        "document.querySelector('#messageHistory').textContent.includes('native overlay message') && document.querySelectorAll('.outgoing[data-status=acknowledged]').length >= 2",
      );
      await overlayExecute("document.querySelector('#overlayLock').click()");
      assert.equal(overlayWindow.isFocusable(), false);
      await untilOverlay("document.querySelector('#overlayLock') === null");
      await overlayExecute(
        "(() => { const label = document.createElement('p'); label.className = 'eyebrow'; label.textContent = 'SYNTHETIC TEST · NO ROBLOX'; document.querySelector('main').prepend(label); })()",
      );
      // A hidden Windows compositor can retain an older painted frame. Show
      // without focus briefly so the evidence captures the verified DOM state.
      overlayWindow.showInactive();
      await delay(200);
      await writeFile(
        path.resolve("docs/evidence/lobbymesh-overlay-test.png"),
        (await overlayWindow.webContents.capturePage()).toPNG(),
      );
      overlayWindow.hide();
      await execute("document.querySelector('[data-widget=network]').click()");
      await untilOverlay(
        "document.querySelector('[data-overlay-widget=network]') === null",
      );
      await execute("document.querySelector('#overlayEnabled').click()");
      await until(
        "window.companion.overlay().then(s => s.state === 'disabled')",
      );
      assert.equal(overlayWindow.isDestroyed(), true);
      await navigate("messages");
    }
    assert.ok(messaging);
    const incoming: TextEnvelope = {
      namespace: DIRECT_NAMESPACE,
      version: 1,
      type: "text",
      id: "12".repeat(16),
      from: allowed,
      to: self,
      senderEpoch: "34".repeat(16),
      seq: 0,
      createdAt: Date.now(),
      text: "<script>window.untrusted = true</script>",
    };
    await messaging.handle(
      { id: allowed, publicKey: "synthetic app", transportKey },
      incoming,
      new AbortController().signal,
    );
    await until(
      "document.querySelector('#messageHistory .incoming')?.textContent.includes('<script>')",
    );
    assert.equal(
      await execute(
        "document.querySelector('#messageHistory script') === null && window.untrusted === undefined",
      ),
      true,
    );
    await execute(
      "(() => { const label = document.createElement('p'); label.id = 'syntheticLabel'; label.className = 'eyebrow'; label.textContent = 'SYNTHETIC UI TEST · NO LIVE PEER'; document.querySelector('#messagesPanel').prepend(label); document.querySelector('#messagesPanel').scrollIntoView(); })()",
    );
    await delay(100);
    await captureDesktop("docs/evidence/lobbymesh-messaging-test.png");
    await execute(
      "document.querySelector('#syntheticLabel').remove(); document.querySelector('#clearMessages').click()",
    );
    await until(
      "document.querySelectorAll('#messageHistory article').length === 0",
    );
    await draft("😀".repeat(1025));
    await until("document.querySelector('#sendMessage').disabled");
    await draft("");
    await assert.rejects(
      execute(`window.companion.sendText('${"ef".repeat(32)}', 'forbidden')`),
      /CONTACT_NOT_AUTHORIZED/,
    );
    // Disconnect must remain available even when all ordinary IPC slots are busy.
    desktop.window.show();
    desktop.window.focus();
    await until("document.hasFocus()");
    await execute(
      "window.companion.voiceAction({action:'consent',enabled:true})",
    );
    holdSends = true;
    await execute(
      `(() => { window.pendingMessages = Array.from({length:16}, () => window.companion.sendText('${allowed}', 'held fixture').catch(() => null)); return true; })()`,
    );
    await delay(30);
    assert.equal(
      (await execute<{ enabled: boolean }>("window.companion.voice()")).enabled,
      true,
    );
    await execute("window.companion.network(false)");
    await execute("Promise.all(window.pendingMessages)");
    await until("window.companion.status().then(s => s.network === 'offline')");
    assert.equal(
      (await execute<{ enabled: boolean }>("window.companion.voice()")).enabled,
      false,
    );
    holdSends = false;
    await execute("window.companion.network(true)");
    await until("window.companion.status().then(s => s.network === 'online')");
    assert.equal(
      (await execute<{ enabled: boolean }>("window.companion.voice()")).enabled,
      false,
    );
    desktop.window.hide();
    await execute("window.scrollTo(0, 0)");
    await navigate("preferences");
    await execute(`(() => {
    const input = document.querySelector('#displayName');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Local smoke test');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#sessionConsent').click();
  })()`);
    await until("!document.querySelector('button[type=submit]').disabled");
    await navigate("overview");
    await navigate("preferences");
    assert.equal(
      await execute("document.querySelector('#displayName').value"),
      "Local smoke test",
    );
    assert.equal(
      await execute(
        "document.querySelector('[data-view=preferences]').getAttribute('aria-label')",
      ),
      "Preferences, unsaved changes",
    );
    await execute("document.querySelector('button[type=submit]').click()");
    await until(
      "document.querySelector('#preferencesNotice')?.textContent.includes('Saved on this device')",
    );
    const saved = await execute<{
      displayName: string;
      sessionConsent: boolean;
      networkEnabled: boolean;
      voiceMode: string;
    }>("window.companion.preferences()");
    assert.equal(saved.displayName, "Local smoke test");
    assert.equal(saved.sessionConsent, true);
    await until(
      "document.querySelector('#sessionStatus')?.textContent === 'Local session detected'",
    );
    const detectionStatus = await execute<{
      session: string;
      detection: { verification: string };
    }>("window.companion.status()");
    assert.equal(detectionStatus.session, "detected");
    assert.equal(detectionStatus.detection.verification, "self-asserted");
    await until(
      "window.companion.status().then(s => s.matching.state === 'ready' && s.matching.participants === 0)",
    );
    await until(
      "document.querySelector('#matchingStatus')?.textContent.includes('0 companions found')",
    );
    assert.equal(
      JSON.stringify(detectionStatus).includes("12345678-abcd"),
      false,
    );
    assert.equal(saved.networkEnabled, true);
    assert.equal(saved.voiceMode, "off");
    assert.ok(
      await execute(
        "window.companion.updatePreferences({unexpected: true}).then(() => false, () => true)",
      ),
    );
    // A safety action must work while unrelated preference edits are dirty,
    // during a call, and with all ordinary IPC slots occupied by sends.
    await execute(
      "(() => {const input=document.querySelector('#displayName');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Unsaved safety draft');input.dispatchEvent(new Event('input',{bubbles:true}));})()",
    );
    await navigate("messages");
    await until(
      "document.querySelector('#blockConversationContact') && !document.querySelector('#blockConversationContact').disabled",
    );
    desktop.window.show();
    desktop.window.focus();
    contents.focus();
    await until("document.hasFocus()");
    await execute(
      "window.companion.voiceAction({action:'consent',enabled:true})",
    );
    const safetyCall = await execute<{ callId: string }>(
      `window.companion.voiceAction({action:'call',peerId:${JSON.stringify(allowed)},consent:true})`,
    );
    assert.ok(remoteVoice);
    await remoteVoice.answer(safetyCall.callId, true);
    await until("window.companion.voice().then(s=>s.phase==='connected')");
    await draft("discard this blocked contact draft");
    holdSends = true;
    await execute(
      `(() => {window.safetyPending = Array.from({length:16},()=>window.companion.sendText(${JSON.stringify(allowed)},'held safety fixture').catch(()=>null));return true;})()`,
    );
    await delay(30);
    assert.equal(
      await execute(
        "window.companion.preferences().then(()=>false,error=>error.message.includes('REQUEST_QUOTA'))",
      ),
      true,
      "all ordinary IPC slots must be occupied before safety action",
    );
    await execute(
      "document.querySelector('#blockConversationContact').click()",
    );
    await execute("Promise.all(window.safetyPending)");
    holdSends = false;
    await until(
      "document.querySelector('#messageNotice')?.textContent.includes('Contact blocked on this device')",
    );
    await until(
      "window.companion.voice().then(s=>s.capturing===false && s.callId===null)",
    );
    assert.equal(policy?.authorized(allowed), false);
    assert.equal(
      (await execute<{ network: string }>("window.companion.status()")).network,
      "online",
    );
    assert.ok(
      await execute(
        `window.companion.messages(${JSON.stringify(allowed)}).then(()=>false,()=>true)`,
      ),
    );
    assert.ok(
      await execute(
        `window.companion.sendText(${JSON.stringify(allowed)},'blocked negative').then(()=>false,()=>true)`,
      ),
    );
    await navigate("preferences");
    assert.equal(
      await execute("document.querySelector('#displayName').value"),
      "Unsaved safety draft",
    );
    assert.equal(
      (await execute<{ displayName: string }>("window.companion.preferences()"))
        .displayName,
      "Local smoke test",
    );
    await execute(
      "(() => {const input=document.querySelector('#displayName');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Local smoke test');input.dispatchEvent(new Event('input',{bubbles:true}));})()",
    );
    await execute(
      "document.querySelector('#view-preferences form button[type=submit]').click()",
    );
    await until(
      "Array.from(document.querySelectorAll('button')).some(b => b.textContent === 'Unblock' && !b.disabled)",
    );
    console.log("desktop safety: blocked under load; draft retained and saved");
    await until(
      "Array.from(document.querySelectorAll('button')).some(b => b.textContent === 'Unblock')",
    );
    assert.ok(policy?.blocked(allowed));
    assert.equal(policy?.authorized(allowed), false);
    await execute(
      "Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Unblock').click()",
    );
    await until(
      "!Array.from(document.querySelectorAll('button')).some(b => b.textContent === 'Unblock')",
    );
    assert.deepEqual(
      await execute(
        "window.companion.preferences().then(p => [p.allowedPeers, p.blockedPeers])",
      ),
      [[], []],
    );
    await navigate("overview");
    await execute("document.querySelector('#networkControl').click()");
    await until("window.companion.status().then(s => s.network === 'offline')");
    await until(
      "document.querySelector('#networkControl')?.textContent === 'Enable peer discovery'",
    );
    assert.equal(stops, 3);
    foreign = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.resolve("dist/preload.cjs"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    await foreign.loadFile(path.resolve("dist/index.html"));
    for (const expression of [
      "window.companion.overlayVoice()",
      "window.companion.endOverlayCall({callId:'ab'.repeat(16)})",
    ]) {
      assert.ok(
        await foreign.webContents.executeJavaScript(
          `${expression}.then(()=>false,()=>true)`,
        ),
      );
    }
    assert.ok(
      await foreign.webContents.executeJavaScript(
        "window.companion.voiceAction({action:'consent',enabled:true}).then(()=>false,()=>true)",
      ),
    );
    assert.ok(
      await foreign.webContents.executeJavaScript(
        "window.companion.preferences().then(() => false, () => true)",
      ),
    );
    assert.ok(
      await foreign.webContents.executeJavaScript(
        "window.companion.network(true).then(() => false, () => true)",
      ),
    );
    desktop.window.setContentSize(1080, 1280);
    await navigate("preferences");
    await delay(100);
    const screenshot = path.resolve("docs/evidence/lobbymesh-settings.png");
    await captureDesktop(screenshot);
    desktop.window.setContentSize(720, 600);
    for (const view of [
      "overview",
      "messages",
      "preferences",
      "overlay",
    ] as const) {
      await navigate(view);
      assert.ok(
        await execute(
          "document.documentElement.scrollWidth <= document.documentElement.clientWidth",
        ),
        `horizontal overflow in ${view}`,
      );
    }
    desktop.window.setContentSize(1080, 800);
    if (process.platform === "win32") {
      await execute(
        "window.companion.preferences().then(p => window.companion.updatePreferences({overlay:{...p.overlay,enabled:true}}))",
      );
      assert.ok(desktop.overlay.getWindow());
    }
    // A prior explicit permission must resume without asking for network keys.
    await execute("window.companion.network(true)");
    await until("window.companion.status().then(s => s.network === 'online')");
    await desktop.close();
    assert.equal(desktop.overlay.getWindow(), undefined);
    desktop.window.destroy();
    desktop = await createDesktop(
      preferencesPath,
      path.resolve("dist"),
      false,
      {
        networkFactory,
        logProvider: new WindowsLogSessionProvider([logsPath]),
      },
    );
    contents = desktop.window.webContents;
    if (process.platform === "win32") {
      assert.equal(desktop.overlay.getWindow()?.isFocusable(), false);
      assert.deepEqual(desktop.overlay.status().preferences.widgets, [
        "voice",
        "chat",
        "session",
      ]);
      assert.equal(desktop.overlay.status().interactive, false);
    }
    await until("window.companion.status().then(s => s.network === 'online')");
    assert.equal(starts, 5);
    await execute("window.companion.network(false)");
    await until("window.companion.status().then(s => s.network === 'offline')");
    assert.equal(stops, 5);
    const canceled = new AbortController();
    const nativeDirectory = path.join(directory, "native-runtime");
    const oldIdentity = await loadOrCreateIdentity(
      path.join(nativeDirectory, "identity"),
    );
    const oldKeys = await loadTransportKeys(
      path.join(nativeDirectory, "transport"),
    );
    const credentials =
      process.platform === "win32"
        ? await loadDesktopCredentials(nativeDirectory, canceled.signal)
        : undefined;
    if (credentials) {
      assert.equal(credentials.identity.peerId, oldIdentity.peerId);
      assert.deepEqual(credentials.transportKeys.publicKey, oldKeys.publicKey);
      const identityMarker = JSON.parse(
        await readFile(
          path.join(nativeDirectory, "identity/identity-v1.json"),
          "utf8",
        ),
      );
      assert.equal(identityMarker.storage, "os-protected");
      assert.equal(
        JSON.parse(
          await readFile(
            path.join(nativeDirectory, "transport/transport-seed-v1"),
            "utf8",
          ),
        ).storage,
        "os-protected",
      );
      await writeFile(
        path.join(directory, "credentials-proof.json"),
        JSON.stringify({
          peerId: credentials.identity.peerId,
          transportKey: credentials.transportKeys.publicKey.toString("hex"),
        }),
        { mode: 0o600 },
      );
    }
    const native = await createOverlayRuntime(nativeDirectory, {
      signal: canceled.signal,
      bootstrap: ["127.0.0.1:9"],
      ...(credentials ? { credentials } : {}),
    });
    let rejected = false;
    const starting = native.start().catch(() => {
      rejected = true;
    });
    await delay(20);
    canceled.abort();
    await native.stop();
    await starting;
    assert.ok(rejected);
    await desktop.close();
    assert.equal(
      JSON.parse(
        await readFile(
          path.join(preferencesPath, "preferences-v1.json"),
          "utf8",
        ),
      ).displayName,
      "Local smoke test",
    );
    console.log(
      JSON.stringify({
        result: "passed",
        electron: process.versions.electron,
        checks: [
          "sandbox",
          "context-isolation",
          "no-renderer-node",
          "preload-ipc",
          "form-persistence",
          "consent-default-off",
          "network-and-mic-off",
          "unknown-field-rejected",
          "block-unblock-no-reauthorization",
          "foreign-window-ipc-rejected",
          "network-opt-in-and-disconnect",
          "sleep-resume-app-events",
          "persisted-network-permission-resumes",
          "live-policy-callbacks",
          "electron-native-runtime-cancellation",
          "authorized-messaging-ui",
          "explicit-voice-consent-call-answer-decline-and-ptt",
          "call-output-volume-mute-and-unknown-level",
          "call-input-gain-coalesced-reset-and-stale-id-denied",
          "input-zero-stall-stops-capture",
          "local-call-quality-measured-and-unavailable-without-call-failure",
          "voice-focus-loss-page-change-and-stalled-mute-teardown",
          "voice-overlay-ipc-denied",
          "explicit-contact-preview-approval-and-revocation",
          "conversation-block-under-load-stops-call-purges-text-and-preserves-unsaved-preferences",
          "desktop-navigation-focus-and-retained-drafts",
          "consent-controlled-log-session-matching",
          ...(process.platform === "win32"
            ? [
                "native-overlay-widgets-and-authorized-chat",
                "overlay-capture-on-unknown-and-confirmed-off",
                "overlay-current-call-redaction-stale-id-denial-and-end-only-control",
                "overlay-input-modes-and-ipc-restrictions",
              ]
            : []),
          "incoming-text-escaped",
          "message-byte-limit-and-clear",
          "disconnect-under-ipc-load",
          ...(credentials ? ["windows-os-credential-migration"] : []),
        ],
        screenshot,
      }),
    );
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    foreign?.destroy();
    desktop?.window.destroy();
    await desktop?.close();
    if (process.exitCode) app.exit(Number(process.exitCode));
    else app.quit();
  }
}
void run().catch((error: unknown) => {
  console.error(error);
  app.exit(1);
});
