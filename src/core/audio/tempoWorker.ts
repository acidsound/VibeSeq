import type { TempoAnalysisOptions, TempoAnalysisResult } from './tempo';
import type { TempoWorkerRequest, TempoWorkerResponse } from './tempo.worker';

interface TempoWorkerLike {
  onmessage: ((event: MessageEvent<TempoWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: TempoWorkerRequest, transfer: Transferable[]): void;
  terminate(): void;
}

export interface TempoWorkerExecution {
  signal?: AbortSignal;
  /** Test seam; production uses the bundled module worker. */
  workerFactory?: () => TempoWorkerLike;
}

const defaultWorkerFactory = (): TempoWorkerLike => new Worker(
  new URL('./tempo.worker.ts', import.meta.url),
  { type: 'module', name: 'vibeseq-tempo-analysis' },
);

const abortError = (): DOMException => new DOMException('Tempo analysis cancelled', 'AbortError');

/** Runs CPU-heavy onset/period analysis away from React and the browser main thread. */
export function analyzeTempoInWorker(
  channelData: readonly Float32Array[],
  sampleRate: number,
  options: TempoAnalysisOptions = {},
  execution: TempoWorkerExecution = {},
): Promise<TempoAnalysisResult> {
  if (execution.signal?.aborted) return Promise.reject(abortError());
  const copiedChannels = channelData.map((channel) => Float32Array.from(channel));
  const worker = (execution.workerFactory ?? defaultWorkerFactory)();
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      execution.signal?.removeEventListener('abort', handleAbort);
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    };
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };
    const handleAbort = (): void => settle(() => reject(abortError()));
    worker.onmessage = (event) => {
      const response = event.data;
      if (response.kind === 'complete') settle(() => resolve(response.result));
      else settle(() => reject(new Error(response.message)));
    };
    worker.onerror = (event) => settle(() => reject(new Error(event.message || 'The tempo worker crashed')));
    execution.signal?.addEventListener('abort', handleAbort, { once: true });
    try {
      worker.postMessage(
        { channelData: copiedChannels, sampleRate, options },
        copiedChannels.map((channel) => channel.buffer),
      );
    } catch (error) {
      settle(() => reject(error));
    }
  });
}
