import { describe, expect, it } from 'vitest'
import { createDemoProject } from '../core/demo'
import { prepareWavExport, safeExportFilenamePart } from './wavExportTarget'

describe('WAV export targets', () => {
  it('isolates one track while preserving arrangement-aligned duration and mix values', () => {
    const project = createDemoProject({ now: '2026-07-16T00:00:00.000Z' })
    project.tracks[0].mute = true
    project.tracks[0].solo = true
    project.tracks[1].clips[0].startBeat = 40
    project.tracks[1].clips[0].durationBeats = 4

    const prepared = prepareWavExport(project, { kind: 'track', trackId: project.tracks[0].id })

    expect(prepared.project).not.toBe(project)
    expect(prepared.project.masterGain).toBe(project.masterGain)
    expect(prepared.project.tracks).toHaveLength(1)
    expect(prepared.project.tracks[0]).toMatchObject({
      id: project.tracks[0].id,
      gain: project.tracks[0].gain,
      pan: project.tracks[0].pan,
      mute: false,
      solo: false,
    })
    expect(prepared.range).toEqual({ fromBeat: 0, toBeat: 44 })
    expect(prepared.filenameScope).toContain('track-01-')
    expect(project.tracks[0]).toMatchObject({ mute: true, solo: true })
  })

  it('resolves project and loop exports without changing their audible track state', () => {
    const project = createDemoProject({ now: '2026-07-16T00:00:00.000Z' })
    project.loop = { enabled: true, startBeat: 4, endBeat: 12 }
    expect(prepareWavExport(project, { kind: 'project' })).toMatchObject({
      project,
      range: {},
      filenameScope: 'full-mix',
    })
    expect(prepareWavExport(project, { kind: 'loop' })).toMatchObject({
      project,
      range: { fromBeat: 4, toBeat: 12 },
      filenameScope: 'loop',
    })
  })

  it('rejects stale track targets and sanitizes filesystem-reserved filename characters', () => {
    const project = createDemoProject({ now: '2026-07-16T00:00:00.000Z' })
    expect(() => prepareWavExport(project, { kind: 'track', trackId: 'missing' }))
      .toThrow('no longer available')
    expect(safeExportFilenamePart('  Bass / Lead:*?  ')).toBe('Bass-Lead')
  })
})
