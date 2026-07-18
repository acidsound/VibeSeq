/// <reference types="vite/client" />

type StableAudioInstallStatus = {
  supported: boolean
  platformKey: string
  variantLabel?: string
  installed: boolean
  modelInstalled?: boolean
  installedBytes: number
  totalBytes: number
  minimumFreeBytes?: number
  revision: string
  modelId?: string
  releaseUrl?: string
  installRoot?: string
  runtimeInstalled?: boolean
  terms?: {
    stability?: string
    gemma?: string
    license?: string
    conditions?: string
    source: string
  }
}

type StableAudioInstallProgress = {
  phase: 'runtime' | 'downloading' | 'verified' | 'complete'
  asset: string | null
  downloadedBytes: number
  totalBytes: number
}

type MuscriptorVerifyResult = {
  verified: boolean
  modelId?: string
  revision?: string
  cacheDirectory?: string
  files?: string[]
}

type CudaRuntimeStatus = {
  supported: boolean
  installed: boolean
  flashAttentionInstalled?: boolean
  muscriptorInstalled?: boolean
  bundleId: string
  runtimeRoot: string
  python?: string | null
}

type CudaRuntimeProgress = {
  detail: string
}

interface Window {
  vibeseqDesktop?: {
    startup?: {
      status: () => Promise<{
        phase: string
        step: number
        title: string
        detail: string
        elapsedSeconds?: number
      }>
      onProgress: (listener: (progress: {
        phase: string
        step: number
        title: string
        detail: string
        elapsedSeconds?: number
      }) => void) => () => void
    }
    studio?: {
      ready: () => void
    }
    stableAudio: {
      status: (modelId?: string) => Promise<StableAudioInstallStatus>
      install: (request: {
        accepted: boolean
        modelId?: string
      }) => Promise<StableAudioInstallStatus>
      cancel: () => Promise<{ cancelled: boolean }>
      onProgress: (listener: (progress: StableAudioInstallProgress) => void) => () => void
    }
    cudaRuntime?: {
      status: () => Promise<CudaRuntimeStatus>
      install: () => Promise<CudaRuntimeStatus>
      cancel: () => Promise<{ cancelled: boolean }>
      onProgress: (listener: (progress: CudaRuntimeProgress) => void) => () => void
    }
    muscriptor: {
      status: (request?: { installRuntime?: boolean }) => Promise<StableAudioInstallStatus>
      install: (request: {
        accepted: boolean
        installRuntime?: boolean
      }) => Promise<StableAudioInstallStatus>
      cancel: () => Promise<{ cancelled: boolean }>
      onProgress: (listener: (progress: StableAudioInstallProgress) => void) => () => void
      verifyCache: () => Promise<MuscriptorVerifyResult>
      openCacheFolder: () => Promise<{ path: string }>
    }
    modelCache: {
      open: () => Promise<{ path: string }>
    }
    openExternal: (url: string) => Promise<void>
  }
}
