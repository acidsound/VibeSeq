import { describe, expect, it } from 'vitest'
import { extractMonoPcmClipSegment, extractMonoPcmSegment } from './segment'

const clipMapping = (
  overrides: Partial<Parameters<typeof extractMonoPcmClipSegment>[2]> = {},
): Parameters<typeof extractMonoPcmClipSegment>[2] => ({
  durationBeats: 1,
  offsetBeats: 0,
  timebase: { mode: 'fixed-seconds', sourceBpm: 60 },
  ...overrides,
})

describe('audio segment extraction', () => {
  it('crops the selected interval and downmixes every source channel', () => {
    const segment = extractMonoPcmSegment([
      Float32Array.from([0, 0.2, 0.4, 0.6, 0.8, 1]),
      Float32Array.from([0, -0.2, -0.2, 0.2, 0.4, 0.6]),
    ], 2, 1, 1.5)

    expect(segment.durationSeconds).toBe(1.5)
    expect(segment.channelData[0][0]).toBeCloseTo(0.1)
    expect(segment.channelData[0][1]).toBeCloseTo(0.4)
    expect(segment.channelData[0][2]).toBeCloseTo(0.6)
  })

  it('rejects a selection outside the source media', () => {
    expect(() => extractMonoPcmSegment([new Float32Array(4)], 2, 4, 1)).toThrow(
      'outside the source audio',
    )
  })

  it('uses the clip trim offset and downmixes stereo without changing the source', () => {
    const left = Float32Array.from([0, 1, 2, 3, 4, 5, 6, 7])
    const right = Float32Array.from([0, -1, 4, 1, 8, 3, 12, 5])
    const leftBefore = left.slice()
    const rightBefore = right.slice()

    const segment = extractMonoPcmClipSegment(
      [left, right],
      2,
      clipMapping({ offsetBeats: 1, durationBeats: 1.5 }),
      60,
    )

    expect(Array.from(segment.channelData[0])).toEqual([3, 2, 6])
    expect(segment.durationSeconds).toBe(1.5)
    expect(left).toEqual(leftBefore)
    expect(right).toEqual(rightBefore)
  })

  it('preserves an onset on the exact first source frame instead of rounding past it', () => {
    const source = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 0])
    const segment = extractMonoPcmClipSegment(
      [source],
      10,
      clipMapping({ offsetBeats: 0.3, durationBeats: 0.2 }),
      60,
    )

    expect(segment.channelData[0]).toHaveLength(2)
    expect(Array.from(segment.channelData[0])).toEqual([1, 0])
  })

  it('concatenates an initial partial cycle and repeated source slices', () => {
    const source = Float32Array.from({ length: 16 }, (_, index) => index)
    const segment = extractMonoPcmClipSegment(
      [source],
      4,
      clipMapping({
        durationBeats: 2.5,
        offsetBeats: 9,
        sourceLoop: { cycleStartBeat: 1, cycleLengthBeats: 1, phaseBeats: 0.5 },
      }),
      60,
    )

    expect(Array.from(segment.channelData[0])).toEqual([6, 7, 4, 5, 6, 7, 4, 5, 6, 7])
    expect(segment.durationSeconds).toBe(2.5)
  })

  it('keeps a final fractional repeat and interpolates fractional source-frame offsets', () => {
    const segment = extractMonoPcmClipSegment(
      [Float32Array.from([0, 1, 2, 3, 4, 5])],
      2,
      clipMapping({
        durationBeats: 1.25,
        sourceLoop: { cycleStartBeat: 0, cycleLengthBeats: 1, phaseBeats: 0.25 },
      }),
      60,
    )

    expect(Array.from(segment.channelData[0])).toEqual([0.5, 1.5, 0.5])
    expect(segment.durationSeconds).toBe(1.5)
  })

  it('rejects negative source mappings and renders lengthened tails as silence', () => {
    const source = new Float32Array(4)

    expect(() => extractMonoPcmClipSegment(
      [source],
      2,
      clipMapping({ offsetBeats: -0.5 }),
      60,
    )).toThrow('outside the source audio')

    const overlong = extractMonoPcmClipSegment(
      [Float32Array.from([1, 2, 3, 4])],
      2,
      clipMapping({ offsetBeats: 1.5, durationBeats: 1 }),
      60,
    )
    expect(Array.from(overlong.channelData[0])).toEqual([4, 0])
  })

  it('downmixes available channels and treats a shorter channel tail as silence', () => {
    const segment = extractMonoPcmClipSegment(
      [Float32Array.from([0, 0, 2, 4, 6, 8, 10, 12]), Float32Array.from([0, 0, 2])],
      2,
      clipMapping({ offsetBeats: 1, durationBeats: 1 }),
      60,
    )
    expect(Array.from(segment.channelData[0])).toEqual([2, 2])
  })

  it.each([
    { bpm: 60, expectedDuration: 8, expectedFrames: 64 },
    { bpm: 120, expectedDuration: 4, expectedFrames: 32 },
    { bpm: 240, expectedDuration: 2, expectedFrames: 16 },
  ])('extracts the exact tempo-follow signal heard at $bpm BPM', ({ bpm, expectedDuration, expectedFrames }) => {
    const sampleRate = 8
    const source = Float32Array.from(
      { length: sampleRate * 4 },
      (_, frame) => 0.1 + (frame / ((sampleRate * 4) - 1)) * 0.4,
    )
    const segment = extractMonoPcmClipSegment(
      [source],
      sampleRate,
      clipMapping({
        durationBeats: 8,
        timebase: { mode: 'tempo-follow-repitch', sourceBpm: 120 },
      }),
      bpm,
    )

    expect(segment.durationSeconds).toBe(expectedDuration)
    expect(segment.channelData[0]).toHaveLength(expectedFrames)
    expect(segment.channelData[0][0]).toBeCloseTo(0.1, 6)
    expect(segment.channelData[0].at(-1)).toBeGreaterThan(0.48)
  })

  it('validates clip timing before allocating output PCM', () => {
    const source = [new Float32Array(4)]
    expect(() => extractMonoPcmClipSegment(source, 2, clipMapping({ durationBeats: 0 }), 60))
      .toThrow('Clip duration must be positive')
    expect(() => extractMonoPcmClipSegment(source, 2, clipMapping(), 0))
      .toThrow('bpm must be positive')
  })
})
