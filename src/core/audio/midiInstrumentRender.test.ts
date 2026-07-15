import { describe, expect, it } from 'vitest'
import {
  chaosDrumAssetId,
  getChaosDrumVoice,
  tinySynthEnvelope,
  tinySynthReleaseTailSeconds,
  tinySynthSampleAtTime,
  tinySynthVoice,
} from './midiInstrumentRender'

describe('lightweight MIDI instrument renderer', () => {
  it('uses the exact pinned TinySynth quality-0 program table', () => {
    expect(tinySynthVoice(0)).toMatchObject({ w: 'triangle', v: 0.5, d: 0.7 })
    expect(tinySynthVoice(40)).toMatchObject({ w: 'sawtooth', a: 0.02, s: 1 })
    expect(tinySynthVoice(127)).toMatchObject({ w: 'n0', v: 0.5 })
    expect(tinySynthVoice(999)).toEqual(tinySynthVoice(127))
  })

  it('changes audible synthesis with the selected GM program and stays deterministic', () => {
    const common = { pitch: 60, velocity: 0.8, noteSeconds: 0.123, noteDurationSeconds: 1, sampleRate: 48_000, noiseSeed: 92 }
    const piano = tinySynthSampleAtTime({ ...common, program: 0 })
    const strings = tinySynthSampleAtTime({ ...common, program: 40 })
    expect(piano).not.toBe(strings)
    expect(tinySynthSampleAtTime({ ...common, program: 127 })).toBe(tinySynthSampleAtTime({ ...common, program: 127 }))
  })

  it('applies attack, decay, and note-off release from TinySynth voice data', () => {
    expect(tinySynthEnvelope(16, 0, 1)).toBe(0)
    expect(tinySynthEnvelope(16, 0.005, 1)).toBeCloseTo(0.5)
    expect(tinySynthEnvelope(0, 1.2, 1)).toBeGreaterThan(0)
    expect(tinySynthEnvelope(0, 2, 1)).toBeLessThan(0.001)
  })

  it('shares the finite release-tail boundary used by realtime scan and offline render', () => {
    expect(tinySynthReleaseTailSeconds(14)).toBe(8)
    expect(tinySynthEnvelope(14, 6, 0.1)).toBeGreaterThan(0)
    expect(tinySynthEnvelope(14, 8.100_001, 0.1)).toBe(0)
  })

  it('routes the compact Chaos kit to four real WebAudioFont sample identities', () => {
    expect(getChaosDrumVoice(36)).toEqual({ assetId: chaosDrumAssetId(36), sourcePitch: 36, playbackRate: 1 })
    expect(getChaosDrumVoice(38).assetId).toBe(chaosDrumAssetId(38))
    expect(getChaosDrumVoice(42).assetId).toBe(chaosDrumAssetId(42))
    expect(getChaosDrumVoice(46).assetId).toBe(chaosDrumAssetId(46))
    expect(getChaosDrumVoice(49).sourcePitch).toBe(46)
  })
})
