import type { AudioAsset, Clip, Project, Track, WaveformPeakLevel } from '../types'

export const MIN_TIMELINE_BARS = 16
export const TIMELINE_TRAILING_BARS = 4

/**
 * Returns a bar-aligned, content-driven Arrangement extent.
 *
 * The timeline always opens with enough room for a 16-bar sketch and keeps a
 * four-bar landing zone after the latest clip, cycle, or requested cursor.
 * Committing material into that landing zone grows the next extent, so project
 * length is never a hidden serialization or editing limit.
 */
export const getArrangementTimelineBeats = (
  project: Pick<Project, 'timeSignature' | 'loop' | 'tracks'>,
  requestedEndBeat = 0,
): number => {
  const beatsPerBar = (project.timeSignature.numerator * 4) / project.timeSignature.denominator
  if (!Number.isFinite(beatsPerBar) || beatsPerBar <= 0) {
    throw new RangeError('Arrangement timeline requires a valid time signature')
  }
  const contentEndBeat = Math.max(
    0,
    requestedEndBeat,
    project.loop.enabled ? project.loop.endBeat : 0,
    ...project.tracks.flatMap((track) => track.clips.map((clip) => clip.startBeat + clip.durationBeats)),
  )
  const requiredBeats = Math.max(
    MIN_TIMELINE_BARS * beatsPerBar,
    contentEndBeat + TIMELINE_TRAILING_BARS * beatsPerBar,
  )
  return Math.ceil((requiredBeats - 1e-9) / beatsPerBar) * beatsPerBar
}

export const formatTime = (seconds: number): string => {
  const safe = Math.max(0, seconds)
  const minutes = Math.floor(safe / 60)
  const rest = Math.floor(safe % 60)
  return `${minutes}:${rest.toString().padStart(2, '0')}`
}

export const midiNoteName = (pitch: number): string => {
  const names = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']
  return `${names[((pitch % 12) + 12) % 12]}${Math.floor(pitch / 12) - 1}`
}

export const findClip = (
  project: Project,
  clipId: string | null,
): { track: Track; clip: Clip } | null => {
  if (!clipId) return null
  for (const track of project.tracks) {
    const clip = track.clips.find((entry) => entry.id === clipId)
    if (clip) return { track, clip }
  }
  return null
}

export const findAsset = (project: Project, assetId?: string): AudioAsset | undefined =>
  assetId ? project.assets.find((asset) => asset.id === assetId) : undefined

export const moveTrackInOrder = (
  tracks: Track[],
  trackId: string,
  direction: 'up' | 'down',
): Track[] => {
  const currentIndex = tracks.findIndex((track) => track.id === trackId)
  const nextIndex = currentIndex + (direction === 'up' ? -1 : 1)
  if (currentIndex < 0 || nextIndex < 0 || nextIndex >= tracks.length) return tracks
  const reordered = [...tracks]
  const [track] = reordered.splice(currentIndex, 1)
  reordered.splice(nextIndex, 0, track)
  return reordered
}

export const findCompatibleTrackId = (
  tracks: readonly Track[],
  sourceTrackId: string,
  kind: Track['kind'],
  direction: 'up' | 'down',
): string | null => {
  const sourceIndex = tracks.findIndex((track) => track.id === sourceTrackId)
  if (sourceIndex < 0) return null
  const step = direction === 'up' ? -1 : 1
  for (let index = sourceIndex + step; index >= 0 && index < tracks.length; index += step) {
    if (tracks[index].kind === kind) return tracks[index].id
  }
  return null
}

export const findClipCollision = (
  track: Pick<Track, 'clips'>,
  clipId: string,
  startBeat: number,
  durationBeats: number,
): Clip | null => {
  if (!Number.isFinite(startBeat) || !Number.isFinite(durationBeats) || durationBeats <= 0) return null
  const endBeat = startBeat + durationBeats
  const epsilon = 1e-9
  return track.clips.find((clip) =>
    clip.id !== clipId
    && startBeat < clip.startBeat + clip.durationBeats - epsilon
    && endBeat > clip.startBeat + epsilon,
  ) ?? null
}

/** Earliest non-overlapping start at or after the requested beat on one track. */
export const findNextAvailableClipStart = (
  track: Pick<Track, 'clips'>,
  clipId: string,
  requestedStartBeat: number,
  durationBeats: number,
): number => {
  if (!Number.isFinite(requestedStartBeat) || !Number.isFinite(durationBeats) || durationBeats <= 0) {
    throw new RangeError('Clip placement requires a finite start and positive duration')
  }
  let startBeat = Math.max(0, requestedStartBeat)
  const clips = track.clips
    .filter((clip) => clip.id !== clipId)
    .sort((left, right) => left.startBeat - right.startBeat)
  for (const clip of clips) {
    if (startBeat + durationBeats <= clip.startBeat + 1e-9) break
    if (startBeat < clip.startBeat + clip.durationBeats - 1e-9) {
      startBeat = clip.startBeat + clip.durationBeats
    }
  }
  return startBeat
}

export const waveformPath = (
  waveform: WaveformPeakLevel | undefined,
  width = 1000,
  height = 100,
): string => {
  if (!waveform?.max.length) return ''
  const values = waveform.max
  const center = height / 2
  const top = values.map((value, index) => {
    const x = (index / Math.max(1, values.length - 1)) * width
    const y = center - Math.max(0.03, value) * center * 0.88
    return `${x.toFixed(2)},${y.toFixed(2)}`
  })
  const bottom = [...values].reverse().map((value, reverseIndex) => {
    const index = values.length - reverseIndex - 1
    const x = (index / Math.max(1, values.length - 1)) * width
    const min = waveform?.min[index] ?? -value * 0.78
    const y = center + Math.abs(min) * center * 0.88
    return `${x.toFixed(2)},${y.toFixed(2)}`
  })
  return `M ${top.join(' L ')} L ${bottom.join(' L ')} Z`
}

export const noteRange = (notes: Array<{ pitch: number }>): { min: number; max: number } => {
  if (!notes.length) return { min: 48, max: 72 }
  const pitches = notes.map((note) => note.pitch)
  const min = Math.min(...pitches)
  const max = Math.max(...pitches)
  return { min: Math.floor(min / 12) * 12, max: Math.ceil((max + 1) / 12) * 12 }
}
