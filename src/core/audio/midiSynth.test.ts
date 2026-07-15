import { describe, expect, it } from 'vitest';
import {
  equalPowerPanGains,
  linearEdgeEnvelopeFactor,
  linearEdgeEnvelopePoints,
  MIDI_SYNTH_HARMONICS,
  midiPeriodicWaveCoefficients,
  midiSynthSampleAtTime,
  midiSynthWaveSample,
  sampleLinearEnvelope,
} from './midiSynth';

describe('shared MIDI synth DSP', () => {
  it('encodes an arbitrary note offset into PeriodicWave Fourier coefficients', () => {
    const phaseOffset = 1.2345;
    const coefficients = midiPeriodicWaveCoefficients(phaseOffset);

    for (const oscillatorPhase of [0, 0.31, 1.7, 5.9]) {
      let reconstructed = 0;
      for (let harmonic = 1; harmonic < MIDI_SYNTH_HARMONICS.length; harmonic += 1) {
        reconstructed += coefficients.real[harmonic] * Math.cos(oscillatorPhase * harmonic)
          + coefficients.imag[harmonic] * Math.sin(oscillatorPhase * harmonic);
      }
      expect(reconstructed).toBeCloseTo(midiSynthWaveSample(oscillatorPhase + phaseOffset), 6);
    }
  });

  it('represents even overlapping linear fades without changing their curve', () => {
    const points = linearEdgeEnvelopePoints(0, 1, 1, 0.8, 0.7);
    for (let step = 0; step <= 100; step += 1) {
      const position = step / 100;
      expect(sampleLinearEnvelope(points, position)).toBeCloseTo(
        linearEdgeEnvelopeFactor(position, 1, 0.8, 0.7),
        10,
      );
    }
  });

  it('uses the equal-power mono pan law implemented by StereoPannerNode', () => {
    expect(equalPowerPanGains(-1, 2)).toEqual([1, 0]);
    expect(equalPowerPanGains(1, 2)[0]).toBeCloseTo(0, 12);
    expect(equalPowerPanGains(1, 2)[1]).toBeCloseTo(1, 12);
    expect(equalPowerPanGains(0, 2)[0]).toBeCloseTo(Math.SQRT1_2, 12);
    expect(equalPowerPanGains(0, 2)[1]).toBeCloseTo(Math.SQRT1_2, 12);
  });

  it('removes Fourier partials at and above Nyquist in both render paths', () => {
    const frequency = 12_000;
    const sampleRate = 44_100;
    const phase = 0.7;
    const coefficients = midiPeriodicWaveCoefficients(phase, frequency, sampleRate);

    expect(coefficients.imag[1]).not.toBe(0);
    expect(coefficients.real[2]).toBe(0);
    expect(coefficients.imag[2]).toBe(0);
    expect(midiSynthSampleAtTime(frequency, phase / (2 * Math.PI * frequency), sampleRate))
      .toBeCloseTo(MIDI_SYNTH_HARMONICS[1] * Math.sin(phase), 12);
  });
});
