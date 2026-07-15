import { describe, expect, it } from 'vitest';
import { analyzeTempo, TempoAnalysisError } from './tempo';

const clickTrack = (bpm: number, sampleRate = 8_000, seconds = 12): Float32Array => {
  const samples = new Float32Array(sampleRate * seconds);
  const interval = (sampleRate * 60) / bpm;
  for (let beat = 0; Math.round(beat * interval) < samples.length; beat += 1) {
    const start = Math.round(beat * interval);
    for (let frame = 0; frame < Math.min(100, samples.length - start); frame += 1) {
      samples[start + frame] += Math.exp(-frame / 18) * (beat % 4 === 0 ? 1 : 0.72);
    }
  }
  return samples;
};

describe('Audio tempo analysis', () => {
  it.each([60, 90, 120, 174])('finds a steady %i BPM pulse', (bpm) => {
    const result = analyzeTempo([clickTrack(bpm)], 8_000);
    expect(result.bpm).toBeCloseTo(bpm, 0);
    expect(result.onsetCount).toBeGreaterThanOrEqual(4);
    expect(result.analyzedSeconds).toBe(12);
    expect(result.candidates[0].strength).toBe(1);
  });

  it('downmixes channels and exposes octave alternatives instead of hiding ambiguity', () => {
    const source = clickTrack(120);
    const result = analyzeTempo([source, Float32Array.from(source, (sample) => sample * 0.5)], 8_000);
    expect(result.bpm).toBeCloseTo(120, 0);
    expect(result.candidates.length).toBeGreaterThan(1);
    expect(result.candidates.every((candidate) => candidate.strength > 0 && candidate.strength <= 1)).toBe(true);
  });

  it('rejects silence and clips too short to establish a pulse', () => {
    expect(() => analyzeTempo([new Float32Array(8_000 * 4)], 8_000)).toThrow(TempoAnalysisError);
    expect(() => analyzeTempo([clickTrack(120, 8_000, 1)], 8_000)).toThrow(/at least two seconds/i);
  });
});
