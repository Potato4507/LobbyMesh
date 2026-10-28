import { installMediaOwner } from "../../apps/desktop/src/media-owner.js";

const context = new AudioContext();
let analyser: AnalyserNode | undefined;
installMediaOwner({
  outputVolume: 0,
  capture: async () => {
    await context.resume();
    const oscillator = context.createOscillator(),
      destination = context.createMediaStreamDestination();
    oscillator.frequency.value = 440;
    oscillator.connect(destination);
    oscillator.start();
    return destination.stream;
  },
  onRemoteStream: (stream) => {
    analyser = context.createAnalyser();
    const silence = context.createGain();
    silence.gain.value = 0;
    context.createMediaStreamSource(stream).connect(analyser);
    analyser.connect(silence);
    silence.connect(context.destination);
  },
});
(globalThis as unknown as { syntheticRms: () => number | null }).syntheticRms =
  () => {
    if (!analyser) return null;
    const values = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(values);
    return Math.sqrt(
      values.reduce((sum, value) => sum + value * value, 0) / values.length,
    );
  };
addEventListener("pagehide", () => {
  void context.close();
});
