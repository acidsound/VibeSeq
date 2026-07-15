import type { AudioAsset, GenerationLengthSnapshot, WaveformPeakLevel } from '../types'
import type { InferenceJob } from '../api/inference'

export type GeneratedCandidate = {
  id: string
  name: string
  prompt: string
  duration: number
  /** Exact Stable Audio seed used for this candidate. Absent only on legacy snapshots. */
  seed?: number
  generationLength?: GenerationLengthSnapshot
  provider: string
  device: string
  model?: string
  modelId?: string
  modelRevision?: string
  codeRevision?: string
  runtime?: string
  route?: string
  sourcePeak?: number | null
  outputPeak?: number | null
  peakProtectionApplied?: boolean
  peakAttenuationDb?: number
  assetId?: string
  assetUrl?: string
  sampleRate?: number
  mimeType?: string
  peaks?: WaveformPeakLevel
  jobId?: string
  blob?: Blob
  bytes?: ArrayBuffer
  contentHashSha256?: string
  integrity?: AudioAsset['integrity']
}

export type JobPresentation = {
  label: string
  job: InferenceJob<unknown>
}

export type MobileSurface = 'arrange' | 'create' | 'mix' | 'detail'
