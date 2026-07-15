import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceSaveCoordinator } from './workspaceSave'

afterEach(() => {
  vi.useRealTimers()
})

describe('workspace save coordinator', () => {
  it('debounces edits and reads the latest project/session snapshot when the timer fires', async () => {
    vi.useFakeTimers()
    let latest = { project: 'first', candidates: 0 }
    const save = vi.fn(async (snapshot: typeof latest) => snapshot)
    const coordinator = createWorkspaceSaveCoordinator({ readLatest: () => latest, save })

    coordinator.schedule()
    latest = { project: 'second', candidates: 1 }
    coordinator.schedule()
    latest = { project: 'latest', candidates: 2 }
    await vi.advanceTimersByTimeAsync(450)

    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith({ project: 'latest', candidates: 2 })
  })

  it('flush cancels the pending debounce and resolves only after the latest snapshot saves', async () => {
    vi.useFakeTimers()
    let latest = { project: 'before', candidates: 0 }
    const saved: Array<typeof latest> = []
    const coordinator = createWorkspaceSaveCoordinator({
      readLatest: () => latest,
      save: async (snapshot) => {
        saved.push(snapshot)
        return `checkpoint:${snapshot.project}`
      },
    })

    coordinator.schedule()
    latest = { project: 'export-now', candidates: 3 }
    await expect(coordinator.flush()).resolves.toBe('checkpoint:export-now')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(saved).toEqual([{ project: 'export-now', candidates: 3 }])
  })

  it('propagates a durability failure and keeps the ordered lane usable for retry', async () => {
    const states: string[] = []
    let latest = 'first'
    const save = vi.fn()
      .mockRejectedValueOnce(new Error('quota unavailable'))
      .mockImplementation(async (snapshot: string) => `saved:${snapshot}`)
    const coordinator = createWorkspaceSaveCoordinator({
      readLatest: () => latest,
      save,
      onStateChange: (state) => states.push(state),
    })

    await expect(coordinator.flush()).rejects.toThrow('quota unavailable')
    latest = 'retry'
    await expect(coordinator.flush()).resolves.toBe('saved:retry')
    expect(save).toHaveBeenNthCalledWith(1, 'first')
    expect(save).toHaveBeenNthCalledWith(2, 'retry')
    expect(states).toEqual(['saving', 'failed', 'saving', 'saved'])
  })
})
