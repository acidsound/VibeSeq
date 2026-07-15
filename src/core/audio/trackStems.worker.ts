/// <reference lib="webworker" />

import {
  executeTrackStemsWorkerRequest,
  type TrackStemsWorkerRequest,
  type TrackStemsWorkerResponse,
} from './trackStemsWorkerCore';

const worker = self as DedicatedWorkerGlobalScope;

worker.onmessage = (event: MessageEvent<TrackStemsWorkerRequest>) => {
  void executeTrackStemsWorkerRequest(event.data, (progress) => {
    worker.postMessage({ kind: 'progress', progress } satisfies TrackStemsWorkerResponse);
  }).then((result) => {
    worker.postMessage({ kind: 'complete', result } satisfies TrackStemsWorkerResponse, [result.zip]);
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Unknown local stem render error';
    worker.postMessage({ kind: 'error', message } satisfies TrackStemsWorkerResponse);
  });
};

export {};
