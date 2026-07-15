import type { AudioAsset, PcmAudioAsset, Project } from '../../types';
import type {
  MixdownWorkerRequest,
  MixdownWorkerResponse,
  WavExportProgress,
  WavExportResult,
  WorkerWavExportOptions,
} from './mixdownWorkerCore';
import type {
  TrackStemsWorkerRequest,
  TrackStemsWorkerResponse,
  TrackStemsZipResult,
} from './trackStemsWorkerCore';

export type {
  WavExportPhase,
  WavExportProgress,
  WavExportResult,
  WorkerWavExportOptions,
} from './mixdownWorkerCore';
export type { TrackStemsManifest, TrackStemsZipResult } from './trackStemsWorkerCore';

interface WorkerLike {
  onmessage: ((event: MessageEvent<MixdownWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: MixdownWorkerRequest, transfer: Transferable[]): void;
  terminate(): void;
}

interface TrackStemsWorkerLike {
  onmessage: ((event: MessageEvent<TrackStemsWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: TrackStemsWorkerRequest, transfer: Transferable[]): void;
  terminate(): void;
}

export interface WorkerWavExportExecution {
  signal?: AbortSignal;
  onProgress?: (progress: WavExportProgress) => void;
  /** Test seam; production always uses the bundled module worker. */
  workerFactory?: () => WorkerLike;
}

export interface WorkerTrackStemsExportExecution extends Omit<WorkerWavExportExecution, 'workerFactory'> {
  /** Test seam; production always uses the bundled module worker. */
  workerFactory?: () => TrackStemsWorkerLike;
}

const withoutEncodedMedia = (asset: AudioAsset): AudioAsset => {
  const portable = { ...asset };
  delete portable.blob;
  delete portable.bytes;
  return portable;
};

const renderProjectCopy = (project: Project): Project => ({
  ...project,
  assets: project.assets.map(withoutEncodedMedia),
});

const defaultWorkerFactory = (): WorkerLike => new Worker(
  new URL('./mixdown.worker.ts', import.meta.url),
  { type: 'module', name: 'vibeseq-wav-export' },
);

const defaultTrackStemsWorkerFactory = (): TrackStemsWorkerLike => new Worker(
  new URL('./trackStems.worker.ts', import.meta.url),
  { type: 'module', name: 'vibeseq-track-stems-export' },
);

const pcmTransferList = (assets: readonly PcmAudioAsset[]): Transferable[] => {
  const buffers = new Set<ArrayBuffer>();
  for (const asset of assets) {
    for (const channel of asset.channelData) {
      if (channel.buffer instanceof ArrayBuffer) buffers.add(channel.buffer);
    }
  }
  return [...buffers];
};

const abortError = (): DOMException => new DOMException('WAV export cancelled', 'AbortError');

/**
 * Transfers decoded PCM ownership to a dedicated worker and resolves with the
 * encoded WAV plus render metrics. Terminating the worker is the cancellation
 * mechanism, so cancellation remains immediate even inside a CPU-heavy loop.
 */
export function exportWavInWorker(
  project: Project,
  pcmAssets: ReadonlyMap<string, PcmAudioAsset>,
  options: WorkerWavExportOptions,
  execution: WorkerWavExportExecution = {},
): Promise<WavExportResult> {
  if (execution.signal?.aborted) return Promise.reject(abortError());
  const assets = [...pcmAssets.values()];
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
      if (response.kind === 'progress') {
        execution.onProgress?.(response.progress);
      } else if (response.kind === 'complete') {
        settle(() => resolve(response.result));
      } else {
        settle(() => reject(new Error(response.message)));
      }
    };
    worker.onerror = (event) => {
      settle(() => reject(new Error(event.message || 'The local WAV render worker crashed')));
    };
    execution.signal?.addEventListener('abort', handleAbort, { once: true });

    try {
      worker.postMessage({ project: renderProjectCopy(project), assets, options }, pcmTransferList(assets));
    } catch (error) {
      settle(() => reject(error));
    }
  });
}

/** Transfers PCM once, then renders and packages every arrangement-aligned track in one worker. */
export function exportTrackStemsZipInWorker(
  project: Project,
  pcmAssets: ReadonlyMap<string, PcmAudioAsset>,
  options: WorkerWavExportOptions,
  execution: WorkerTrackStemsExportExecution = {},
): Promise<TrackStemsZipResult> {
  if (execution.signal?.aborted) return Promise.reject(abortError());
  const assets = [...pcmAssets.values()];
  const worker = (execution.workerFactory ?? defaultTrackStemsWorkerFactory)();

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
      if (response.kind === 'progress') execution.onProgress?.(response.progress);
      else if (response.kind === 'complete') settle(() => resolve(response.result));
      else settle(() => reject(new Error(response.message)));
    };
    worker.onerror = (event) => settle(() => reject(new Error(event.message || 'The local stem render worker crashed')));
    execution.signal?.addEventListener('abort', handleAbort, { once: true });

    try {
      worker.postMessage({ project: renderProjectCopy(project), assets, options }, pcmTransferList(assets));
    } catch (error) {
      settle(() => reject(error));
    }
  });
}
