/// <reference lib="webworker" />

import { analyzeTempo } from './tempo';
import type { TempoAnalysisOptions, TempoAnalysisResult } from './tempo';

export type TempoWorkerRequest = {
  channelData: Float32Array[];
  sampleRate: number;
  options?: TempoAnalysisOptions;
};

export type TempoWorkerResponse =
  | { kind: 'complete'; result: TempoAnalysisResult }
  | { kind: 'error'; message: string; code?: string };

const worker = self as DedicatedWorkerGlobalScope;

worker.onmessage = (event: MessageEvent<TempoWorkerRequest>) => {
  try {
    const result = analyzeTempo(event.data.channelData, event.data.sampleRate, event.data.options);
    worker.postMessage({ kind: 'complete', result } satisfies TempoWorkerResponse);
  } catch (error) {
    worker.postMessage({
      kind: 'error',
      message: error instanceof Error ? error.message : 'Audio tempo analysis failed',
      code: error instanceof Error && 'code' in error ? String(error.code) : undefined,
    } satisfies TempoWorkerResponse);
  }
};

export {};
