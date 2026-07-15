import { describe, expect, it } from 'vitest';
import type { AudioAsset, AudioClip } from '../../types';
import {
  audioSourceBeatToSeconds,
  getAudioClipPlaybackRate,
  getAudioSourceDurationBeats,
  rescaleFixedSecondsAudioClipGeometry,
} from './timebase';

const clip = (mode: AudioClip['timebase']['mode'] = 'fixed-seconds'): AudioClip => ({
  id: 'clip',
  name: 'Timebase fixture',
  kind: 'audio',
  assetId: 'asset',
  startBeat: 16,
  durationBeats: 8,
  offsetBeats: 2,
  sourceLoop: { cycleStartBeat: 2, cycleLengthBeats: 4, phaseBeats: 1 },
  timebase: { mode, sourceBpm: 120 },
  gain: 1,
  fadeIn: 0.1,
  fadeOut: 0.2,
  provenance: { source: 'user', createdAt: '2026-07-15T00:00:00.000Z' },
});

const asset: Pick<AudioAsset, 'durationSeconds'> = { durationSeconds: 4 };

describe('Audio clip timebase mapping', () => {
  it('keeps source-media coordinates on the authored source BPM', () => {
    const source = clip('tempo-follow-repitch');
    expect(getAudioSourceDurationBeats(source, asset)).toBe(8);
    expect(audioSourceBeatToSeconds(source, 2)).toBe(1);
  });

  it.each([
    { projectBpm: 60, playbackRate: 0.5 },
    { projectBpm: 120, playbackRate: 1 },
    { projectBpm: 240, playbackRate: 2 },
  ])('maps 120 BPM loop material at $projectBpm BPM to $playbackRate x', ({ projectBpm, playbackRate }) => {
    expect(getAudioClipPlaybackRate(clip('tempo-follow-repitch'), projectBpm)).toBe(playbackRate);
  });

  it.each([
    {
      toBpm: 60,
      expected: {
        durationBeats: 4,
        offsetBeats: 1,
        sourceLoop: { cycleStartBeat: 1, cycleLengthBeats: 2, phaseBeats: 0.5 },
      },
    },
    {
      toBpm: 240,
      expected: {
        durationBeats: 16,
        offsetBeats: 4,
        sourceLoop: { cycleStartBeat: 4, cycleLengthBeats: 8, phaseBeats: 2 },
      },
    },
  ])('rebases fixed-seconds beat geometry from 120 to $toBpm BPM without moving the clip', ({ toBpm, expected }) => {
    const source = clip();
    const rebased = rescaleFixedSecondsAudioClipGeometry(source, 120, toBpm);

    expect(rebased).toMatchObject({
      startBeat: 16,
      fadeIn: 0.1,
      fadeOut: 0.2,
      timebase: { mode: 'fixed-seconds', sourceBpm: toBpm },
      ...expected,
    });
    expect(audioSourceBeatToSeconds(rebased, rebased.offsetBeats)).toBe(
      audioSourceBeatToSeconds(source, source.offsetBeats),
    );
    expect((rebased.durationBeats * 60) / toBpm).toBe((source.durationBeats * 60) / 120);
  });

  it('requires a fixed-seconds clip to be rebased before playback at a new tempo', () => {
    expect(() => getAudioClipPlaybackRate(clip(), 60)).toThrow(/rescaled before changing project BPM/);
  });

  it('does not rewrite beat geometry for tempo-follow material', () => {
    const source = clip('tempo-follow-repitch');
    expect(rescaleFixedSecondsAudioClipGeometry(source, 120, 60)).toBe(source);
  });
});
