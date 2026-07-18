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
    accessGranted: null,
    missingFiles: ['config.json', 'model.safetensors'],
    bootstrap: {
      modelId: 'MuScriptor/muscriptor-medium',
      revision: 'f32236969308476e01fd3aae67357de5feb05a2d',
      files: ['config.json', 'model.safetensors'],
      accessUrl: 'https://huggingface.co/MuScriptor/muscriptor-medium',
      requiresApproval: true,
    },
  }
  return health
}

const blockedWindowsGpuHealth = (): InferenceHealth => {
  const health = blockedHealth()
  health.hardware = { preferredDevice: 'cuda', devices: ['cuda', 'cpu'] }
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
      muscriptor: {
        verifyCache: vi.fn().mockResolvedValue({ verified: false }),
        openCacheFolder: vi.fn(),
      },
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
      token: undefined,
    }))
    await waitFor(() => expect(onModelInstalled).toHaveBeenCalledOnce())
    expect(screen.getByText('Apple Silicon · MLX')).not.toBeNull()
  })

  it('requires a same-account Hugging Face token for the Windows FA2 model', async () => {
    const install = vi.fn().mockResolvedValue({
      supported: true,
      platformKey: 'win32-x64',
      variantLabel: 'Windows x64 · NVIDIA CUDA · FlashAttention 2',
      installed: true,
      installedBytes: 10_443_825_499,
      totalBytes: 10_443_825_499,
      revision: '27b5a21b791b1b033d193a9e1e3ce78493f102f9',
      modelInstalled: true,
      requiresToken: false,
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
          requiresToken: true,
          releaseUrl: 'https://huggingface.co/stabilityai/stable-audio-3-medium',
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
      muscriptor: { verifyCache: vi.fn(), openCacheFolder: vi.fn() },
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

    const download = await screen.findByRole('button', { name: /Download & install 10.44 GB/ })
    fireEvent.click(screen.getByRole('checkbox'))
    expect(download.hasAttribute('disabled')).toBe(true)
    fireEvent.change(screen.getByLabelText('Hugging Face read token'), {
      target: { value: 'hf_ephemeral' },
    })
    expect(download.hasAttribute('disabled')).toBe(false)
    fireEvent.click(download)

    await waitFor(() => expect(install).toHaveBeenCalledWith({
      accepted: true,
      modelId: 'stabilityai/stable-audio-3-medium',
      token: 'hf_ephemeral',
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
      requiresToken: false,
      releaseUrl: 'https://huggingface.co/stabilityai/stable-audio-3-medium',
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
      muscriptor: { verifyCache: vi.fn(), openCacheFolder: vi.fn() },
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

  it('guides gated MuScriptor access and verifies both browser-downloaded files', async () => {
    const verifyCache = vi.fn().mockResolvedValue({
      verified: true,
      modelId: 'MuScriptor/muscriptor-medium',
      revision: 'f32236969308476e01fd3aae67357de5feb05a2d',
      files: ['config.json', 'model.safetensors'],
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
      muscriptor: { verifyCache, openCacheFolder },
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

    expect(screen.getByRole('link', { name: 'MuScriptor access form' })).not.toBeNull()
    expect(screen.queryByRole('link', { name: /Open model access page/ })).toBeNull()
    expect(screen.getByRole('link', { name: 'config.json' }).getAttribute('href')).toContain('/blob/f32236969308476e01fd3aae67357de5feb05a2d/config.json')
    expect(screen.getByRole('link', { name: 'model.safetensors' }).getAttribute('href')).toContain('/blob/f32236969308476e01fd3aae67357de5feb05a2d/model.safetensors')
    expect(screen.getByText(/VibeSeq does not download, select, or move MuScriptor files/)).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Open model cache folder' }).textContent).toContain('models--MuScriptor--muscriptor-medium/snapshots/f32236969308476e01fd3aae67357de5feb05a2d')
    fireEvent.click(screen.getByRole('button', { name: 'Open model cache folder' }))
    await waitFor(() => expect(openCacheFolder).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('button', { name: 'Verify files in cache' }))

    await waitFor(() => expect(verifyCache).toHaveBeenCalledOnce())
    await waitFor(() => expect(onModelInstalled).toHaveBeenCalledOnce())
  })

  it('directs a failed MuScriptor verification back to SAVE CACHE UNDER', async () => {
    window.vibeseqDesktop = {
      stableAudio: {
        status: vi.fn(),
        install: vi.fn(),
        cancel: vi.fn(),
        onProgress: vi.fn(() => () => undefined),
      },
      muscriptor: {
        verifyCache: vi.fn().mockRejectedValue(new Error('internal validation detail')),
        openCacheFolder: vi.fn(),
      },
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

    fireEvent.click(screen.getByRole('button', { name: 'Verify files in cache' }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Verification failed. Check that config.json and model.safetensors are directly inside SAVE CACHE UNDER, then try again.',
    )
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
      muscriptor: { verifyCache: vi.fn(), openCacheFolder: vi.fn() },
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
