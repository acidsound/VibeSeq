import { Zip, ZipPassThrough } from 'fflate';
import type { PcmAudioAsset, Project, Track } from '../../types';
import { prepareWavExport } from '../../ui/wavExportTarget';
import {
  executeMixdownWorkerRequest,
  type WavExportProgress,
  type WavExportResult,
  type WorkerWavExportOptions,
} from './mixdownWorkerCore';

export interface TrackStemManifestEntry {
  trackId: string;
  index: number;
  name: string;
  kind: Track['kind'];
  filename: string;
  mutedInArrangement: boolean;
  soloInArrangement: boolean;
  gain: number;
  pan: number;
  sampleRate: number;
  durationSeconds: number;
  sourceSamplePeak: number;
  sourceInterSamplePeak: number;
  interSamplePeak: number;
  peakProtectionApplied: boolean;
  peakAttenuationDb: number;
}

export interface TrackStemsManifest {
  schema: 'vibeseq-track-stems';
  version: 1;
  project: { id: string; name: string; bpm: number };
  arrangement: { fromBeat: 0; toBeat: number; durationSeconds: number };
  format: { sampleRate: number; bitDepth: 16 | 24 | 32; channels: 2; peakProtection: boolean };
  tracks: TrackStemManifestEntry[];
}

export interface TrackStemsWorkerRequest {
  project: Project;
  assets: PcmAudioAsset[];
  options: WorkerWavExportOptions;
}

export interface TrackStemsZipResult {
  zip: ArrayBuffer;
  manifest: TrackStemsManifest;
}

export type TrackStemsWorkerResponse =
  | { kind: 'progress'; progress: WavExportProgress }
  | { kind: 'complete'; result: TrackStemsZipResult }
  | { kind: 'error'; message: string };

const ZIP_DATE = new Date('1980-01-01T00:00:00.000Z');

const createStoredZip = (entries: ReadonlyArray<{ name: string; data: Uint8Array }>): Promise<ArrayBuffer> => (
  new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    const archive = new Zip((error, chunk, final) => {
      if (error) {
        reject(error);
        return;
      }
      chunks.push(chunk);
      totalBytes += chunk.byteLength;
      if (!final) return;
      const output = new Uint8Array(totalBytes);
      let offset = 0;
      for (const item of chunks) {
        output.set(item, offset);
        offset += item.byteLength;
      }
      resolve(output.buffer);
    });

    for (const entry of entries) {
      const file = new ZipPassThrough(entry.name);
      file.mtime = ZIP_DATE;
      archive.add(file);
      file.push(entry.data, true);
    }
    archive.end();
  })
);

const manifestEntry = (
  track: Track,
  index: number,
  filename: string,
  rendered: WavExportResult,
): TrackStemManifestEntry => ({
  trackId: track.id,
  index: index + 1,
  name: track.name,
  kind: track.kind,
  filename,
  mutedInArrangement: track.mute,
  soloInArrangement: track.solo,
  gain: track.gain,
  pan: track.pan,
  sampleRate: rendered.sampleRate,
  durationSeconds: rendered.durationSeconds,
  sourceSamplePeak: rendered.sourceSamplePeak,
  sourceInterSamplePeak: rendered.sourceInterSamplePeak,
  interSamplePeak: rendered.interSamplePeak,
  peakProtectionApplied: rendered.peakProtectionApplied,
  peakAttenuationDb: rendered.peakAttenuationDb,
});

/** Renders every track from the same project checkpoint and packages aligned WAV stems. */
export async function executeTrackStemsWorkerRequest(
  request: TrackStemsWorkerRequest,
  onProgress: (progress: WavExportProgress) => void,
): Promise<TrackStemsZipResult> {
  if (request.project.tracks.length === 0) throw new Error('Add an Audio or MIDI track before exporting stems');
  const zipEntries: Array<{ name: string; data: Uint8Array }> = [];
  const manifestTracks: TrackStemManifestEntry[] = [];
  const trackCount = request.project.tracks.length;
  let durationSeconds = 0;
  let toBeat = 0;

  for (let index = 0; index < trackCount; index += 1) {
    const track = request.project.tracks[index];
    const prepared = prepareWavExport(request.project, { kind: 'track', trackId: track.id });
    toBeat = prepared.range.toBeat ?? 0;
    const rendered = await executeMixdownWorkerRequest({
      project: prepared.project,
      assets: request.assets,
      options: {
        ...request.options,
        ...prepared.range,
        rejectSilent: false,
      },
    }, (progress) => onProgress({
      phase: progress.phase,
      progress: ((index + progress.progress) / trackCount) * 0.94,
    }));
    durationSeconds = rendered.durationSeconds;
    const filename = `${prepared.filenameScope}.wav`;
    zipEntries.push({ name: filename, data: new Uint8Array(rendered.wav) });
    manifestTracks.push(manifestEntry(track, index, filename, rendered));
  }

  const bitDepth = request.options.bitDepth ?? 24;
  const sampleRate = request.options.sampleRate ?? request.project.sampleRate;
  const manifest: TrackStemsManifest = {
    schema: 'vibeseq-track-stems',
    version: 1,
    project: { id: request.project.id, name: request.project.name, bpm: request.project.bpm },
    arrangement: { fromBeat: 0, toBeat, durationSeconds },
    format: {
      sampleRate,
      bitDepth,
      channels: 2,
      peakProtection: request.options.protectPeaks ?? false,
    },
    tracks: manifestTracks,
  };
  onProgress({ phase: 'packaging', progress: 0.95 });
  zipEntries.push({
    name: 'manifest.json',
    data: new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`),
  });
  const zip = await createStoredZip(zipEntries);
  onProgress({ phase: 'packaging', progress: 1 });
  return { zip, manifest };
}
