import type { AudioAsset, AudioClip, ClipSourceLoop } from '../../types';
import { beatsToSeconds, secondsToBeats } from '../time';

const BPM_EPSILON = 1e-9;

const assertBpm = (bpm: number, label: string): void => {
  if (!Number.isFinite(bpm) || bpm <= 0) throw new RangeError(`${label} must be positive`);
};

/** Source-media duration expressed in the clip's authored source-beat clock. */
export function getAudioSourceDurationBeats(
  clip: Pick<AudioClip, 'timebase'>,
  asset: Pick<AudioAsset, 'durationSeconds'>,
): number {
  assertBpm(clip.timebase.sourceBpm, 'Audio source BPM');
  if (!Number.isFinite(asset.durationSeconds) || asset.durationSeconds < 0) {
    throw new RangeError('Audio asset duration must be non-negative');
  }
  return secondsToBeats(asset.durationSeconds, clip.timebase.sourceBpm);
}

/**
 * Rate applied to AudioBufferSourceNode and the CPU renderer.
 * A fixed-seconds clip is valid only after its beat geometry has been rebased
 * to the current project tempo, which keeps this rate exactly 1.
 */
export function getAudioClipPlaybackRate(
  clip: Pick<AudioClip, 'timebase'>,
  projectBpm: number,
): number {
  assertBpm(projectBpm, 'Project BPM');
  assertBpm(clip.timebase.sourceBpm, 'Audio source BPM');
  if (clip.timebase.mode === 'fixed-seconds') {
    if (Math.abs(clip.timebase.sourceBpm - projectBpm) > BPM_EPSILON) {
      throw new RangeError('Fixed-seconds audio geometry must be rescaled before changing project BPM');
    }
    return 1;
  }
  return projectBpm / clip.timebase.sourceBpm;
}

/** Converts one source-beat coordinate without consulting mutable project BPM. */
export function audioSourceBeatToSeconds(
  clip: Pick<AudioClip, 'timebase'>,
  sourceBeat: number,
): number {
  assertBpm(clip.timebase.sourceBpm, 'Audio source BPM');
  if (!Number.isFinite(sourceBeat)) throw new RangeError('Audio source beat must be finite');
  return beatsToSeconds(sourceBeat, clip.timebase.sourceBpm);
}

const scaleSourceLoop = (loop: ClipSourceLoop | undefined, ratio: number): ClipSourceLoop | undefined =>
  loop && {
    cycleStartBeat: loop.cycleStartBeat * ratio,
    cycleLengthBeats: loop.cycleLengthBeats * ratio,
    phaseBeats: loop.phaseBeats * ratio,
  };

/**
 * Preserves fixed-seconds Audio source positions and duration across a tempo
 * edit while leaving its musical start position unchanged. The caller must
 * preflight overlap policy before committing the returned geometry.
 */
export function rescaleFixedSecondsAudioClipGeometry<T extends AudioClip>(
  clip: T,
  fromBpm: number,
  toBpm: number,
): T {
  assertBpm(fromBpm, 'Previous project BPM');
  assertBpm(toBpm, 'Next project BPM');
  if (clip.timebase.mode !== 'fixed-seconds') return clip;
  if (Math.abs(clip.timebase.sourceBpm - fromBpm) > BPM_EPSILON) {
    throw new RangeError('Fixed-seconds audio source BPM does not match the previous project tempo');
  }
  const ratio = toBpm / fromBpm;
  return {
    ...clip,
    durationBeats: clip.durationBeats * ratio,
    offsetBeats: clip.offsetBeats * ratio,
    sourceLoop: scaleSourceLoop(clip.sourceLoop, ratio),
    timebase: { mode: 'fixed-seconds', sourceBpm: toBpm },
  };
}
