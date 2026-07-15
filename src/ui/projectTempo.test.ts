import { describe, expect, it } from 'vitest'
import { createBlankProject } from '../core'
import type { AudioClip, MidiClip, Track } from '../types'
import { applyProjectTempoChange, planProjectTempoChange } from './projectTempo'

const fixedClip = (overrides: Partial<AudioClip> = {}): AudioClip => ({
  id: 'fixed',
  name: 'Fixed SFX',
  kind: 'audio',
  assetId: 'audio',
  startBeat: 0,
  durationBeats: 8,
  offsetBeats: 2,
  sourceLoop: { cycleStartBeat: 2, cycleLengthBeats: 4, phaseBeats: 1 },
  timebase: { mode: 'fixed-seconds', sourceBpm: 120 },
  gain: 1,
  fadeIn: 0,
  fadeOut: 0,
  provenance: { source: 'user', createdAt: '2026-07-15T00:00:00.000Z' },
  ...overrides,
})

const musicalClip = (): AudioClip => ({
  ...fixedClip({ id: 'musical', name: 'Musical loop', startBeat: 12, offsetBeats: 0, sourceLoop: undefined }),
  timebase: { mode: 'tempo-follow-repitch', sourceBpm: 120 },
})

const midiClip = (): MidiClip => ({
  id: 'midi',
  name: 'MIDI',
  kind: 'midi',
  startBeat: 24,
  durationBeats: 4,
  offsetBeats: 0,
  gain: 1,
  fadeIn: 0,
  fadeOut: 0,
  notes: [],
  provenance: { source: 'user', createdAt: '2026-07-15T00:00:00.000Z' },
})

const projectWith = (clips: Track['clips']) => {
  const project = createBlankProject({ id: 'tempo-project', now: '2026-07-15T00:00:00.000Z' })
  const base = {
    id: 'track',
    name: 'Timing track',
    color: '#fff',
    gain: 1,
    pan: 0,
    mute: false,
    solo: false,
    clips,
  }
  project.tracks.push(clips.every((clip) => clip.kind === 'midi')
    ? { ...base, kind: 'midi', midi: { channel: 0, instrument: { kind: 'melodic', playbackId: 'WebAudio-TinySynth', program: 0 } } }
    : { ...base, kind: 'audio' })
  return project
}

describe('atomic project tempo changes', () => {
  it('preserves fixed seconds while leaving musical and MIDI beat geometry unchanged', () => {
    const project = projectWith([fixedClip(), musicalClip()])
    project.tracks.push({
      id: 'midi-track',
      name: 'MIDI',
      kind: 'midi',
      midi: { channel: 0, instrument: { kind: 'melodic', playbackId: 'WebAudio-TinySynth', program: 0 } },
      color: '#fff',
      gain: 1,
      pan: 0,
      mute: false,
      solo: false,
      clips: [midiClip()],
    })
    const plan = planProjectTempoChange(project, 60)

    expect(plan.collision).toBeUndefined()
    applyProjectTempoChange(project, plan)
    const fixed = project.tracks[0].clips[0] as AudioClip
    const musical = project.tracks[0].clips[1] as AudioClip
    expect(project.bpm).toBe(60)
    expect(fixed).toMatchObject({
      startBeat: 0,
      durationBeats: 4,
      offsetBeats: 1,
      sourceLoop: { cycleStartBeat: 1, cycleLengthBeats: 2, phaseBeats: 0.5 },
      timebase: { mode: 'fixed-seconds', sourceBpm: 60 },
    })
    expect(musical).toMatchObject({
      startBeat: 12,
      durationBeats: 8,
      timebase: { mode: 'tempo-follow-repitch', sourceBpm: 120 },
    })
    expect(project.tracks[1].clips[0]).toMatchObject({ startBeat: 24, durationBeats: 4 })
  })

  it('rejects the whole edit when expanding fixed-seconds geometry would overlap', () => {
    const project = projectWith([
      fixedClip({ durationBeats: 4, sourceLoop: undefined }),
      fixedClip({ id: 'next', name: 'Next region', startBeat: 5, durationBeats: 2, offsetBeats: 0, sourceLoop: undefined }),
    ])
    const plan = planProjectTempoChange(project, 240)

    expect(plan.collision).toMatchObject({ clipName: 'Fixed SFX', conflictingClipName: 'Next region' })
    expect(() => applyProjectTempoChange(project, plan)).toThrow(/overlapping regions/i)
    expect(project.bpm).toBe(120)
    expect(project.tracks[0].clips.map((clip) => clip.durationBeats)).toEqual([4, 2])
  })
})
