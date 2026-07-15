import type { Clip, ClipSourceLoop, MidiClip, MidiNote } from '../types';

const LOOP_EPSILON = 1e-9;
const MAX_SOURCE_SLICES = 1_000_000;

/** Smallest source cycle accepted by core helpers and project imports (1/64 beat). */
export const MIN_SOURCE_LOOP_CYCLE_BEATS = 1 / 64;

export type MidiCrossingNotePolicy = 'keep' | 'shorten' | 'split';

export interface ClipSourceSlice {
  /** Position relative to the arrangement clip's left edge. */
  placementStartBeat: number;
  durationBeats: number;
  /** Position in the immutable source represented at this placement slice. */
  sourceStartBeat: number;
}

export interface ArrangedMidiNote {
  note: MidiNote;
  /** Absolute project beat after source offset/loop expansion and range clipping. */
  startBeat: number;
  durationBeats: number;
  /** Elapsed beats since the authored source-note onset. */
  noteOffsetBeats: number;
}

export type SplitEntityIdFactory = (kind: 'clip' | 'note', sourceId: string) => string;

export interface SplitClipOptions {
  createId: SplitEntityIdFactory;
  /** Required for MIDI, even when no note happens to cross this split. */
  crossingNotePolicy?: MidiCrossingNotePolicy;
}

export interface SplitClipResult<T extends Clip = Clip> {
  left: T;
  right: T;
  /** Arrangement UX selects the newly-created right result, matching the edit direction. */
  selectedClipId: string;
}

export const positiveModulo = (value: number, modulus: number): number => {
  if (!Number.isFinite(value) || !Number.isFinite(modulus) || modulus <= 0) {
    throw new RangeError('Modulo operands must be finite and modulus must be positive');
  }
  const result = value % modulus;
  return result < 0 ? result + modulus : result;
};

export const normalizeSourceLoop = (loop: ClipSourceLoop): ClipSourceLoop => {
  if (!Number.isFinite(loop.cycleStartBeat) || loop.cycleStartBeat < 0) {
    throw new RangeError('Source-loop cycle start must be a non-negative finite beat');
  }
  if (!Number.isFinite(loop.cycleLengthBeats) || loop.cycleLengthBeats < MIN_SOURCE_LOOP_CYCLE_BEATS) {
    throw new RangeError(`Source-loop cycle length must be at least ${MIN_SOURCE_LOOP_CYCLE_BEATS} beat`);
  }
  return {
    cycleStartBeat: loop.cycleStartBeat,
    cycleLengthBeats: loop.cycleLengthBeats,
    phaseBeats: positiveModulo(loop.phaseBeats, loop.cycleLengthBeats),
  };
};

/** Source beat heard at one position relative to the arrangement clip's left edge. */
export const sourceBeatAtClipPosition = (
  clip: Pick<Clip, 'offsetBeats' | 'sourceLoop'>,
  placementPositionBeat: number,
): number => {
  if (!Number.isFinite(placementPositionBeat)) throw new RangeError('Clip position must be finite');
  if (!clip.sourceLoop) return clip.offsetBeats + placementPositionBeat;
  const loop = normalizeSourceLoop(clip.sourceLoop);
  return loop.cycleStartBeat
    + positiveModulo(loop.phaseBeats + placementPositionBeat, loop.cycleLengthBeats);
};

/**
 * Expands a placement interval into contiguous source reads. Loop boundaries are
 * explicit slices so WebAudio can schedule the same source mapping as CPU export.
 */
