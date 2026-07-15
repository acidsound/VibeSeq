import { describe, expect, it } from 'vitest'
import { createBlankProject } from './demo'

describe('blank project startup', () => {
  it('contains no synthetic musical material or active playback range', () => {
    const project = createBlankProject({
      id: 'project-test',
      name: 'Test Project',
      bpm: 96,
      now: '2026-07-15T00:00:00.000Z',
    })

    expect(project).toMatchObject({
      id: 'project-test',
      name: 'Test Project',
      bpm: 96,
      loop: { enabled: false, startBeat: 0, endBeat: 16 },
      assets: [],
      tracks: [],
      jobs: [],
    })
    expect(project.createdAt).toBe('2026-07-15T00:00:00.000Z')
  })
})
