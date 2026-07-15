// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { InferenceJobTerminalError, waitForJob } from './inference'

const response = (body: unknown): Response => ({
  ok: true,
  json: async () => body,
} as Response)

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('inference job polling', () => {
  it('removes each abort listener after a completed polling interval', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ id: 'job-1', kind: 'generate', status: 'running', progress: 0.2 }))
      .mockResolvedValueOnce(response({ id: 'job-1', kind: 'generate', status: 'running', progress: 0.6 }))
      .mockResolvedValueOnce(response({ id: 'job-1', kind: 'generate', status: 'completed', progress: 1, result: { assetId: 'asset-1' } }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const addListener = vi.spyOn(controller.signal, 'addEventListener')
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener')

    const completed = waitForJob<{ assetId: string }>('job-1', () => undefined, controller.signal)
    await vi.advanceTimersByTimeAsync(350)
    await vi.advanceTimersByTimeAsync(350)

    await expect(completed).resolves.toMatchObject({ status: 'completed', result: { assetId: 'asset-1' } })
    expect(addListener.mock.calls.filter(([type]) => type === 'abort')).toHaveLength(2)
    expect(removeListener.mock.calls.filter(([type]) => type === 'abort')).toHaveLength(2)
  })

  it('removes the current listener and rejects promptly when polling is aborted', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      response({ id: 'job-2', kind: 'transcribe', status: 'running', progress: 0.3 }),
    ))
    const controller = new AbortController()
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener')
    const pending = waitForJob('job-2', () => undefined, controller.signal)
    await vi.advanceTimersByTimeAsync(0)

    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('preserves the terminal job status for callers that must distinguish cancellation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      response({ id: 'job-3', kind: 'generate', status: 'cancelled', progress: 0.4 }),
    ))

    try {
      await waitForJob('job-3', () => undefined)
      expect.fail('cancelled polling should reject')
    } catch (error) {
      expect(error).toBeInstanceOf(InferenceJobTerminalError)
      expect((error as InferenceJobTerminalError<unknown>).job).toMatchObject({
        id: 'job-3',
        status: 'cancelled',
      })
    }
  })
})
