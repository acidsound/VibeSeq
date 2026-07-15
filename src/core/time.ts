import type { TimeSignature } from '../types';

export const DEFAULT_PPQ = 480;

export type NoteDivision =
  | '1/1'
  | '1/2'
  | '1/4'
  | '1/8'
  | '1/16'
  | '1/32'
  | '1/64'
  | '1/2D'
  | '1/4D'
  | '1/8D'
  | '1/16D'
  | '1/4T'
  | '1/8T'
  | '1/16T'
  | '1/32T';

export type SnapMode = 'nearest' | 'floor' | 'ceil';

export interface SnapOptions {
  division?: NoteDivision | number;
  mode?: SnapMode;
  originBeat?: number;
  strength?: number;
}

export interface BarsBeatsTicks {
  /** One-based bar number. */
  bar: number;
  /** One-based metrical beat within the bar. */
  beat: number;
  tick: number;
}

const assertFinitePositive = (value: number, label: string): void => {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a finite positive number`);
  }
};

/** Converts a musical note division to quarter-note beats. */
export function divisionToBeats(division: NoteDivision | number): number {
  if (typeof division === 'number') {
    assertFinitePositive(division, 'division');
    return division;
  }

  const match = /^(\d+)\/(\d+)([DT])?$/.exec(division);
  if (!match) throw new RangeError(`Unsupported note division: ${division}`);
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  assertFinitePositive(numerator, 'division numerator');
  assertFinitePositive(denominator, 'division denominator');

  let beats = (4 * numerator) / denominator;
  if (match[3] === 'D') beats *= 1.5;
  if (match[3] === 'T') beats *= 2 / 3;
  return beats;
}

export function snapBeat(
  beat: number,
  divisionOrOptions: NoteDivision | number | SnapOptions = '1/16',
): number {
  if (!Number.isFinite(beat)) return beat;
  const options: SnapOptions =
    typeof divisionOrOptions === 'object'
      ? divisionOrOptions
      : { division: divisionOrOptions };
  const grid = divisionToBeats(options.division ?? '1/16');
  const origin = options.originBeat ?? 0;
  const mode = options.mode ?? 'nearest';
  const strength = Math.min(1, Math.max(0, options.strength ?? 1));
  const ratio = (beat - origin) / grid;
  const snappedRatio =
    mode === 'floor' ? Math.floor(ratio) : mode === 'ceil' ? Math.ceil(ratio) : Math.round(ratio);
  const target = origin + snappedRatio * grid;
  const result = beat + (target - beat) * strength;
  return Math.abs(result) < 1e-12 ? 0 : Number(result.toFixed(12));
}

export function beatsToSeconds(beats: number, bpm: number): number {
  assertFinitePositive(bpm, 'bpm');
  return (beats * 60) / bpm;
}

export function secondsToBeats(seconds: number, bpm: number): number {
  assertFinitePositive(bpm, 'bpm');
  return (seconds * bpm) / 60;
}

export function beatsPerBar(timeSignature: TimeSignature): number {
  assertFinitePositive(timeSignature.numerator, 'time signature numerator');
  assertFinitePositive(timeSignature.denominator, 'time signature denominator');
  return (timeSignature.numerator * 4) / timeSignature.denominator;
}

export function metricalBeatLength(timeSignature: TimeSignature): number {
  return 4 / timeSignature.denominator;
}

export function beatToBarsBeatsTicks(
  absoluteBeat: number,
  timeSignature: TimeSignature,
  ppq = DEFAULT_PPQ,
): BarsBeatsTicks {
  assertFinitePositive(ppq, 'ppq');
  const barLength = beatsPerBar(timeSignature);
  const beatLength = metricalBeatLength(timeSignature);
  const clamped = Math.max(0, absoluteBeat);
  const barIndex = Math.floor(clamped / barLength);
  const withinBar = clamped - barIndex * barLength;
  const beatIndex = Math.floor((withinBar + 1e-10) / beatLength);
  const quarterRemainder = withinBar - beatIndex * beatLength;
  let tick = Math.round(quarterRemainder * ppq);
  let adjustedBeat = beatIndex;
  let adjustedBar = barIndex;
  if (tick >= Math.round(beatLength * ppq)) {
    tick = 0;
    adjustedBeat += 1;
    if (adjustedBeat >= timeSignature.numerator) {
      adjustedBeat = 0;
      adjustedBar += 1;
    }
  }
  return { bar: adjustedBar + 1, beat: adjustedBeat + 1, tick };
}

export function barsBeatsTicksToBeat(
  position: BarsBeatsTicks,
  timeSignature: TimeSignature,
  ppq = DEFAULT_PPQ,
): number {
  assertFinitePositive(ppq, 'ppq');
  const bar = Math.max(1, Math.trunc(position.bar));
  const beat = Math.max(1, Math.trunc(position.beat));
  return (
    (bar - 1) * beatsPerBar(timeSignature) +
    (beat - 1) * metricalBeatLength(timeSignature) +
    position.tick / ppq
  );
}

export function beatToPixels(beat: number, pixelsPerBeat: number, scrollBeat = 0): number {
  assertFinitePositive(pixelsPerBeat, 'pixelsPerBeat');
  return (beat - scrollBeat) * pixelsPerBeat;
}

export function pixelsToBeat(pixels: number, pixelsPerBeat: number, scrollBeat = 0): number {
  assertFinitePositive(pixelsPerBeat, 'pixelsPerBeat');
  return scrollBeat + pixels / pixelsPerBeat;
}

export function getProjectEndBeat(tracks: ReadonlyArray<{ clips: ReadonlyArray<{ startBeat: number; durationBeats: number }> }>): number {
  let endBeat = 0;
  for (const track of tracks) {
    for (const clip of track.clips) {
      endBeat = Math.max(endBeat, clip.startBeat + clip.durationBeats);
    }
  }
  return endBeat;
}
