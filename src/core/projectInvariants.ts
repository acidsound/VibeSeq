import type { Clip, Project, Track } from '../types';
import { MIN_SOURCE_LOOP_CYCLE_BEATS } from './clip';
import {
  isMidiChannel,
  isMidiProgram,
  MIDI_DRUM_CHANNEL,
  MIDI_DRUM_INSTRUMENT_ID,
  MIDI_MELODIC_INSTRUMENT_ID,
} from './midi/instrument';

const PLACEMENT_EPSILON = 1e-9;

export type ProjectArrangementInvariantCode =
  | 'invalid-overlap-policy'
  | 'duplicate-clip-id'
  | 'clip-kind-mismatch'
  | 'invalid-clip-geometry'
  | 'invalid-audio-timebase'
  | 'invalid-midi-track-settings'
  | 'invalid-source-loop'
  | 'clip-overlap';

export interface ProjectArrangementInvariantContext {
  trackId?: string;
  clipIds?: readonly string[];
}

/** A mutation was rejected before commit because it would make arrangement state invalid. */
export class ProjectArrangementInvariantError extends Error {
  readonly code: ProjectArrangementInvariantCode;
  readonly trackId?: string;
  readonly clipIds?: readonly string[];

  constructor(
    code: ProjectArrangementInvariantCode,
    message: string,
    context: ProjectArrangementInvariantContext = {},
  ) {
    super(message);
    this.name = 'ProjectArrangementInvariantError';
    this.code = code;
    this.trackId = context.trackId;
    this.clipIds = context.clipIds;
  }
}

const invalidNumber = (value: number): boolean => !Number.isFinite(value);

const assertMidiTrackSettings = (track: Track): void => {
  if (track.kind !== 'midi') return;
  const midi = track.midi as unknown;
  if (!midi || typeof midi !== 'object') {
    // Older projects can remain alive in a hot-loaded history store before
    // persistence migration runs. Missing metadata is resolved by the MIDI
    // runtime defaults and must not block unrelated edits such as Solo/Mute.
    return;
  }
  const source = midi as Record<string, unknown>;
  const channel = source.channel;
  const instrument = source.instrument;
  let valid = typeof channel === 'number' && isMidiChannel(channel)
    && instrument !== null && typeof instrument === 'object';
  if (valid) {
    const profile = instrument as Record<string, unknown>;
    valid = profile.kind === 'drums'
      ? channel === MIDI_DRUM_CHANNEL && profile.playbackId === MIDI_DRUM_INSTRUMENT_ID
      : profile.kind === 'melodic'
        && channel !== MIDI_DRUM_CHANNEL
        && profile.playbackId === MIDI_MELODIC_INSTRUMENT_ID
        && typeof profile.program === 'number'
        && isMidiProgram(profile.program);
  }
  if (!valid) {
    throw new ProjectArrangementInvariantError(
      'invalid-midi-track-settings',
      `MIDI track "${track.id}" has an invalid channel or instrument profile`,
      { trackId: track.id },
    );
  }
};

