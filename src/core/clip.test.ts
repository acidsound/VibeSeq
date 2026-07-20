import { describe, expect, it } from 'vitest';
import type { AudioClip, MidiClip } from '../types';
import {
  getArrangedMidiNotes,
  getClipSourceSlices,
  resizeClipPlacement,
  sourceBeatAtClipPosition,
  splitClipAtBeat,
  trimClipStart,
} from './clip';

const timestamp = '2026-07-15T00:00:00.000Z';

const audioLoop = (): AudioClip => ({
  id: 'audio-loop',
  name: 'Audio loop',
  kind: 'audio',
  assetId: 'asset-loop',
  startBeat: 4,
  durationBeats: 5.5,
  offsetBeats: 1,
  timebase: { mode: 'tempo-follow-repitch', sourceBpm: 120 },
  sourceLoop: { cycleStartBeat: 8, cycleLengthBeats: 2, phaseBeats: 0.5 },
  gain: 1,
  fadeIn: 0,
  fadeOut: 0,
  provenance: { source: 'user', createdAt: timestamp },
});

const midiClip = (): MidiClip => ({
  id: 'midi-source',
  name: 'MIDI source',
  kind: 'midi',
  startBeat: 2,
  durationBeats: 4,
  offsetBeats: 0,
  gain: 1,
  fadeIn: 0,
  fadeOut: 0,
  notes: [
    { id: 'before', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 0.8 },
    { id: 'crossing', pitch: 64, startBeat: 1, durationBeats: 2, velocity: 0.8 },
    { id: 'after', pitch: 67, startBeat: 3, durationBeats: 0.5, velocity: 0.8 },
  ],
  provenance: { source: 'user', createdAt: timestamp },
});

describe('clip source loops', () => {
  it('keeps source and placement spans distinct, including a non-integer final repeat', () => {
    const clip = audioLoop();
    expect(sourceBeatAtClipPosition(clip, 0)).toBe(8.5);
    expect(sourceBeatAtClipPosition(clip, 1.5)).toBe(8);
    expect(sourceBeatAtClipPosition(clip, 4)).toBe(8.5);
    expect(getClipSourceSlices(clip)).toEqual([
      { placementStartBeat: 0, durationBeats: 1.5, sourceStartBeat: 8.5 },
      { placementStartBeat: 1.5, durationBeats: 2, sourceStartBeat: 8 },
      { placementStartBeat: 3.5, durationBeats: 2, sourceStartBeat: 8 },
    ]);
  });

  it('maps stretched placement beats into the rendered derivative and keeps trim/split phase exact', () => {
    const clip = audioLoop();
    clip.durationBeats = 11;
    clip.transform = {
      sourceAssetId: 'asset-loop-source',
      pitchSemitones: 7,
      stretchRatio: 2,
    };

    expect(sourceBeatAtClipPosition(clip, 0)).toBe(17);
    expect(sourceBeatAtClipPosition(clip, 3)).toBe(16);
    expect(getClipSourceSlices(clip).slice(0, 2)).toEqual([
      { placementStartBeat: 0, durationBeats: 3, sourceStartBeat: 17 },
      { placementStartBeat: 3, durationBeats: 4, sourceStartBeat: 16 },
    ]);

    const trimmed = trimClipStart(clip, 7.5);
    expect(trimmed.offsetBeats).toBe(2.75);
    expect(trimmed.sourceLoop?.phaseBeats).toBe(0.25);
    expect(sourceBeatAtClipPosition(trimmed, 0)).toBe(sourceBeatAtClipPosition(clip, 3.5));

    const split = splitClipAtBeat(clip, 8.5, { createId: () => 'stretched-right' });
    expect(split.right.offsetBeats).toBe(3.25);
    expect(split.right.sourceLoop?.phaseBeats).toBe(0.75);
    expect(sourceBeatAtClipPosition(split.right, 0)).toBe(sourceBeatAtClipPosition(clip, 4.5));
  });

  it('resizes only the placement and keeps the immutable source cycle', () => {
    const clip = audioLoop();
    const resized = resizeClipPlacement(clip, 9.25);
    expect(resized.durationBeats).toBe(9.25);
    expect(resized.sourceLoop).toEqual(clip.sourceLoop);
    expect(clip.durationBeats).toBe(5.5);
    expect(resized.sourceLoop).not.toBe(clip.sourceLoop);
  });

  it('keeps phase exact through left trim and split without mutating the source clip', () => {
    const clip = audioLoop();
    clip.fadeIn = 0.4;
    clip.fadeOut = 0.8;
    const original = structuredClone(clip);
    const trimmed = trimClipStart(clip, 5.75);
    expect(trimmed.durationBeats).toBe(3.75);
    expect(trimmed.offsetBeats).toBe(2.75);
    expect(trimmed.sourceLoop?.phaseBeats).toBe(0.25);
    expect(sourceBeatAtClipPosition(trimmed, 0)).toBe(sourceBeatAtClipPosition(clip, 1.75));

    const result = splitClipAtBeat(clip, 6.25, {
      createId: () => 'audio-loop-right',
    });
    expect(result.left.durationBeats).toBe(2.25);
    expect(result.right.startBeat).toBe(6.25);
    expect(result.right.durationBeats).toBe(3.25);
    expect(result.right.sourceLoop?.phaseBeats).toBe(0.75);
    expect(result.left.fadeIn).toBe(0.4);
    expect(result.left.fadeOut).toBe(0);
    expect(result.right.fadeIn).toBe(0);
    expect(result.right.fadeOut).toBe(0.8);
    expect(sourceBeatAtClipPosition(result.right, 0)).toBe(sourceBeatAtClipPosition(clip, 2.25));
    expect(result.selectedClipId).toBe('audio-loop-right');
    expect(clip).toEqual(original);
    expect(result.left).not.toBe(clip);
    expect(result.right.sourceLoop).not.toBe(clip.sourceLoop);
  });
});

