import type { AudioClip, MidiPlaybackInstrumentId, Project, Track } from '../../types';
import { getArrangedMidiNotes } from '../clip';
import { getMidiTrackPlaybackProfile, type MidiPlaybackProfile } from '../midi/instrument';
import { assertProjectArrangementInvariants } from '../projectInvariants';
import { getProjectEndBeat } from '../time';
import { getAudioClipPlaybackRate } from './timebase';

export const VIBESEQ_AUDIO_PROCESSOR_NAME = 'vibeseq-audio-engine-v1';

export interface WorkletSourceLoop {
  cycleStartBeat: number;
  cycleLengthBeats: number;
  phaseBeats: number;
}

export interface WorkletAudioClip {
  id: string;
  assetId: string;
  startBeat: number;
  durationBeats: number;
  offsetBeats: number;
  sourceLoop?: WorkletSourceLoop;
  timebase: AudioClip['timebase'];
  stretchRatio: number;
  gain: number;
  fadeIn: number;
  fadeOut: number;
  muted: boolean;
}

export interface WorkletMidiEvent {
  clipId: string;
  noteId: string;
  startBeat: number;
  durationBeats: number;
  noteOffsetBeats: number;
  noteDurationBeats: number;
  pitch: number;
  velocity: number;
  /** Track-wide zero-based wire channel, including channel 9 for drums. */
  midiChannel: number;
  instrumentKind: 'drums' | 'melodic';
  instrumentId: MidiPlaybackInstrumentId;
  midiProgram?: number;
  clipStartBeat: number;
  clipDurationBeats: number;
  clipGain: number;
  clipFadeIn: number;
  clipFadeOut: number;
  clipMuted: boolean;
}

export interface WorkletTrackSnapshot {
  id: string;
  kind: Track['kind'];
  gain: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  midiProfile?: MidiPlaybackProfile;
  audioClips: WorkletAudioClip[];
  midiEvents: WorkletMidiEvent[];
}

export interface WorkletProjectSnapshot {
  id: string;
  bpm: number;
  masterGain: number;
  endBeat: number;
  loop: Project['loop'];
  tracks: WorkletTrackSnapshot[];
}

export interface WorkletAssetPayload {
  id: string;
  sampleRate: number;
  channelData: Float32Array[];
}

export interface WorkletTrackParameterPatch {
  gain?: number;
  pan?: number;
  mute?: boolean;
  solo?: boolean;
}

export const MIN_MIDI_AUDITION_SECONDS = 0.03;
export const MAX_MIDI_AUDITION_SECONDS = 4;

/**
 * A click-time instrument snapshot. Keeping the resolved route in the command
 * makes a note deterministic even if the UI changes channel/program while the
 * browser is resuming its AudioContext.
 */
export interface WorkletMidiAudition {
  token: number;
  trackId: string;
  pitch: number;
  velocity: number;
  durationSeconds: number;
  profile: MidiPlaybackProfile;
}

export interface WorkletRecordingStart {
  sessionId: string;
  startPositionBeat: number;
  startFrame: number;
  sampleRate: number;
  channelCount: number;
}

export interface WorkletRecordingResult extends WorkletRecordingStart {
  endFrame: number;
  frameCount: number;
  channelData: Float32Array[];
}

export type WorkletPlaybackState = 'idle' | 'playing' | 'paused';

export type WorkletCommand =
  | { type: 'sync-project'; project: WorkletProjectSnapshot }
  | { type: 'sync-asset'; asset: WorkletAssetPayload }
  | { type: 'remove-asset'; assetId: string }
  | { type: 'play'; fromBeat: number; toBeat: number; loop: boolean }
  | { type: 'pause' }
  | { type: 'stop'; positionBeat: number }
  | { type: 'seek'; positionBeat: number }
  | { type: 'set-loop'; enabled: boolean; startBeat: number; endBeat: number }
  | { type: 'set-master-gain'; gain: number }
  | { type: 'set-track-parameters'; trackId: string; parameters: WorkletTrackParameterPatch }
  | { type: 'audition'; assetId: string; token: number }
  | { type: 'stop-audition'; token?: number }
  | { type: 'audition-midi-note'; audition: WorkletMidiAudition }
  | { type: 'stop-midi-note-audition'; token?: number }
  | { type: 'start-recording'; sessionId: string; channelCount: number }
  | { type: 'stop-recording'; sessionId: string }
  | { type: 'cancel-recording'; sessionId: string }
  | { type: 'dispose' };

export type WorkletEvent =
  | {
      type: 'telemetry';
      state: WorkletPlaybackState;
      positionBeat: number;
      masterPeak: number;
      trackPeaks: Record<string, number>;
    }
  | { type: 'state'; state: WorkletPlaybackState; positionBeat: number }
  | { type: 'ended'; positionBeat: number }
  | { type: 'audition-ended'; token: number }
  | { type: 'midi-audition-ended'; token: number }
  | ({ type: 'recording-started' } & WorkletRecordingStart)
  | { type: 'recording-chunk'; sessionId: string; frameCount: number; channelData: Float32Array[] }
  | { type: 'recording-complete'; sessionId: string; endFrame: number; frameCount: number }
  | { type: 'recording-cancelled'; sessionId: string }
  | { type: 'error'; code: string; message: string; assetId?: string };

