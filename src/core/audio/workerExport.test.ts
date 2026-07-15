import { describe, expect, it } from 'vitest';
import { createBlankProject } from '../demo';
import { exportWavInWorker } from './workerExport';
import type { MixdownWorkerRequest, MixdownWorkerResponse } from './mixdownWorkerCore';

class FakeWorker {
  onmessage: ((event: MessageEvent<MixdownWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  request?: MixdownWorkerRequest;
  transfer?: Transferable[];
  terminated = false;
  respond = true;

  postMessage(message: MixdownWorkerRequest, transfer: Transferable[]): void {
    this.request = message;
    this.transfer = transfer;
    if (!this.respond) return;
    queueMicrotask(() => this.onmessage?.({ data: {
      kind: 'complete',
      result: {
        wav: new ArrayBuffer(44),
        sampleRate: 44_100,
        durationSeconds: 1,
        peak: 0.5,
        sourceSamplePeak: 0.5,
        sourceInterSamplePeak: 0.6,
        interSamplePeak: 0.6,
        peakProtectionApplied: false,
        peakAttenuationDb: 0,
      },
    } } as MessageEvent<MixdownWorkerResponse>));
  }

  terminate(): void { this.terminated = true; }
}

describe('worker WAV export client', () => {
  it('strips encoded project media and transfers PCM buffers to the worker', async () => {
    const project = createBlankProject({ now: '2026-07-15T00:00:00.000Z' });
    project.assets = [{
      id: 'asset',
      name: 'source',
      mimeType: 'audio/wav',
      durationSeconds: 1,
      createdAt: project.createdAt,
      bytes: new ArrayBuffer(8),
      provenance: { source: 'import', createdAt: project.createdAt },
    }];
    const pcmBuffer = new ArrayBuffer(16);
    const worker = new FakeWorker();

    const result = await exportWavInWorker(project, new Map([['asset', {
      id: 'asset',
      sampleRate: 44_100,
      channelData: [new Float32Array(pcmBuffer)],
    }]]), { bitDepth: 24 }, { workerFactory: () => worker });

    expect(result.wav.byteLength).toBe(44);
    expect(worker.request?.project.assets[0].bytes).toBeUndefined();
    expect(worker.request?.project.assets[0].blob).toBeUndefined();
    expect(worker.request?.assets[0].channelData[0].buffer).toBe(pcmBuffer);
    expect(worker.transfer).toEqual([pcmBuffer]);
    expect(worker.terminated).toBe(true);
  });

  it('terminates the worker and rejects with AbortError when cancelled', async () => {
    const project = createBlankProject({ now: '2026-07-15T00:00:00.000Z' });
    const worker = new FakeWorker();
    worker.respond = false;
    const controller = new AbortController();
    const exporting = exportWavInWorker(project, new Map(), {}, {
      signal: controller.signal,
      workerFactory: () => worker,
    });

    controller.abort();

    await expect(exporting).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.terminated).toBe(true);
  });
});
