import { describe, expect, it } from 'vitest'
import { snapGridDivision, snapGridLabel } from './snapGrid'

describe('snapGrid', () => {
  it('defaults can resolve a meter-aware Bar grid', () => {
    expect(snapGridDivision('bar', { numerator: 4, denominator: 4 })).toBe(4)
    expect(snapGridDivision('bar', { numerator: 6, denominator: 8 })).toBe(3)
  })

  it('resolves note divisions and Free placement', () => {
    expect(snapGridDivision('1/2', { numerator: 4, denominator: 4 })).toBe(2)
    expect(snapGridDivision('1/16', { numerator: 4, denominator: 4 })).toBe(0.25)
    expect(snapGridDivision('free', { numerator: 4, denominator: 4 })).toBeNull()
    expect(snapGridLabel('bar')).toBe('Bar')
  })
})
