import { describe, expect, it } from 'vitest'
import type { InferenceHealth } from '../api/inference'
import { presentEngine, presentTransportEngine } from './engineHealth'

const mediumHealth = (): InferenceHealth => ({
  status: 'ok',
  target: 'local',
  hardware: { preferredDevice: 'metal', devices: ['metal', 'cpu'] },
  storage: {
    root: '/Users/artist/VibeSeq Data',
    modelCache: '/Users/artist/VibeSeq Data/models/huggingface/hub',
  },
  generation: {
    available: true,
    ready: true,
    provider: 'stable-audio-3',
    model: 'medium',
    modelId: 'stabilityai/stable-audio-3-optimized',
    modelRevision: 'c2949a435de2392fe49c5914c52bc174cfc05a9b',
    codeRevision: 'b32763cf3b71c160f10a0daa4fa0e0d471b5772e',
    device: 'metal',
    runtime: 'mlx',
    route: 'apple-mlx',
    packageInstalled: true,
    weightsCached: true,
    codeCached: true,
    accessGranted: true,
    runtimeCompatible: true,
    adapterImplemented: true,
    executionEnabled: true,
    reason: 'Exact medium weights, packages, and runtime route are ready.',
  },
  transcription: {
    available: true,
    ready: true,
    provider: 'muscriptor',
    model: 'medium',
    modelId: 'MuScriptor/muscriptor-medium',
    modelRevision: 'f32236969308476e01fd3aae67357de5feb05a2d',
    device: 'mps',
    runtime: 'pytorch-mps',
  },
})

describe('engine health presentation', () => {
  it('shows exact medium provenance and uses explicit ready only', () => {
    const presentation = presentEngine(mediumHealth(), 'generation', 'stable-audio-3')

    expect(presentation).toMatchObject({
      inspected: true,
      ready: true,
      fixture: false,
      statusLabel: 'MEDIUM READY',
      modelId: 'stabilityai/stable-audio-3-optimized',
      modelRevision: 'c2949a435de2392fe49c5914c52bc174cfc05a9b',
      runtimeLabel: 'mlx · metal · apple-mlx',
    })
    expect(presentation.gates.every((gate) => gate.state === 'pass')).toBe(true)
  })

  it('never claims readiness for an uninspected provider selection', () => {
    const presentation = presentEngine(mediumHealth(), 'generation', 'procedural-demo')

    expect(presentation.ready).toBe(false)
    expect(presentation.statusLabel).toBe('NOT INSPECTED')
    expect(presentation.modelId).toBe('not reported for selection')
    expect(presentation.actions[0]).toContain('stable-audio-3')
  })

  it('turns every failed model gate into an actionable message', () => {
    const health = mediumHealth()
    health.generation = {
      ...health.generation,
      available: false,
      ready: false,
      gated: true,
      accessGranted: null,
      packageInstalled: false,
      missingPackages: ['sentencepiece'],
      requiredPackages: ['mlx', 'sentencepiece', 'huggingface_hub'],
      weightsCached: false,
      codeCached: false,
      missingFiles: ['MLX/dit_medium_f16.npz'],
      adapterImplemented: false,
      executionEnabled: false,
      bootstrap: { accessUrl: 'https://huggingface.co/stabilityai/stable-audio-3-medium' },
    }

    const presentation = presentEngine(health, 'generation', 'stable-audio-3')
    expect(presentation.statusLabel).toBe('BLOCKED')
    expect(presentation.actions).toEqual(expect.arrayContaining([
      expect.stringContaining('Approve gated access'),
      expect.stringContaining('Cache the exact source checkout'),
      expect.stringContaining('Install required runtime packages: sentencepiece'),
      expect.stringContaining('Cache 1 missing file'),
      expect.stringContaining('adapter is not executable'),
      expect.stringContaining('Execution is disabled'),
    ]))
    expect(presentation.accessUrl).toContain('huggingface.co')
  })

  it('keeps the transport blocked when ready is absent even if available is true', () => {
    const health = mediumHealth()
    health.generation.ready = undefined
    health.generation.available = true

    const presentation = presentTransportEngine(health, 'stable-audio-3')
    expect(presentation.ready).toBe(false)
    expect(presentation.label).toContain('blocked')
    expect(presentation.title).toContain('stabilityai/stable-audio-3-optimized@c2949')
  })

  it('asks an older service to expose readiness instead of trusting available', () => {
    const health = mediumHealth()
    health.generation = {
      available: true,
      provider: 'stable-audio-3',
      model: 'medium',
      modelId: 'stabilityai/stable-audio-3-medium',
      device: 'mps',
    }

    const presentation = presentEngine(health, 'generation', 'stable-audio-3')
    expect(presentation.ready).toBe(false)
    expect(presentation.actions).toEqual(expect.arrayContaining([
      expect.stringContaining('does not infer readiness from availability'),
      expect.stringContaining('model readiness requires verified code'),
    ]))
  })

  it('rejects a ready claim below the Medium model floor', () => {
    const health = mediumHealth()
    health.generation.model = 'small'
    health.generation.modelId = 'stabilityai/stable-audio-3-small'

    const presentation = presentEngine(health, 'generation', 'stable-audio-3')
    expect(presentation.ready).toBe(false)
    expect(presentation.gates[0]).toEqual({ id: 'model', label: 'MODEL', state: 'blocked' })
    expect(presentation.actions[0]).toContain('never downgrades to Small')
  })

  it('rejects Medium READY when the exact code checkout is not cached', () => {
    const health = mediumHealth()
    health.generation.codeCached = false

    const presentation = presentEngine(health, 'generation', 'stable-audio-3')
    expect(presentation.ready).toBe(false)
    expect(presentation.gates.find((gate) => gate.id === 'code')?.state).toBe('blocked')
    expect(presentation.reason).toContain('exact source revision is not cached')
    expect(presentation.actions[0]).toContain('model readiness requires verified code')
  })
})
