/// <reference types="vite/client" />

type StableAudioInstallStatus = {
  supported: boolean
  platformKey: string
  variantLabel?: string
  installed: boolean
  installedBytes: number
  totalBytes: number
  minimumFreeBytes?: number
  revision: string
  modelId?: string
  releaseUrl?: string
  installRoot?: string
  terms?: {
    stability: string
    gemma: string
    source: string
  }
}

type StableAudioInstallProgress = {
  phase: 'downloading' | 'verified' | 'complete'
  asset: string | null
  downloadedBytes: number
  totalBytes: number
}

interface Window {
  vibeseqDesktop?: {
    stableAudio: {
      status: () => Promise<StableAudioInstallStatus>
      install: (accepted: boolean) => Promise<StableAudioInstallStatus>
      cancel: () => Promise<{ cancelled: boolean }>
      onProgress: (listener: (progress: StableAudioInstallProgress) => void) => () => void
    }
    openExternal: (url: string) => Promise<void>
  }
}
