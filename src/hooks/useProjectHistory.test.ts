// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { assertProjectArrangementInvariants, createBlankProject, ProjectArrangementInvariantError } from '../core'
import type { AudioClip, Project, Track } from '../types'
import { useProjectHistory } from './useProjectHistory'

afterEach(cleanup)

const createdAt = '2026-07-15T00:00:00.000Z'

const audioClip = (id: string, startBeat: number): AudioClip => ({
  id,
  name: id,
  kind: 'audio',
  startBeat,
  durationBeats: 2,
  offsetBeats: 0,
  timebase: { mode: 'fixed-seconds', sourceBpm: 120 },
  assetId: `asset-${id}`,
  gain: 1,
  fadeIn: 0,
  fadeOut: 0,
  provenance: { source: 'user', createdAt },
})

const projectWithGap = (): Project => {
  const project = createBlankProject({ now: createdAt })
  const track: Track = {
    id: 'track-audio',
    name: 'Audio',
    kind: 'audio',
    color: '#f6a84b',
    gain: 1,
    pan: 0,
    mute: false,
    solo: false,
    clips: [audioClip('clip-a', 0), audioClip('clip-b', 8)],
  }
  project.tracks = [track]
  return project
}

describe('useProjectHistory arrangement invariants', () => {
  it('atomically rejects the second of two stale but independently valid queued moves', async () => {
    const initial = projectWithGap()
    const moveAOnly = structuredClone(initial)
    moveAOnly.tracks[0].clips[0].startBeat = 4
    const moveBOnly = structuredClone(initial)
    moveBOnly.tracks[0].clips[1].startBeat = 4
    expect(() => assertProjectArrangementInvariants(moveAOnly)).not.toThrow()
    expect(() => assertProjectArrangementInvariants(moveBOnly)).not.toThrow()

    const { result } = renderHook(() => useProjectHistory(initial))
    let outcomes: PromiseSettledResult<void>[] = []

    await act(async () => {
      const first = result.current.mutate('Move A into gap', (draft) => {
        draft.tracks[0].clips[0].startBeat = 4
      })
      const second = result.current.mutate('Move B into same gap', (draft) => {
        draft.tracks[0].clips[1].startBeat = 4
      })
      outcomes = await Promise.allSettled([first, second])
    })

    expect(outcomes[0]).toMatchObject({ status: 'fulfilled' })
    expect(outcomes[1]).toMatchObject({
      status: 'rejected',
      reason: expect.any(ProjectArrangementInvariantError),
    })
    expect(result.current.project.tracks[0].clips.map((clip) => clip.startBeat)).toEqual([4, 8])
    expect(result.current.undoLabel).toBe('Move A into gap')
    expect(result.current.mutationError).toMatchObject({
      label: 'Move B into same gap',
      message: expect.stringMatching(/prevents clips .* from overlapping/),
    })
  })

  it('serializes operational updates and preserves current jobs and integrity through undo and redo', async () => {
    const initial = projectWithGap()
    initial.assets.push({
      id: 'asset-clip-a',
      name: 'A',
      mimeType: 'audio/wav',
      durationSeconds: 1,
      createdAt,
      integrity: { state: 'unverified' },
      provenance: { source: 'user', createdAt },
    })
    const { result } = renderHook(() => useProjectHistory(initial))

    await act(async () => {
      const edit = result.current.mutate('Change clip gain', (draft) => {
        draft.tracks[0].clips[0].gain = 0.5
      })
      const operational = result.current.updateOperational((draft) => {
        draft.jobs.push({
          id: 'generation-completed',
          kind: 'stable-audio-generation',
          state: 'completed',
          computeTarget: 'local-gpu',
          progress: 1,
          createdAt,
          updatedAt: createdAt,
          input: { prompt: 'operational truth', durationSeconds: 4, seed: 7 },
          output: { assetId: 'asset-clip-a' },
        })
        draft.assets[0].integrity = {
          state: 'available',
          expectedHashSha256: 'a'.repeat(64),
          actualHashSha256: 'a'.repeat(64),
        }
      })
      await Promise.all([edit, operational])
    })

    expect(result.current.project.tracks[0].clips[0].gain).toBe(0.5)
    expect(result.current.project.jobs[0]).toMatchObject({ id: 'generation-completed', state: 'completed', progress: 1 })
    expect(result.current.project.assets[0].integrity?.state).toBe('available')
    expect(result.current.undoLabel).toBe('Change clip gain')

    await act(async () => { await result.current.undo() })
    expect(result.current.project.tracks[0].clips[0].gain).toBe(1)
    expect(result.current.project.jobs[0]).toMatchObject({ id: 'generation-completed', state: 'completed', progress: 1 })
    expect(result.current.project.assets[0].integrity?.state).toBe('available')

    await act(async () => { await result.current.redo() })
    expect(result.current.project.tracks[0].clips[0].gain).toBe(0.5)
    expect(result.current.project.jobs[0]).toMatchObject({ id: 'generation-completed', state: 'completed', progress: 1 })
    expect(result.current.project.assets[0].integrity?.state).toBe('available')
  })
})