export function getClipSourceSlices(
  clip: Pick<Clip, 'durationBeats' | 'offsetBeats' | 'sourceLoop'>,
  fromPlacementBeat = 0,
  toPlacementBeat = clip.durationBeats,
): ClipSourceSlice[] {
  if (!Number.isFinite(fromPlacementBeat) || !Number.isFinite(toPlacementBeat)) {
    throw new RangeError('Source-slice range must be finite');
  }
  const from = Math.max(0, Math.min(clip.durationBeats, fromPlacementBeat));
  const to = Math.max(from, Math.min(clip.durationBeats, toPlacementBeat));
  if (to - from <= LOOP_EPSILON) return [];
  if (!clip.sourceLoop) {
    return [{
      placementStartBeat: from,
      durationBeats: to - from,
      sourceStartBeat: clip.offsetBeats + from,
    }];
  }

  const loop = normalizeSourceLoop(clip.sourceLoop);
  const slices: ClipSourceSlice[] = [];
  let placement = from;
  while (placement < to - LOOP_EPSILON) {
    if (slices.length >= MAX_SOURCE_SLICES) {
      throw new RangeError('Source-loop expansion exceeds the safe slice limit');
    }
    const phase = positiveModulo(loop.phaseBeats + placement, loop.cycleLengthBeats);
    const untilCycleEnd = loop.cycleLengthBeats - phase;
    const durationBeats = Math.min(to - placement, untilCycleEnd);
    if (durationBeats <= LOOP_EPSILON) {
      placement += Math.min(to - placement, LOOP_EPSILON);
      continue;
    }
    slices.push({
      placementStartBeat: placement,
      durationBeats,
      sourceStartBeat: loop.cycleStartBeat + phase,
    });
    placement += durationBeats;
  }
  return slices;
}

/**
 * Expands authored source notes into audible arrangement instances. A note is
 * clipped at source-cycle boundaries, preventing an internal loop repeat from
 * leaking a tail over the next iteration.
 */
export function getArrangedMidiNotes(
  clip: MidiClip,
  fromBeat = clip.startBeat,
  toBeat = clip.startBeat + clip.durationBeats,
): ArrangedMidiNote[] {
  const clipEnd = clip.startBeat + clip.durationBeats;
  const rangeStart = Math.max(clip.startBeat, fromBeat);
  const rangeEnd = Math.min(clipEnd, toBeat);
  if (rangeEnd - rangeStart <= LOOP_EPSILON) return [];
  const slices = getClipSourceSlices(
    clip,
    rangeStart - clip.startBeat,
    rangeEnd - clip.startBeat,
  );
  const instances: ArrangedMidiNote[] = [];
  for (const slice of slices) {
    const sourceEnd = slice.sourceStartBeat + slice.durationBeats;
    for (const note of clip.notes) {
      const noteEnd = note.startBeat + note.durationBeats;
      const sourceStart = Math.max(slice.sourceStartBeat, note.startBeat);
      const clippedSourceEnd = Math.min(sourceEnd, noteEnd);
      if (clippedSourceEnd - sourceStart <= LOOP_EPSILON) continue;
      instances.push({
        note,
        startBeat: clip.startBeat + slice.placementStartBeat + (sourceStart - slice.sourceStartBeat),
        durationBeats: clippedSourceEnd - sourceStart,
        noteOffsetBeats: sourceStart - note.startBeat,
      });
    }
  }
  return instances.sort((a, b) =>
    a.startBeat - b.startBeat
    || a.note.pitch - b.note.pitch
    || a.note.id.localeCompare(b.note.id));
}

/** Resize only the arrangement/loop span; source-cycle fields remain unchanged. */
export function resizeClipPlacement<T extends Clip>(clip: T, durationBeats: number): T {
  if (!Number.isFinite(durationBeats) || durationBeats <= 0) {
    throw new RangeError('Clip placement duration must be positive and finite');
  }
  return { ...structuredClone(clip), durationBeats };
}

/** Move the lower/left source edge while preserving loop phase and the old right edge. */
export function trimClipStart<T extends Clip>(clip: T, startBeat: number): T {
  if (!Number.isFinite(startBeat)) throw new RangeError('Clip start must be finite');
  const oldEnd = clip.startBeat + clip.durationBeats;
  if (startBeat >= oldEnd) throw new RangeError('Clip start trim must remain before the clip end');
  const delta = startBeat - clip.startBeat;
  const next = structuredClone(clip);
  next.startBeat = startBeat;
  next.durationBeats = oldEnd - startBeat;
  next.offsetBeats += delta;
  if (next.sourceLoop) {
    next.sourceLoop.phaseBeats = positiveModulo(
      next.sourceLoop.phaseBeats + delta,
      next.sourceLoop.cycleLengthBeats,
    );
  }
  return next;
}

const checkedId = (
  factory: SplitEntityIdFactory,
  kind: 'clip' | 'note',
  sourceId: string,
  usedIds: ReadonlySet<string>,
): string => {
  const id = factory(kind, sourceId);
  if (typeof id !== 'string' || id.length === 0) throw new Error(`Split ${kind} id factory returned an empty id`);
  if (id === sourceId || usedIds.has(id)) throw new Error(`Split ${kind} id factory returned a duplicate id "${id}"`);
  return id;
};