describe('MIDI clip splitting', () => {
  it('does not manufacture fades at the internal split boundary', () => {
    const clip = midiClip();
    clip.fadeIn = 0.25;
    clip.fadeOut = 0.75;
    const result = splitClipAtBeat(clip, 4, {
      crossingNotePolicy: 'keep',
      createId: () => 'right-envelope',
    });
    expect(result.left).toMatchObject({ fadeIn: 0.25, fadeOut: 0 });
    expect(result.right).toMatchObject({ fadeIn: 0, fadeOut: 0.75 });
  });

  it('requires an explicit crossing-note policy and caller-owned ids', () => {
    const clip = midiClip();
    expect(() => splitClipAtBeat(clip, 4, { createId: () => 'right' })).toThrow(/crossing-note policy/);
    expect(() => splitClipAtBeat(clip, 4, {
      crossingNotePolicy: 'keep',
      createId: () => clip.id,
    })).toThrow(/duplicate id/);
  });

  it('keeps a crossing note non-destructively on the left', () => {
    const clip = midiClip();
    const result = splitClipAtBeat(clip, 4, {
      crossingNotePolicy: 'keep',
      createId: () => 'right-keep',
    });
    expect(result.left.kind).toBe('midi');
    expect(result.right.kind).toBe('midi');
    if (result.left.kind !== 'midi' || result.right.kind !== 'midi') return;
    expect(result.left.notes.map((note) => [note.id, note.durationBeats])).toEqual([
      ['before', 1],
      ['crossing', 2],
    ]);
    expect(result.right.notes.map((note) => note.id)).toEqual(['after']);
    expect(result.selectedClipId).toBe('right-keep');
  });

  it('shortens a crossing note at the split source beat', () => {
    const result = splitClipAtBeat(midiClip(), 4, {
      crossingNotePolicy: 'shorten',
      createId: () => 'right-shorten',
    });
    if (result.left.kind !== 'midi' || result.right.kind !== 'midi') return;
    expect(result.left.notes.find((note) => note.id === 'crossing')?.durationBeats).toBe(1);
    expect(result.right.notes.map((note) => note.id)).toEqual(['after']);
  });

  it('splits a crossing note with an explicit continuation id and selects the right clip', () => {
    const calls: Array<[string, string]> = [];
    const result = splitClipAtBeat(midiClip(), 4, {
      crossingNotePolicy: 'split',
      createId: (kind, sourceId) => {
        calls.push([kind, sourceId]);
        return kind === 'clip' ? 'right-split' : 'crossing-continuation';
      },
    });
    if (result.left.kind !== 'midi' || result.right.kind !== 'midi') return;
    expect(result.left.notes.find((note) => note.id === 'crossing')?.durationBeats).toBe(1);
    expect(result.right.notes).toEqual([
      { id: 'crossing-continuation', pitch: 64, startBeat: 2, durationBeats: 1, velocity: 0.8 },
      { id: 'after', pitch: 67, startBeat: 3, durationBeats: 0.5, velocity: 0.8 },
    ]);
    expect(calls).toEqual([['clip', 'midi-source'], ['note', 'crossing']]);
    expect(result.selectedClipId).toBe('right-split');
  });

  it('repeats source MIDI deterministically and clips the final partial cycle', () => {
    const clip = midiClip();
    clip.startBeat = 0;
    clip.durationBeats = 2.5;
    clip.sourceLoop = { cycleStartBeat: 0, cycleLengthBeats: 1, phaseBeats: 0 };
    clip.notes = [{ id: 'pulse', pitch: 60, startBeat: 0.25, durationBeats: 0.5, velocity: 0.8 }];
    expect(getArrangedMidiNotes(clip).map(({ startBeat, durationBeats, noteOffsetBeats }) => ({
      startBeat,
      durationBeats,
      noteOffsetBeats,
    }))).toEqual([
      { startBeat: 0.25, durationBeats: 0.5, noteOffsetBeats: 0 },
      { startBeat: 1.25, durationBeats: 0.5, noteOffsetBeats: 0 },
      { startBeat: 2.25, durationBeats: 0.25, noteOffsetBeats: 0 },
    ]);
  });

  it('rejects a destructive one-boundary policy for a repeated source note', () => {
    const clip = midiClip();
    clip.startBeat = 0;
    clip.durationBeats = 3;
    clip.sourceLoop = { cycleStartBeat: 0, cycleLengthBeats: 2, phaseBeats: 0 };
    clip.notes = [{ id: 'crossing-loop-note', pitch: 60, startBeat: 0.5, durationBeats: 1.5, velocity: 0.8 }];
    expect(() => splitClipAtBeat(clip, 1, {
      crossingNotePolicy: 'split',
      createId: (kind) => `${kind}-right`,
    })).toThrow(/flatten the source loop/);

    const kept = splitClipAtBeat(clip, 1, {
      crossingNotePolicy: 'keep',
      createId: () => 'loop-right',
    });
    expect(kept.right.sourceLoop?.phaseBeats).toBe(1);
    expect(kept.selectedClipId).toBe('loop-right');
  });
});
