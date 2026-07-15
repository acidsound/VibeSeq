import { rescaleFixedSecondsAudioClipGeometry } from '../core'
import type { AudioClip, Project } from '../types'

const TEMPO_EPSILON = 1e-9

export interface ProjectTempoCollision {
  trackId: string
  trackName: string
  clipId: string
  clipName: string
  conflictingClipId: string
  conflictingClipName: string
}

export interface ProjectTempoChangePlan {
  fromBpm: number
  toBpm: number
  retimedAudioClips: ReadonlyMap<string, AudioClip>
  collision?: ProjectTempoCollision
}

const normalizedTempo = (bpm: number): number => {
  if (!Number.isFinite(bpm)) throw new RangeError('Project tempo must be finite')
  return Math.round(Math.max(30, Math.min(300, bpm)) * 10) / 10
}

/**
 * Computes one atomic tempo edit without mutating the project. Fixed-seconds
 * Audio changes beat geometry; musical clips keep their authored beat span.
 */
export const planProjectTempoChange = (
  project: Pick<Project, 'bpm' | 'tracks'>,
  requestedBpm: number,
): ProjectTempoChangePlan => {
  const toBpm = normalizedTempo(requestedBpm)
  const retimedAudioClips = new Map<string, AudioClip>()

  for (const track of project.tracks) {
    const spans = track.clips.map((clip) => {
      if (clip.kind !== 'audio') return clip
      const retimed = rescaleFixedSecondsAudioClipGeometry(clip, project.bpm, toBpm)
      retimedAudioClips.set(clip.id, retimed)
      return retimed
    }).sort((left, right) => left.startBeat - right.startBeat || left.id.localeCompare(right.id))

    for (let index = 1; index < spans.length; index += 1) {
      const previous = spans[index - 1]
      const current = spans[index]
      if (previous.startBeat + previous.durationBeats <= current.startBeat + TEMPO_EPSILON) continue
      return {
        fromBpm: project.bpm,
        toBpm,
        retimedAudioClips,
        collision: {
          trackId: track.id,
          trackName: track.name,
          clipId: previous.id,
          clipName: previous.name,
          conflictingClipId: current.id,
          conflictingClipName: current.name,
        },
      }
    }
  }

  return { fromBpm: project.bpm, toBpm, retimedAudioClips }
}

/** Applies a previously preflighted plan inside one history mutation. */
export const applyProjectTempoChange = (
  project: Project,
  plan: ProjectTempoChangePlan,
): void => {
  if (plan.collision) throw new Error('A tempo change with overlapping regions cannot be applied')
  if (Math.abs(project.bpm - plan.fromBpm) > TEMPO_EPSILON) {
    throw new Error('The project tempo changed after this edit was prepared')
  }
  for (const track of project.tracks) {
    track.clips = track.clips.map((clip) => (
      clip.kind === 'audio' ? plan.retimedAudioClips.get(clip.id) ?? clip : clip
    ))
  }
  project.bpm = plan.toBpm
}
