import { afterEach, describe, expect, it } from 'vitest'
import {
  AUDIO_SOURCE_DRAG_TYPE,
  clearAudioSourceDrag,
  readAudioSourceDrag,
  writeAudioSourceDrag,
} from './sourceDrag'

afterEach(clearAudioSourceDrag)

describe('Audio source drag session', () => {
  it('keeps placement geometry available while dragover protects custom data', () => {
    const payload = {
      source: 'candidate' as const,
      id: 'candidate-1',
      durationBeats: 16,
      grabOffsetX: 84,
    }
    const values = new Map<string, string>()
    const types: string[] = []
    const writable = {
      types,
      effectAllowed: 'none',
      setData(type: string, value: string) {
        values.set(type, value)
        types.splice(0, types.length, ...values.keys())
      },
      getData(type: string) { return values.get(type) ?? '' },
    } as unknown as DataTransfer
    writeAudioSourceDrag(writable, payload)

    const protectedDragOver = {
      types: [AUDIO_SOURCE_DRAG_TYPE],
      getData: () => '',
    } as unknown as DataTransfer
    expect(readAudioSourceDrag(protectedDragOver)).toEqual(payload)

    clearAudioSourceDrag()
    expect(readAudioSourceDrag(protectedDragOver)).toBeNull()
  })
})
