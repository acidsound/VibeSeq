import { describe, expect, it } from 'vitest';
import type { MidiTrack, Project, Track } from '../../types';
import { createBlankProject } from '../demo';
import { assertProjectArrangementInvariants } from '../projectInvariants';
import {
  createDrumMidiTrackSettings,
  createMelodicMidiTrackSettings,
  getMidiTrackPlaybackProfile,
  inferLegacyMidiTrackSettings,
  MELODIC_MIDI_CHANNELS,
  MIDI_DRUM_CHANNEL,
  MIDI_DRUM_INSTRUMENT_ID,
  MIDI_MELODIC_INSTRUMENT_ID,
  normalizeProjectMidiTracks,
} from './instrument';

const legacyMidiTrack = (channel?: number): Track => ({
  id: 'legacy-midi',
  name: 'Legacy MIDI',
  kind: 'midi',
  color: '#5dd6d1',
  gain: 1,
  pan: 0,
  mute: false,
  solo: false,
  clips: [{
    id: 'legacy-midi-clip',
    name: 'Legacy MIDI',
    kind: 'midi',
    startBeat: 0,
    durationBeats: 1,
    offsetBeats: 0,
    gain: 1,
    fadeIn: 0,
    fadeOut: 0,
    notes: [{ id: 'note', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 1, channel }],
    provenance: { source: 'user', createdAt: '2026-07-15T00:00:00.000Z' },
  }],
} as unknown as MidiTrack);

describe('MIDI track instrument contracts', () => {
  it('uses the declared lightweight playback engines and reserves wire channel 10 for drums', () => {
    expect(createDrumMidiTrackSettings()).toEqual({
      channel: MIDI_DRUM_CHANNEL,
      instrument: { kind: 'drums', playbackId: MIDI_DRUM_INSTRUMENT_ID },
    });
    expect(createMelodicMidiTrackSettings(4, 40)).toEqual({
      channel: 4,
      instrument: { kind: 'melodic', playbackId: MIDI_MELODIC_INSTRUMENT_ID, program: 40 },
    });
    expect(MELODIC_MIDI_CHANNELS).not.toContain(MIDI_DRUM_CHANNEL);
    expect(() => createMelodicMidiTrackSettings(MIDI_DRUM_CHANNEL)).toThrow(/reserved|except channel 9/i);
    expect(() => createMelodicMidiTrackSettings(0, 128)).toThrow(/0\.\.127/);
  });

  it('migrates legacy note channels to one deterministic track-wide route', () => {
    expect(inferLegacyMidiTrackSettings([{ channel: 9 }, { channel: 9 }, { channel: 2 }]))
      .toEqual(createDrumMidiTrackSettings());
    expect(inferLegacyMidiTrackSettings([{ channel: 4 }, { channel: 4 }, { channel: 2 }]))
      .toEqual(createMelodicMidiTrackSettings(4));
    expect(inferLegacyMidiTrackSettings([{ channel: 4 }, { channel: 2 }]))
      .toEqual(createMelodicMidiTrackSettings(2));
  });

  it('normalizes a hot-loaded legacy track without blocking the first unrelated Solo edit', () => {
    const project = createBlankProject({ now: '2026-07-15T00:00:00.000Z' }) as Project;
    const track = legacyMidiTrack();
    project.tracks.push(track);
    track.solo = true;
    expect(() => assertProjectArrangementInvariants(project)).not.toThrow();

    normalizeProjectMidiTracks(project);
    expect(project.tracks[0]).toMatchObject({
      solo: true,
      midi: createMelodicMidiTrackSettings(),
    });
  });

  it('provides a complete fallback playback profile before runtime normalization', () => {
    const track = legacyMidiTrack(9) as MidiTrack;
    expect(getMidiTrackPlaybackProfile(track)).toEqual({
      channel: 9,
      instrumentKind: 'drums',
      instrumentId: MIDI_DRUM_INSTRUMENT_ID,
    });
  });
});
