import { describe, expect, it } from 'vitest'
import { createBlankProject } from '../core'
import type { Track } from '../types'
import { findClipCollision, findCompatibleTrackId, findNextAvailableClipStart, getArrangementTimelineBeats, moveTrackInOrder, waveformPath } from './music'

describe('waveformPath', () => {
  it('never invents a waveform when source peaks are absent', () => {
    expect(waveformPath(undefined)).toBe('')
    expect(waveformPath({ samplesPerPeak: 1, min: [], max: [] })).toBe('')
  })

  it('draws only the supplied peak geometry', () => {
    const path = waveformPath({
      samplesPerPeak: 128,
      min: [-0.25, -0.5],
      max: [0.5, 0.25],
    }, 100, 20)

    expect(path).toMatch(/^M /)
    expect(path).toContain('0.00,5.60')
    expect(path).toContain('100.00,7.80')
  })
})

describe('moveTrackInOrder', () => {
  const track = (id: string, kind: Track['kind'] = 'audio'): Track => {
    const base = {
      id,
      name: id,
      color: '#F6A84B',
      gain: 1,
      pan: 0,
      mute: false,
      solo: false,
      clips: [],
    }
    return kind === 'midi'
      ? { ...base, kind, midi: { channel: 0, instrument: { kind: 'melodic', playbackId: 'WebAudio-TinySynth', program: 0 } } }
      : { ...base, kind }
  }

  it('moves only the requested track by one slot without mutating the source array', () => {
    const source = [track('a'), track('b'), track('c')]
    expect(moveTrackInOrder(source, 'b', 'up').map(({ id }) => id)).toEqual(['b', 'a', 'c'])
    expect(moveTrackInOrder(source, 'b', 'down').map(({ id }) => id)).toEqual(['a', 'c', 'b'])
    expect(source.map(({ id }) => id)).toEqual(['a', 'b', 'c'])
  })

  it('returns the same array for boundary and missing-track no-ops', () => {
    const source = [track('a'), track('b')]
    expect(moveTrackInOrder(source, 'a', 'up')).toBe(source)
    expect(moveTrackInOrder(source, 'b', 'down')).toBe(source)
    expect(moveTrackInOrder(source, 'missing', 'down')).toBe(source)
  })

  it('finds the next compatible lane while skipping incompatible tracks', () => {
    const tracks = [track('audio-a'), track('midi-a', 'midi'), track('midi-b', 'midi'), track('audio-b')]
    expect(findCompatibleTrackId(tracks, 'audio-a', 'audio', 'down')).toBe('audio-b')
    expect(findCompatibleTrackId(tracks, 'audio-b', 'audio', 'up')).toBe('audio-a')
    expect(findCompatibleTrackId(tracks, 'midi-a', 'midi', 'down')).toBe('midi-b')
  })

  it('reports no compatible lane at a boundary or for a missing source track', () => {
    const tracks = [track('audio'), track('midi', 'midi')]
    expect(findCompatibleTrackId(tracks, 'audio', 'audio', 'up')).toBeNull()
    expect(findCompatibleTrackId(tracks, 'audio', 'audio', 'down')).toBeNull()
    expect(findCompatibleTrackId(tracks, 'missing', 'audio', 'down')).toBeNull()
  })
})

describe('findClipCollision', () => {
  const track: Track = {
    id: 'audio',
    name: 'Audio',
    kind: 'audio',
    color: '#F6A84B',
    gain: 1,
    pan: 0,
    mute: false,
    solo: false,
    clips: [
      {
        id: 'a',
        name: 'A',
        kind: 'audio',
        assetId: 'asset-a',
        startBeat: 4,
        durationBeats: 4,
        offsetBeats: 0,
        timebase: { mode: 'fixed-seconds', sourceBpm: 120 },
        gain: 1,
        fadeIn: 0,
        fadeOut: 0,
        provenance: { source: 'user', createdAt: '2026-07-15T00:00:00.000Z' },
      },
      {
        id: 'b',
        name: 'B',
        kind: 'audio',
        assetId: 'asset-b',
        startBeat: 10,
        durationBeats: 2,
        offsetBeats: 0,
        timebase: { mode: 'fixed-seconds', sourceBpm: 120 },
        gain: 1,
        fadeIn: 0,
        fadeOut: 0,
        provenance: { source: 'user', createdAt: '2026-07-15T00:00:00.000Z' },
      },
    ],
  }

  it('treats clip intervals as half-open so adjacent regions remain valid', () => {
    expect(findClipCollision(track, 'moving', 0, 4)).toBeNull()
    expect(findClipCollision(track, 'moving', 8, 2)).toBeNull()
    expect(findClipCollision(track, 'moving', 12, 2)).toBeNull()
  })

  it('returns the first conflicting region and ignores the moved region itself', () => {
    expect(findClipCollision(track, 'moving', 6, 3)?.id).toBe('a')
    expect(findClipCollision(track, 'a', 4, 4)).toBeNull()
  })

  it('finds the first gap large enough for a duplicate', () => {
    expect(findNextAvailableClipStart(track, 'new', 0, 4)).toBe(0)
    expect(findNextAvailableClipStart(track, 'new', 5, 3)).toBe(12)
    expect(findNextAvailableClipStart(track, 'a', 4, 4)).toBe(4)
  })
})

describe('getArrangementTimelineBeats', () => {
  it('opens an empty project with a full 16-bar writing surface', () => {
    expect(getArrangementTimelineBeats(createBlankProject())).toBe(64)
  })

  it('aligns non-4/4 projects to their own bars', () => {
    const project = createBlankProject()
    project.timeSignature = { numerator: 6, denominator: 8 }
    expect(getArrangementTimelineBeats(project)).toBe(48)
  })

  it('grows beyond the old 40-beat ceiling and retains four trailing bars', () => {
    const project = createBlankProject()
    project.tracks.push({
      id: 'long',
      name: 'Long arrangement',
      kind: 'audio',
      color: '#F6A84B',
      gain: 1,
      pan: 0,
      mute: false,
      solo: false,
      clips: [{
        id: 'late',
        name: 'Late clip',
        kind: 'audio',
        assetId: 'asset',
        startBeat: 1180,
        durationBeats: 20,
        offsetBeats: 0,
        timebase: { mode: 'fixed-seconds', sourceBpm: 120 },
        gain: 1,
        fadeIn: 0,
        fadeOut: 0,
        provenance: { source: 'user', createdAt: '2026-07-15T00:00:00.000Z' },
      }],
    })
    expect(getArrangementTimelineBeats(project)).toBe(1216)
  })
})
