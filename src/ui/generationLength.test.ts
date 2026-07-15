import { describe, expect, it } from 'vitest'
import { generationLengthChoiceId, generationLengthLabel, parseGenerationLengthChoice, resolveGenerationLength } from './generationLength'

describe('generation length', () => {
  it('keeps SFX seconds independent from project tempo', () => {
    const resolved = resolveGenerationLength({ unit: 'seconds', value: 4 }, 73, { numerator: 7, denominator: 8 })
    expect(resolved.durationSeconds).toBe(4)
    expect(generationLengthLabel(resolved)).toBe('4 sec')
  })

  it('resolves bars through both BPM and time signature', () => {
    const fourFour = resolveGenerationLength({ unit: 'bars', value: 2 }, 120, { numerator: 4, denominator: 4 })
    const sixEight = resolveGenerationLength({ unit: 'bars', value: 2 }, 120, { numerator: 6, denominator: 8 })
    expect(fourFour.durationSeconds).toBe(4)
    expect(sixEight.durationSeconds).toBe(3)
    expect(generationLengthLabel(sixEight)).toBe('2 bars · 3.00 sec @ 120.0 BPM')
  })

  it('round-trips selector values and rejects malformed choices', () => {
    const choice = { unit: 'bars', value: 4 } as const
    expect(parseGenerationLengthChoice(generationLengthChoiceId(choice))).toEqual(choice)
    expect(() => parseGenerationLengthChoice('frames:4')).toThrow(/seconds or bars/)
  })
})
