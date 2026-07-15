import type { PcmAudioAsset, Project } from '../../types';
import {
  encodeWav,
  renderProjectToPcm,
  type ExportWavOptions,
  type PcmMixdown,
} from './mixdown';

export type WavExportPhase = 'preparing' | 'decoding' | 'mixing' | 'analyzing' | 'encoding' | 'packaging' | 'cancelling';

export interface WavExportProgress {
  phase: WavExportPhase;
  progress: number;
}

export interface WorkerWavExportOptions extends Omit<ExportWavOptions, 'onRenderProgress' | 'onEncodeProgress'> {
  rejectSilent?: boolean;
  rejectUnprotectedClipping?: boolean;
}

export interface MixdownWorkerRequest {
  project: Project;
  assets: PcmAudioAsset[];
  options: WorkerWavExportOptions;
}

export interface WavExportResult extends Omit<PcmMixdown, 'channelData'> {
  wav: ArrayBuffer;
}

export type MixdownWorkerResponse =
  | { kind: 'progress'; progress: WavExportProgress }
  | { kind: 'complete'; result: WavExportResult }
  | { kind: 'error'; message: string };

const emitFraction = (
  onProgress: (progress: WavExportProgress) => void,
  phase: WavExportPhase,
  completed: number,
  total: number,
  rangeStart: number,
  rangeEnd: number,
): void => {
  const fraction = total > 0 ? Math.max(0, Math.min(1, completed / total)) : 1;
  onProgress({ phase, progress: rangeStart + fraction * (rangeEnd - rangeStart) });
};

/** Pure worker-side operation, exported separately so its output remains unit-testable. */
export async function executeMixdownWorkerRequest(
  request: MixdownWorkerRequest,
  onProgress: (progress: WavExportProgress) => void,
): Promise<WavExportResult> {
  const assets = new Map(request.assets.map((asset) => [asset.id, asset]));
  const { rejectSilent, rejectUnprotectedClipping, ...renderOptions } = request.options;
  const rendered = await renderProjectToPcm(request.project, assets, {
    ...renderOptions,
    onRenderProgress: ({ phase, completed, total }) => {
      if (phase === 'mixing') emitFraction(onProgress, phase, completed, total, 0, 0.62);
      else emitFraction(onProgress, phase, completed, total, 0.62, 0.78);
    },
  });

  if (rejectSilent && rendered.sourceSamplePeak === 0) {
    throw new Error('The selected range is silent');
  }
  if (rejectUnprotectedClipping && !request.options.protectPeaks && rendered.sourceInterSamplePeak > 1) {
    throw new Error(`4× inter-sample peak estimate is ${(20 * Math.log10(rendered.sourceInterSamplePeak)).toFixed(1)} dBFS. Lower the mix or enable peak protection`);
  }

  const wav = encodeWav(rendered.channelData, rendered.sampleRate, {
    bitDepth: request.options.bitDepth,
    dither: request.options.dither,
    ditherSeed: request.options.ditherSeed,
    onEncodeProgress: (completedFrames, totalFrames) => {
      emitFraction(onProgress, 'encoding', completedFrames, totalFrames, 0.78, 1);
    },
  });
  return {
    wav,
    sampleRate: rendered.sampleRate,
    durationSeconds: rendered.durationSeconds,
    peak: rendered.peak,
    sourceSamplePeak: rendered.sourceSamplePeak,
    sourceInterSamplePeak: rendered.sourceInterSamplePeak,
    interSamplePeak: rendered.interSamplePeak,
    peakProtectionApplied: rendered.peakProtectionApplied,
    peakAttenuationDb: rendered.peakAttenuationDb,
  };
}
