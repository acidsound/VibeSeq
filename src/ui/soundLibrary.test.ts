import { describe, expect, it, vi } from 'vitest'
import type { GeneratedCandidate } from './types'
import {
  generatedCandidateToSoundLibraryItem,
  soundLibraryAssetId,
  soundLibraryCandidateId,
  soundLibraryItemToCandidate,
} from './soundLibrary'

describe('Sound Library UI mapping', () => {
  it('preserves generated source provenance and local media', () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'sound-id' })
    const blob = new Blob(['audio'], { type: 'audio/wav' })
    const candidate: GeneratedCandidate = {
      id: 'candidate-1',
      name: 'Warm loop',
      prompt: 'warm tape loop',
      duration: 4,
      seed: 91,
      generationLength: {
        unit: 'bars',
        value: 2,
        durationSeconds: 4,
        bpm: 120,
        timeSignature: { numerator: 4, denominator: 4 },
      },
      provider: 'stable-audio-3',
      device: 'mps',
      modelId: 'stable-audio-medium',
      mimeType: 'audio/wav',
      sampleRate: 44_100,
      blob,
      contentHashSha256: 'abc',
    }

    const item = generatedCandidateToSoundLibraryItem(candidate, blob, '2026-07-15T00:00:00.000Z')

    expect(item).toMatchObject({
      id: 'sound-sound-id',
      source: 'generated',
      prompt: 'warm tape loop',
      seed: 91,
      durationSeconds: 4,
      modelId: 'stable-audio-medium',
      blob,
    })
    vi.unstubAllGlobals()
  })

  it('maps a global item to stable project-local candidate and asset identities', () => {
    const blob = new Blob(['audio'], { type: 'audio/wav' })
    const candidate = soundLibraryItemToCandidate({
      id: 'sound-9',
      name: 'Global sound',
      source: 'generated',
      createdAt: '2026-07-15T00:00:00.000Z',
      durationSeconds: 2,
      mimeType: 'audio/wav',
      provider: 'stable-audio-3',
      blob,
    })

    expect(candidate.id).toBe(soundLibraryCandidateId('sound-9'))
    expect(candidate.assetId).toBe(soundLibraryAssetId('sound-9'))
    expect(candidate.blob).toBe(blob)
    expect(candidate.provider).toBe('stable-audio-3')
  })
})
