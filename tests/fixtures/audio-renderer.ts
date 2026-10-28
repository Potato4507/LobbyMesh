import { AudioPeer } from "../../packages/voice/src/audio-peer.js";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function run() {
  const context = new AudioContext();
  await context.resume();
  const peers: AudioPeer[] = [],
    sources: OscillatorNode[] = [],
    tracks: MediaStreamTrack[] = [];
  let captures = 0;
  const analysers: AnalyserNode[] = [];
  const sinks: HTMLAudioElement[] = [];
  const rms = () => {
    const analyser = analysers[0];
    check(analyser, "REMOTE_AUDIO_SINK_MISSING");
    const samples = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(samples);
    return Math.sqrt(
      samples.reduce((sum, value) => sum + value * value, 0) / samples.length,
    );
  };
  const capture = async (constraints: MediaStreamConstraints) => {
    check(
      constraints.video === false && typeof constraints.audio === "object",
      "AUDIO_ONLY_CONSTRAINTS",
    );
    captures++;
    const source = context.createOscillator(),
      destination = context.createMediaStreamDestination();
    source.frequency.value = 440;
    source.connect(destination);
    source.start();
    sources.push(source);
    tracks.push(...destination.stream.getTracks());
    return destination.stream;
  };
  const create = (
    permitted: () => boolean,
    customCapture = capture,
    timeoutMs = 5000,
  ) => {
    const peer = new AudioPeer({
      permitted,
      capture: customCapture,
      timeoutMs,
      onRemoteStream: (stream) => {
        const sink = new Audio();
        sink.srcObject = stream;
        sink.volume = 0;
        sinks.push(sink);
        void sink.play();
        const input = context.createMediaStreamSource(stream),
          silence = context.createGain(),
          analyser = context.createAnalyser();
        analysers.push(analyser);
        silence.gain.value = 0;
        input.connect(analyser);
        analyser.connect(silence);
        silence.connect(context.destination);
      },
    });
    peers.push(peer);
    return peer;
  };
  try {
    const denied = create(() => false);
    await denied.offer(true).then(
      () => {
        throw new Error("DENIED_CAPTURE_ACCEPTED");
      },
      () => {},
    );
    const noConsent = create(() => true);
    await noConsent.offer(false).then(
      () => {
        throw new Error("NO_CONSENT_ACCEPTED");
      },
      () => {},
    );
    check(captures === 0, "CAPTURE_BEFORE_PERMISSION");
    const invalid = create(() => true);
    await invalid.answer("untrusted invalid SDP", true).then(
      () => {
        throw new Error("INVALID_SDP_ACCEPTED");
      },
      () => {},
    );
    check(captures === 0, "INVALID_OFFER_CAPTURED");
    const browserDenied = new AudioPeer({ permitted: () => true });
    peers.push(browserDenied);
    await browserDenied.offer(true).then(
      () => {
        throw new Error("BROWSER_PERMISSION_BYPASSED");
      },
      () => {},
    );
    check(!browserDenied.status().capturing, "BROWSER_DENIAL_CAPTURE_LEAK");
    let permitted = true;
    const left = create(() => permitted),
      right = create(() => true);
    const offer = await left.offer(true);
    check(
      !left.status().transmitting && tracks.every((track) => !track.enabled),
      "NOT_MUTED_BY_DEFAULT",
    );
    const answer = await right.answer(offer, true);
    await left.acceptAnswer(answer);
    const expires = performance.now() + 7000;
    while (
      (left.status().phase !== "connected" ||
        right.status().phase !== "connected") &&
      performance.now() < expires
    )
      await delay(25);
    check(
      left.status().phase === "connected" &&
        right.status().phase === "connected",
      "LOCAL_WEBRTC_NOT_CONNECTED",
    );
    await delay(300);
    const muted = await right.metrics();
    const mutedRms = rms();
    check(mutedRms < 0.00001, "MUTED_AUDIO_LEAK");
    left.setTalking(true);
    await delay(600);
    const talking = await right.metrics();
    const talkingRms = rms();
    check(
      talking.receivedPackets > muted.receivedPackets &&
        talking.receivedBytes > muted.receivedBytes &&
        talkingRms > 0.01,
      `NO_SYNTHETIC_RTP_AUDIO ${JSON.stringify({ muted, talking, mutedRms, talkingRms, context: context.state })}`,
    );
    left.setTalking(false);
    check(
      !left.status().transmitting && !tracks[0]?.enabled,
      "PTT_RELEASE_FAILED",
    );
    await delay(400);
    const releasedRms = rms();
    check(releasedRms < 0.00001, "AUDIO_AFTER_PTT_RELEASE");
    permitted = false;
    check(
      left.status().phase === "closed" &&
        !left.status().capturing &&
        tracks[0]?.readyState === "ended",
      "REVOKE_DID_NOT_STOP_CAPTURE",
    );
    right.close();
    check(
      tracks.slice(0, 2).every((track) => track.readyState === "ended"),
      "TRACKS_NOT_STOPPED",
    );
    let resolveCapture: (stream: MediaStream) => void = () => {};
    const late = create(
      () => true,
      () =>
        new Promise((resolve) => {
          resolveCapture = resolve;
        }),
      25,
    );
    await late.offer(true).then(
      () => {
        throw new Error("STALLED_CAPTURE_ACCEPTED");
      },
      (error: Error) =>
        check(error.message === "MEDIA_TIMEOUT", "CAPTURE_TIMEOUT_REASON"),
    );
    const lateStream = await capture({ audio: {}, video: false });
    resolveCapture(lateStream);
    await delay(0);
    check(
      lateStream.getTracks().every((track) => track.readyState === "ended"),
      "LATE_CAPTURE_LEAK",
    );
    const canceled = create(
      () => true,
      () =>
        new Promise((resolve) => {
          resolveCapture = resolve;
        }),
    );
    const canceledOffer = canceled.offer(true);
    await canceled.offer(true).then(
      () => {
        throw new Error("OVERLAPPING_CAPTURE_ACCEPTED");
      },
      (error: Error) => check(error.message === "MEDIA_BUSY", "BUSY_REASON"),
    );
    canceled.close();
    await canceledOffer.then(
      () => {
        throw new Error("CLOSED_CAPTURE_ACCEPTED");
      },
      () => {},
    );
    const canceledStream = await capture({ audio: {}, video: false });
    resolveCapture(canceledStream);
    await delay(0);
    check(
      canceledStream.getTracks().every((track) => track.readyState === "ended"),
      "CANCELED_CAPTURE_LEAK",
    );
    return {
      result: "synthetic-audio-passed",
      syntheticSources: captures,
      receivedPackets: talking.receivedPackets,
      receivedBytes: talking.receivedBytes,
      receivedEnergy: talking.receivedEnergy,
      mutedRms,
      talkingRms,
      releasedRms,
      microphone: false,
      audibleOutput: false,
      crossNat: false,
    };
  } finally {
    for (const sink of sinks) {
      sink.pause();
      sink.srcObject = null;
    }
    for (const peer of peers) peer.close();
    for (const source of sources) source.stop();
    for (const track of tracks) track.stop();
    await context.close();
  }
}
(globalThis as unknown as { mediaResult: Promise<unknown> }).mediaResult =
  run();
