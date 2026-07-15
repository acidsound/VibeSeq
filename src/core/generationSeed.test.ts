import { describe, expect, it } from 'vitest'
import {
  MAX_GENERATION_SEED,
  parseGenerationSeedDraft,
  randomGenerationSeed,
} from './generationSeed'

describe('Stable Audio generation seeds', () => {
  it('accepts exact integers, clamps the API range, and rejects ambiguous drafts', () => {
    expect(parseGenerationSeedDraft('61061')).toBe(61_061)
    expect(parseGenerationSeedDraft('  +42 ')).toBe(42)
    expect(parseGenerationSeedDraft('-9')).toBe(0)
    expect(parseGenerationSeedDraft(String(MAX_GENERATION_SEED + 1))).toBe(MAX_GENERATION_SEED)
    expect(parseGenerationSeedDraft('')).toBeNull()
    expect(parseGenerationSeedDraft('1.5')).toBeNull()
    expect(parseGenerationSeedDraft('1e3')).toBeNull()
  })

  it('uses all 32 random bits without narrowing the generated seed', () => {
    expect(randomGenerationSeed((target) => { target[0] = 0xfedc_ba98 })).toBe(0xfedc_ba98)
  })
})
