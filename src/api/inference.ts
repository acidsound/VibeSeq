/** Matches the inference service's GenerateRequest prompt contract. */
export const GENERATION_PROMPT_MAX_LENGTH = 2_000

export type EngineBootstrap = {
  kind?: string
  modelId?: string
  revision?: string
  files?: string[]
  accessUrl?: string
  requiresApproval?: boolean
}

export type EngineCapability = {
  available: boolean
  ready?: boolean
  provider: string
  model: string
  modelId?: string
  modelRevision?: string
  revision?: string
  codeRepository?: string | null
  codeRevision?: string | null
  license?: string
  gated?: boolean
  device: string
  runtime?: string
  route?: string
  provisional?: boolean
  packageInstalled?: boolean
  weightsCached?: boolean
  codeCached?: boolean
  accessGranted?: boolean | null
  accessEvidence?: string | null
  runtimeCompatible?: boolean
  adapterImplemented?: boolean
  executionEnabled?: boolean
  missingFiles?: string[]
  requiredPackages?: string[]
  bootstrap?: EngineBootstrap
  reason?: string
  fallbackRoutes?: Array<Partial<Omit<EngineCapability, 'fallbackRoutes'>> & { id?: string }>
}

export type ModelManifestEntry = Pick<
  EngineCapability,
  'model' | 'modelId' | 'modelRevision' | 'codeRepository' | 'codeRevision' | 'license' | 'gated'
> & { files?: string[] }

export type InferenceHealth = {
  status: string
  target?: string
  hardware: {
    preferredDevice: string
    devices: string[]
  }
  generation: EngineCapability
  transcription: EngineCapability
  selectableProviders?: {
    generation?: string[]
    transcription?: string[]
  }
  modelManifest?: Record<string, ModelManifestEntry>
}

export type GeneratedAssetResult = {
  assetId: string
  assetUrl: string
  duration: number
  sampleRate: number
  provider: string
  device: string
  model?: string | null
  modelId?: string | null
  modelRevision?: string | null
  codeRevision?: string | null
  runtime?: string | null
  route?: string | null
  sourcePeak?: number | null
  outputPeak?: number | null
  peakProtectionApplied?: boolean
  peakAttenuationDb?: number
  prompt?: string
  seed?: number
  peaks?: number[] | { min: number[]; max: number[]; rms?: number[] }
}

export type TranscribedNote = {
  pitch: number
  startTime: number
  endTime: number
  velocity: number
  instrument?: string
  confidence?: number
}

export type TranscriptionResult = {
  midiAssetId: string
  midiAssetUrl: string
  notes: TranscribedNote[]
  provider: string
  device: string
  model?: string
  modelId?: string
  modelRevision?: string
  codeRevision?: string
  runtime?: string
  route?: string
}

export type InferenceJob<T> = {
  id: string
  kind: 'generate' | 'transcribe'
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  progress: number
  result?: T
  error?: string
}

export class InferenceJobTerminalError<T> extends Error {
  readonly job: InferenceJob<T>

  constructor(job: InferenceJob<T>) {
    super(job.error ?? `Job ${job.status}`)
    this.name = 'InferenceJobTerminalError'
    this.job = job
  }
}

const normalizeJob = <T>(value: unknown): InferenceJob<T> => {
  const raw = value as Record<string, unknown>
  return {
    id: String(raw.id ?? raw.jobId ?? raw.job_id ?? ''),
    kind: String(raw.kind ?? raw.type ?? 'generate') as InferenceJob<T>['kind'],
    status: String(raw.status ?? 'queued') as InferenceJob<T>['status'],
    progress: Number(raw.progress ?? 0),
    result: raw.result as T | undefined,
    error: raw.error ? String(raw.error) : undefined,
  }
}

const parseResponse = async <T>(response: Response): Promise<T> => {
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { detail?: string } | null
    throw new Error(payload?.detail ?? `Inference service returned ${response.status}`)
  }
  return response.json() as Promise<T>
}

export const getInferenceHealth = async (signal?: AbortSignal): Promise<InferenceHealth> =>
  parseResponse<InferenceHealth>(await fetch('/api/health', { signal }))

export const startGeneration = async (input: {
  prompt: string
  duration: number
  bpm: number
  seed: number
  provider?: string
}): Promise<InferenceJob<GeneratedAssetResult>> => {
  const response = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  return normalizeJob(await parseResponse<unknown>(response))
}

export const startTranscription = async (
  audio: Blob,
  filename = 'region.wav',
  provider?: string,
): Promise<InferenceJob<TranscriptionResult>> => {
  const body = new FormData()
  body.append('audio', audio, filename)
  if (provider) body.append('provider', provider)
  const response = await fetch('/api/transcribe', { method: 'POST', body })
  return normalizeJob(await parseResponse<unknown>(response))
}

export const getJob = async <T>(id: string): Promise<InferenceJob<T>> =>
  normalizeJob(await parseResponse<unknown>(await fetch(`/api/jobs/${encodeURIComponent(id)}`)))

export const cancelJob = async (id: string): Promise<void> => {
  await parseResponse(await fetch(`/api/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' }))
}

const waitForPollInterval = (signal?: AbortSignal): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }

    const onAbort = () => {
      window.clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    const timer = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, 350)
    signal?.addEventListener('abort', onAbort, { once: true })
  })

export const waitForJob = async <T>(
  id: string,
  onProgress: (job: InferenceJob<T>) => void,
  signal?: AbortSignal,
): Promise<InferenceJob<T>> => {
  while (!signal?.aborted) {
    const job = await getJob<T>(id)
    onProgress(job)
    if (job.status === 'completed') return job
    if (job.status === 'failed' || job.status === 'cancelled') {
      throw new InferenceJobTerminalError(job)
    }
    await waitForPollInterval(signal)
  }
  throw new DOMException('Aborted', 'AbortError')
}
