import type {
  MidiInstrumentProfile,
  MidiNote,
  MidiPlaybackInstrumentId,
  Project,
  MidiTrack,
  MidiTrackSettings,
} from '../../types';

/** MIDI wire channels are zero-based internally. This is displayed as channel 10. */
export const MIDI_DRUM_CHANNEL = 9;
export const MIDI_CHANNELS = Object.freeze(Array.from({ length: 16 }, (_, channel) => channel));
export const MELODIC_MIDI_CHANNELS = Object.freeze(
  MIDI_CHANNELS.filter((channel) => channel !== MIDI_DRUM_CHANNEL),
);

export const DEFAULT_MELODIC_MIDI_CHANNEL = 0;
export const DEFAULT_MELODIC_MIDI_PROGRAM = 0;
export const MIDI_DRUM_INSTRUMENT_ID = 'WebAudioFont 128_0_Chaos_sf2_file' as const;
export const MIDI_MELODIC_INSTRUMENT_ID = 'WebAudio-TinySynth' as const;

export interface MidiPlaybackProfile {
  channel: number;
  instrumentKind: MidiInstrumentProfile['kind'];
  instrumentId: MidiPlaybackInstrumentId;
  program?: number;
}

export const isMidiChannel = (value: number): boolean =>
  Number.isInteger(value) && value >= 0 && value <= 15;

export const isMidiProgram = (value: number): boolean =>
  Number.isInteger(value) && value >= 0 && value <= 127;

export function createDrumMidiTrackSettings(): MidiTrackSettings {
  return {
    channel: MIDI_DRUM_CHANNEL,
    instrument: { kind: 'drums', playbackId: MIDI_DRUM_INSTRUMENT_ID },
  };
}

export function createMelodicMidiTrackSettings(
  channel = DEFAULT_MELODIC_MIDI_CHANNEL,
  program = DEFAULT_MELODIC_MIDI_PROGRAM,
): MidiTrackSettings {
  if (!isMidiChannel(channel) || channel === MIDI_DRUM_CHANNEL) {
    throw new RangeError('Melodic MIDI channel must be a zero-based channel from 0..15 except channel 9');
  }
  if (!isMidiProgram(program)) throw new RangeError('MIDI program must be an integer from 0..127');
  return {
    channel,
    instrument: {
      kind: 'melodic',
      playbackId: MIDI_MELODIC_INSTRUMENT_ID,
      program,
    },
  };
}

/**
 * Migrates note-level channel data into one deterministic track-wide route.
 * Legacy channel 9 data becomes drums; otherwise the most-used melodic channel
 * wins, with the lowest channel breaking ties.
 */
export function inferLegacyMidiTrackSettings(
  notes: readonly Pick<MidiNote, 'channel'>[],
): MidiTrackSettings {
  const counts = Array.from({ length: 16 }, () => 0);
  for (const note of notes) {
    if (note.channel !== undefined && isMidiChannel(note.channel)) counts[note.channel] += 1;
  }
  let channel = DEFAULT_MELODIC_MIDI_CHANNEL;
  let count = 0;
  for (const candidate of MIDI_CHANNELS) {
    if (counts[candidate] > count) {
      channel = candidate;
      count = counts[candidate];
    }
  }
  return channel === MIDI_DRUM_CHANNEL
    ? createDrumMidiTrackSettings()
    : createMelodicMidiTrackSettings(channel);
}

const notesFromTrack = (track: Pick<MidiTrack, 'clips'>): MidiNote[] =>
  track.clips.flatMap((clip) => clip.kind === 'midi' ? clip.notes : []);

/** Resolves old in-memory tracks safely before their next persistence migration. */
export function resolveMidiTrackSettings(
  track: Pick<MidiTrack, 'clips'> & { midi?: MidiTrackSettings },
): MidiTrackSettings {
  return track.midi ?? inferLegacyMidiTrackSettings(notesFromTrack(track));
}

/**
 * Upgrades pre-routing runtime state in place. This is intended for project
 * initialization/replacement boundaries so the first user edit is never
 * blocked merely because a hot-loaded or legacy MIDI track lacks metadata.
 */
export function normalizeProjectMidiTracks(project: Pick<Project, 'tracks'>): void {
  for (const track of project.tracks) {
    if (track.kind !== 'midi') continue;
    const legacyTrack = track as MidiTrack & { midi?: MidiTrackSettings };
    legacyTrack.midi = resolveMidiTrackSettings(legacyTrack);
  }
}

export function getMidiTrackPlaybackProfile(
  track: Pick<MidiTrack, 'clips'> & { midi?: MidiTrackSettings },
): MidiPlaybackProfile {
  const { channel, instrument } = resolveMidiTrackSettings(track);
  return instrument.kind === 'drums'
    ? {
        channel,
        instrumentKind: instrument.kind,
        instrumentId: instrument.playbackId,
      }
    : {
        channel,
        instrumentKind: instrument.kind,
        instrumentId: instrument.playbackId,
        program: instrument.program,
      };
}
