/// <reference lib="webworker" />

import {
  executeMixdownWorkerRequest,
  type MixdownWorkerRequest,
  type MixdownWorkerResponse,
} from './mixdownWorkerCore';

const worker = self as DedicatedWorkerGlobalScope;

worker.onmessage = (event: MessageEvent<MixdownWorkerRequest>) => {
  void executeMixdownWorkerRequest(event.data, (progress) => {
    worker.postMessage({ kind: 'progress', progress } satisfies MixdownWorkerResponse);
  }).then((result) => {
    worker.postMessage({ kind: 'complete', result } satisfies MixdownWorkerResponse, [result.wav]);
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Unknown local render error';
    worker.postMessage({ kind: 'error', message } satisfies MixdownWorkerResponse);
  });
};

export {};
