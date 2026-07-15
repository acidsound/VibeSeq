export interface TempoCandidate {
  bpm: number;
  strength: number;
}

export interface TempoAnalysisResult {
  bpm: number;
  confidence: number;
  candidates: TempoCandidate[];
  onsetCount: number;
  analyzedSeconds: number;
}

export interface TempoAnalysisOptions {
  minimumBpm?: number;
  maximumBpm?: number;
}

export class TempoAnalysisError extends Error {
  readonly code: 'invalid-audio' | 'insufficient-rhythm';

  constructor(code: TempoAnalysisError['code'], message: string) {
    super(message);
    this.name = 'TempoAnalysisError';
    this.code = code;
  }
}

const ENVELOPE_HZ = 200;
const BPM_STEP = 0.25;

const median = (values: readonly number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
};

const interpolate = (values: Float64Array, position: number): number => {
  const left = Math.floor(position);
  const fraction = position - left;
  if (left < 0 || left >= values.length) return 0;
  const right = Math.min(values.length - 1, left + 1);
  return values[left] + (values[right] - values[left]) * fraction;
};

const foldBpm = (bpm: number, minimum: number, maximum: number): number => {
  let folded = bpm;
  while (folded < minimum) folded *= 2;
  while (folded > maximum) folded /= 2;
  return folded;
};

const normalizedAutocorrelation = (onsets: Float64Array, lag: number): number => {
  const first = Math.ceil(lag);
  let product = 0;
  let energyA = 0;
  let energyB = 0;
  for (let index = first; index < onsets.length; index += 1) {
    const current = onsets[index];
    const delayed = interpolate(onsets, index - lag);
    product += current * delayed;
    energyA += current * current;
    energyB += delayed * delayed;
  }
  return energyA > 0 && energyB > 0 ? product / Math.sqrt(energyA * energyB) : 0;
};

const buildOnsetEnvelope = (
  channelData: readonly Float32Array[],
  sampleRate: number,
): { onsets: Float64Array; analyzedSeconds: number } => {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || channelData.length === 0) {
    throw new TempoAnalysisError('invalid-audio', 'Tempo analysis requires decoded PCM and a positive sample rate');
  }
  const frameCount = Math.max(...channelData.map((channel) => channel.length));
  if (frameCount < sampleRate * 2) {
    throw new TempoAnalysisError('insufficient-rhythm', 'Tempo analysis needs at least two seconds of audio');
  }
  const hop = Math.max(1, Math.round(sampleRate / ENVELOPE_HZ));
  const envelopeFrames = Math.ceil(frameCount / hop);
  const energy = new Float64Array(envelopeFrames);
  for (let envelopeFrame = 0; envelopeFrame < envelopeFrames; envelopeFrame += 1) {
    const start = envelopeFrame * hop;
    const end = Math.min(frameCount, start + hop);
    let sum = 0;
    let samples = 0;
    for (const channel of channelData) {
      const channelEnd = Math.min(channel.length, end);
      for (let frame = start; frame < channelEnd; frame += 1) {
        const sample = channel[frame];
        sum += sample * sample;
        samples += 1;
      }
    }
    energy[envelopeFrame] = samples > 0 ? Math.sqrt(sum / samples) : 0;
  }

  const onsets = new Float64Array(envelopeFrames);
  let previous = energy[0];
  for (let index = 1; index < envelopeFrames; index += 1) {
    const localFloor = previous * 0.82;
    onsets[index] = Math.max(0, energy[index] - localFloor);
    previous = previous * 0.65 + energy[index] * 0.35;
  }
  return { onsets, analyzedSeconds: frameCount / sampleRate };
};

/**
 * Estimates a steady pulse from decoded PCM. It combines onset-interval voting
 * with normalized onset-envelope autocorrelation and returns alternatives so
 * octave ambiguity remains visible to the caller.
 */
