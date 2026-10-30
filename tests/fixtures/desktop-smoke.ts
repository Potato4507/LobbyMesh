import assert from "node:assert/strict";
import { mkdir, readFile, utimes, writeFile } from "node:fs/promises";
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
  const startedAt = performance.now();
  const stage = (name: string) =>
    console.log(
      JSON.stringify({
        desktopStage: name,
        elapsedMs: Math.round(performance.now() - startedAt),
      }),
    );
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
  const fixtureLog = [
    "[FLog::Output] ! Joining game '12345678-abcd-1234-abcd-123456789abc' place 123 at 127.0.0.1",
    "[FLog::GameJoinLoadTime] Report game_join_loadtime: universeid:456, userid:999",
    "[FLog::Network] Replicator created: serverId: 127.0.0.1|1",
  ]
    .map((entry) => `${logPrefix}${entry}\n`)
    .join("");
  if (process.argv[3] !== "session-status-only")
    await writeFile(
      path.join(logsPath, "0.1_Player_ABCD_last.log"),
      fixtureLog,
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
  let textFailure: string | null = null;
  let hideMessageRouting = false,
    messageClockAdvance = 0,
    holdContactSearch = false;
  let searchOutcome: "found" | "not-located" | "incomplete" = "found";
  let searchSignal: AbortSignal | undefined;
  let remoteVoice: VoiceCalls | undefined,
    localMediaStarts = 0,
    holdVoiceMute = false,
    holdVoiceInput = false;
  let failVoiceClose = false,
    failVoiceHangup = false,
    failVoiceQuality = true;
  let inputActivityMode: "unknown" | "measured" | "peaking" = "unknown";
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
        if (textFailure && (request as { type?: string }).type === "text")
          throw new Error(textFailure);
        return remote.handle(
          { id: self, publicKey: "synthetic app", transportKey },
          request,
          signal,
        );
      },
      value,
      () => (hideMessageRouting ? [] : [{ id: allowed, transportKey }]),
      () => Date.now() + messageClockAdvance,
      async (peerId, signal) => {
        searchSignal = signal;
        if (holdContactSearch)
          await new Promise<void>((_resolve, reject) => {
            if (signal.aborted) reject(new Error("canceled"));
            else
              signal.addEventListener(
                "abort",
                () => reject(new Error("canceled")),
                { once: true },
              );
          });
        return {
          contact:
            searchOutcome === "found" ? { id: peerId, transportKey } : null,
          complete: searchOutcome !== "incomplete",
        };
      },
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
        async inputChoices() {
          return {
            available: true,
            choices: [
              { id: "system-default", label: "System default" },
              { id: "f".repeat(32), label: "Synthetic microphone" },
            ],
            selected: "system-default",
          };
        },
        async switchInput(_choice: string) {
          talking = false;
        },
        async setInputGain(value: number) {
          if (local && holdVoiceInput && value === 0)
            await new Promise<void>(() => {});
        },
        async quality() {
          if (failVoiceQuality) throw new Error("synthetic stats unavailable");
          return { roundTripMs: 18.25, jitterMs: 2.75, packetsLost: 3 };
        },
        async status() {
          return {
            phase,
            capturing: !closed,
            transmitting: talking,
            inputLevel:
              inputActivityMode === "unknown"
                ? null
                : talking
                  ? inputActivityMode === "peaking"
                    ? 1
                    : 0.25
                  : 0,
            inputClipping:
              inputActivityMode === "unknown"
                ? null
                : talking && inputActivityMode === "peaking",
          };
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
      (_contact, request, signal) => {
        if (
          failVoiceHangup &&
          request &&
          typeof request === "object" &&
          "op" in request &&
          request.op === "hangup"
        )
          throw new Error("private transport notification detail");
        return otherVoice.handle(
          { id: self, publicKey: "synthetic app", transportKey },
          request,
          signal,
        );
      },
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
  let fixturePlayers: { startedAt: number }[] = [],
    activityFailure = false;
  const logProvider = new WindowsLogSessionProvider(
    [logsPath],
    process.argv[3] === "session-status-only"
      ? {
          activity: async () => {
            if (activityFailure)
              throw new Error("private synthetic activity failure");
            return fixturePlayers;
          },
        }
      : {},
  );
  try {
    desktop = await createDesktop(
      preferencesPath,
      path.resolve("dist"),
      false,
      {
        networkFactory,
        logProvider,
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
    if (process.argv[3] === "overlay-capture-only") {
      assert.equal(process.platform, "win32");
      desktop.window.show();
      desktop.window.focus();
      await until("document.hasFocus()");
      await execute("window.companion.network(true)");
      await until("window.companion.status().then(s=>s.network==='online')");
      await execute(
        "window.companion.preferences().then(p=>window.companion.updatePreferences({overlay:{...p.overlay,enabled:true,widgets:['session']}}))",
      );
      const overlay = desktop.overlay.getWindow();
      assert.ok(overlay);
      const overlayExecute = <T>(code: string): Promise<T> =>
        overlay.webContents.executeJavaScript(code);
      const indicator = async (text: string) => {
        for (let n = 0; n < 250; n++) {
          if (
            await overlayExecute(
              `document.querySelector('#overlayCaptureStatus')?.textContent === ${JSON.stringify(text)}`,
            )
          )
            return;
          await delay(20);
        }
        throw new Error("PERSISTENT_CAPTURE_STATUS_TIMEOUT");
      };
      await indicator("LobbyMesh microphone off");
      assert.equal(
        await overlayExecute(
          "document.querySelector('[data-overlay-widget=network]') === null && document.querySelector('[data-overlay-widget=voice]') === null",
        ),
        true,
      );
      await execute(
        "window.companion.voiceAction({action:'consent',enabled:true})",
      );
      const call = await execute<{ callId: string }>(
        `window.companion.voiceAction({action:'call',peerId:${JSON.stringify(allowed)},consent:true})`,
      );
      assert.ok(remoteVoice);
      await remoteVoice.answer(call.callId, true);
      await indicator("LobbyMesh microphone on");
      failVoiceClose = true;
      assert.equal(
        await execute(
          `window.companion.voiceAction({action:'hangup',callId:${JSON.stringify(call.callId)}}).then(()=>false,error=>error.message === "Error invoking remote method 'companion:voice:action': Error: VOICE_END_UNCONFIRMED")`,
        ),
        true,
      );
      await indicator("LobbyMesh microphone state unknown");
      await overlayExecute(
        "(() => {const label=document.createElement('p'); label.className='eyebrow'; label.textContent='SYNTHETIC STATUS · NO MICROPHONE'; document.querySelector('header > div').prepend(label); window.scrollTo(0,document.body.scrollHeight);})()",
      );
      overlay.showInactive();
      await delay(200);
      assert.equal(
        await overlayExecute(
          "(() => { const view=document.querySelector('#overlayCaptureStatus').getBoundingClientRect(); return window.scrollY > 0 && view.top >= 0 && view.bottom <= innerHeight; })()",
        ),
        true,
      );
      await writeFile(
        path.resolve("docs/evidence/lobbymesh-overlay-capture-test.png"),
        (await overlay.webContents.capturePage()).toPNG(),
      );
      overlay.hide();
      failVoiceClose = false;
      await execute(
        "window.companion.voiceAction({action:'consent',enabled:false})",
      );
      await indicator("LobbyMesh microphone off");
      await remoteVoice.hangup().catch(() => {});
      assert.equal(remoteVoice.status().capturing, false);
      const remote = remoteVoice;
      const startCall = async () => {
        desktop?.window.show();
        desktop?.window.focus();
        await until("document.hasFocus()");
        await execute(
          "window.companion.voiceAction({action:'consent',enabled:true})",
        );
        remote.setConsent(true);
        const next = await execute<{ callId: string }>(
          `window.companion.voiceAction({action:'call',peerId:${JSON.stringify(allowed)},consent:true})`,
        );
        await remote.answer(next.callId, true);
        await indicator("LobbyMesh microphone on");
        return next;
      };
      await navigate("messages");
      const mainCall = await startCall();
      await until(
        "document.querySelector('#hangupCall') && !document.querySelector('#hangupCall').disabled",
      );
      failVoiceHangup = true;
      await execute("document.querySelector('#hangupCall').click()");
      await until(
        "document.querySelector('#voiceNotice')?.textContent.includes('Call ended on this computer. Peer notification was not confirmed')",
      );
      await indicator("LobbyMesh microphone off");
      assert.equal(remote.status().capturing, true);
      assert.equal(
        await execute(
          "window.companion.voice().then(s=>s.capturing===false && s.transmitting===false && s.callId===null)",
        ),
        true,
      );
      assert.equal(
        await execute(
          "document.querySelector('#voiceNotice').textContent.includes('private transport')",
        ),
        false,
      );
      assert.equal(
        await execute(
          `window.companion.voiceAction({action:'hangup',callId:${JSON.stringify(mainCall.callId)}}).then(()=>false,e=>e.message === "Error invoking remote method 'companion:voice:action': Error: VOICE_STATE_MISMATCH")`,
        ),
        true,
      );
      await execute(
        "(() => {const notice=document.querySelector('#voiceNotice'); const label=document.createElement('p'); label.id='endFixture'; label.className='eyebrow'; label.textContent='SYNTHETIC CALL · NO AUDIO'; notice.before(label); notice.scrollIntoView({block:'center'});})()",
      );
      await captureDesktop("docs/evidence/lobbymesh-call-end-notice-test.png");
      await execute("document.querySelector('#endFixture').remove()");
      await remote.hangup().catch(() => {});
      const overlayCall = await startCall();
      await execute(
        "window.companion.preferences().then(p=>window.companion.updatePreferences({overlay:{...p.overlay,widgets:['voice']}}))",
      );
      await execute("window.companion.overlayMode(true)");
      for (let n = 0; n < 250; n++) {
        if (
          await overlayExecute(
            "document.querySelector('#overlayEndCall') !== null",
          )
        )
          break;
        await delay(20);
      }
      assert.equal(
        await overlayExecute(
          "document.querySelector('#overlayEndCall') !== null",
        ),
        true,
      );
      await overlayExecute("document.querySelector('#overlayEndCall').click()");
      for (let n = 0; n < 250; n++) {
        if (
          await overlayExecute(
            "document.querySelector('#overlayCallError')?.textContent.includes('Call ended on this computer. Peer notification was not confirmed')",
          )
        )
          break;
        await delay(20);
      }
      assert.equal(
        await overlayExecute(
          "document.querySelector('#overlayCallError')?.textContent.includes('Call ended on this computer. Peer notification was not confirmed')",
        ),
        true,
      );
      await indicator("LobbyMesh microphone off");
      assert.equal(remote.status().capturing, true);
      failVoiceHangup = false;
      assert.equal(
        await overlayExecute(
          `window.companion.endOverlayCall({callId:${JSON.stringify(overlayCall.callId)}}).then(()=>false,e=>e.message === "Error invoking remote method 'companion:overlay:voice:end': Error: VOICE_STATE_MISMATCH")`,
        ),
        true,
      );
      await remote.hangup().catch(() => {});
      assert.equal(
        await execute("window.companion.status().then(s=>s.network)"),
        "online",
      );
      console.log(
        JSON.stringify({
          result: "overlay-capture-passed",
          optionalCaptureWidgets: false,
          indicatorVisibleAfterScroll: true,
          states: ["off", "on", "unknown", "off"],
          endFailureProjection:
            "main-and-overlay-local-off-peer-notification-unconfirmed",
          microphone: false,
          physicalAudio: false,
        }),
      );
      return;
    }
    if (process.argv[3] === "session-status-only") {
      desktop.window.show();
      desktop.window.focus();
      await navigate("overview");
      await execute(
        "window.companion.updatePreferences({sessionConsent:true})",
      );
      await until(
        "document.querySelector('#sessionStatus')?.textContent === 'Waiting for Roblox'",
      );
      assert.equal(logProvider.status().reason, "player-not-running");
      const startedAt = Date.parse(logPrefix.split(",")[0] ?? "") - 1000;
      fixturePlayers = [{ startedAt }];
      await logProvider.refresh();
      await until(
        "document.querySelector('#sessionStatus')?.textContent === 'Waiting for player logs'",
      );
      assert.equal(logProvider.status().reason, "player-log-pending");
      const file = path.join(logsPath, "0.1_Player_ABCD_last.log");
      await writeFile(file, "");
      await logProvider.refresh();
      await until(
        "document.querySelector('#sessionStatus')?.textContent === 'Waiting for session details' && document.querySelector('#sessionSourceNotice')?.textContent.includes('No complete local session')",
      );
      await writeFile(file, `${fixtureLog.split("\n")[0]}\n`);
      await logProvider.refresh();
      await until(
        "document.querySelector('#sessionStatus')?.textContent === 'Session details incomplete' && document.querySelector('#sessionSourceNotice')?.textContent.includes('Matching stays paused')",
      );
      await writeFile(file, fixtureLog);
      await logProvider.refresh();
      await until(
        "document.querySelector('#sessionStatus')?.textContent === 'Local session detected' && document.querySelector('#sessionSourceNotice')?.textContent.includes('unverified evidence')",
      );
      await utimes(file, new Date(startedAt - 1), new Date(startedAt - 1));
      await logProvider.refresh();
      await until(
        "document.querySelector('#sessionStatus')?.textContent === 'Waiting for fresh game logs'",
      );
      await utimes(file, new Date(), new Date());
      await logProvider.refresh();
      await until(
        "document.querySelector('#sessionStatus')?.textContent === 'Local session detected'",
      );
      fixturePlayers = [{ startedAt }, { startedAt: startedAt + 1 }];
      await logProvider.refresh();
      await until(
        "document.querySelector('#sessionStatus')?.textContent === 'Session source ambiguous' && document.querySelector('#sessionSourceNotice')?.textContent.includes('More than one Roblox client')",
      );
      await execute(
        "(() => {const label=document.createElement('p');label.className='eyebrow';label.textContent='SYNTHETIC SESSION TEST · NO LIVE ROBLOX';document.querySelector('.status-grid').before(label);document.querySelector('.status-grid').scrollIntoView({block:'center'});})()",
      );
      await captureDesktop("docs/evidence/lobbymesh-session-status-test.png");
      activityFailure = true;
      await logProvider.refresh();
      await until(
        "document.querySelector('#sessionStatus')?.textContent === 'Session detection unavailable' && document.querySelector('#sessionSourceNotice')?.textContent.includes('Windows player activity is unavailable')",
      );
      activityFailure = false;
      fixturePlayers = [{ startedAt }];
      await logProvider.refresh();
      await until(
        "document.querySelector('#sessionStatus')?.textContent === 'Local session detected'",
      );
      assert.equal(
        (await logProvider.current())?.verification,
        "self-asserted",
      );
      await execute(
        "window.companion.updatePreferences({sessionConsent:false})",
      );
      await until(
        "document.querySelector('#sessionStatus')?.textContent === 'Detection off'",
      );
      assert.equal(await logProvider.current(), null);
      const status = await execute<{
        network: string;
        microphone: string;
        matching: { state: string };
      }>("window.companion.status()");
      assert.equal(status.network, "offline");
      assert.equal(status.microphone, "off");
      assert.equal(status.matching.state, "offline");
      assert.equal(starts, 0);
      assert.ok(!JSON.stringify(status).includes("12345678-abcd"));
      console.log(
        JSON.stringify({
          result: "session-status-passed",
          states: [
            "player-not-running",
            "player-log-pending",
            "log-without-session-markers",
            "incomplete",
            "detected",
            "stale",
            "ambiguous",
            "unavailable",
            "disabled",
          ],
          recovered: true,
          verification: "self-asserted",
          network: "offline",
          microphone: "off",
          actualRoblox: false,
        }),
      );
      return;
    }
    if (process.argv[3] === "conversation-clear-only") {
      desktop.window.show();
      desktop.window.focus();
      await execute("window.companion.network(true)");
      await until("window.companion.status().then(s=>s.network==='online')");
      await navigate("messages");
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
        text: "synthetic cleared message",
      };
      await messaging.handle(
        { id: allowed, publicKey: "synthetic app", transportKey },
        incoming,
        new AbortController().signal,
      );
      await until(
        "document.querySelector('#messageHistory .incoming')?.textContent.includes('synthetic cleared message')",
      );
      const draft = (text: string) =>
        execute(
          `(()=>{const input=document.querySelector('#messageDraft');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(text)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
        );
      for (let seq = 1; seq <= 6; seq++)
        await messaging.handle(
          { id: allowed, publicKey: "synthetic app", transportKey },
          {
            ...incoming,
            id: seq.toString(16).padStart(32, "0"),
            seq,
            text: `Synthetic older message ${seq}\nSecond line\nThird line`,
          },
          new AbortController().signal,
        );
      await until(
        "document.querySelectorAll('#messageHistory article').length === 7",
      );
      await draft("draft retained while reading history");
      await execute(
        `(() => { const history = document.querySelector('#messageHistory'); history.scrollTop = 0; history.dispatchEvent(new Event('scroll')); })()`,
      );
      await until("document.querySelector('#jumpToLatest') !== null");
      await execute("document.querySelector('#messageHistory').focus()");
      desktop.window.webContents.sendInputEvent({
        type: "keyDown",
        keyCode: "PageDown",
      });
      desktop.window.webContents.sendInputEvent({
        type: "keyUp",
        keyCode: "PageDown",
      });
      await until("document.querySelector('#messageHistory').scrollTop > 0");
      desktop.window.webContents.sendInputEvent({
        type: "keyDown",
        keyCode: "Home",
      });
      desktop.window.webContents.sendInputEvent({
        type: "keyUp",
        keyCode: "Home",
      });
      await until("document.querySelector('#messageHistory').scrollTop === 0");
      await messaging.handle(
        { id: allowed, publicKey: "synthetic app", transportKey },
        {
          ...incoming,
          id: "77".repeat(16),
          seq: 7,
          text: "Synthetic newest message while reading older text",
        },
        new AbortController().signal,
      );
      await until(
        "document.querySelectorAll('#messageHistory article').length === 8",
      );
      assert.equal(
        await execute("document.querySelector('#messageHistory').scrollTop"),
        0,
      );
      assert.equal(
        await execute("document.querySelector('#messageDraft').value"),
        "draft retained while reading history",
      );
      await execute("document.querySelector('#jumpToLatest').click()");
      await until("document.querySelector('#jumpToLatest') === null");
      assert.ok(
        await execute(
          "(() => {const history = document.querySelector('#messageHistory'); return history.scrollTop > 0 && history.scrollHeight - history.scrollTop - history.clientHeight < 40 && document.activeElement === history;})()",
        ),
      );
      assert.equal(
        await execute(
          "document.querySelector('#messageHistory').getAttribute('aria-label')",
        ),
        "Conversation messages",
      );
      const historyRead = messaging.history.bind(messaging);
      let heldHistory: (() => void)[] = [],
        delayHistory = true;
      messaging.history = ((peerId: string) => {
        const snapshot = historyRead(peerId);
        if (!delayHistory) return snapshot;
        return new Promise((resolve) => {
          heldHistory.push(() => resolve(snapshot));
        });
      }) as unknown as DesktopMessaging["history"];
      const historyDeadline = Date.now() + 2000;
      while (!heldHistory.length && Date.now() < historyDeadline)
        await delay(20);
      assert.ok(heldHistory.length, "old history poll was not held");
      await execute("document.querySelector('#clearMessages').click()");
      await until(
        "document.querySelectorAll('#messageHistory article').length === 0",
      );
      delayHistory = false;
      for (const finish of heldHistory) finish();
      heldHistory = [];
      await delay(100);
      assert.equal(
        await execute(
          "document.querySelectorAll('#messageHistory article').length",
        ),
        0,
      );
      messaging.history = historyRead;
      await messaging.handle(
        { id: allowed, publicKey: "synthetic app", transportKey },
        incoming,
        new AbortController().signal,
      );
      assert.deepEqual(messaging.history(allowed), []);
      await delay(1100);
      assert.equal(
        await execute(
          "document.querySelectorAll('#messageHistory article').length",
        ),
        0,
      );
      holdSends = true;
      await draft("cancel this send with clear");
      await execute(
        "document.querySelector('#messagesPanel form').requestSubmit()",
      );
      await until(
        "document.querySelector('#sendMessage')?.textContent.includes('Sending') && !document.querySelector('#clearMessages').disabled",
      );
      await execute("document.querySelector('#clearMessages').click()");
      await until(
        "document.querySelector('#messageNotice')?.textContent.includes('Local conversation cleared') && document.querySelector('#sendMessage')?.textContent === 'Send'",
      );
      assert.deepEqual(messaging.history(allowed), []);
      holdSends = false;

      holdSends = true;
      await execute(
        `(()=>{window.pendingMessages=Array.from({length:16},()=>window.companion.sendText('${allowed}','held fixture').catch(()=>null));return true;})()`,
      );
      await delay(30);
      assert.equal(
        await execute(
          "window.companion.preferences().then(()=>false,e=>e.message.includes('REQUEST_QUOTA'))",
        ),
        true,
      );
      const onePending = messaging
        .history(allowed)
        .find((row) => row.status === "sending");
      assert.ok(onePending);
      assert.deepEqual(
        await execute(
          `window.companion.cancelMessage(${JSON.stringify({ peerId: allowed, localId: onePending.localId })})`,
        ),
        { canceled: true },
      );
      await delay(10);
      assert.equal(
        messaging.history(allowed).filter((row) => row.status === "sending")
          .length,
        15,
      );
      assert.equal(
        messaging
          .history(allowed)
          .find((row) => row.localId === onePending.localId)?.failure?.reason,
        "canceled",
      );
      await execute(
        `window.pendingMessages.push(window.companion.sendText('${allowed}','replacement held fixture').catch(()=>null));true`,
      );
      await delay(30);
      assert.equal(
        await execute(
          "window.companion.preferences().then(()=>false,e=>e.message.includes('REQUEST_QUOTA'))",
        ),
        true,
      );
      await execute(`window.companion.clearMessages('${allowed}')`);
      await execute("Promise.all(window.pendingMessages)");
      assert.deepEqual(messaging.history(allowed), []);
      assert.equal(
        await execute("window.companion.status().then(s=>s.network)"),
        "online",
      );

      holdSends = false;
      for (const [code, label] of [
        [
          "REMOTE_RPC_REJECTED",
          "Peer app rejected the request · delivery unconfirmed",
        ],
        ["private synthetic error details", "Delivery unconfirmed"],
      ]) {
        textFailure = code ?? null;
        await draft("failure fixture");
        await execute(
          "document.querySelector('#messagesPanel form').requestSubmit()",
        );
        await until(
          `document.querySelector('[data-status=unconfirmed] .message-status')?.textContent === ${JSON.stringify(label)}`,
        );
        assert.equal(
          await execute("document.querySelector('#messageDraft').value"),
          "failure fixture",
        );
        assert.ok(
          !(await execute<boolean>(
            "document.querySelector('#messageHistory').textContent.includes('private synthetic error details')",
          )),
        );
        await execute("document.querySelector('#clearMessages').click()");
        await until(
          "document.querySelectorAll('#messageHistory article').length === 0",
        );
      }
      textFailure = null;
      holdSends = true;
      await draft("single local cancellation fixture");
      await execute(
        "document.querySelector('#messagesPanel form').requestSubmit()",
      );
      await until("document.querySelector('[data-cancel-send]') !== null");
      await execute(
        "(() => {const label=document.createElement('p');label.className='eyebrow';label.textContent='SYNTHETIC SEND TEST · NO LIVE PEER';document.querySelector('#messageHistory').before(label);document.querySelector('[data-cancel-send]').scrollIntoView({block:'center'});})()",
      );
      await captureDesktop("docs/evidence/lobbymesh-send-cancel-test.png");
      await execute("document.querySelector('[data-cancel-send]').click()");
      await until(
        "document.querySelector('[data-status=unconfirmed] .message-status')?.textContent.includes('Canceled locally') && document.querySelector('#messageNotice')?.textContent.includes('The peer may already have received') && document.querySelector('#sendMessage')?.textContent === 'Send'",
      );
      assert.equal(
        await execute("document.querySelector('#messageDraft').value"),
        "single local cancellation fixture",
      );
      holdSends = false;
      hideMessageRouting = true;
      messageClockAdvance = 120001;
      await draft("retained during contact discovery");
      await until(
        "document.querySelector('#contactSelect')?.selectedOptions[0]?.textContent.includes('Waiting for discovery') && document.querySelector('#sendMessage').disabled",
      );
      assert.equal(
        await execute(
          "window.companion.rediscoverContact({peerId:'a'.repeat(64)}).then(()=>false,()=>true)",
        ),
        true,
      );
      searchOutcome = "incomplete";
      await execute("document.querySelector('#findContact').click()");
      await until(
        "document.querySelector('#messageNotice')?.textContent.includes('Contact search was incomplete')",
      );
      assert.equal(
        await execute("document.querySelector('#sendMessage').disabled"),
        true,
      );
      searchOutcome = "not-located";
      messageClockAdvance += 5000;
      await execute("document.querySelector('#findContact').click()");
      await until(
        "document.querySelector('#messageNotice')?.textContent.includes('Contact not located in this attempt')",
      );
      assert.equal(
        await execute("document.querySelector('#sendMessage').disabled"),
        true,
      );
      searchOutcome = "found";
      messageClockAdvance += 5000;
      await execute("document.querySelector('#findContact').click()");
      await until(
        "document.querySelector('#messageNotice')?.textContent.includes('Verified connection details found') && document.querySelector('#contactSelect')?.selectedOptions[0]?.textContent.includes('Connection details known')",
      );
      assert.equal(
        await execute("document.querySelector('#messageDraft').value"),
        "retained during contact discovery",
      );
      await execute(
        "(() => {const label=document.createElement('p');label.className='eyebrow';label.textContent='SYNTHETIC CONTACT SEARCH · NO LIVE PEER';document.querySelector('#contactSelect').before(label);document.querySelector('#findContact').scrollIntoView({block:'center'});})()",
      );
      await captureDesktop("docs/evidence/lobbymesh-contact-search-test.png");
      messageClockAdvance += 5000;
      holdContactSearch = true;
      await execute("document.querySelector('#findContact').click()");
      await until(
        "document.querySelector('#findContact')?.disabled && document.querySelector('#messageNotice')?.textContent.includes('Looking for this approved')",
      );
      await execute(
        "document.querySelector('#blockConversationContact').click()",
      );
      await until(
        "document.querySelector('#messageNotice')?.textContent.includes('Contact blocked on this device')",
      );
      assert.equal(searchSignal?.aborted, true);
      assert.equal(policy?.blocked(allowed), true);
      console.log(
        JSON.stringify({
          result: "conversation-clear-passed",
          oldReadDiscarded: true,
          lostAckRetrySuppressed: true,
          pendingSendCanceled: true,
          clearUnderFullQuota: true,
          networkStayedOnline: true,
          deliveryReasons: "bounded-unconfirmed-and-draft-retained",
          individualCancel: "one-row-draft-retained-and-priority-quota",
          historyNavigation:
            "reading-position-retained-explicit-jump-and-focused-scroll-region",
          contactSearch:
            "incomplete-not-located-found-draft-retained-and-block-canceled",
          microphone: false,
        }),
      );
      return;
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
    await execute(
      "[...document.querySelectorAll('#callDevices button')].find(b=>b.textContent==='Refresh microphones').click()",
    );
    await until(
      "document.querySelectorAll('#callMicrophone option').length === 2",
    );
    await execute(
      "(() => {const select=document.querySelector('#callMicrophone'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'f'.repeat(32)); select.dispatchEvent(new Event('change',{bubbles:true}));})()",
    );
    await execute(
      "[...document.querySelectorAll('#callDevices button')].find(b=>b.textContent==='Use microphone').click()",
    );
    await until(
      "document.querySelector('#callDevices output')?.textContent.includes('Press Hold to talk again')",
    );
    assert.equal(
      await execute(
        "window.companion.voice().then(s=>s.phase==='connected' && !s.transmitting && s.inputGain===0.25)",
      ),
      true,
    );
    assert.equal(
      await execute(
        "window.companion.voiceInputs({callId:'0'.repeat(32)}).then(()=>false,()=>true)",
      ),
      true,
    );
    assert.equal(
      await execute(
        "window.companion.voice().then(s=>window.companion.voiceInputs({callId:s.callId,extra:true})).then(()=>false,()=>true)",
      ),
      true,
    );
    assert.equal(
      await execute(
        "window.companion.voiceAction({action:'switch-input',callId:'0'.repeat(32),choice:'system-default',consent:true}).then(()=>false,()=>true)",
      ),
      true,
    );
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
    inputActivityMode = "measured";
    await until("document.querySelector('#callInputLevel')?.value === 0.25");
    inputActivityMode = "peaking";
    await until("document.querySelector('#inputClippingNotice') !== null");
    inputActivityMode = "unknown";
    await until(
      "document.querySelector('#callInputLevel') === null && document.querySelector('#voiceState')?.textContent === 'Connected'",
    );
    inputActivityMode = "measured";
    await execute(
      "[...document.querySelectorAll('#callDevices button')].find(b=>b.textContent==='Use microphone').click()",
    );
    await until(
      "window.companion.voice().then(s=>s.phase==='connected' && !s.transmitting)",
    );
    await delay(600);
    assert.equal(
      await execute("window.companion.voice().then(s=>s.transmitting)"),
      false,
    );
    contents.sendInputEvent({ type: "keyUp", keyCode: "Space" });
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
    await execute(
      "[...document.querySelectorAll('#callDevices button')].find(b=>b.textContent==='Refresh microphones').click()",
    );
    await until(
      "document.querySelectorAll('#callMicrophone option').length === 2",
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
    stage("overlay-start");
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
      assert.deepEqual(
        await overlayExecute(
          `window.companion.rediscoverContact('${allowed}')`,
        ),
        { state: "found" },
      );
      assert.deepEqual(
        await overlayExecute(
          `window.companion.cancelMessage(${JSON.stringify({ peerId: allowed, localId: "0".repeat(32) })})`,
        ),
        { canceled: false },
      );
      assert.equal(
        await overlayExecute(
          `window.companion.cancelMessage(${JSON.stringify({ peerId: allowed, localId: "0".repeat(32), transportKey: "private" })}).then(()=>false,e=>e.message.includes('INVALID_MESSAGE_CANCEL'))`,
        ),
        true,
      );
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
      assert.equal(
        await overlayExecute(
          "document.querySelector('#overlayCaptureStatus')?.textContent",
        ),
        "LobbyMesh microphone off",
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
      assert.equal(
        await overlayExecute(
          "document.querySelector('#overlayCaptureStatus')?.textContent",
        ),
        "LobbyMesh microphone on",
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
      assert.equal(
        await overlayExecute(
          "document.querySelector('#overlayCaptureStatus')?.textContent",
        ),
        "LobbyMesh microphone state unknown",
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
      await execute("window.companion.overlayMode(true)");
      await untilOverlay("document.querySelector('#overlayLock') !== null");
      await overlayExecute(`(() => {
        const input = document.querySelector('#messageDraft');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'draft retained on Escape');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      overlayWindow.webContents.sendInputEvent({
        type: "keyUp",
        keyCode: "Escape",
      });
      await delay(25);
      assert.equal(desktop.overlay.status().interactive, true);
      overlayWindow.webContents.sendInputEvent({
        type: "keyDown",
        keyCode: "Tab",
      });
      await delay(25);
      assert.equal(desktop.overlay.status().interactive, true);
      overlayWindow.webContents.sendInputEvent({
        type: "keyDown",
        keyCode: "Escape",
      });
      await untilOverlay(
        "window.companion.overlay().then(s => !s.interactive)",
      );
      assert.equal(overlayWindow.isFocusable(), false);
      await untilOverlay("document.querySelector('#overlayLock') === null");
      assert.equal(
        await overlayExecute("document.querySelector('#messageDraft').value"),
        "draft retained on Escape",
      );
      assert.equal(
        (
          await execute<{ state: string }>(
            "window.companion.status().then(s => s.connection)",
          )
        ).state,
        "online",
      );
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
    stage("overlay-complete");
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
    stage("safety-start");
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
    stage("safety-complete");
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
    stage("foreign-sender-start");
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
      "window.companion.rediscoverContact('a'.repeat(64))",
      "window.companion.cancelMessage({peerId:'a'.repeat(64),localId:'b'.repeat(32)})",
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
          "input-activity-meter-peak-and-unknown-without-call-failure",
          "explicit-input-device-selection-current-call-and-fresh-ptt",
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
