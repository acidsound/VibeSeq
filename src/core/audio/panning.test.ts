import { describe, expect, it } from 'vitest'
import { equalPowerPanGains, webAudioStereoPanMatrix } from './panning'

const applyStereoMatrix = (left: number, right: number, pan: number): [number, number] => {
  const matrix = webAudioStereoPanMatrix(pan)
  return [
    left * matrix.leftFromLeft + right * matrix.leftFromRight,
    left * matrix.rightFromLeft + right * matrix.rightFromRight,
  ]
}

describe('Web Audio panning laws', () => {
  it('keeps the equal-power mono-input law', () => {
    expect(equalPowerPanGains(-1, 2)).toEqual([1, 0])
    expect(equalPowerPanGains(0, 2)[0]).toBeCloseTo(Math.SQRT1_2, 12)
    expect(equalPowerPanGains(0, 2)[1]).toBeCloseTo(Math.SQRT1_2, 12)
    expect(equalPowerPanGains(1, 2)[0]).toBeCloseTo(0, 12)
    expect(equalPowerPanGains(1, 2)[1]).toBeCloseTo(1, 12)
  })

  it('uses the StereoPannerNode stereo fold-in law with identity at center', () => {
    const left = 0.5
    const right = 0.25
    expect(applyStereoMatrix(left, right, -1)).toEqual([0.75, 0])
    expect(applyStereoMatrix(left, right, -0.5)[0]).toBeCloseTo(0.676_776_695, 9)
    expect(applyStereoMatrix(left, right, -0.5)[1]).toBeCloseTo(0.176_776_695, 9)
    expect(applyStereoMatrix(left, right, 0)).toEqual([left, right])
    expect(applyStereoMatrix(left, right, 0.5)[0]).toBeCloseTo(0.353_553_391, 9)
    expect(applyStereoMatrix(left, right, 0.5)[1]).toBeCloseTo(0.603_553_391, 9)
    expect(applyStereoMatrix(left, right, 1)[0]).toBeCloseTo(0, 12)
    expect(applyStereoMatrix(left, right, 1)[1]).toBeCloseTo(0.75, 12)
  })
})
