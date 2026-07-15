import { describe, expect, it, vi } from 'vitest'
import { analyzeTempoInWorker } from './tempoWorker'
import type { TempoWorkerResponse } from './tempo.worker'

class FakeTempoWorker {
  onmessage: ((event: MessageEvent<TempoWorkerResponse>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  readonly postMessage = vi.fn()
  readonly terminate = vi.fn()
}

describe('tempo analysis worker bridge', () => {
  it('transfers copied PCM and resolves the worker result', async () => {
    const worker = new FakeTempoWorker()
    const original = new Float32Array([0.25, -0.25])
    const pending = analyzeTempoInWorker([original], 44_100, {}, { workerFactory: () => worker })

    expect(worker.postMessage).toHaveBeenCalledOnce()
    const [request, transfer] = worker.postMessage.mock.calls[0] as [{ channelData: Float32Array[] }, ArrayBuffer[]]
    expect(request.channelData[0]).not.toBe(original)
    expect([...request.channelData[0]]).toEqual([...original])
    expect(transfer).toEqual([request.channelData[0].buffer])

    worker.onmessage?.({ data: {
      kind: 'complete',
      result: { bpm: 120, confidence: 0.8, candidates: [{ bpm: 120, strength: 1 }], onsetCount: 8, analyzedSeconds: 4 },
    } } as MessageEvent<TempoWorkerResponse>)

    await expect(pending).resolves.toMatchObject({ bpm: 120, confidence: 0.8 })
    expect(worker.terminate).toHaveBeenCalledOnce()
  })

  it('rejects worker domain errors and terminates', async () => {
    const worker = new FakeTempoWorker()
    const pending = analyzeTempoInWorker([new Float32Array(2)], 44_100, {}, { workerFactory: () => worker })
    worker.onmessage?.({ data: { kind: 'error', message: 'No stable pulse', code: 'insufficient-rhythm' } } as MessageEvent<TempoWorkerResponse>)
    await expect(pending).rejects.toThrow('No stable pulse')
    expect(worker.terminate).toHaveBeenCalledOnce()
  })

  it('aborts active analysis without waiting for the worker', async () => {
    const worker = new FakeTempoWorker()
    const controller = new AbortController()
    const pending = analyzeTempoInWorker([new Float32Array(2)], 44_100, {}, {
      signal: controller.signal,
      workerFactory: () => worker,
    })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(worker.terminate).toHaveBeenCalledOnce()
  })
})