const splitMidiNotes = (
  clip: MidiClip,
  splitSourceBeat: number,
  policy: MidiCrossingNotePolicy,
  createId: SplitEntityIdFactory,
): { left: MidiNote[]; right: MidiNote[] } => {
  const left: MidiNote[] = [];
  const right: MidiNote[] = [];
  const usedIds = new Set(clip.notes.map((note) => note.id));
  for (const original of clip.notes) {
    const note = structuredClone(original);
    const noteEnd = note.startBeat + note.durationBeats;
    if (noteEnd <= splitSourceBeat + LOOP_EPSILON) {
      left.push(note);
      continue;
    }
    if (note.startBeat >= splitSourceBeat - LOOP_EPSILON) {
      right.push(note);
      continue;
    }

    if (policy === 'keep') {
      left.push(note);
      continue;
    }
    const leftDuration = splitSourceBeat - note.startBeat;
    if (leftDuration > LOOP_EPSILON) left.push({ ...note, durationBeats: leftDuration });
    if (policy === 'split') {
      const continuationId = checkedId(createId, 'note', note.id, usedIds);
      usedIds.add(continuationId);
      right.push({
        ...note,
        id: continuationId,
        startBeat: splitSourceBeat,
        durationBeats: noteEnd - splitSourceBeat,
      });
    }
  }
  return { left, right };
};

/**
 * Non-mutating arrangement split. For unlooped MIDI, crossing-note semantics are:
 * keep = retain the full hidden note only on the left; shorten = end it at the
 * split; split = shorten left and create a newly-attacked continuation on right.
 *
 * Source-loop MIDI keeps its authored cycle in both children for `keep`.
 * A crossing `shorten`/`split` is rejected instead of pretending to edit one
 * repeat while silently changing every occurrence of the shared source note.
 */
export function splitClipAtBeat<T extends Clip>(
  clip: T,
  atBeat: number,
  options: SplitClipOptions,
): SplitClipResult<T> {
  const clipEnd = clip.startBeat + clip.durationBeats;
  if (!Number.isFinite(atBeat) || atBeat <= clip.startBeat || atBeat >= clipEnd) {
    throw new RangeError('Split beat must be strictly inside the clip placement');
  }
  if (!options || typeof options.createId !== 'function') throw new Error('Split requires an explicit id factory');
  if (clip.kind === 'midi' && !options.crossingNotePolicy) {
    throw new Error('MIDI split requires an explicit crossing-note policy');
  }
  if (clip.kind === 'midi' && clip.sourceLoop && options.crossingNotePolicy !== 'keep') {
    const hasCrossingInstance = getArrangedMidiNotes(clip).some((instance) =>
      instance.startBeat < atBeat - LOOP_EPSILON
      && instance.startBeat + instance.durationBeats > atBeat + LOOP_EPSILON);
    if (hasCrossingInstance) {
      throw new Error('Looped MIDI crossing notes support keep; flatten the source loop before shorten or split');
    }
  }
  const rightId = checkedId(options.createId, 'clip', clip.id, new Set([clip.id]));
  const localSplit = atBeat - clip.startBeat;
  const left = structuredClone(clip);
  const right = structuredClone(clip);
  left.durationBeats = localSplit;
  // A split creates an edit boundary, not a new audible envelope edge.
  left.fadeOut = 0;
  right.id = rightId;
  right.startBeat = atBeat;
  right.durationBeats = clipEnd - atBeat;
  right.offsetBeats += localSplit;
  right.fadeIn = 0;
  if (right.sourceLoop) {
    right.sourceLoop.phaseBeats = positiveModulo(
      right.sourceLoop.phaseBeats + localSplit,
      right.sourceLoop.cycleLengthBeats,
    );
  }

  if (clip.kind === 'midi' && left.kind === 'midi' && right.kind === 'midi') {
    if (clip.sourceLoop) {
      left.notes = structuredClone(clip.notes);
      right.notes = structuredClone(clip.notes);
    } else {
      const notes = splitMidiNotes(
        clip,
        clip.offsetBeats + localSplit,
        options.crossingNotePolicy!,
        options.createId,
      );
      left.notes = notes.left;
      right.notes = notes.right;
    }
  }

  return { left, right, selectedClipId: rightId } as SplitClipResult<T>;
}
