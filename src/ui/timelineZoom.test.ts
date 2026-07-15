import { describe, expect, it } from 'vitest'
import {
  calculateCentroidScrollLeft,
  calculateScrollLeftForAnchor,
  calculateTimelineZoom,
  clampTimelineZoom,
} from './timelineZoom'

const musicalViewportX = (
  ratio: number,
  contentWidth: number,
  headerWidth: number,
  scrollLeft: number,
): number => headerWidth + ratio * (contentWidth - headerWidth) - scrollLeft

describe('calculateTimelineZoom', () => {
  it('preserves the beat beneath an offset client centroid while zooming in', () => {
    const result = calculateTimelineZoom({
      centroidClientX: 740,
      viewportClientLeft: 100,
      scrollLeft: 240,
      clientWidth: 1000,
      contentWidth: 1500,
      headerWidth: 168,
      oldZoom: 1.5,
      newZoom: 2.5,
    })

    expect(result.zoom).toBe(2.5)
    expect(result.contentWidth).toBe(2500)
    expect(result.scrollLeft).toBeCloseTo(774.534535, 6)
    expect(musicalViewportX(result.anchorRatio, result.contentWidth, 168, result.scrollLeft))
      .toBeCloseTo(result.anchorViewportX, 9)
  })

  it('preserves the beat beneath the centroid while zooming out', () => {
    const result = calculateTimelineZoom({
      centroidClientX: 460,
      viewportClientLeft: 40,
      scrollLeft: 900,
      clientWidth: 960,
      contentWidth: 2400,
      headerWidth: 168,
      oldZoom: 3,
      newZoom: 2,
    })

    expect(result.contentWidth).toBe(1600)
    expect(musicalViewportX(result.anchorRatio, result.contentWidth, 168, result.scrollLeft))
      .toBeCloseTo(420, 9)
  })

  it('clamps zoom requests to the supported 1..3 range', () => {
    expect(clampTimelineZoom(-4)).toBe(1)
    expect(clampTimelineZoom(8)).toBe(3)

    const result = calculateTimelineZoom({
      centroidClientX: 500,
      viewportClientLeft: 0,
      scrollLeft: 0,
      clientWidth: 1000,
      contentWidth: 1000,
      headerWidth: 168,
      oldZoom: 0.5,
      newZoom: 8,
    })
    expect(result.zoom).toBe(3)
    expect(result.contentWidth).toBe(3000)
  })

  it('keeps beat zero at the timeline boundary when the centroid is over the header', () => {
    const result = calculateTimelineZoom({
      centroidClientX: 60,
      viewportClientLeft: 0,
      scrollLeft: 0,
      clientWidth: 1000,
      contentWidth: 1000,
      headerWidth: 168,
      oldZoom: 1,
      newZoom: 2,
    })

    expect(result.anchorRatio).toBe(0)
    expect(result.anchorViewportX).toBe(168)
    expect(result.scrollLeft).toBe(0)
  })

  it('clamps at both scroll edges when preservation is impossible', () => {
    const left = calculateCentroidScrollLeft({
      centroidClientX: 170,
      viewportClientLeft: 0,
      scrollLeft: 0,
      clientWidth: 1000,
      contentWidth: 2000,
      newContentWidth: 1000,
      headerWidth: 168,
    })
    expect(left.scrollLeft).toBe(0)

    const right = calculateCentroidScrollLeft({
      centroidClientX: 980,
      viewportClientLeft: 0,
      scrollLeft: 1000,
      clientWidth: 1000,
      contentWidth: 2000,
      newContentWidth: 1500,
      headerWidth: 168,
    })
    expect(right.scrollLeft).toBe(500)
  })

  it('uses an exact next content width for min-width constrained layouts', () => {
    const result = calculateTimelineZoom({
      centroidClientX: 300,
      viewportClientLeft: 0,
      scrollLeft: 100,
      clientWidth: 390,
      contentWidth: 650,
      headerWidth: 112,
      oldZoom: 1,
      newZoom: 2,
      newContentWidth: 780,
    })

    expect(result.contentWidth).toBe(780)
    expect(musicalViewportX(result.anchorRatio, 780, 112, result.scrollLeft))
      .toBeCloseTo(result.anchorViewportX, 9)
  })

  it('keeps the captured beat under a translated gesture centroid', () => {
    const scrollLeft = calculateScrollLeftForAnchor({
      anchorRatio: 0.4,
      anchorViewportX: 520,
      clientWidth: 900,
      newContentWidth: 1800,
      headerWidth: 168,
    })

    expect(musicalViewportX(0.4, 1800, 168, scrollLeft)).toBeCloseTo(520, 9)
  })

  it('rejects impossible or non-finite geometry', () => {
    expect(() => calculateCentroidScrollLeft({
      centroidClientX: Number.NaN,
      viewportClientLeft: 0,
      scrollLeft: 0,
      clientWidth: 100,
      contentWidth: 200,
      newContentWidth: 300,
      headerWidth: 50,
    })).toThrow('centroidClientX must be finite')

    expect(() => calculateCentroidScrollLeft({
      centroidClientX: 50,
      viewportClientLeft: 0,
      scrollLeft: 0,
      clientWidth: 100,
      contentWidth: 50,
      newContentWidth: 300,
      headerWidth: 50,
    })).toThrow('contentWidth must include a non-empty musical timeline')
  })
})
