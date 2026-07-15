import { getProjectEndBeat } from '../core/time'
import type { Project } from '../types'

export type WavExportTarget =
  | { kind: 'project' }
  | { kind: 'loop' }
  | { kind: 'track'; trackId: string }

export interface PreparedWavExport {
  project: Project
  range: { fromBeat?: number; toBeat?: number }
  filenameScope: string
  label: string
}

export const safeExportFilenamePart = (value: string): string => {
  const normalized = value
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
  return normalized || 'untitled'
}

/**
 * Resolves one immutable render target from a durable project checkpoint.
 * Track exports keep project time zero/end so every file stays arrangement-aligned.
 * The chosen track is rendered in isolation: other Solo state and its own Mute
 * button do not turn an explicitly requested stem into a silent file.
 */
export function prepareWavExport(
  project: Project,
  target: WavExportTarget,
): PreparedWavExport {
  if (target.kind === 'project') {
    return {
      project,
      range: {},
      filenameScope: 'full-mix',
      label: 'Full mix',
    }
  }
  if (target.kind === 'loop') {
    if (!project.loop.enabled) throw new Error('Enable a project loop before exporting its range')
    return {
      project,
      range: { fromBeat: project.loop.startBeat, toBeat: project.loop.endBeat },
      filenameScope: 'loop',
      label: 'Loop range',
    }
  }

  const trackIndex = project.tracks.findIndex((track) => track.id === target.trackId)
  const track = project.tracks[trackIndex]
  if (!track) throw new Error('The selected export track is no longer available')
  const isolatedTrack = structuredClone(track)
  isolatedTrack.mute = false
  isolatedTrack.solo = false
  const sequence = String(trackIndex + 1).padStart(2, '0')
  return {
    project: { ...project, tracks: [isolatedTrack] },
    range: { fromBeat: 0, toBeat: getProjectEndBeat(project.tracks) },
    filenameScope: `track-${sequence}-${safeExportFilenamePart(track.name)}`,
    label: `Track ${sequence} · ${track.name}`,
  }
}
