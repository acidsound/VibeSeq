import { describe, expect, it } from 'vitest'
import { BUILTIN_CHAOS_DRUM_ASSETS } from './builtinMidiAssets'

describe('built-in MIDI asset packaging', () => {
  it('keeps every drum sample as a fetchable file URL instead of a CSP-blocked data URL', () => {
    expect(BUILTIN_CHAOS_DRUM_ASSETS).toHaveLength(4)
    for (const asset of BUILTIN_CHAOS_DRUM_ASSETS) {
      expect(asset.url.startsWith('data:')).toBe(false)
      expect(asset.url).toContain('.mp3')
    }
  })
})
