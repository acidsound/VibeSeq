// @vitest-environment jsdom

import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { InferenceHealth } from '../api/inference'
import { EngineDialog } from './EngineDialog'

afterEach(() => {
  cleanup()
  delete window.vibeseqDesktop
})

const blockedHealth = (): InferenceHealth => ({
  status: 'ok',
  target: 'local',
  hardware: { preferredDevice: 'metal', devices: ['metal', 'cpu'] },
  storage: {
    root: '/Users/artist/VibeSeq Data',
    modelCache: '/Users/artist/VibeSeq Data/models/huggingface/hub',
  },
  generation: {
    available: false,
    ready: false,
    provider: 'stable-audio-3',
    model: 'medium',
    modelId: 'stabilityai/stable-audio-3-optimized',
    modelRevision: 'c2949a435de2392fe49c5914c52bc174cfc05a9b',
    codeRevision: 'b32763cf3b71c160f10a0daa4fa0e0d471b5772e',
    device: 'metal',
    runtime: 'mlx',
    route: 'apple-mlx',
    packageInstalled: true,
    weightsCached: false,
    codeCached: true,
    accessGranted: true,
    runtimeCompatible: true,
    adapterImplemented: true,
    executionEnabled: true,
    missingFiles: ['MLX/dit_medium_f16.npz'],
    bootstrap: {
      modelId: 'stabilityai/stable-audio-3-optimized',
      revision: 'c2949a435de2392fe49c5914c52bc174cfc05a9b',
      files: ['MLX/dit_medium_f16.npz'],
      accessUrl: 'https://huggingface.co/stabilityai/stable-audio-3-optimized',
    },
  },
  transcription: {
    available: true,
    ready: true,
    provider: 'muscriptor',
    model: 'medium',
    modelId: 'MuScriptor/muscriptor-medium',
    device: 'mps',
    runtime: 'pytorch-mps',
  },
})

const blockedMuscriptorHealth = (): InferenceHealth => {
  const health = blockedHealth()
  health.transcription = {
    available: false,
    ready: false,
    provider: 'muscriptor',
    model: 'medium',
    modelId: 'MuScriptor/muscriptor-medium',
    modelRevision: 'f32236969308476e01fd3aae67357de5feb05a2d',
    device: 'mps',
    runtime: 'pytorch-mps',
    route: 'apple-mps',
    weightsCached: false,
    accessGranted: true,
    missingFiles: ['config.json', 'model.safetensors'],
    bootstrap: {
      modelId: 'MuScriptor/muscriptor-medium',
      revision: 'f32236969308476e01fd3aae67357de5feb05a2d',
      files: ['config.json', 'model.safetensors'],
      accessUrl: 'https://huggingface.co/MuScriptor/muscriptor-medium',
      requiresApproval: false,
    },
  }
  return health
}

const blockedWindowsGpuHealth = (): InferenceHealth => {
  const health = blockedHealth()
  health.hardware = {
    preferredDevice: 'cpu',
    devices: ['cpu'],
    system: 'Windows',
    machine: 'AMD64',
    cudaName: 'NVIDIA GeForce RTX 4090',
    cudaCapability: [8, 9],
  }
  health.generation = {
    ...health.generation,
    modelId: 'stabilityai/stable-audio-3-medium',
    modelRevision: '27b5a21b791b1b033d193a9e1e3ce78493f102f9',
    device: 'cuda',
    runtime: 'pytorch-fa2',
    route: 'cuda-ampere-fa2',
    weightsCached: false,
    accessGranted: null,
    missingFiles: ['model.safetensors'],
    bootstrap: {
      modelId: 'stabilityai/stable-audio-3-medium',
      revision: '27b5a21b791b1b033d193a9e1e3ce78493f102f9',
      files: ['model.safetensors'],
      accessUrl: 'https://huggingface.co/stabilityai/stable-audio-3-medium',
      requiresApproval: true,
    },
  }
  return health
}

const blockedWindowsMuscriptorCudaHealth = (): InferenceHealth => {
  const health = blockedMuscriptorHealth()
  health.hardware = {
    preferredDevice: 'cpu',
    devices: ['cpu'],
    system: 'Windows',
    machine: 'AMD64',
    cudaName: 'NVIDIA GeForce RTX 4090',
    cudaCapability: [8, 9],
  }
  health.transcription = {
    ...health.transcription,
    device: 'cuda',
    runtime: 'pytorch-cuda',
    route: 'cuda-pytorch',
    runtimeCompatible: false,
    reason: 'The managed VibeSeq CUDA runtime has not passed its on-device check.',
  }
  return health
}

