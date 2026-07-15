import { describe, expect, it } from 'vitest'
import type { MidiNote } from '../types'
import { existingMidiNoteIds, normalizeMidiNoteBatch } from './midiNoteBatch'

const notes: MidiNote[] = [
  { id: 'a', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 0.5 },
  { id: 'b', pitch: 64, startBeat: 1, durationBeats: 0.5, velocity: 0.8, channel: 2 },
]

describe('MIDI note atomic batch normalization', () => {
  it('merges duplicate ids, preserves order, and drops no-op or missing edits', () => {
    expect(normalizeMidiNoteBatch(notes, [
      { id: 'a', patch: { pitch: 61 } },
      { id: 'missing', patch: { pitch: 70 } },
      { id: 'a', patch: { durationBeats: 2 } },
      { id: 'b', patch: { velocity: 0.8 } },
    ])).toEqual([{ id: 'a', patch: { pitch: 61, durationBeats: 2 } }])
  })

  it('rejects invalid musical fields and never accepts identity replacement', () => {
    expect(normalizeMidiNoteBatch(notes, [{
      id: 'a',
      patch: { id: 'replacement', pitch: 128, startBeat: -1, durationBeats: 0, velocity: Number.NaN, channel: 16 },
    }])).toEqual([])
  })

  it('deduplicates deletion ids against the current source notes', () => {
    expect(existingMidiNoteIds(notes, ['b', 'missing', 'a', 'b'])).toEqual(['b', 'a'])
  })
})
