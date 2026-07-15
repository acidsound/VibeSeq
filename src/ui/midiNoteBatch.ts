import type { MidiNote } from '../types'

export type MidiNoteBatchEdit = {
  id: string
  patch: Partial<MidiNote>
}

const NOTE_EPSILON = 1e-9

const validField = (key: keyof MidiNote, value: number): boolean => {
  if (!Number.isFinite(value)) return false
  if (key === 'pitch') return Number.isInteger(value) && value >= 0 && value <= 127
  if (key === 'startBeat') return value >= 0
  if (key === 'durationBeats') return value > 0
  if (key === 'velocity') return value > 0 && value <= 1
  if (key === 'channel') return Number.isInteger(value) && value >= 0 && value <= 15
  return false
}

const EDITABLE_FIELDS = ['pitch', 'startBeat', 'durationBeats', 'velocity', 'channel'] as const

/**
 * Deduplicate and validate a UI batch against the current source notes.
 * Identity is deliberately immutable: an edit may never replace a note id.
 */
export const normalizeMidiNoteBatch = (
  notes: readonly MidiNote[],
  candidateEdits: readonly MidiNoteBatchEdit[],
): MidiNoteBatchEdit[] => {
  const notesById = new Map(notes.map((note) => [note.id, note]))
  const merged = new Map<string, Partial<MidiNote>>()

  for (const edit of candidateEdits) {
    if (!notesById.has(edit.id)) continue
    const patch = { ...merged.get(edit.id) }
    for (const key of EDITABLE_FIELDS) {
      const value = edit.patch[key]
      if (typeof value === 'number' && validField(key, value)) patch[key] = value
    }
    merged.set(edit.id, patch)
  }

  return [...merged].flatMap(([id, patch]) => {
    const note = notesById.get(id)!
    const changed: Partial<MidiNote> = {}
    for (const key of EDITABLE_FIELDS) {
      const value = patch[key]
      if (typeof value !== 'number') continue
      const current = note[key]
      if (typeof current !== 'number' || Math.abs(current - value) > NOTE_EPSILON) changed[key] = value
    }
    return Object.keys(changed).length > 0 ? [{ id, patch: changed }] : []
  })
}

export const existingMidiNoteIds = (
  notes: readonly MidiNote[],
  candidateIds: readonly string[],
): string[] => {
  const available = new Set(notes.map((note) => note.id))
  return [...new Set(candidateIds)].filter((id) => available.has(id))
}