const assertClipGeometry = (track: Track, clip: Clip, projectBpm?: number): void => {
  if (
    invalidNumber(clip.startBeat)
    || invalidNumber(clip.durationBeats)
    || invalidNumber(clip.offsetBeats)
    || clip.startBeat < 0
    || clip.durationBeats <= 0
    || clip.offsetBeats < 0
  ) {
    throw new ProjectArrangementInvariantError(
      'invalid-clip-geometry',
      `Clip "${clip.id}" requires a finite non-negative start/offset and a positive duration`,
      { trackId: track.id, clipIds: [clip.id] },
    );
  }

  if (clip.kind !== track.kind) {
    throw new ProjectArrangementInvariantError(
      'clip-kind-mismatch',
      `Clip "${clip.id}" kind ${clip.kind} does not match track "${track.id}" kind ${track.kind}`,
      { trackId: track.id, clipIds: [clip.id] },
    );
  }

  if (clip.kind === 'audio') {
    const timebase = clip.timebase;
    if (
      !timebase
      || typeof timebase !== 'object'
      || !('mode' in timebase)
      || !('sourceBpm' in timebase)
    ) {
      throw new ProjectArrangementInvariantError(
        'invalid-audio-timebase',
        `Audio clip "${clip.id}" requires a valid explicit timebase`,
        { trackId: track.id, clipIds: [clip.id] },
      );
    }
    const { mode, sourceBpm } = timebase;
    if (
      (mode !== 'fixed-seconds' && mode !== 'tempo-follow-repitch')
      || invalidNumber(sourceBpm)
      || sourceBpm <= 0
      || sourceBpm > 1_000
      || (mode === 'fixed-seconds'
        && projectBpm !== undefined
        && Math.abs(sourceBpm - projectBpm) > PLACEMENT_EPSILON)
    ) {
      throw new ProjectArrangementInvariantError(
        'invalid-audio-timebase',
        mode === 'fixed-seconds' && projectBpm !== undefined
          ? `Fixed-seconds Audio clip "${clip.id}" must be rescaled to the project BPM before commit`
          : `Audio clip "${clip.id}" requires a valid explicit timebase`,
        { trackId: track.id, clipIds: [clip.id] },
      );
    }
  }

  const loop = clip.sourceLoop;
  if (!loop) return;
  if (
    invalidNumber(loop.cycleStartBeat)
    || invalidNumber(loop.cycleLengthBeats)
    || invalidNumber(loop.phaseBeats)
    || loop.cycleStartBeat < 0
    || loop.cycleLengthBeats < MIN_SOURCE_LOOP_CYCLE_BEATS
    || loop.phaseBeats < 0
    || loop.phaseBeats >= loop.cycleLengthBeats
  ) {
    throw new ProjectArrangementInvariantError(
      'invalid-source-loop',
      `Clip "${clip.id}" has an invalid source-loop cycle or phase`,
      { trackId: track.id, clipIds: [clip.id] },
    );
  }
};

/**
 * Pure, non-normalizing assertion shared by import validation and live edits.
 * It is intentionally limited to arrangement state so gain/note edits do not
 * traverse or rebuild immutable media payloads and waveform peak arrays.
 */
export function assertProjectArrangementInvariants(
  project: Pick<Project, 'arrangement' | 'tracks'> & Partial<Pick<Project, 'bpm'>>,
): void {
  if (project.arrangement.overlapPolicy !== 'prevent') {
    throw new ProjectArrangementInvariantError(
      'invalid-overlap-policy',
      'Only the deterministic prevent-overlap arrangement policy is supported',
    );
  }

  const clipIds = new Set<string>();
  for (const track of project.tracks) {
    assertMidiTrackSettings(track);
    for (const clip of track.clips) {
      if (clipIds.has(clip.id)) {
        throw new ProjectArrangementInvariantError(
          'duplicate-clip-id',
          `Arrangement contains duplicate clip id "${clip.id}"`,
          { trackId: track.id, clipIds: [clip.id] },
        );
      }
      clipIds.add(clip.id);
      assertClipGeometry(track, clip, project.bpm);
    }

    const orderedClips = [...track.clips].sort((left, right) =>
      left.startBeat - right.startBeat || left.id.localeCompare(right.id));
    for (let index = 1; index < orderedClips.length; index += 1) {
      const previous = orderedClips[index - 1];
      const current = orderedClips[index];
      if (current.startBeat < previous.startBeat + previous.durationBeats - PLACEMENT_EPSILON) {
        throw new ProjectArrangementInvariantError(
          'clip-overlap',
          `Arrangement overlap policy prevents clips "${previous.id}" and "${current.id}" from overlapping`,
          { trackId: track.id, clipIds: [previous.id, current.id] },
        );
      }
    }
  }
}
