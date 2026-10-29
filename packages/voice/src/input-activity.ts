export interface InputActivity {
  inputLevel: number | null;
  inputClipping: boolean | null;
}
export const unknownInputActivity = (): InputActivity => ({
  inputLevel: null,
  inputClipping: null,
});
export function validInputActivity(value: InputActivity): boolean {
  return (
    (value.inputLevel === null && value.inputClipping === null) ||
    (typeof value.inputLevel === "number" &&
      Number.isFinite(value.inputLevel) &&
      value.inputLevel >= 0 &&
      value.inputLevel <= 1 &&
      typeof value.inputClipping === "boolean")
  );
}
// Fixed 512-sample post-gain window. Samples never leave the media owner.
// Muted transmission never reads even the analyser's recent sample window.
export function readInputActivity(
  analyser: { getFloatTimeDomainData(target: Float32Array<ArrayBuffer>): void },
  transmitting: boolean,
): InputActivity {
  if (!transmitting) return { inputLevel: 0, inputClipping: false };
  try {
    const samples = new Float32Array(512);
    analyser.getFloatTimeDomainData(samples);
    let square = 0,
      peak = 0;
    for (const value of samples) {
      if (!Number.isFinite(value)) return unknownInputActivity();
      square += value * value;
      peak = Math.max(peak, Math.abs(value));
    }
    return {
      inputLevel: Math.min(1, Math.sqrt(square / samples.length)),
      inputClipping: peak >= 1,
    };
  } catch {
    return unknownInputActivity();
  }
}
