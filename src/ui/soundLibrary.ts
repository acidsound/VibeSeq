import type { SoundLibraryItem } from '../core/soundLibrary'
import type { GeneratedCandidate } from './types'

const LIBRARY_CANDIDATE_PREFIX = 'library-candidate:'
const LIBRARY_ASSET_PREFIX = 'library-asset:'

export const soundLibraryCandidateId = (libraryItemId: string): string =>
  `${LIBRARY_CANDIDATE_PREFIX}${libraryItemId}`

export const soundLibraryAssetId = (libraryItemId: string): string =>
  `${LIBRARY_ASSET_PREFIX}${libraryItemId}`

export const soundLibraryItemToCandidate = (item: SoundLibraryItem): GeneratedCandidate => ({
  id: soundLibraryCandidateId(item.id),
  name: item.name,
  prompt: item.prompt ?? '',
  duration: item.durationSeconds,
  seed: item.seed,
  generationLength: item.generationLength,
  provider: item.provider ?? (item.source === 'generated' ? 'local-generation' : 'local-import'),
  device: item.device ?? 'local library',
  model: item.model,
  modelId: item.modelId,
  modelRevision: item.modelRevision,
  codeRevision: item.codeRevision,
  runtime: item.runtime,
  route: item.route,
  sourcePeak: item.sourcePeak,
  outputPeak: item.outputPeak,
  peakProtectionApplied: item.peakProtectionApplied,
  peakAttenuationDb: item.peakAttenuationDb,
  assetId: soundLibraryAssetId(item.id),
  sampleRate: item.sampleRate,
  mimeType: item.mimeType,
  peaks: item.waveform,
  blob: item.blob,
  bytes: item.bytes,
  contentHashSha256: item.contentHashSha256,
  integrity: item.integrity,
})

export const generatedCandidateToSoundLibraryItem = (
  candidate: GeneratedCandidate,
  media: Blob | ArrayBuffer,
  createdAt = new Date().toISOString(),
): SoundLibraryItem => ({
  id: `sound-${crypto.randomUUID()}`,
  name: candidate.name,
  source: 'generated',
  createdAt,
  durationSeconds: candidate.duration,
  mimeType: candidate.mimeType || (media instanceof Blob ? media.type : '') || 'audio/wav',
  sampleRate: candidate.sampleRate,
  channelCount: 2,
  prompt: candidate.prompt,
  seed: candidate.seed,
  generationLength: candidate.generationLength,
  provider: candidate.provider,
  device: candidate.device,
  model: candidate.model,
  modelId: candidate.modelId,
  modelRevision: candidate.modelRevision,
  codeRevision: candidate.codeRevision,
  runtime: candidate.runtime,
  route: candidate.route,
  sourcePeak: candidate.sourcePeak,
  outputPeak: candidate.outputPeak,
  peakProtectionApplied: candidate.peakProtectionApplied,
  peakAttenuationDb: candidate.peakAttenuationDb,
  waveform: candidate.peaks,
  ...(media instanceof Blob ? { blob: media } : { bytes: media }),
  contentHashSha256: candidate.contentHashSha256,
  integrity: candidate.integrity,
})