const audioClipSnapshot = (clip: AudioClip, projectBpm: number): WorkletAudioClip => {
  // This catches a fixed-seconds clip that was not atomically rebased before
  // project sync instead of allowing realtime and offline engines to diverge.
  getAudioClipPlaybackRate(clip, projectBpm);
  return {
    id: clip.id,
    assetId: clip.assetId,
    startBeat: clip.startBeat,
    durationBeats: clip.durationBeats,
    offsetBeats: clip.offsetBeats,
    sourceLoop: clip.sourceLoop ? { ...clip.sourceLoop } : undefined,
    timebase: { ...clip.timebase },
    stretchRatio: clip.transform?.stretchRatio ?? 1,
    gain: clip.gain,
    fadeIn: clip.fadeIn,
    fadeOut: clip.fadeOut,
    muted: clip.muted ?? false,
  };
};

const trackSnapshot = (track: Track, projectBpm: number): WorkletTrackSnapshot => {
  const midiProfile = track.kind === 'midi' ? getMidiTrackPlaybackProfile(track) : undefined;
  return {
    id: track.id,
    kind: track.kind,
    gain: track.gain,
    pan: track.pan,
    mute: track.mute,
    solo: track.solo,
    midiProfile,
    audioClips: track.clips.flatMap((clip) =>
      clip.kind === 'audio' ? [audioClipSnapshot(clip, projectBpm)] : []),
    midiEvents: track.clips.flatMap((clip) => {
      if (clip.kind !== 'midi' || !midiProfile) return [];
      return getArrangedMidiNotes(clip).map((instance): WorkletMidiEvent => ({
        clipId: clip.id,
        noteId: instance.note.id,
        startBeat: instance.startBeat,
        durationBeats: instance.durationBeats,
        noteOffsetBeats: instance.noteOffsetBeats,
        noteDurationBeats: instance.note.durationBeats,
        pitch: Math.max(0, Math.min(127, Math.round(instance.note.pitch))),
        velocity: Math.max(0, Math.min(1, instance.note.velocity)),
        midiChannel: midiProfile.channel,
        instrumentKind: midiProfile.instrumentKind,
        instrumentId: midiProfile.instrumentId,
        midiProgram: midiProfile.program,
        clipStartBeat: clip.startBeat,
        clipDurationBeats: clip.durationBeats,
        clipGain: clip.gain,
        clipFadeIn: clip.fadeIn,
        clipFadeOut: clip.fadeOut,
        clipMuted: clip.muted ?? false,
      }));
    }),
  };
};

/**
 * Creates the immutable render graph sent to the audio thread. Expanding MIDI
 * instances on the control thread protects the realtime callback from large
 * source-loop edits; sample generation and every mixer decision remain inside
 * the AudioWorkletProcessor.
 */
export function createWorkletProjectSnapshot(project: Project): WorkletProjectSnapshot {
  assertProjectArrangementInvariants(project);
  return {
    id: project.id,
    bpm: project.bpm,
    masterGain: project.masterGain,
    endBeat: getProjectEndBeat(project.tracks),
    loop: { ...project.loop },
    tracks: project.tracks.map((track) => trackSnapshot(track, project.bpm)),
  };
}

/**
 * Stable identity for the snapshot fields that change rendered samples.
 * Mixer controls and loop bounds are deliberately excluded so they can be
 * updated with small realtime commands while playback remains uninterrupted.
 */
export function workletRenderGraphKey(project: WorkletProjectSnapshot): string {
  return JSON.stringify({
    id: project.id,
    bpm: project.bpm,
    endBeat: project.endBeat,
    tracks: project.tracks.map((track) => ({
      id: track.id,
      kind: track.kind,
      midiProfile: track.midiProfile,
      audioClips: track.audioClips,
      midiEvents: track.midiEvents,
    })),
  });
}

/** Every arranged audio source, independent of the current mute/solo state. */
export function allProjectAudioAssetIds(project: Project): Set<string> {
  return new Set(project.tracks.flatMap((track) => (
    track.kind === 'audio'
      ? track.clips.flatMap((clip) => clip.kind === 'audio' ? [clip.assetId] : [])
      : []
  )));
}

export function requiredWorkletAssetIds(project: WorkletProjectSnapshot): Set<string> {
  const anySolo = project.tracks.some((track) => track.solo && !track.mute);
  return new Set(project.tracks.flatMap((track) => {
    if (track.kind !== 'audio' || track.mute || (anySolo && !track.solo)) return [];
    return track.audioClips.filter((clip) => !clip.muted).map((clip) => clip.assetId);
  }));
}
