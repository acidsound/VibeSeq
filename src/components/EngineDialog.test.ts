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

    await waitFor(() => expect(install).toHaveBeenCalledWith(true))
    await waitFor(() => expect(onModelInstalled).toHaveBeenCalledOnce())
    expect(screen.getByText('Apple Silicon · MLX')).not.toBeNull()
  })
})