type DesktopMuscriptor = NonNullable<Window['vibeseqDesktop']>['muscriptor']

const mockMuscriptor = (overrides: Partial<DesktopMuscriptor> = {}): DesktopMuscriptor => ({
  status: vi.fn(),
  install: vi.fn(),
  cancel: vi.fn(),
  onProgress: vi.fn(() => () => undefined),
  verifyCache: vi.fn(),
  openCacheFolder: vi.fn(),
  ...overrides,
})

describe('EngineDialog model installation guidance', () => {
  it('shows the official source, exact file, and effective model-cache path', () => {
    render(createElement(EngineDialog, {
      health: blockedHealth(),
      generationProvider: 'stable-audio-3',
      transcriptionProvider: 'muscriptor',
      onGenerationProvider: vi.fn(),
      onTranscriptionProvider: vi.fn(),
      onClose: vi.fn(),
    }))

    expect(screen.getByText('/Users/artist/VibeSeq Data/models/huggingface/hub')).not.toBeNull()
    expect(screen.getByText('MLX/dit_medium_f16.npz')).not.toBeNull()
    const link = screen.getByRole('link', { name: /Open official model files/ })
    expect(link.getAttribute('href')).toBe(
      'https://huggingface.co/stabilityai/stable-audio-3-optimized',
    )
  })

  it('downloads only the desktop OS bundle after explicit license acceptance', async () => {
    const install = vi.fn().mockResolvedValue({
      supported: true,
      platformKey: 'darwin-arm64',
      variantLabel: 'Apple Silicon · MLX',
      installed: true,
      installedBytes: 5_179_078_812,
      totalBytes: 5_179_078_812,
      revision: 'c2949a435de2392fe49c5914c52bc174cfc05a9b',
    })
    const onModelInstalled = vi.fn()
    window.vibeseqDesktop = {
      stableAudio: {
        status: vi.fn().mockResolvedValue({
          supported: true,
          platformKey: 'darwin-arm64',
          variantLabel: 'Apple Silicon · MLX',
          installed: false,
          installedBytes: 0,
          totalBytes: 5_179_078_812,
          minimumFreeBytes: 7_200_000_000,
          revision: 'c2949a435de2392fe49c5914c52bc174cfc05a9b',
          terms: {
            stability: 'https://huggingface.co/stabilityai/stable-audio-3-optimized/blob/revision/LICENSE.md',
            gemma: 'https://ai.google.dev/gemma/terms',
            source: 'https://huggingface.co/stabilityai/stable-audio-3-optimized',
          },
        }),
        install,
        cancel: vi.fn().mockResolvedValue({ cancelled: true }),
        onProgress: vi.fn(() => () => undefined),
      },
      muscriptor: mockMuscriptor(),
      modelCache: { open: vi.fn().mockResolvedValue({ path: '/Users/artist/VibeSeq Data/models/huggingface/hub' }) },
      openExternal: vi.fn().mockResolvedValue(undefined),
    }

    render(createElement(EngineDialog, {
      health: blockedHealth(),
      generationProvider: 'stable-audio-3',
      transcriptionProvider: 'muscriptor',
      onGenerationProvider: vi.fn(),
      onTranscriptionProvider: vi.fn(),
      onModelInstalled,
      onClose: vi.fn(),
    }))

    const download = await screen.findByRole('button', { name: /Download & install 5.18 GB/ })
    expect(download.hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('checkbox'))
    expect(download.hasAttribute('disabled')).toBe(false)
    fireEvent.click(download)

    await waitFor(() => expect(install).toHaveBeenCalledWith({
      accepted: true,
      modelId: 'stabilityai/stable-audio-3-optimized',
    }))
    await waitFor(() => expect(onModelInstalled).toHaveBeenCalledOnce())
    expect(screen.getByText('Apple Silicon · MLX')).not.toBeNull()
  })

  it('offers the Windows FA2 model as the same one-click release download', async () => {
    const install = vi.fn().mockResolvedValue({
      supported: true,
      platformKey: 'win32-x64',
      variantLabel: 'Windows x64 · NVIDIA CUDA · FlashAttention 2',
      installed: true,
      installedBytes: 10_443_825_499,
      totalBytes: 10_443_825_499,
      revision: '27b5a21b791b1b033d193a9e1e3ce78493f102f9',
      modelInstalled: true,
    })
    window.vibeseqDesktop = {
      stableAudio: {
        status: vi.fn().mockResolvedValue({
          supported: true,
          platformKey: 'win32-x64',
          variantLabel: 'Windows x64 · NVIDIA CUDA · FlashAttention 2',
          installed: false,
          installedBytes: 0,
          totalBytes: 10_443_825_499,
          revision: '27b5a21b791b1b033d193a9e1e3ce78493f102f9',
          releaseUrl: 'https://github.com/acidsound/VibeSeq/releases/tag/stable-audio-3-27b5a21-windows-x64-fa2',
          terms: {
            stability: 'https://huggingface.co/stabilityai/stable-audio-3-medium/blob/revision/LICENSE.md',
            gemma: 'https://ai.google.dev/gemma/terms',
            source: 'https://huggingface.co/stabilityai/stable-audio-3-medium',
          },
        }),
        install,
        cancel: vi.fn().mockResolvedValue({ cancelled: true }),
        onProgress: vi.fn(() => () => undefined),
      },
      muscriptor: mockMuscriptor(),
      modelCache: { open: vi.fn() },
      openExternal: vi.fn(),
    }

    render(createElement(EngineDialog, {
      health: blockedWindowsGpuHealth(),
      generationProvider: 'stable-audio-3',
      transcriptionProvider: 'muscriptor',
      onGenerationProvider: vi.fn(),
      onTranscriptionProvider: vi.fn(),
      onClose: vi.fn(),
    }))

    expect(screen.getByText('GPU')).not.toBeNull()
    expect(screen.getByText('NVIDIA GeForce RTX 4090 · CUDA · FlashAttention 2')).not.toBeNull()
    expect(screen.queryByText('CPU')).toBeNull()
    const download = await screen.findByRole('button', { name: /Download & install 10.44 GB/ })
    fireEvent.click(screen.getByRole('checkbox'))
    expect(download.hasAttribute('disabled')).toBe(false)
    expect(screen.queryByText('Hugging Face read token')).toBeNull()
    expect(screen.queryByText(/Approve gated access/)).toBeNull()
    fireEvent.click(download)

    await waitFor(() => expect(install).toHaveBeenCalledWith({
      accepted: true,
      modelId: 'stabilityai/stable-audio-3-medium',
    }))
  })

  it('offers CUDA runtime repair when GPU weights are already cached', async () => {
    const health = blockedWindowsGpuHealth()
    health.generation = {
      ...health.generation,
      weightsCached: true,
      packageInstalled: false,
      runtimeCompatible: false,
      missingFiles: [],
    }
    const status = vi.fn().mockResolvedValue({
      supported: true,
      platformKey: 'win32-x64',
      variantLabel: 'Windows x64 · NVIDIA CUDA · FlashAttention 2',
      installed: false,
      modelInstalled: true,
      installedBytes: 10_443_825_499,
      totalBytes: 10_443_825_499,
      revision: '27b5a21b791b1b033d193a9e1e3ce78493f102f9',
      releaseUrl: 'https://github.com/acidsound/VibeSeq/releases/tag/stable-audio-3-27b5a21-windows-x64-fa2',
      terms: {
        stability: 'https://huggingface.co/stabilityai/stable-audio-3-medium/blob/revision/LICENSE.md',
        gemma: 'https://ai.google.dev/gemma/terms',
        source: 'https://huggingface.co/stabilityai/stable-audio-3-medium',
      },
    })
    window.vibeseqDesktop = {
      stableAudio: {
        status,
        install: vi.fn(),
        cancel: vi.fn(),
        onProgress: vi.fn(() => () => undefined),
      },
      muscriptor: mockMuscriptor(),
      modelCache: { open: vi.fn() },
      openExternal: vi.fn(),
    }

    render(createElement(EngineDialog, {
      health,
      generationProvider: 'stable-audio-3',
      transcriptionProvider: 'muscriptor',
      onGenerationProvider: vi.fn(),
      onTranscriptionProvider: vi.fn(),
      onClose: vi.fn(),
    }))

    const download = await screen.findByRole('button', { name: /Download & install 10.44 GB/ })
    fireEvent.click(screen.getByRole('checkbox'))
    expect(download.hasAttribute('disabled')).toBe(false)
    expect(screen.queryByText('Hugging Face read token')).toBeNull()
    expect(status).toHaveBeenCalledWith('stabilityai/stable-audio-3-medium')
  })

  it('installs the shared MuScriptor release bundle after explicit CC BY-NC acceptance', async () => {
    const status = vi.fn().mockResolvedValue({
      supported: true,
      platformKey: 'darwin-arm64',
      variantLabel: 'macOS ARM64 · PyTorch MPS',
      installed: false,
      installedBytes: 0,
      totalBytes: 1_228_145_602,
      revision: 'f32236969308476e01fd3aae67357de5feb05a2d',
      terms: {
        license: 'https://creativecommons.org/licenses/by-nc/4.0/legalcode.en',
        conditions: 'https://huggingface.co/MuScriptor/muscriptor-medium',
        source: 'https://huggingface.co/MuScriptor/muscriptor-medium/tree/revision',
      },
    })
    const install = vi.fn().mockResolvedValue({
      supported: true,
      platformKey: 'darwin-arm64',
      variantLabel: 'macOS ARM64 · PyTorch MPS',
      installed: true,
      installedBytes: 1_228_145_602,
      totalBytes: 1_228_145_602,
      revision: 'f32236969308476e01fd3aae67357de5feb05a2d',
    })
    const openCacheFolder = vi.fn().mockResolvedValue({
      path: '/Users/artist/VibeSeq Data/models/huggingface/hub/models--MuScriptor--muscriptor-medium/snapshots/f32236969308476e01fd3aae67357de5feb05a2d',
    })
    const onModelInstalled = vi.fn()
    window.vibeseqDesktop = {
      stableAudio: {
        status: vi.fn(),
        install: vi.fn(),
        cancel: vi.fn(),
        onProgress: vi.fn(() => () => undefined),
      },
      muscriptor: mockMuscriptor({ status, install, openCacheFolder }),
      modelCache: { open: vi.fn().mockResolvedValue({ path: '/Users/artist/VibeSeq Data/models/huggingface/hub' }) },
      openExternal: vi.fn().mockResolvedValue(undefined),
    }

    render(createElement(EngineDialog, {
      health: blockedMuscriptorHealth(),
      generationProvider: 'procedural-demo',
      transcriptionProvider: 'muscriptor',
      onGenerationProvider: vi.fn(),
      onTranscriptionProvider: vi.fn(),
      onModelInstalled,
      onClose: vi.fn(),
    }))

    expect(screen.queryByRole('link', { name: 'MuScriptor access form' })).toBeNull()
    expect(screen.queryByRole('link', { name: /Open model access page/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Open model cache folder' }).textContent).toContain('models--MuScriptor--muscriptor-medium/snapshots/f32236969308476e01fd3aae67357de5feb05a2d')
    fireEvent.click(screen.getByRole('button', { name: 'Open model cache folder' }))
    await waitFor(() => expect(openCacheFolder).toHaveBeenCalledOnce())
    const download = await screen.findByRole('button', { name: /Download & install 1.23 GB/ })
    expect(screen.getByRole('link', { name: 'CC BY-NC 4.0' })).not.toBeNull()
    expect(screen.getByText(/I have all necessary rights in source audio/)).not.toBeNull()
    expect(download.hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(download)

    await waitFor(() => expect(status).toHaveBeenCalledWith({ installRuntime: false }))
    await waitFor(() => expect(install).toHaveBeenCalledWith({ accepted: true, installRuntime: false }))
    await waitFor(() => expect(onModelInstalled).toHaveBeenCalledOnce())
  })

  it('installs the MuScriptor model and managed CUDA runtime with one click on NVIDIA Windows', async () => {
    const status = vi.fn().mockResolvedValue({
      supported: true,
      platformKey: 'win32-x64',
      variantLabel: 'Windows x64 · PyTorch CPU/CUDA',
      installed: false,
      installedBytes: 0,
      totalBytes: 1_228_145_602,
      revision: 'f32236969308476e01fd3aae67357de5feb05a2d',
      terms: {
        license: 'https://creativecommons.org/licenses/by-nc/4.0/legalcode.en',
        conditions: 'https://huggingface.co/MuScriptor/muscriptor-medium',
        source: 'https://huggingface.co/MuScriptor/muscriptor-medium/tree/revision',
      },
    })
    const install = vi.fn().mockResolvedValue({
      supported: true,
      platformKey: 'win32-x64',
      variantLabel: 'Windows x64 · PyTorch CPU/CUDA',
      installed: true,
      installedBytes: 1_228_145_602,
      totalBytes: 1_228_145_602,
      revision: 'f32236969308476e01fd3aae67357de5feb05a2d',
      runtimeInstalled: true,
    })
    const onModelInstalled = vi.fn()
    window.vibeseqDesktop = {
      stableAudio: {
        status: vi.fn(),
        install: vi.fn(),
        cancel: vi.fn(),
        onProgress: vi.fn(() => () => undefined),
      },
      muscriptor: mockMuscriptor({ status, install }),
      modelCache: { open: vi.fn() },
      openExternal: vi.fn(),
    }

    render(createElement(EngineDialog, {
      health: blockedWindowsMuscriptorCudaHealth(),
      generationProvider: 'procedural-demo',
      transcriptionProvider: 'muscriptor',
      onGenerationProvider: vi.fn(),
      onTranscriptionProvider: vi.fn(),
      onModelInstalled,
      onClose: vi.fn(),
    }))

    expect(screen.getByText('GPU')).not.toBeNull()
    expect(screen.getByText('NVIDIA GeForce RTX 4090 · CUDA · PyTorch')).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Install CUDA runtime' })).toBeNull()
    const download = await screen.findByRole('button', { name: /Download & install 1.23 GB/ })
    expect(screen.getByText(/same click also installs the isolated MuScriptor CUDA runtime/)).not.toBeNull()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(download)

    await waitFor(() => expect(status).toHaveBeenCalledWith({ installRuntime: true }))
    await waitFor(() => expect(install).toHaveBeenCalledWith({ accepted: true, installRuntime: true }))
    await waitFor(() => expect(onModelInstalled).toHaveBeenCalledOnce())
  })

  it('shows a MuScriptor one-click installation failure without requiring manual cache steps', async () => {
    const status = vi.fn().mockResolvedValue({
      supported: true,
      platformKey: 'darwin-arm64',
      installed: false,
      installedBytes: 0,
      totalBytes: 1_228_145_602,
      revision: 'f32236969308476e01fd3aae67357de5feb05a2d',
      terms: {
        license: 'https://creativecommons.org/licenses/by-nc/4.0/legalcode.en',
        conditions: 'https://huggingface.co/MuScriptor/muscriptor-medium',
        source: 'https://huggingface.co/MuScriptor/muscriptor-medium/tree/revision',
      },
    })
    window.vibeseqDesktop = {
      stableAudio: {
        status: vi.fn(),
        install: vi.fn(),
        cancel: vi.fn(),
        onProgress: vi.fn(() => () => undefined),
      },
      muscriptor: mockMuscriptor({
        status,
        install: vi.fn().mockRejectedValue(new Error('Release asset digest mismatch.')),
      }),
      modelCache: { open: vi.fn() },
      openExternal: vi.fn(),
    }

    render(createElement(EngineDialog, {
      health: blockedMuscriptorHealth(),
      generationProvider: 'procedural-demo',
      transcriptionProvider: 'muscriptor',
      onGenerationProvider: vi.fn(),
      onTranscriptionProvider: vi.fn(),
      onClose: vi.fn(),
    }))

    const download = await screen.findByRole('button', { name: /Download & install 1.23 GB/ })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(download)
    expect((await screen.findByRole('alert')).textContent).toBe('Release asset digest mismatch.')
  })

  it('opens the effective model cache folder from its displayed path', async () => {
    const openModelCache = vi.fn().mockResolvedValue({ path: '/Users/artist/VibeSeq Data/models/huggingface/hub' })
    window.vibeseqDesktop = {
      stableAudio: {
        status: vi.fn().mockResolvedValue({ supported: false, installed: false, installedBytes: 0, totalBytes: 0, revision: 'test', platformKey: 'test' }),
        install: vi.fn(),
        cancel: vi.fn(),
        onProgress: vi.fn(() => () => undefined),
      },
      muscriptor: mockMuscriptor(),
      modelCache: { open: openModelCache },
      openExternal: vi.fn(),
    }

    render(createElement(EngineDialog, {
      health: blockedHealth(),
      generationProvider: 'stable-audio-3',
      transcriptionProvider: 'muscriptor',
      onGenerationProvider: vi.fn(),
      onTranscriptionProvider: vi.fn(),
      onClose: vi.fn(),
    }))

    fireEvent.click(screen.getByRole('button', { name: 'Open model cache folder' }))
    await waitFor(() => expect(openModelCache).toHaveBeenCalledOnce())
  })
})

describe('EngineDialog recording compensation', () => {
  it('shows the browser estimate and applies a bounded manual trim', () => {
    const onRecordingLatencyTrim = vi.fn()
    render(createElement(EngineDialog, {
      health: null,
      generationProvider: 'procedural-demo',
      transcriptionProvider: 'signal-demo',
      onGenerationProvider: vi.fn(),
      onTranscriptionProvider: vi.fn(),
      recordingLatencyEstimateMs: 18.5,
      recordingLatencyTrimMs: 2,
      onRecordingLatencyTrim,
      onClose: vi.fn(),
    }))

    expect(screen.getByText('20.5 ms')).not.toBeNull()
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Recording latency manual trim' }), {
      target: { value: '600' },
    })
    expect(onRecordingLatencyTrim).toHaveBeenCalledWith(500)
  })
})
