import { describe, expect, it } from 'vitest'
import { AuditionPreviewGate } from './auditionPreview'

describe('AuditionPreviewGate', () => {
  it('aborts and invalidates a preparing preview when a replacement begins', () => {
    const gate = new AuditionPreviewGate()
    const first = gate.begin('candidate-a')
    const second = gate.begin('candidate-b')

    expect(first.signal.aborted).toBe(true)
    expect(gate.isCurrent(first)).toBe(false)
    expect(gate.isCurrent(second)).toBe(true)
    expect(gate.activeCandidateId).toBe('candidate-b')
  })

  it('invalidates preparation immediately when the active candidate is stopped', () => {
    const gate = new AuditionPreviewGate()
    const request = gate.begin('candidate-a')

    expect(gate.cancel()).toBe('candidate-a')
    expect(request.signal.aborted).toBe(true)
    expect(gate.isCurrent(request)).toBe(false)
    expect(gate.activeCandidateId).toBeNull()
  })

  it('only lets the current request clear active preview state', () => {
    const gate = new AuditionPreviewGate()
    const stale = gate.begin('candidate-a')
    const current = gate.begin('candidate-b')

    expect(gate.finish(stale)).toBe(false)
    expect(gate.activeCandidateId).toBe('candidate-b')
    expect(gate.finish(current)).toBe(true)
    expect(gate.activeCandidateId).toBeNull()
  })
})
