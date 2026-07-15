import { describe, expect, it } from 'vitest';
import { createDemoProject } from '../demo';
import { exportWavBuffer } from './mixdown';
import { executeMixdownWorkerRequest, type WavExportProgress } from './mixdownWorkerCore';

describe('mixdown worker core', () => {
  it('keeps the worker WAV byte-identical to the synchronous reference and reports real phases', async () => {
    const project = createDemoProject({ now: '2026-07-15T00:00:00.000Z' });
    project.tracks = project.tracks.filter((track) => track.kind === 'midi');
    project.assets = [];
    const options = {
      sampleRate: 44_100 as const,
      fromBeat: 0,
      toBeat: 2,
      channelCount: 2 as const,
      bitDepth: 16 as const,
      dither: 'tpdf' as const,
      protectPeaks: true,
      rejectSilent: true,
      rejectUnprotectedClipping: true,
    };
    const progress: WavExportProgress[] = [];

    const result = await executeMixdownWorkerRequest({ project, assets: [], options }, (update) => progress.push(update));
    const reference = await exportWavBuffer(project, new Map(), options);

    expect(new Uint8Array(result.wav)).toEqual(new Uint8Array(reference));
    expect(result.sourceSamplePeak).toBeGreaterThan(0);
    expect(progress[0]).toEqual({ phase: 'mixing', progress: 0 });
    expect(progress.some((update) => update.phase === 'analyzing')).toBe(true);
    expect(progress.some((update) => update.phase === 'encoding')).toBe(true);
    expect(progress.at(-1)).toEqual({ phase: 'encoding', progress: 1 });
    expect(progress.every((update, index) => index === 0 || update.progress >= progress[index - 1].progress)).toBe(true);
  });

  it('rejects a silent production export before allocating a WAV payload', async () => {
    const project = createDemoProject({ now: '2026-07-15T00:00:00.000Z' });
    project.tracks = [];
    project.assets = [];

    await expect(executeMixdownWorkerRequest({
      project,
      assets: [],
      options: { fromBeat: 0, toBeat: 1, rejectSilent: true },
    }, () => undefined)).rejects.toThrow('selected range is silent');
  });
});
