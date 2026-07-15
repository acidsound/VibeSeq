export const MIN_TIMELINE_ZOOM = 1
export const MAX_TIMELINE_ZOOM = 3

export type TimelineViewportGeometry = {
  /** Gesture centroid in viewport/client coordinates (for example, Touch.clientX). */
  centroidClientX: number
  /** Left edge of the scroll viewport from getBoundingClientRect().left. */
  viewportClientLeft: number
  /** Current horizontal scroll offset of the viewport. */
  scrollLeft: number
  /** Visible width of the scroll viewport. */
  clientWidth: number
  /** Current full width of the timeline stage, including the track header. */
  contentWidth: number
  /** Non-musical track-header width at the start of the timeline stage. */
  headerWidth: number
}

export type CentroidScrollRequest = TimelineViewportGeometry & {
  /** Exact full stage width after layout applies the new zoom. */
  newContentWidth: number
}

export type CentroidScrollResult = {
  scrollLeft: number
  /** Normalized musical position under the effective gesture anchor. */
  anchorRatio: number
  /** Effective anchor relative to the viewport's left edge. */
  anchorViewportX: number
}

export type TimelineAnchorRequest = {
  /** Normalized 0..1 musical position captured when the gesture started. */
  anchorRatio: number
  /** Current gesture centroid relative to the scroll viewport's left edge. */
  anchorViewportX: number
  clientWidth: number
  newContentWidth: number
  headerWidth: number
}

export type TimelineZoomRequest = TimelineViewportGeometry & {
  oldZoom: number
  newZoom: number
  /**
   * Exact next stage width, when known. Prefer this for layouts with min-width.
   * Otherwise the current width is scaled by the clamped zoom ratio.
   */
  newContentWidth?: number
}

export type TimelineZoomResult = CentroidScrollResult & {
  zoom: number
  contentWidth: number
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value))

const finite = (value: number, name: string): number => {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`)
  return value
}

const validateGeometry = ({
  centroidClientX,
  viewportClientLeft,
  scrollLeft,
  clientWidth,
  contentWidth,
  headerWidth,
}: TimelineViewportGeometry): void => {
  finite(centroidClientX, 'centroidClientX')
  finite(viewportClientLeft, 'viewportClientLeft')
  finite(scrollLeft, 'scrollLeft')
  finite(clientWidth, 'clientWidth')
  finite(contentWidth, 'contentWidth')
  finite(headerWidth, 'headerWidth')
  if (clientWidth <= 0) throw new RangeError('clientWidth must be greater than zero')
  if (headerWidth < 0) throw new RangeError('headerWidth cannot be negative')
  if (contentWidth <= headerWidth) {
    throw new RangeError('contentWidth must include a non-empty musical timeline')
  }
}

export const clampTimelineZoom = (zoom: number): number =>
  clamp(finite(zoom, 'zoom'), MIN_TIMELINE_ZOOM, MAX_TIMELINE_ZOOM)

/** Resolves a previously captured musical anchor against a new layout width. */
export function calculateScrollLeftForAnchor({
  anchorRatio,
  anchorViewportX,
  clientWidth,
  newContentWidth,
  headerWidth,
}: TimelineAnchorRequest): number {
  finite(anchorRatio, 'anchorRatio')
  finite(anchorViewportX, 'anchorViewportX')
  finite(clientWidth, 'clientWidth')
  finite(newContentWidth, 'newContentWidth')
  finite(headerWidth, 'headerWidth')
  if (clientWidth <= 0) throw new RangeError('clientWidth must be greater than zero')
  if (headerWidth < 0 || newContentWidth <= headerWidth) {
    throw new RangeError('newContentWidth must include a non-empty musical timeline')
  }
  const ratio = clamp(anchorRatio, 0, 1)
  const viewportX = clamp(anchorViewportX, 0, clientWidth)
  const target = headerWidth + ratio * (newContentWidth - headerWidth) - viewportX
  return clamp(target, 0, Math.max(0, newContentWidth - clientWidth))
}

/**
 * Calculates the scroll offset that keeps the same musical position beneath a
 * gesture centroid as the stage width changes. If the gesture is over a visible
 * track header, beat zero (the timeline boundary) is used as the anchor instead.
 * Scroll-bound clamping wins at either edge, where exact preservation is
 * geometrically impossible.
 */
export function calculateCentroidScrollLeft({
  centroidClientX,
  viewportClientLeft,
  scrollLeft,
  clientWidth,
  contentWidth,
  newContentWidth,
  headerWidth,
}: CentroidScrollRequest): CentroidScrollResult {
  const geometry = {
    centroidClientX,
    viewportClientLeft,
    scrollLeft,
    clientWidth,
    contentWidth,
    headerWidth,
  }
  validateGeometry(geometry)
  finite(newContentWidth, 'newContentWidth')
  if (newContentWidth <= headerWidth) {
    throw new RangeError('newContentWidth must include a non-empty musical timeline')
  }

  const oldMaximumScroll = Math.max(0, contentWidth - clientWidth)
  const currentScrollLeft = clamp(scrollLeft, 0, oldMaximumScroll)
  const rawCentroidViewportX = clamp(centroidClientX - viewportClientLeft, 0, clientWidth)
  const timelineStartViewportX = headerWidth - currentScrollLeft
  const timelineEndViewportX = contentWidth - currentScrollLeft
  const anchorViewportX = clamp(
    rawCentroidViewportX,
    Math.min(clientWidth, Math.max(0, timelineStartViewportX)),
    Math.min(clientWidth, Math.max(0, timelineEndViewportX)),
  )
  const oldTimelineWidth = contentWidth - headerWidth
  const anchorContentX = currentScrollLeft + anchorViewportX
  const anchorRatio = clamp((anchorContentX - headerWidth) / oldTimelineWidth, 0, 1)
  return {
    scrollLeft: calculateScrollLeftForAnchor({ anchorRatio, anchorViewportX, clientWidth, newContentWidth, headerWidth }),
    anchorRatio,
    anchorViewportX,
  }
}

/**
 * DOM-friendly zoom calculation. Pass newContentWidth when CSS constraints make
 * the post-zoom stage width differ from contentWidth * newZoom / oldZoom.
 */
export function calculateTimelineZoom(request: TimelineZoomRequest): TimelineZoomResult {
  validateGeometry(request)
  const oldZoom = clampTimelineZoom(request.oldZoom)
  const zoom = clampTimelineZoom(request.newZoom)
  const contentWidth = request.newContentWidth === undefined
    ? Math.max(request.clientWidth, (request.contentWidth / oldZoom) * zoom)
    : finite(request.newContentWidth, 'newContentWidth')
  const centroid = calculateCentroidScrollLeft({ ...request, newContentWidth: contentWidth })

  return { ...centroid, zoom, contentWidth }
}
