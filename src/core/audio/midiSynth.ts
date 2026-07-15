export interface LinearEnvelopePoint {
  atSeconds: number;
  gain: number;
}

// Compatibility export for callers that previously imported the shared mono
// pan law from this synth module.
export { equalPowerPanGains } from './panning';

/** Harmonic amplitudes for the built-in MIDI preview/export voice (index = harmonic). */
export const MIDI_SYNTH_HARMONICS = Object.freeze([0, 0.78, 0.16, 0.06] as const);

/** Keeps the intentionally simple preview voice below the rest of a typical arrangement. */
export const MIDI_SYNTH_GAIN = 0.18;

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.max(minimum, Math.min(maximum, value));

export function midiPitchFrequency(pitch: number): number {
  return 440 * 2 ** ((clamp(Math.round(pitch), 0, 127) - 69) / 12);
}

export function midiSynthWaveSample(phaseRadians: number): number {
  let sample = 0;
  for (let harmonic = 1; harmonic < MIDI_SYNTH_HARMONICS.length; harmonic += 1) {
    sample += MIDI_SYNTH_HARMONICS[harmonic] * Math.sin(phaseRadians * harmonic);
  }
  return sample;
}

const harmonicIsBelowNyquist = (harmonic: number, frequency: number, sampleRate: number): boolean =>
  !Number.isFinite(sampleRate) || harmonic * frequency < sampleRate / 2;

export function midiSynthSampleAtTime(
  frequency: number,
  noteSeconds: number,
  sampleRate = Number.POSITIVE_INFINITY,
): number {
  const phaseRadians = 2 * Math.PI * frequency * noteSeconds;
  let sample = 0;
  for (let harmonic = 1; harmonic < MIDI_SYNTH_HARMONICS.length; harmonic += 1) {
    if (harmonicIsBelowNyquist(harmonic, frequency, sampleRate)) {
      sample += MIDI_SYNTH_HARMONICS[harmonic] * Math.sin(phaseRadians * harmonic);
    }
  }
  return sample;
}

export function midiSynthAttackSeconds(noteDurationSeconds: number): number {
  return Math.min(0.012, Math.max(0, noteDurationSeconds) * 0.2);
}

export function midiSynthReleaseSeconds(noteDurationSeconds: number): number {
  return Math.min(0.1, Math.max(0, noteDurationSeconds) * 0.25);
}

/** Linear edge envelope shared by clip fades and the MIDI voice attack/release. */
export function linearEdgeEnvelopeFactor(
  positionSeconds: number,
  durationSeconds: number,
  fadeInSeconds: number,
  fadeOutSeconds: number,
): number {
  const duration = Math.max(0, durationSeconds);
  const position = clamp(positionSeconds, 0, duration);
  const fadeIn = Math.max(0, fadeInSeconds);
  const fadeOut = Math.max(0, fadeOutSeconds);
  const inFactor = fadeIn > 0 ? clamp(position / fadeIn, 0, 1) : 1;
  const outFactor = fadeOut > 0 ? clamp((duration - position) / fadeOut, 0, 1) : 1;
  return Math.min(inFactor, outFactor);
}

export function midiSynthEnvelopeFactor(noteSeconds: number, noteDurationSeconds: number): number {
  return linearEdgeEnvelopeFactor(
    noteSeconds,
    noteDurationSeconds,
    midiSynthAttackSeconds(noteDurationSeconds),
    midiSynthReleaseSeconds(noteDurationSeconds),
  );
}

/**
 * Returns the minimum set of linear automation points for a clipped interval of
 * an edge envelope. Keeping clip and voice envelopes on separate GainNodes makes
 * their product match the CPU renderer, including overlapping clip fades.
 */
export function linearEdgeEnvelopePoints(
  segmentOffsetSeconds: number,
  segmentDurationSeconds: number,
  totalDurationSeconds: number,
  fadeInSeconds: number,
  fadeOutSeconds: number,
): LinearEnvelopePoint[] {
  const totalDuration = Math.max(0, totalDurationSeconds);
  const segmentStart = clamp(segmentOffsetSeconds, 0, totalDuration);
  const segmentEnd = clamp(segmentStart + Math.max(0, segmentDurationSeconds), segmentStart, totalDuration);
  const fadeIn = Math.max(0, fadeInSeconds);
  const fadeOut = Math.max(0, fadeOutSeconds);
  const positions = [segmentStart, segmentEnd];

  if (fadeIn > segmentStart && fadeIn < segmentEnd) positions.push(fadeIn);
  const fadeOutStart = totalDuration - fadeOut;
  if (fadeOutStart > segmentStart && fadeOutStart < segmentEnd) positions.push(fadeOutStart);

  if (fadeIn > 0 && fadeOut > 0 && fadeIn + fadeOut > totalDuration) {
    const intersection = (totalDuration * fadeIn) / (fadeIn + fadeOut);
    if (intersection > segmentStart && intersection < segmentEnd) positions.push(intersection);
  }

  return [...new Set(positions)]
    .sort((a, b) => a - b)
    .map((position) => ({
      atSeconds: position - segmentStart,
      gain: linearEdgeEnvelopeFactor(position, totalDuration, fadeIn, fadeOut),
    }));
}

export function midiSynthEnvelopePoints(
  noteOffsetSeconds: number,
  segmentDurationSeconds: number,
  noteDurationSeconds: number,
): LinearEnvelopePoint[] {
  return linearEdgeEnvelopePoints(
    noteOffsetSeconds,
    segmentDurationSeconds,
    noteDurationSeconds,
    midiSynthAttackSeconds(noteDurationSeconds),
    midiSynthReleaseSeconds(noteDurationSeconds),
  );
}

/**
 * Fourier coefficients for a PeriodicWave beginning at the requested note
 * phase. `disableNormalization: true` is required when constructing the wave.
 */
export function midiPeriodicWaveCoefficients(
  phaseRadians: number,
  frequency = 0,
  sampleRate = Number.POSITIVE_INFINITY,
): {
  real: Float32Array;
  imag: Float32Array;
} {
  const real = new Float32Array(MIDI_SYNTH_HARMONICS.length);
  const imag = new Float32Array(MIDI_SYNTH_HARMONICS.length);
  for (let harmonic = 1; harmonic < MIDI_SYNTH_HARMONICS.length; harmonic += 1) {
    if (!harmonicIsBelowNyquist(harmonic, frequency, sampleRate)) continue;
    const harmonicPhase = phaseRadians * harmonic;
    real[harmonic] = MIDI_SYNTH_HARMONICS[harmonic] * Math.sin(harmonicPhase);
    imag[harmonic] = MIDI_SYNTH_HARMONICS[harmonic] * Math.cos(harmonicPhase);
  }
  return { real, imag };
}

export function sampleLinearEnvelope(points: readonly LinearEnvelopePoint[], atSeconds: number): number {
  if (points.length === 0) return 1;
  if (atSeconds <= points[0].atSeconds) return points[0].gain;
  for (let index = 1; index < points.length; index += 1) {
    const next = points[index];
    if (atSeconds > next.atSeconds) continue;
    const previous = points[index - 1];
    const duration = next.atSeconds - previous.atSeconds;
    if (duration <= 0) return next.gain;
    const progress = (atSeconds - previous.atSeconds) / duration;
    return previous.gain + (next.gain - previous.gain) * progress;
  }
  return points.at(-1)?.gain ?? 1;
}
