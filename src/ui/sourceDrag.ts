export const AUDIO_SOURCE_DRAG_TYPE = 'application/x-vibeseq-audio-source'

export type AudioSourceDragPayload = {
  source: 'candidate' | 'library'
  id: string
  durationBeats: number
  grabOffsetX: number
}

let activeAudioSourceDrag: AudioSourceDragPayload | null = null

const isAudioSourceDragPayload = (payload: Partial<AudioSourceDragPayload>): payload is AudioSourceDragPayload => (
  (payload.source === 'candidate' || payload.source === 'library')
  && typeof payload.id === 'string'
  && Boolean(payload.id)
  && typeof payload.durationBeats === 'number'
  && Number.isFinite(payload.durationBeats)
  && payload.durationBeats > 0
  && typeof payload.grabOffsetX === 'number'
  && Number.isFinite(payload.grabOffsetX)
  && payload.grabOffsetX >= 0
)

export const writeAudioSourceDrag = (dataTransfer: DataTransfer, payload: AudioSourceDragPayload): void => {
  activeAudioSourceDrag = payload
  dataTransfer.effectAllowed = 'copy'
  dataTransfer.setData(AUDIO_SOURCE_DRAG_TYPE, JSON.stringify(payload))
}

export const clearAudioSourceDrag = (): void => { activeAudioSourceDrag = null }

export const hasAudioSourceDrag = (dataTransfer: DataTransfer): boolean =>
  Array.from(dataTransfer.types).includes(AUDIO_SOURCE_DRAG_TYPE)

export const readAudioSourceDrag = (dataTransfer: DataTransfer): AudioSourceDragPayload | null => {
  if (!hasAudioSourceDrag(dataTransfer)) return null
  try {
    const serialized = dataTransfer.getData(AUDIO_SOURCE_DRAG_TYPE)
    if (!serialized) return activeAudioSourceDrag
    const payload = JSON.parse(serialized) as Partial<AudioSourceDragPayload>
    return isAudioSourceDragPayload(payload) ? payload : null
  } catch {
    return activeAudioSourceDrag
  }
}
