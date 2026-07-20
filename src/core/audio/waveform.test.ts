import { describe, expect, it } from 'vitest';
import { buildWaveformPyramid, extractWaveformPeaks } from './waveform';

describe('waveform peak extraction', () => {
  it('captures min, max and rms without browser audio types', () => {
    const peaks = extractWaveformPeaks(Float32Array.from([-1, -0.5, 0.25, 1]), 2);
    expect(peaks.min).toEqual([-1, 0.25]);
    expect(peaks.max).toEqual([-0.5, 1]);
    expect(peaks.rms?.[0]).toBeCloseTo(Math.sqrt(0.625));
  });

  it('uses an integer samples-per-peak value when the recording length does not divide evenly', () => {
    const peaks = extractWaveformPeaks(Float32Array.from([-1, -0.5, 0, 0.5, 1]), 2);

    expect(peaks.samplesPerPeak).toBe(3);
    expect(peaks.min).toEqual([-1, 0.5]);
    expect(peaks.max).toEqual([0, 1]);
  });

  it('builds sorted de-duplicated zoom levels', () => {
    const levels = buildWaveformPyramid(new Float32Array(64), [32, 8, 32]);
    expect(levels.map((level) => level.max.length)).toEqual([8, 32]);
  });
});
