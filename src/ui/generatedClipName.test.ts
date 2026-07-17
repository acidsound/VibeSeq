import { describe, expect, it } from 'vitest'
import { generatedClipName } from './generatedClipName'

describe('generatedClipName', () => {
  it('uses only the leading prompt words without semantic rewriting', () => {
    expect(generatedClipName('E minor, woman scat, smoky jazz phrasing, 120 BPM', 8))
      .toBe('E Minor Woman')
    expect(generatedClipName('A minor, uprising hard lead loop, 140bpm', 6.86))
      .toBe('A Minor Uprising')
  })

  it('preserves useful compound words while trimming punctuation', () => {
    expect(generatedClipName('dusty neo-soul drums, loose pocket, warm tape, 120 BPM', 8))
      .toBe('Dusty Neo-Soul Drums')
  })

  it('uses fewer leading words for a short clip and more for a long clip', () => {
    expect(generatedClipName('bright analog synth lead', 2)).toBe('Bright Analog')
    expect(generatedClipName('bright analog synth lead', 12)).toBe('Bright Analog Synth Lead')
  })

  it('falls back only when the prompt has no usable word', () => {
    expect(generatedClipName('  ...  ', 8)).toBe('Generated Sound')
  })
})