export function analyzeTempo(
  channelData: readonly Float32Array[],
  sampleRate: number,
  options: TempoAnalysisOptions = {},
): TempoAnalysisResult {
  const minimumBpm = options.minimumBpm ?? 50;
  const maximumBpm = options.maximumBpm ?? 200;
  if (!Number.isFinite(minimumBpm) || !Number.isFinite(maximumBpm) || minimumBpm <= 0 || maximumBpm <= minimumBpm) {
    throw new TempoAnalysisError('invalid-audio', 'Tempo range must be finite, positive, and ordered');
  }
  const { onsets, analyzedSeconds } = buildOnsetEnvelope(channelData, sampleRate);
  const onsetValues = [...onsets];
  const center = median(onsetValues);
  const deviations = onsetValues.map((value) => Math.abs(value - center));
  const threshold = center + Math.max(1e-7, median(deviations) * 4);
  const peaks: Array<{ frame: number; strength: number }> = [];
  const minimumPeakDistance = Math.max(1, Math.round(ENVELOPE_HZ * 0.075));
  for (let frame = 1; frame < onsets.length - 1; frame += 1) {
    const value = onsets[frame];
    if (value < threshold || value < onsets[frame - 1] || value <= onsets[frame + 1]) continue;
    const previous = peaks.at(-1);
    if (previous && frame - previous.frame < minimumPeakDistance) {
      if (value > previous.strength) peaks[peaks.length - 1] = { frame, strength: value };
      continue;
    }
    peaks.push({ frame, strength: value });
  }
  if (peaks.length < 4) {
    throw new TempoAnalysisError('insufficient-rhythm', 'No stable rhythmic pulse was found in this audio');
  }

  const binCount = Math.floor((maximumBpm - minimumBpm) / BPM_STEP) + 1;
  const intervalVotes = new Float64Array(binCount);
  for (let left = 0; left < peaks.length; left += 1) {
    for (let right = left + 1; right < Math.min(peaks.length, left + 5); right += 1) {
      const intervalSeconds = (peaks[right].frame - peaks[left].frame) / ENVELOPE_HZ;
      if (intervalSeconds <= 0) continue;
      const bpm = foldBpm(60 / intervalSeconds, minimumBpm, maximumBpm);
      if (bpm < minimumBpm || bpm > maximumBpm) continue;
      const centerBin = Math.round((bpm - minimumBpm) / BPM_STEP);
      const pairDistance = right - left;
      const weight = Math.sqrt(peaks[left].strength * peaks[right].strength) / pairDistance;
      for (let spread = -3; spread <= 3; spread += 1) {
        const bin = centerBin + spread;
        if (bin < 0 || bin >= intervalVotes.length) continue;
        intervalVotes[bin] += weight * Math.exp(-0.5 * (spread / 1.35) ** 2);
      }
    }
  }

  const scored = Array.from({ length: binCount }, (_, index) => {
    const bpm = minimumBpm + index * BPM_STEP;
    const lag = (ENVELOPE_HZ * 60) / bpm;
    const correlation = Math.max(0, normalizedAutocorrelation(onsets, lag));
    const halfCorrelation = Math.max(0, normalizedAutocorrelation(onsets, lag * 2));
    const doubleCorrelation = lag >= 2
      ? Math.max(0, normalizedAutocorrelation(onsets, lag / 2))
      : 0;
    const interval = intervalVotes[index];
    return {
      bpm,
      score: interval * (0.65 + correlation * 0.85 + halfCorrelation * 0.15 + doubleCorrelation * 0.08),
    };
  }).sort((left, right) => right.score - left.score || left.bpm - right.bpm);

  const best = scored[0];
  if (!best || best.score <= 0) {
    throw new TempoAnalysisError('insufficient-rhythm', 'No stable rhythmic pulse was found in this audio');
  }
  const distinct = scored.filter((entry, index, all) => (
    index === 0 || all.slice(0, index).every((candidate) => Math.abs(candidate.bpm - entry.bpm) >= 2)
  )).slice(0, 3);
  const alternative = distinct[1]?.score ?? 0;
  const confidence = Math.max(0, Math.min(1, (best.score - alternative) / best.score));
  return {
    bpm: Math.round(best.bpm * 10) / 10,
    confidence,
    candidates: distinct.map((entry) => ({
      bpm: Math.round(entry.bpm * 10) / 10,
      strength: entry.score / best.score,
    })),
    onsetCount: peaks.length,
    analyzedSeconds,
  };
}
