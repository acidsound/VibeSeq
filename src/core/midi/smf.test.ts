import { describe, expect, it } from 'vitest';
import { createBlankProject, createDemoProject } from '../demo';
import { exportMidi, importMidi } from './smf';

describe('Standard MIDI File I/O', () => {
  it('round-trips tempo, meter and arranged notes', () => {
    const project = createDemoProject({ now: '2026-07-15T00:00:00.000Z' });
    const bytes = exportMidi(project, { ppq: 480 });
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('MThd');
    const imported = importMidi(bytes, { now: '2026-07-15T00:00:00.000Z' });
    expect(imported.bpm).toBeCloseTo(118, 2);
    expect(imported.timeSignature).toEqual({ numerator: 4, denominator: 4 });
    expect(imported.tracks).toHaveLength(2);
    expect(imported.tracks[0].clips[0].kind).toBe('midi');
    if (imported.tracks[0].clips[0].kind === 'midi') {
      expect(imported.tracks[0].clips[0].notes.length).toBeGreaterThan(0);
    }
  });

  it('exports repeated MIDI source cycles as explicit arranged notes', () => {
    const project = createBlankProject({ now: '2026-07-15T00:00:00.000Z', bpm: 120 });
    project.tracks = [{
      id: 'loop-track',
      name: 'Loop track',
      kind: 'midi',
      midi: { channel: 0, instrument: { kind: 'melodic', playbackId: 'WebAudio-TinySynth', program: 0 } },
      color: '#5dd6d1',
      gain: 1,
      pan: 0,
      mute: false,
      solo: false,
      clips: [{
        id: 'loop-clip',
        name: 'Loop clip',
        kind: 'midi',
        startBeat: 0,
        durationBeats: 2.5,
        offsetBeats: 0,
        sourceLoop: { cycleStartBeat: 0, cycleLengthBeats: 1, phaseBeats: 0 },
        gain: 1,
        fadeIn: 0,
        fadeOut: 0,
        notes: [{ id: 'source-note', pitch: 64, startBeat: 0.25, durationBeats: 0.5, velocity: 0.8 }],
        provenance: { source: 'user', createdAt: project.createdAt },
      }],
    }];
    const bytes = exportMidi(project, { ppq: 480, fromBeat: 0, toBeat: 2.5 });
    const imported = importMidi(bytes, { now: project.createdAt });
    const clip = imported.tracks[0]?.clips[0];
    expect(clip?.kind).toBe('midi');
    if (clip?.kind !== 'midi') return;
    expect(clip.notes.map((note) => [note.startBeat, note.durationBeats])).toEqual([
      [0.25, 0.5],
      [1.25, 0.5],
      [2.25, 0.25],
    ]);
  });

  it('excludes muted regions from Standard MIDI File export', () => {
    const project = createDemoProject({ now: '2026-07-15T00:00:00.000Z' });
    for (const track of project.tracks) {
      for (const clip of track.clips) {
        if (clip.kind === 'midi') clip.muted = true;
      }
    }
    const imported = importMidi(exportMidi(project), { now: project.createdAt });
    const noteCount = imported.tracks.flatMap((track) => track.clips)
      .filter((clip) => clip.kind === 'midi')
      .reduce((count, clip) => count + clip.notes.length, 0);

    expect(noteCount).toBe(0);
  });

  it('exports melodic notes on the track channel with its General MIDI program', () => {
    const project = createBlankProject({ now: '2026-07-15T00:00:00.000Z', bpm: 120 });
    project.tracks = [{
      id: 'melodic-track',
      name: 'Strings',
      kind: 'midi',
      midi: { channel: 4, instrument: { kind: 'melodic', playbackId: 'WebAudio-TinySynth', program: 40 } },
      color: '#5dd6d1',
      gain: 1,
      pan: 0,
      mute: false,
      solo: false,
      clips: [{
        id: 'melodic-clip',
        name: 'Strings',
        kind: 'midi',
        startBeat: 0,
        durationBeats: 1,
        offsetBeats: 0,
        gain: 1,
        fadeIn: 0,
        fadeOut: 0,
        // A stale note-level channel must not override explicit track routing.
        notes: [{ id: 'note', pitch: 64, channel: 9, startBeat: 0, durationBeats: 1, velocity: 1 }],
        provenance: { source: 'user', createdAt: project.createdAt },
      }],
    }];

    const imported = importMidi(exportMidi(project), { now: project.createdAt });
    expect(imported.tracks[0]).toMatchObject({
      midi: {
        channel: 4,
        instrument: { kind: 'melodic', playbackId: 'WebAudio-TinySynth', program: 40 },
      },
    });
    const clip = imported.tracks[0].clips[0];
    expect(clip.kind === 'midi' ? clip.notes[0].channel : undefined).toBe(4);
  });

  it('exports drums only on MIDI wire channel 10 without a melodic program profile', () => {
    const project = createBlankProject({ now: '2026-07-15T00:00:00.000Z', bpm: 120 });
    project.tracks = [{
      id: 'drum-track',
      name: 'Drums',
      kind: 'midi',
      midi: { channel: 9, instrument: { kind: 'drums', playbackId: 'WebAudioFont 128_0_Chaos_sf2_file' } },
      color: '#ff704d',
      gain: 1,
      pan: 0,
      mute: false,
      solo: false,
      clips: [{
        id: 'drum-clip',
        name: 'Drums',
        kind: 'midi',
        startBeat: 0,
        durationBeats: 1,
        offsetBeats: 0,
        gain: 1,
        fadeIn: 0,
        fadeOut: 0,
        notes: [{ id: 'kick', pitch: 36, channel: 0, startBeat: 0, durationBeats: 0.25, velocity: 1 }],
        provenance: { source: 'user', createdAt: project.createdAt },
      }],
    }];

    const imported = importMidi(exportMidi(project), { now: project.createdAt });
    expect(imported.tracks[0]).toMatchObject({
      midi: {
        channel: 9,
        instrument: { kind: 'drums', playbackId: 'WebAudioFont 128_0_Chaos_sf2_file' },
      },
    });
    const clip = imported.tracks[0].clips[0];
    expect(clip.kind === 'midi' ? clip.notes[0].channel : undefined).toBe(9);
  });

  it('rejects malformed input', () => {
    expect(() => importMidi(Uint8Array.from([1, 2, 3, 4]))).toThrow();
  });
});
