import { describe, expect, it } from 'vitest';
import {
  barsBeatsTicksToBeat,
  beatToBarsBeatsTicks,
  beatsToSeconds,
  divisionToBeats,
  snapBeat,
} from './time';

describe('musical time', () => {
  it('converts straight, dotted and triplet divisions', () => {
    expect(divisionToBeats('1/16')).toBe(0.25);
    expect(divisionToBeats('1/8D')).toBe(0.75);
    expect(divisionToBeats('1/8T')).toBeCloseTo(1 / 3);
  });

  it('snaps around an arbitrary origin without breaking negative beats', () => {
    expect(snapBeat(1.12, { division: 0.25, originBeat: 0.125 })).toBe(1.125);
    expect(snapBeat(-0.13, { division: 0.25, mode: 'floor' })).toBe(-0.25);
    expect(snapBeat(1.12, { division: 0.25, strength: 0.5 })).toBe(1.06);
  });

  it('round-trips bars, beats and ticks in compound meter', () => {
    const signature = { numerator: 6, denominator: 8 } as const;
    const position = beatToBarsBeatsTicks(4.25, signature, 480);
    expect(position).toEqual({ bar: 2, beat: 3, tick: 120 });
    expect(barsBeatsTicksToBeat(position, signature, 480)).toBe(4.25);
    expect(beatsToSeconds(4, 120)).toBe(2);
  });
});
