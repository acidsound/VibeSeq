// @vitest-environment jsdom

import { createElement } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { InferenceHealth } from '../api/inference'
import { EngineDialog } from './EngineDialog'

afterEach(cleanup)

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
})
