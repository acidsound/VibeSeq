import type { WaveformPeakLevel } from '../../types';

export interface AudioBufferLike {
  length: number;
  numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

export interface WaveformPeakOptions {
  /** Number of horizontal peak buckets. */
  buckets?: number;
  /** Optional source sample range, useful for detailed clip views. */
  startSample?: number;
  endSample?: number;
}

const getChannels = (
  input: Float32Array | readonly Float32Array[] | AudioBufferLike,
): readonly Float32Array[] => {
  if (input instanceof Float32Array) return [input];
  if (Array.isArray(input)) return input;
  const buffer = input as AudioBufferLike;
  return Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel));
};

/** Extracts min/max/RMS buckets collapsed across channels, without relying on browser APIs. */
export function extractWaveformPeaks(
  input: Float32Array | readonly Float32Array[] | AudioBufferLike,
  options: WaveformPeakOptions | number = {},
): WaveformPeakLevel {
  const normalizedOptions = typeof options === 'number' ? { buckets: options } : options;
  const channels = getChannels(input);
  const sourceLength = channels.reduce((length, channel) => Math.max(length, channel.length), 0);
  const start = Math.max(0, Math.min(sourceLength, Math.floor(normalizedOptions.startSample ?? 0)));
  const end = Math.max(start, Math.min(sourceLength, Math.ceil(normalizedOptions.endSample ?? sourceLength)));
  const available = end - start;
  const requestedBuckets = Math.max(1, Math.floor(normalizedOptions.buckets ?? 1_024));
  // Persisted waveform metadata requires an exact source-frame stride. Keep
  // that stride integral and let the final bucket contain fewer samples when
  // the source length does not divide evenly (common for live recordings).
  const samplesPerPeak = available === 0 ? 1 : Math.max(1, Math.ceil(available / requestedBuckets));
  const bucketCount = available === 0 ? requestedBuckets : Math.ceil(available / samplesPerPeak);
  const min = new Array<number>(bucketCount).fill(0);
  const max = new Array<number>(bucketCount).fill(0);
  const rms = new Array<number>(bucketCount).fill(0);

  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const bucketStart = start + Math.floor(bucket * samplesPerPeak);
    const bucketEnd = Math.min(end, start + Math.max(bucketStart - start + 1, Math.floor((bucket + 1) * samplesPerPeak)));
    let minimum = 1;
    let maximum = -1;
    let sumSquares = 0;
    let sampleCount = 0;
    for (const channel of channels) {
      const channelEnd = Math.min(channel.length, bucketEnd);
      for (let sample = bucketStart; sample < channelEnd; sample += 1) {
        const value = Number.isFinite(channel[sample]) ? channel[sample] : 0;
        minimum = Math.min(minimum, value);
        maximum = Math.max(maximum, value);
        sumSquares += value * value;
        sampleCount += 1;
      }
    }
    min[bucket] = sampleCount ? minimum : 0;
    max[bucket] = sampleCount ? maximum : 0;
    rms[bucket] = sampleCount ? Math.sqrt(sumSquares / sampleCount) : 0;
  }

  return { samplesPerPeak, min, max, rms };
}

export function buildWaveformPyramid(
  input: Float32Array | readonly Float32Array[] | AudioBufferLike,
  bucketCounts: readonly number[] = [256, 1_024, 4_096],
): WaveformPeakLevel[] {
  return [...new Set(bucketCounts.filter((count) => Number.isFinite(count) && count > 0))]
    .sort((a, b) => a - b)
    .map((buckets) => extractWaveformPeaks(input, buckets));
}
