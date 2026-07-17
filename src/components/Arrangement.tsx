import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, AudioLines, Link2, Music2, Redo2, Repeat2, Undo2, VolumeX } from 'lucide-react'
import { getArrangedMidiNotes, getAudioSourceDurationBeats, getClipSourceSlices, positiveModulo, secondsToBeats, snapBeat } from '../core'
import type { ArrangedMidiNote, ClipSourceSlice } from '../core'
import type { AudioAsset, Clip, ClipSourceLoop, Project, Track, TrackKind } from '../types'
import { findAsset, findClip, findClipCollision, findCompatibleTrackId, getArrangementTimelineBeats, MIN_TIMELINE_BARS, waveformPath } from '../ui/music'
import { calculateCentroidScrollLeft, calculateScrollLeftForAnchor, clampTimelineZoom } from '../ui/timelineZoom'
import { clearAudioSourceDrag, hasAudioSourceDrag, readAudioSourceDrag, type AudioSourceDragPayload } from '../ui/sourceDrag'
import { AddTrackButtons } from './AddTrackButtons'

type ClipEdit = { startBeat?: number; durationBeats?: number; offsetBeats?: number; sourceLoop?: ClipSourceLoop }

const sourceDurationBeatsForClip = (
  clip: Clip,
  asset: AudioAsset,
  projectBpm: number,
): number => clip.kind === 'audio'
  ? getAudioSourceDurationBeats(clip, asset)
  : secondsToBeats(asset.durationSeconds, projectBpm)

type ArrangementProps = {
  project: Project
  selectedClipId: string | null
  selectedTrackId: string | null
  revealRequest?: ArrangementRevealRequest | null
  playheadBeat: number
  zoom: number
  snapping: boolean
  snapDivision?: number
  trackLevels: Record<string, number>
  canUndo: boolean
  canRedo: boolean
  onSelectClip: (clipId: string, trackId: string) => void
  onSelectTrack: (trackId: string) => void
  onSeek: (beat: number) => void
  onEditClip: (trackId: string, clipId: string, edit: ClipEdit) => void
  onMoveClip: (sourceTrackId: string, targetTrackId: string, clipId: string, startBeat: number) => void
  onOpenClipDetail: (clipId: string, trackId: string) => void
  onOpenClipCommands: (clipId: string, trackId: string, anchor: { x: number; y: number }) => void
  onToggleTrack: (trackId: string, field: 'mute' | 'solo') => void
  onTrackGain: (trackId: string, gain: number) => void
  onMoveTrack: (trackId: string, direction: 'up' | 'down') => void
  onAddTrack: (kind: TrackKind) => void
  onToggleLoop: () => void
  onEditLoop: (startBeat: number, endBeat: number) => void
  onUndo: () => void
  onRedo: () => void
  onZoomChange: (zoom: number) => void
  onDropAudioSource: (payload: AudioSourceDragPayload, trackId: string, startBeat: number) => void
}

type DragState = {
  interactionId: number
  pointerId: number
  pointerTarget: Element
  mode: 'move' | 'trim-start' | 'trim-end' | 'loop-end' | 'cycle-end'
  trackId: string
  clipId: string
  clipKind: Clip['kind']
  pointerType: string
  originX: number
  originY: number
  width: number
  startBeat: number
  durationBeats: number
  offsetBeats: number
  sourceLoop?: ClipSourceLoop
  sourceCycleMax: number
  previewStart: number
  previewDuration: number
  previewOffset: number
  previewCycleLength: number
  previewTranslateY: number
  targetTrackId: string | null
  dropStatus: 'source' | 'valid' | 'invalid' | 'collision' | 'outside'
  hasMoved: boolean
}

type PinchGesture = {
  pointerIds: [number, number]
  pointerTarget: Element
  startDistance: number
  startZoom: number
  lastZoom: number
  anchorRatio: number
  anchorOffset: number
}

type LoopDragState = {
  interactionId: number
  pointerId: number
  pointerTarget: Element
  mode: 'start' | 'end' | 'move'
  originX: number
  width: number
  startBeat: number
  endBeat: number
  previewStart: number
  previewEnd: number
}

type RulerScrub = {
  pointerId: number
  pointerTarget: Element
}

const capturePointer = (target: Element, pointerId: number) => {
  try {
    target.setPointerCapture?.(pointerId)
  } catch {
    // Browsers can reject capture when a pointer was already cancelled.
  }
}

const releasePointer = (target: Element, pointerId: number) => {
  try {
    if (target.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId)
  } catch {
    // Lost capture and unmount can race; the gesture is already cancelled.
  }
}

export type ArrangementRevealRequest = {
  clipId: string
  requestId: number
}

export type RenderableWaveformSlice = {
  placementStartBeat: number
  durationBeats: number
  viewStart: number
  viewWidth: number
}

/** Intersects a source read with the real asset so out-of-range audio stays visually silent. */
export function getRenderableWaveformSlice(
  slice: ClipSourceSlice,
  sourceDurationBeats: number,
): RenderableWaveformSlice | null {
  if (!Number.isFinite(sourceDurationBeats) || sourceDurationBeats <= 0) return null
  const sourceEndBeat = slice.sourceStartBeat + slice.durationBeats
  const validSourceStartBeat = Math.max(0, slice.sourceStartBeat)
  const validSourceEndBeat = Math.min(sourceDurationBeats, sourceEndBeat)
  const validDurationBeats = validSourceEndBeat - validSourceStartBeat
  if (validDurationBeats <= 0) return null

  return {
    placementStartBeat: slice.placementStartBeat + (validSourceStartBeat - slice.sourceStartBeat),
    durationBeats: validDurationBeats,
    viewStart: (validSourceStartBeat / sourceDurationBeats) * 1000,
    viewWidth: (validDurationBeats / sourceDurationBeats) * 1000,
  }
}

/**
 * Collapses an arbitrary note count into one bounded SVG path. Arrangement
 * thumbnails communicate density and contour; individual editable note DOM
 * nodes belong only in the Detail editor.
 */
export function midiThumbnailPath(
  instances: ArrangedMidiNote[],
  clipStartBeat: number,
  clipDurationBeats: number,
  minPitch: number,
  maxPitch: number,
  columns = 96,
  rows = 16,
): string {
  if (
    instances.length === 0
    || !Number.isFinite(clipDurationBeats)
    || clipDurationBeats <= 0
    || !Number.isInteger(columns)
    || !Number.isInteger(rows)
    || columns <= 0
    || rows <= 0
  ) return ''

  const occupied = new Uint8Array(columns * rows)
  const pitchSpan = Math.max(1, maxPitch - minPitch)
  for (const instance of instances) {
    const relativeStart = (instance.startBeat - clipStartBeat) / clipDurationBeats
    const relativeEnd = (instance.startBeat + instance.durationBeats - clipStartBeat) / clipDurationBeats
    if (relativeEnd <= 0 || relativeStart >= 1) continue
    const firstColumn = Math.max(0, Math.min(columns - 1, Math.floor(relativeStart * columns)))
    const lastColumn = Math.max(firstColumn, Math.min(columns - 1, Math.ceil(relativeEnd * columns) - 1))
    const pitchRatio = (maxPitch - instance.note.pitch) / pitchSpan
    const row = Math.max(0, Math.min(rows - 1, Math.round(pitchRatio * (rows - 1))))
    for (let column = firstColumn; column <= lastColumn; column += 1) {
      occupied[row * columns + column] = 1
    }
  }

  const cellWidth = 1000 / columns
  const cellHeight = 100 / rows
  const noteHeight = Math.max(1.5, cellHeight * 0.62)
  const commands: string[] = []
  for (let row = 0; row < rows; row += 1) {
    let column = 0
    while (column < columns) {
      if (occupied[row * columns + column] === 0) {
        column += 1
        continue
      }
      const runStart = column
      while (column < columns && occupied[row * columns + column] === 1) column += 1
      const x = runStart * cellWidth
      const y = row * cellHeight + (cellHeight - noteHeight) / 2
      const width = Math.max(1.5, (column - runStart) * cellWidth - 0.75)
      commands.push(`M${x.toFixed(2)} ${y.toFixed(2)}h${width.toFixed(2)}v${noteHeight.toFixed(2)}h-${width.toFixed(2)}Z`)
    }
  }
  return commands.join('')
}

export function Arrangement({
  project,
  selectedClipId,
  selectedTrackId,
  revealRequest,
  playheadBeat,
  zoom,
  snapping,
  snapDivision = 0.25,
  trackLevels,
  canUndo,
  canRedo,
  onSelectClip,
  onSelectTrack,
  onSeek,
  onEditClip,
  onMoveClip,
  onOpenClipDetail,
  onOpenClipCommands,
  onToggleTrack,
  onTrackGain,
  onMoveTrack,
  onAddTrack,
  onToggleLoop,
  onEditLoop,
  onUndo,
  onRedo,
  onZoomChange,
  onDropAudioSource,
}: ArrangementProps) {
  const timelineRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const rulerCornerRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<DragState | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const [loopDrag, setLoopDrag] = useState<LoopDragState | null>(null)
  const loopDragRef = useRef(loopDrag)
  const rulerScrubRef = useRef<RulerScrub | null>(null)
  const activePointersRef = useRef(new Map<number, { x: number; y: number }>())
  const pinchRef = useRef<PinchGesture | null>(null)
  const pendingAnchorRef = useRef<{ ratio: number; viewportX: number } | null>(null)
  const wheelGestureFrameRef = useRef<number | null>(null)
  const gestureSequenceRef = useRef(0)
  const cancelActiveGesturesRef = useRef<(updateState?: boolean) => void>(() => {})
  const [stageBaseWidth, setStageBaseWidth] = useState(0)
  const [gestureZooming, setGestureZooming] = useState(false)
  const touchTapRef = useRef<{ clipId: string; at: number } | null>(null)
  const longPressRef = useRef<{ timer: number; clipId: string; trackId: string; x: number; y: number } | null>(null)
  const selected = findClip(project, selectedClipId)
  const barBeats = (project.timeSignature.numerator * 4) / project.timeSignature.denominator
  const timelineBeats = useMemo(
    () => getArrangementTimelineBeats(project, playheadBeat),
    [playheadBeat, project],
  )
  const rulerMarks = useMemo(
    () => Array.from({ length: Math.floor(timelineBeats / barBeats) + 1 }, (_, index) => index * barBeats),
    [barBeats, timelineBeats],
  )

  useLayoutEffect(() => {
    if (!revealRequest) return
    const clipElement = [...(stageRef.current?.querySelectorAll<HTMLElement>('.timeline-clip[data-clip-id]') ?? [])]
      .find((element) => element.dataset.clipId === revealRequest.clipId)
    if (!clipElement) return
    clipElement.scrollIntoView?.({ behavior: 'auto', block: 'center', inline: 'center' })
    clipElement.querySelector<HTMLButtonElement>('.clip-body-control')?.focus({ preventScroll: true })
  }, [revealRequest])

  const clearLongPress = () => {
    if (!longPressRef.current) return
    window.clearTimeout(longPressRef.current.timer)
    longPressRef.current = null
  }

  const cancelActiveGestures = (updateState = true) => {
    clearLongPress()
    const activeDrag = dragRef.current
    const activeLoopDrag = loopDragRef.current
    const activePinch = pinchRef.current
    const activeRulerScrub = rulerScrubRef.current
    dragRef.current = null
    loopDragRef.current = null
    pinchRef.current = null
    rulerScrubRef.current = null
    activePointersRef.current.clear()
    pendingAnchorRef.current = null
    touchTapRef.current = null
    if (wheelGestureFrameRef.current !== null) {
      window.cancelAnimationFrame(wheelGestureFrameRef.current)
      wheelGestureFrameRef.current = null
    }
    if (activeDrag) releasePointer(activeDrag.pointerTarget, activeDrag.pointerId)
    if (activeLoopDrag) releasePointer(activeLoopDrag.pointerTarget, activeLoopDrag.pointerId)
    if (activePinch) activePinch.pointerIds.forEach((pointerId) => releasePointer(activePinch.pointerTarget, pointerId))
    if (activeRulerScrub) releasePointer(activeRulerScrub.pointerTarget, activeRulerScrub.pointerId)
    if (!updateState) return
    setDrag(null)
    setLoopDrag(null)
    setGestureZooming(false)
  }
  cancelActiveGesturesRef.current = cancelActiveGestures

  useLayoutEffect(() => {
    const scroll = scrollRef.current
    const stage = stageRef.current
    if (!scroll || !stage) return
    const measure = () => {
      const minimum = Number.parseFloat(window.getComputedStyle(stage).minWidth)
      const next = Math.max(scroll.clientWidth, Number.isFinite(minimum) ? minimum : 0)
      setStageBaseWidth((current) => Math.abs(current - next) < 0.5 ? current : next)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(scroll)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    const pending = pendingAnchorRef.current
    const scroll = scrollRef.current
    const stage = stageRef.current
    const header = rulerCornerRef.current
    if (!pending || !scroll || !stage || !header) return
    scroll.scrollLeft = calculateScrollLeftForAnchor({
      anchorRatio: pending.ratio,
      anchorViewportX: pending.viewportX,
      clientWidth: scroll.clientWidth,
      newContentWidth: stage.getBoundingClientRect().width,
      headerWidth: header.getBoundingClientRect().width,
    })
    pendingAnchorRef.current = null
  }, [gestureZooming, stageBaseWidth, zoom])

  useEffect(() => {
    const cancel = () => cancelActiveGesturesRef.current()
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') cancel()
    }
    const onLostPointerCapture = (event: Event) => {
      const pointerId = (event as PointerEvent).pointerId
      const target = event.target
      const activeDrag = dragRef.current
      const activeLoopDrag = loopDragRef.current
      const activePinch = pinchRef.current
      const lostOwnedPointer = (
        activeDrag?.pointerTarget === target && activeDrag.pointerId === pointerId
      ) || (
        activeLoopDrag?.pointerTarget === target && activeLoopDrag.pointerId === pointerId
      ) || (
        activePinch?.pointerTarget === target && activePinch.pointerIds.includes(pointerId)
      )
      if (lostOwnedPointer) cancel()
    }
    const scroll = scrollRef.current
    window.addEventListener('blur', cancel)
    document.addEventListener('visibilitychange', onVisibilityChange)
    scroll?.addEventListener('lostpointercapture', onLostPointerCapture)
    return () => {
      window.removeEventListener('blur', cancel)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      scroll?.removeEventListener('lostpointercapture', onLostPointerCapture)
      cancelActiveGesturesRef.current(false)
    }
  }, [])

  useEffect(() => {
    if (!drag) return
    const onMove = (event: PointerEvent) => {
      if (event.pointerId !== drag.pointerId || dragRef.current?.interactionId !== drag.interactionId) return
      if (pinchRef.current) return
      const deltaX = event.clientX - drag.originX
      const deltaY = event.clientY - drag.originY
      if (Math.hypot(deltaX, deltaY) > 8) clearLongPress()
      const deltaBeat = (deltaX / drag.width) * timelineBeats
      setDrag((current) => {
        if (!current) return current
        const movement = current.mode === 'move' ? Math.hypot(deltaX, deltaY) : Math.abs(deltaX)
        const threshold = current.pointerType === 'touch' ? 6 : 3
        if (!current.hasMoved && movement < threshold) return current
        const quantize = (value: number) => snapping ? snapBeat(value, snapDivision) : value
        let next: DragState
        if (current.mode === 'move') {
          const rows = [...document.querySelectorAll<HTMLElement>('.track-row[data-track-id]')]
          const sourceRow = rows.find((row) => row.dataset.trackId === current.trackId)
          const targetRow = rows.find((row) => {
            const bounds = row.getBoundingClientRect()
            return event.clientY >= bounds.top && event.clientY <= bounds.bottom
          })
          const targetTrackId = targetRow?.dataset.trackId ?? null
          const targetTrack = project.tracks.find((track) => track.id === targetTrackId)
          const previewStart = Math.max(0, quantize(current.startBeat + deltaBeat))
          let dropStatus: DragState['dropStatus'] = !targetTrack
            ? 'outside'
            : targetTrack.kind !== current.clipKind
              ? 'invalid'
              : targetTrack.id === current.trackId ? 'source' : 'valid'
          if (targetTrack && (dropStatus === 'source' || dropStatus === 'valid') && findClipCollision(targetTrack, current.clipId, previewStart, current.durationBeats)) {
            dropStatus = 'collision'
          }
          const previewTranslateY = sourceRow && targetRow
            ? targetRow.getBoundingClientRect().top - sourceRow.getBoundingClientRect().top
            : deltaY
          next = {
            ...current,
            previewStart,
            previewTranslateY,
            targetTrackId,
            dropStatus,
            hasMoved: true,
          }
        } else if (current.mode === 'trim-end' || current.mode === 'loop-end') {
          const previewDuration = Math.max(0.25, quantize(current.durationBeats + deltaBeat))
          const sourceTrack = project.tracks.find((track) => track.id === current.trackId)
          next = {
            ...current,
            previewDuration,
            dropStatus: sourceTrack && findClipCollision(sourceTrack, current.clipId, current.startBeat, previewDuration) ? 'collision' : 'source',
            hasMoved: true,
          }
        } else if (current.mode === 'cycle-end') {
          const minimum = (current.sourceLoop?.phaseBeats ?? 0) + 0.25
          next = {
            ...current,
            previewCycleLength: Math.min(current.sourceCycleMax, Math.max(minimum, quantize((current.sourceLoop?.cycleLengthBeats ?? minimum) + deltaBeat))),
            hasMoved: true,
          }
        } else {
          const maxDelta = current.durationBeats - 0.25
          const adjusted = Math.max(-current.offsetBeats, Math.min(maxDelta, deltaBeat))
          const nextStart = quantize(current.startBeat + adjusted)
          const actualDelta = nextStart - current.startBeat
          const previewDuration = Math.max(0.25, current.durationBeats - actualDelta)
          const sourceTrack = project.tracks.find((track) => track.id === current.trackId)
          next = {
            ...current,
            previewStart: Math.max(0, nextStart),
            previewDuration,
            previewOffset: Math.max(0, current.offsetBeats + actualDelta),
            dropStatus: sourceTrack && findClipCollision(sourceTrack, current.clipId, Math.max(0, nextStart), previewDuration) ? 'collision' : 'source',
            hasMoved: true,
          }
        }
        dragRef.current = next
        return next
      })
    }
    const onUp = (event: PointerEvent) => {
      if (event.pointerId !== drag.pointerId || dragRef.current?.interactionId !== drag.interactionId) return
      clearLongPress()
      const current = dragRef.current
      dragRef.current = null
      setDrag(null)
      if (!current) return
      releasePointer(current.pointerTarget, current.pointerId)
      if (!current.hasMoved) {
        if (current.pointerType === 'touch') {
          const previousTap = touchTapRef.current
          const now = performance.now()
          if (previousTap?.clipId === current.clipId && now - previousTap.at <= 450) {
            touchTapRef.current = null
            onOpenClipDetail(current.clipId, current.trackId)
          } else {
            touchTapRef.current = { clipId: current.clipId, at: now }
          }
        }
        return
      }
      touchTapRef.current = null
      if (current.dropStatus === 'collision') return
      if (current.mode === 'move') {
        if ((current.dropStatus === 'source' || current.dropStatus === 'valid') && current.targetTrackId) {
          onMoveClip(current.trackId, current.targetTrackId, current.clipId, current.previewStart)
        }
        return
      }
      if (current.mode === 'cycle-end' && current.sourceLoop && current.previewCycleLength !== current.sourceLoop.cycleLengthBeats) {
        onEditClip(current.trackId, current.clipId, {
          sourceLoop: {
            ...current.sourceLoop,
            cycleLengthBeats: current.previewCycleLength,
            phaseBeats: positiveModulo(current.sourceLoop.phaseBeats, current.previewCycleLength),
          },
        })
        return
      }
      if (
        current.previewStart !== current.startBeat
        || current.previewDuration !== current.durationBeats
        || current.previewOffset !== current.offsetBeats
      ) {
        onEditClip(current.trackId, current.clipId, {
          startBeat: current.previewStart,
          durationBeats: current.previewDuration,
          offsetBeats: current.previewOffset,
          ...(current.mode === 'trim-start' && current.sourceLoop ? {
            sourceLoop: {
              ...current.sourceLoop,
              phaseBeats: positiveModulo(
                current.sourceLoop.phaseBeats + current.previewStart - current.startBeat,
                current.sourceLoop.cycleLengthBeats,
              ),
            },
          } : {}),
        })
      }
    }
    const onCancel = (event: PointerEvent) => {
      if (event.pointerId !== drag.pointerId) return
      cancelActiveGesturesRef.current()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      cancelActiveGesturesRef.current()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [drag?.clipId, drag?.interactionId, drag?.mode, drag?.originX, drag?.originY, drag?.pointerId, drag?.width, onEditClip, onMoveClip, onOpenClipDetail, project.tracks, snapDivision, snapping, timelineBeats])

  useEffect(() => {
    if (!loopDrag) return
    const onMove = (event: PointerEvent) => {
      if (event.pointerId !== loopDrag.pointerId || loopDragRef.current?.interactionId !== loopDrag.interactionId) return
      if (pinchRef.current) return
      setLoopDrag((current) => {
        if (!current) return current
        const rawDelta = ((event.clientX - current.originX) / current.width) * timelineBeats
        const delta = snapping ? snapBeat(rawDelta, snapDivision) : rawDelta
        let previewStart = current.startBeat
        let previewEnd = current.endBeat
        if (current.mode === 'start') previewStart = Math.max(0, Math.min(current.endBeat - 0.25, current.startBeat + delta))
        else if (current.mode === 'end') previewEnd = Math.min(timelineBeats, Math.max(current.startBeat + 0.25, current.endBeat + delta))
        else {
          const duration = current.endBeat - current.startBeat
          previewStart = Math.max(0, Math.min(timelineBeats - duration, current.startBeat + delta))
          previewEnd = previewStart + duration
        }
        const next = { ...current, previewStart, previewEnd }
        loopDragRef.current = next
        return next
      })
    }
    const onUp = (event: PointerEvent) => {
      if (event.pointerId !== loopDrag.pointerId || loopDragRef.current?.interactionId !== loopDrag.interactionId) return
      const current = loopDragRef.current
      loopDragRef.current = null
      setLoopDrag(null)
      if (current) {
        releasePointer(current.pointerTarget, current.pointerId)
        onEditLoop(current.previewStart, current.previewEnd)
      }
    }
    const onCancel = (event: PointerEvent) => {
      if (event.pointerId !== loopDrag.pointerId) return
      cancelActiveGesturesRef.current()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    return () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); window.removeEventListener('pointercancel', onCancel) }
  }, [loopDrag?.interactionId, loopDrag?.mode, loopDrag?.pointerId, onEditLoop, snapDivision, snapping, timelineBeats])

  const beginLoopDrag = (event: React.PointerEvent, mode: 'start' | 'end' | 'move') => {
    if (pinchRef.current) return
    event.preventDefault()
    event.stopPropagation()
    const width = timelineRef.current?.getBoundingClientRect().width ?? 1
    capturePointer(event.currentTarget, event.pointerId)
    const next: LoopDragState = {
      interactionId: ++gestureSequenceRef.current,
      pointerId: event.pointerId,
      pointerTarget: event.currentTarget,
      mode,
      originX: event.clientX,
      width,
      startBeat: project.loop.startBeat,
      endBeat: project.loop.endBeat,
      previewStart: project.loop.startBeat,
      previewEnd: project.loop.endBeat,
    }
    loopDragRef.current = next
    setLoopDrag(next)
  }

  const beginDrag = (event: React.PointerEvent, track: Track, clip: Clip, mode: DragState['mode']) => {
    if (pinchRef.current) return
    if (event.pointerType === 'mouse' && event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget instanceof HTMLElement && event.currentTarget.focus({ preventScroll: true })
    onSelectClip(clip.id, track.id)
    const width = timelineRef.current?.getBoundingClientRect().width ?? 1
    const asset = findAsset(project, clip.assetId)
    const sourceCycleMax = clip.sourceLoop && asset
      ? Math.max(clip.sourceLoop.cycleLengthBeats, sourceDurationBeatsForClip(clip, asset, project.bpm) - clip.sourceLoop.cycleStartBeat)
      : clip.sourceLoop?.cycleLengthBeats ?? clip.durationBeats
    const nextDrag: DragState = {
      interactionId: ++gestureSequenceRef.current,
      pointerId: event.pointerId,
      pointerTarget: event.currentTarget,
      mode,
      trackId: track.id,
      clipId: clip.id,
      clipKind: clip.kind,
      pointerType: event.pointerType,
      originX: event.clientX,
      originY: event.clientY,
      width,
      startBeat: clip.startBeat,
      durationBeats: clip.durationBeats,
      offsetBeats: clip.offsetBeats,
      sourceLoop: clip.sourceLoop ? { ...clip.sourceLoop } : undefined,
      sourceCycleMax,
      previewStart: clip.startBeat,
      previewDuration: clip.durationBeats,
      previewOffset: clip.offsetBeats,
      previewCycleLength: clip.sourceLoop?.cycleLengthBeats ?? clip.durationBeats,
      previewTranslateY: 0,
      targetTrackId: track.id,
      dropStatus: 'source',
      hasMoved: false,
    }
    capturePointer(event.currentTarget, event.pointerId)
    dragRef.current = nextDrag
    setDrag(nextDrag)
    if (event.pointerType === 'touch') {
      clearLongPress()
      const x = event.clientX
      const y = event.clientY
      const timer = window.setTimeout(() => {
        cancelActiveGesturesRef.current()
        onSelectClip(clip.id, track.id)
        onOpenClipCommands(clip.id, track.id, { x, y })
      }, 550)
      longPressRef.current = { timer, clipId: clip.id, trackId: track.id, x, y }
    }
  }

  const seekFromClientX = (clientX: number) => {
    const bounds = timelineRef.current?.getBoundingClientRect()
    if (!bounds?.width) return
    const beat = Math.max(0, Math.min(timelineBeats, ((clientX - bounds.left) / bounds.width) * timelineBeats))
    onSeek(snapping ? snapBeat(beat, snapDivision) : beat)
  }

  const beginRulerScrub = (event: React.PointerEvent<HTMLDivElement>) => {
    if (pinchRef.current || rulerScrubRef.current) return
    if (event.pointerType === 'mouse' && event.button !== 0) return
    event.preventDefault()
    capturePointer(event.currentTarget, event.pointerId)
    rulerScrubRef.current = { pointerId: event.pointerId, pointerTarget: event.currentTarget }
    seekFromClientX(event.clientX)
  }

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      if (rulerScrubRef.current?.pointerId !== event.pointerId || pinchRef.current) return
      seekFromClientX(event.clientX)
    }
    const finish = (event: PointerEvent) => {
      const active = rulerScrubRef.current
      if (!active || active.pointerId !== event.pointerId) return
      if (event.type === 'pointerup') seekFromClientX(event.clientX)
      rulerScrubRef.current = null
      releasePointer(active.pointerTarget, active.pointerId)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
    }
  }, [onSeek, snapDivision, snapping, timelineBeats])

  const gestureGeometry = (centroidClientX: number) => {
    const scroll = scrollRef.current
    const stage = stageRef.current
    const header = rulerCornerRef.current
    if (!scroll || !stage || !header) return null
    const viewportBounds = scroll.getBoundingClientRect()
    const contentWidth = stage.getBoundingClientRect().width
    const headerWidth = header.getBoundingClientRect().width
    if (scroll.clientWidth <= 0 || contentWidth <= headerWidth) return null
    const result = calculateCentroidScrollLeft({
      centroidClientX,
      viewportClientLeft: viewportBounds.left,
      scrollLeft: scroll.scrollLeft,
      clientWidth: scroll.clientWidth,
      contentWidth,
      newContentWidth: contentWidth,
      headerWidth,
    })
    return { scroll, stage, headerWidth, viewportBounds, ...result }
  }

  const beginPinch = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'touch') return
    activePointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (activePointersRef.current.size !== 2 || pinchRef.current) return
    const pointers = [...activePointersRef.current.entries()]
    const [[firstId, first], [secondId, second]] = pointers
    const distance = Math.hypot(second.x - first.x, second.y - first.y)
    if (distance < 8) return
    const centroidClientX = (first.x + second.x) / 2
    const geometry = gestureGeometry(centroidClientX)
    if (!geometry) return
    const rawViewportX = Math.max(0, Math.min(geometry.scroll.clientWidth, centroidClientX - geometry.viewportBounds.left))
    pinchRef.current = {
      pointerIds: [firstId, secondId],
      pointerTarget: event.currentTarget,
      startDistance: distance,
      startZoom: zoom,
      lastZoom: zoom,
      anchorRatio: geometry.anchorRatio,
      anchorOffset: geometry.anchorViewportX - rawViewportX,
    }
    clearLongPress()
    const interruptedDrag = dragRef.current
    const interruptedLoopDrag = loopDragRef.current
    dragRef.current = null
    loopDragRef.current = null
    if (interruptedDrag) releasePointer(interruptedDrag.pointerTarget, interruptedDrag.pointerId)
    if (interruptedLoopDrag) releasePointer(interruptedLoopDrag.pointerTarget, interruptedLoopDrag.pointerId)
    setDrag(null)
    setLoopDrag(null)
    setGestureZooming(true)
    for (const pointerId of [firstId, secondId]) {
      capturePointer(event.currentTarget, pointerId)
    }
    event.preventDefault()
    event.stopPropagation()
  }

  const movePinch = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'touch' || !activePointersRef.current.has(event.pointerId)) return
    activePointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    const gesture = pinchRef.current
    if (!gesture) return
    const first = activePointersRef.current.get(gesture.pointerIds[0])
    const second = activePointersRef.current.get(gesture.pointerIds[1])
    const scroll = scrollRef.current
    const stage = stageRef.current
    const header = rulerCornerRef.current
    if (!first || !second || !scroll || !stage || !header) return
    const distance = Math.hypot(second.x - first.x, second.y - first.y)
    const nextZoom = clampTimelineZoom(gesture.startZoom * (distance / gesture.startDistance))
    const bounds = scroll.getBoundingClientRect()
    const rawViewportX = (first.x + second.x) / 2 - bounds.left
    const viewportX = Math.max(0, Math.min(scroll.clientWidth, rawViewportX + gesture.anchorOffset))
    const headerWidth = header.getBoundingClientRect().width
    scroll.scrollLeft = calculateScrollLeftForAnchor({
      anchorRatio: gesture.anchorRatio,
      anchorViewportX: viewportX,
      clientWidth: scroll.clientWidth,
      newContentWidth: stage.getBoundingClientRect().width,
      headerWidth,
    })
    pendingAnchorRef.current = { ratio: gesture.anchorRatio, viewportX }
    if (Math.abs(nextZoom - gesture.lastZoom) >= 0.001) {
      gesture.lastZoom = nextZoom
      onZoomChange(nextZoom)
    }
    event.preventDefault()
    event.stopPropagation()
  }

  const endPinchPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'touch') return
    activePointersRef.current.delete(event.pointerId)
    const gesture = pinchRef.current
    if (!gesture?.pointerIds.includes(event.pointerId)) return
    pinchRef.current = null
    activePointersRef.current.clear()
    setGestureZooming(false)
    gesture.pointerIds.forEach((pointerId) => releasePointer(gesture.pointerTarget, pointerId))
  }

  const zoomFromWheel = (event: WheelEvent) => {
    if (!event.ctrlKey && !event.metaKey) return
    const geometry = gestureGeometry(event.clientX)
    if (!geometry) return
    event.preventDefault()
    const nextZoom = clampTimelineZoom(zoom * Math.exp(-event.deltaY * 0.0025))
    pendingAnchorRef.current = { ratio: geometry.anchorRatio, viewportX: geometry.anchorViewportX }
    setGestureZooming(true)
    onZoomChange(nextZoom)
    if (wheelGestureFrameRef.current !== null) window.cancelAnimationFrame(wheelGestureFrameRef.current)
    wheelGestureFrameRef.current = window.requestAnimationFrame(() => {
      wheelGestureFrameRef.current = null
      setGestureZooming(false)
    })
  }

  useEffect(() => {
    const scroll = scrollRef.current
    if (!scroll) return
    scroll.addEventListener('wheel', zoomFromWheel, { passive: false })
    return () => scroll.removeEventListener('wheel', zoomFromWheel)
  }, [zoom, onZoomChange])

  const editLoopFromKeyboard = (event: React.KeyboardEvent, mode: 'start' | 'end' | 'move') => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    event.stopPropagation()
    const direction = event.key === 'ArrowRight' ? 1 : -1
    const delta = direction * (snapping ? snapDivision : 0.05)
    const start = project.loop.startBeat
    const end = project.loop.endBeat
    if (mode === 'start') {
      onEditLoop(Math.max(0, Math.min(end - 0.25, start + delta)), end)
      return
    }
    if (mode === 'end') {
      onEditLoop(start, Math.min(timelineBeats, Math.max(start + 0.25, end + delta)))
      return
    }
    const duration = end - start
    const nextStart = Math.max(0, Math.min(timelineBeats - duration, start + delta))
    onEditLoop(nextStart, nextStart + duration)
  }

  const dragTarget = drag?.targetTrackId
    ? project.tracks.find((track) => track.id === drag.targetTrackId)
    : undefined
  const dragStatus = !drag?.hasMoved || drag.mode !== 'move'
    ? ''
    : drag.dropStatus === 'invalid'
      ? `Cannot move ${drag.clipKind} region to ${dragTarget?.name ?? 'this track'}; choose a ${drag.clipKind} track.`
      : drag.dropStatus === 'collision'
        ? `Move blocked: another region already occupies this range on ${dragTarget?.name ?? 'the track'}.`
        : drag.dropStatus === 'outside'
          ? 'Move cancelled if released outside a track.'
          : `Move region to ${dragTarget?.name ?? 'current track'} at beat ${drag.previewStart.toFixed(2)}.`

  return (
    <main className="arrangement-panel panel" aria-label="Arrangement">
      <header className="arrangement-heading">
        <div><p className="eyebrow">ARRANGEMENT</p><h1>{project.name}</h1></div>
        <div className="arrangement-tools">
          <span>{project.tracks.length} tracks</span>
          <span className="overlap-policy" title="Regions may touch but cannot overlap">OVERLAP · PREVENT</span>
          <AddTrackButtons onAddTrack={onAddTrack} />
          <div className="mobile-arrangement-actions"><button className={project.loop.enabled ? 'is-active' : ''} onClick={onToggleLoop} aria-label="Toggle loop" aria-pressed={project.loop.enabled}><Repeat2 /></button><button onClick={onUndo} disabled={!canUndo} aria-label="Undo"><Undo2 /></button><button onClick={onRedo} disabled={!canRedo} aria-label="Redo"><Redo2 /></button></div>
        </div>
      </header>

      <div
        className="arrangement-scroll"
        ref={scrollRef}
        onPointerDownCapture={beginPinch}
        onPointerMoveCapture={movePinch}
        onPointerUpCapture={endPinchPointer}
        onPointerCancelCapture={() => cancelActiveGesturesRef.current()}
      >
        <div
          ref={stageRef}
          className={`timeline-stage ${gestureZooming ? 'is-gesture-zooming' : ''}`}
          style={{
            width: stageBaseWidth > 0
              ? `${stageBaseWidth * zoom * (timelineBeats / (MIN_TIMELINE_BARS * barBeats))}px`
              : `${Math.max(100, zoom * 100)}%`,
            '--beat-grid-width': `${100 / timelineBeats}%`,
            '--bar-grid-width': `${(barBeats / timelineBeats) * 100}%`,
          } as React.CSSProperties}
        >
          <div className="ruler-row">
            <div className="ruler-corner" ref={rulerCornerRef}><span>TRACKS</span></div>
            <div
              className="timeline-ruler"
              ref={timelineRef}
              onPointerDown={beginRulerScrub}
              onLostPointerCapture={(event) => {
                if (rulerScrubRef.current?.pointerId === event.pointerId) cancelActiveGesturesRef.current()
              }}
              data-timeline-beats={timelineBeats}
            >
              <div className="ruler-seek-control" onKeyDown={(event) => { const step = snapping ? snapDivision : 0.05; if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); onSeek(Math.max(0, Math.min(timelineBeats, playheadBeat + (event.key === 'ArrowRight' ? step : -step)))) } }} role="slider" tabIndex={0} aria-label="Arrangement playhead" aria-valuemin={0} aria-valuemax={timelineBeats} aria-valuenow={Number(playheadBeat.toFixed(3))} aria-valuetext={`${playheadBeat.toFixed(2)} beats`} />
              {rulerMarks.map((beat, index) => <span key={beat} style={{ left: `${(beat / timelineBeats) * 100}%` }}>{index + 1}</span>)}
              {project.loop.enabled && (() => {
                const startBeat = loopDrag?.previewStart ?? project.loop.startBeat
                const endBeat = loopDrag?.previewEnd ?? project.loop.endBeat
                return <div className="loop-brace" style={{ left: `${(startBeat / timelineBeats) * 100}%`, width: `${((endBeat - startBeat) / timelineBeats) * 100}%` }}>
                  <button className="loop-handle loop-start" onPointerDown={(event) => beginLoopDrag(event, 'start')} onKeyDown={(event) => editLoopFromKeyboard(event, 'start')} role="slider" aria-label="Loop start" aria-valuemin={0} aria-valuemax={Number((endBeat - 0.25).toFixed(3))} aria-valuenow={Number(startBeat.toFixed(3))} aria-valuetext={`${startBeat.toFixed(2)} beats`} />
                  <button className="loop-range" onPointerDown={(event) => beginLoopDrag(event, 'move')} onKeyDown={(event) => editLoopFromKeyboard(event, 'move')} role="slider" aria-label="Loop range position" aria-valuemin={0} aria-valuemax={Number((timelineBeats - (endBeat - startBeat)).toFixed(3))} aria-valuenow={Number(startBeat.toFixed(3))} aria-valuetext={`${startBeat.toFixed(2)} to ${endBeat.toFixed(2)} beats`} />
                  <button className="loop-handle loop-end" onPointerDown={(event) => beginLoopDrag(event, 'end')} onKeyDown={(event) => editLoopFromKeyboard(event, 'end')} role="slider" aria-label="Loop end" aria-valuemin={Number((startBeat + 0.25).toFixed(3))} aria-valuemax={timelineBeats} aria-valuenow={Number(endBeat.toFixed(3))} aria-valuetext={`${endBeat.toFixed(2)} beats`} />
                </div>
              })()}
            </div>
          </div>

          <div className={`track-stack ${drag?.hasMoved ? 'is-clip-dragging' : ''}`}>
            <p className="sr-only" id="arrangement-clip-keyboard-help">Use Left and Right Arrow to move in time. Use Alt plus Up or Down Arrow to move to the previous or next compatible track. Press Enter to open Detail.</p>
            <p className="sr-only" role="status" aria-live="polite">{dragStatus}</p>
            {project.tracks.length === 0 && <div className="arrangement-empty"><Music2 /><div><b>Your arrangement is empty</b><p>Generate or import Audio, or add an Audio or MIDI track to start shaping the song.</p></div><AddTrackButtons onAddTrack={onAddTrack} /></div>}
            {project.tracks.map((track, trackIndex) => (
              <TrackRow
                key={track.id}
                project={project}
                track={track}
                timelineBeats={timelineBeats}
                index={trackIndex}
                trackCount={project.tracks.length}
                selectedClipId={selectedClipId}
                selectedTrack={selected ? selected.track.id === track.id : selectedTrackId === track.id}
                snapping={snapping}
                snapDivision={snapDivision}
                level={trackLevels[track.id] ?? 0}
                drag={drag}
                onSelectTrack={onSelectTrack}
                onSelectClip={onSelectClip}
                onBeginDrag={beginDrag}
                onEditClip={onEditClip}
                onMoveClip={onMoveClip}
                onOpenClipDetail={onOpenClipDetail}
                onOpenClipCommands={onOpenClipCommands}
                onToggleTrack={onToggleTrack}
                onTrackGain={onTrackGain}
                onMoveTrack={onMoveTrack}
                onDropAudioSource={onDropAudioSource}
              />
            ))}
            {project.tracks.length > 0 && <div className="playhead" style={{ '--playhead': Math.min(timelineBeats, playheadBeat) / timelineBeats } as React.CSSProperties} aria-hidden="true"><i /></div>}
          </div>
        </div>
      </div>
    </main>
  )
}

type TrackRowProps = {
  project: Project
  track: Track
  timelineBeats: number
  index: number
  trackCount: number
  selectedClipId: string | null
  selectedTrack: boolean
  snapping: boolean
  snapDivision: number
  level: number
  drag: DragState | null
  onSelectTrack: (trackId: string) => void
  onSelectClip: (clipId: string, trackId: string) => void
  onBeginDrag: (event: React.PointerEvent, track: Track, clip: Clip, mode: DragState['mode']) => void
  onEditClip: (trackId: string, clipId: string, edit: ClipEdit) => void
  onMoveClip: (sourceTrackId: string, targetTrackId: string, clipId: string, startBeat: number) => void
  onOpenClipDetail: (clipId: string, trackId: string) => void
  onOpenClipCommands: (clipId: string, trackId: string, anchor: { x: number; y: number }) => void
  onToggleTrack: (trackId: string, field: 'mute' | 'solo') => void
  onTrackGain: (trackId: string, gain: number) => void
  onMoveTrack: (trackId: string, direction: 'up' | 'down') => void
  onDropAudioSource: (payload: AudioSourceDragPayload, trackId: string, startBeat: number) => void
}

function TrackRow({
  project,
  track,
  timelineBeats,
  index,
  trackCount,
  selectedClipId,
  selectedTrack,
  snapping,
  snapDivision,
  level,
  drag,
  onSelectTrack,
  onSelectClip,
  onBeginDrag,
  onEditClip,
  onMoveClip,
  onOpenClipDetail,
  onOpenClipCommands,
  onToggleTrack,
  onTrackGain,
  onMoveTrack,
  onDropAudioSource,
}: TrackRowProps) {
  const [sourceDrop, setSourceDrop] = useState<{ startBeat: number; durationBeats: number; status: 'valid' | 'invalid' | 'collision' } | null>(null)
  const [minPitch, maxPitch] = useMemo(() => {
    let minimum = 127
    let maximum = 0
    let count = 0
    for (const clip of track.clips) {
      if (clip.kind !== 'midi') continue
      for (const note of clip.notes) {
        minimum = Math.min(minimum, note.pitch)
        maximum = Math.max(maximum, note.pitch)
        count += 1
      }
    }
    return count > 0 ? [minimum, maximum] : [48, 72]
  }, [track.clips])
  const midiThumbnails = useMemo(() => new Map(track.clips.flatMap((clip) => {
    if (clip.kind !== 'midi') return []
    return [[clip.id, midiThumbnailPath(
      getArrangedMidiNotes(clip),
      clip.startBeat,
      clip.durationBeats,
      minPitch,
      maxPitch,
    )] as const]
  })), [track.clips, minPitch, maxPitch])
  const activeTrackDrop = drag?.hasMoved && drag.mode === 'move' && drag.targetTrackId === track.id
  const dropLabel = activeTrackDrop
    ? drag.dropStatus === 'invalid'
      ? `${track.kind.toUpperCase()} TRACK · ${drag.clipKind.toUpperCase()} REGION NOT ALLOWED`
      : drag.dropStatus === 'collision'
        ? `OCCUPIED · MOVE BLOCKED`
        : drag.dropStatus === 'source' ? `MOVE WITHIN ${track.name}` : `MOVE TO ${track.name}`
    : undefined
  const sourceDropLabel = sourceDrop
    ? sourceDrop.status === 'invalid'
      ? 'AUDIO SOURCE · MIDI TRACK NOT ALLOWED'
      : sourceDrop.status === 'collision'
        ? 'OCCUPIED · PLACE BLOCKED'
        : `COPY TO ${track.name} · BEAT ${sourceDrop.startBeat.toFixed(2)}`
    : undefined
  const updateSourceDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (!hasAudioSourceDrag(event.dataTransfer)) return
    event.preventDefault()
    const bounds = event.currentTarget.getBoundingClientRect()
    const payload = readAudioSourceDrag(event.dataTransfer)
    const sourceLeft = event.clientX - (payload?.grabOffsetX ?? 0)
    const ratio = bounds.width > 0 ? (sourceLeft - bounds.left) / bounds.width : 0
    const rawStartBeat = Math.max(0, Math.min(timelineBeats, ratio * timelineBeats))
    const startBeat = snapping ? snapBeat(rawStartBeat, snapDivision) : rawStartBeat
    const status = !payload || track.kind !== 'audio'
      ? 'invalid'
      : findClipCollision(track, '__source-drop__', startBeat, payload.durationBeats)
        ? 'collision'
        : 'valid'
    event.dataTransfer.dropEffect = status === 'valid' ? 'copy' : 'none'
    setSourceDrop({ startBeat, durationBeats: payload?.durationBeats ?? 0, status })
  }
  const editTrimFromKeyboard = (event: React.KeyboardEvent, clip: Clip, edge: 'start' | 'end') => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    event.stopPropagation()
    const direction = event.key === 'ArrowRight' ? 1 : -1
    const step = snapping ? snapDivision : 0.05
    if (edge === 'end') {
      if (clip.sourceLoop) {
        const asset = findAsset(project, clip.assetId)
        const maximum = asset
          ? Math.max(clip.sourceLoop.cycleLengthBeats, sourceDurationBeatsForClip(clip, asset, project.bpm) - clip.sourceLoop.cycleStartBeat)
          : clip.sourceLoop.cycleLengthBeats
        const cycleLengthBeats = Math.min(maximum, Math.max(clip.sourceLoop.phaseBeats + 0.25, clip.sourceLoop.cycleLengthBeats + direction * step))
        onEditClip(track.id, clip.id, { sourceLoop: { ...clip.sourceLoop, cycleLengthBeats, phaseBeats: positiveModulo(clip.sourceLoop.phaseBeats, cycleLengthBeats) } })
        return
      }
      onEditClip(track.id, clip.id, { durationBeats: Math.max(0.25, clip.durationBeats + direction * step) })
      return
    }
    const requestedDelta = direction * step
    const lowerBound = -Math.min(clip.startBeat, clip.offsetBeats)
    const actualDelta = Math.max(lowerBound, Math.min(clip.durationBeats - 0.25, requestedDelta))
    onEditClip(track.id, clip.id, {
      startBeat: clip.startBeat + actualDelta,
      durationBeats: clip.durationBeats - actualDelta,
      offsetBeats: clip.offsetBeats + actualDelta,
      ...(clip.sourceLoop ? {
        sourceLoop: {
          ...clip.sourceLoop,
          phaseBeats: positiveModulo(clip.sourceLoop.phaseBeats + actualDelta, clip.sourceLoop.cycleLengthBeats),
        },
      } : {}),
    })
  }
  return (
    <div className={`track-row ${selectedTrack ? 'is-selected-track' : ''} ${drag?.hasMoved && drag.trackId === track.id ? 'has-clip-drag' : ''}`} style={{ '--track-color': track.color } as React.CSSProperties} data-track-id={track.id}>
      <div className="track-header">
        <button className="track-identity" onClick={() => onSelectTrack(track.id)} aria-label={`Select ${track.name} track`} aria-current={selectedTrack ? 'true' : undefined}>
          <strong>{index + 1}</strong>
          <span className="track-kind-icon">{track.kind === 'audio' ? <AudioLines /> : <Music2 />}</span>
          <div><b>{track.name}</b><small>{track.kind === 'audio' ? 'AUDIO' : 'MIDI'}</small></div>
        </button>
        <div className="track-order-actions" role="group" aria-label={`${track.name} track order`}>
          <button type="button" aria-label={`Move ${track.name} track up`} onClick={() => onMoveTrack(track.id, 'up')} disabled={index === 0}><ArrowUp /></button>
          <button type="button" aria-label={`Move ${track.name} track down`} onClick={() => onMoveTrack(track.id, 'down')} disabled={index === trackCount - 1}><ArrowDown /></button>
        </div>
        <div className="track-controls">
          <button aria-label={`Mute ${track.name}`} aria-pressed={track.mute} className={track.mute ? 'is-active' : ''} onClick={() => onToggleTrack(track.id, 'mute')}>M</button>
          <button aria-label={`Solo ${track.name}`} aria-pressed={track.solo} className={track.solo ? 'is-active' : ''} onClick={() => onToggleTrack(track.id, 'solo')}>S</button>
          <div className="mini-meter" role="meter" aria-label={`${track.name} peak level`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)}><i style={{ width: `${Math.round(level * 100)}%` }} /></div>
          <input aria-label={`${track.name} gain`} aria-valuetext={`${(20 * Math.log10(Math.max(0.001, track.gain))).toFixed(1)} decibels`} type="range" min="0" max="1.25" step="0.01" value={track.gain} onChange={(event) => onTrackGain(track.id, Number(event.target.value))} />
        </div>
      </div>
      <div
        className={`track-lane timeline-grid ${activeTrackDrop ? drag.dropStatus === 'invalid' || drag.dropStatus === 'collision' ? 'is-invalid-drop-target' : 'is-valid-drop-target' : sourceDrop?.status === 'invalid' ? 'is-invalid-drop-target' : sourceDrop ? 'has-source-drop-preview' : ''}`}
        onClick={(event) => { if (event.target === event.currentTarget) onSelectTrack(track.id) }}
        onDragEnter={updateSourceDrop}
        onDragOver={updateSourceDrop}
        onDragLeave={(event) => {
          if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
          setSourceDrop(null)
        }}
        onDrop={(event) => {
          if (!hasAudioSourceDrag(event.dataTransfer)) return
          event.preventDefault()
          const payload = readAudioSourceDrag(event.dataTransfer)
          const placement = sourceDrop
          clearAudioSourceDrag()
          setSourceDrop(null)
          if (payload && placement?.status === 'valid') onDropAudioSource(payload, track.id, placement.startBeat)
        }}
        aria-label={`${track.name} timeline lane`}
        data-drop-label={sourceDropLabel ?? dropLabel}
      >
        {sourceDrop && sourceDrop.status !== 'invalid' && sourceDrop.durationBeats > 0 && (
          <div
            className={`source-drop-preview is-${sourceDrop.status}`}
            style={{
              left: `${(sourceDrop.startBeat / timelineBeats) * 100}%`,
              width: `${(sourceDrop.durationBeats / timelineBeats) * 100}%`,
            }}
            data-drop-label={sourceDropLabel}
            aria-hidden="true"
          />
        )}
        {track.clips.map((clip) => {
          const activeDrag = drag?.clipId === clip.id ? drag : null
          const start = activeDrag?.previewStart ?? clip.startBeat
          const duration = activeDrag?.previewDuration ?? clip.durationBeats
          const asset = findAsset(project, clip.assetId)
          const selected = clip.id === selectedClipId
          const sourceLoop = clip.sourceLoop
            ? {
                ...clip.sourceLoop,
                cycleLengthBeats: activeDrag?.mode === 'cycle-end' ? activeDrag.previewCycleLength : clip.sourceLoop.cycleLengthBeats,
              }
            : undefined
          const visualClip = { ...clip, startBeat: start, durationBeats: duration, sourceLoop } as Clip
          const sourceSlices = getClipSourceSlices(visualClip)
          const midiPath = visualClip.kind === 'midi'
            ? activeDrag
              ? midiThumbnailPath(getArrangedMidiNotes(visualClip), start, duration, minPitch, maxPitch)
              : midiThumbnails.get(clip.id) ?? ''
            : ''
          const sourceDurationBeats = asset ? sourceDurationBeatsForClip(visualClip, asset, project.bpm) : 0
          const cycleBoundary = sourceLoop
            ? Math.min(duration, Math.max(0.25, sourceLoop.cycleLengthBeats - sourceLoop.phaseBeats))
            : duration
          return (
            <div
              key={clip.id}
              className={`timeline-clip ${clip.kind} ${clip.muted ? 'is-muted' : ''} ${selected ? 'is-selected' : ''} ${activeDrag?.hasMoved ? 'is-dragging' : ''} ${activeDrag?.hasMoved ? `is-drop-${activeDrag.dropStatus}` : ''}`}
              style={{ left: `${(start / timelineBeats) * 100}%`, width: `${(duration / timelineBeats) * 100}%`, transform: activeDrag?.hasMoved ? `translate3d(0, ${activeDrag.previewTranslateY}px, 0)` : undefined, '--clip-color': clip.color ?? track.color } as React.CSSProperties}
              role="group"
              aria-label={`${clip.name} region controls`}
              data-clip-id={clip.id}
            >
              <button
                className="clip-body-control"
                onClick={(event) => { event.stopPropagation(); onSelectClip(clip.id, track.id) }}
                onDoubleClick={(event) => { event.stopPropagation(); onOpenClipDetail(clip.id, track.id) }}
                onContextMenu={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  onSelectClip(clip.id, track.id)
                  onOpenClipCommands(clip.id, track.id, { x: event.clientX, y: event.clientY })
                }}
                onPointerDown={(event) => onBeginDrag(event, track, clip, 'move')}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    event.stopPropagation()
                    onOpenClipDetail(clip.id, track.id)
                    return
                  }
                  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                    event.preventDefault()
                    event.stopPropagation()
                    const bounds = event.currentTarget.getBoundingClientRect()
                    onOpenClipCommands(clip.id, track.id, { x: bounds.left + 12, y: bounds.top + 20 })
                    return
                  }
                  if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
                    event.preventDefault()
                    event.stopPropagation()
                    const targetTrackId = findCompatibleTrackId(project.tracks, track.id, clip.kind, event.key === 'ArrowUp' ? 'up' : 'down')
                    if (targetTrackId) onMoveClip(track.id, targetTrackId, clip.id, clip.startBeat)
                    return
                  }
                  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                    event.preventDefault()
                    const step = snapping ? snapDivision : 0.05
                    onEditClip(track.id, clip.id, { startBeat: Math.max(0, clip.startBeat + (event.key === 'ArrowRight' ? step : -step)) })
                  }
                }}
                aria-describedby="arrangement-clip-keyboard-help"
                aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown Enter Shift+F10"
                aria-label={`${selected ? 'Selected, ' : ''}${clip.name}, ${clip.kind} region, starts at beat ${start.toFixed(2)}, duration ${duration.toFixed(2)} beats${clip.muted ? ', muted' : ''}${sourceLoop ? ', clip source loop enabled' : ''}`}
              />
              <header className="clip-title" aria-hidden="true"><span>{clip.name}</span>{clip.muted && <VolumeX className="clip-muted-icon" />}{sourceLoop && <b><Repeat2 />{sourceSlices.length}×</b>}{clip.provenance.parentAssetId && <Link2 />}</header>
              {clip.kind === 'audio' ? (
                asset?.waveform?.[0] && sourceDurationBeats > 0 ? (
                  <div className="clip-waveform-slices" aria-hidden="true">
                    {sourceSlices.map((slice, sliceIndex) => {
                      const renderable = getRenderableWaveformSlice(slice, sourceDurationBeats)
                      if (!renderable) return null
                      return <svg key={`${slice.placementStartBeat}-${sliceIndex}`} className="clip-waveform" style={{ left: `${(renderable.placementStartBeat / duration) * 100}%`, width: `${(renderable.durationBeats / duration) * 100}%` }} viewBox={`${renderable.viewStart} 0 ${renderable.viewWidth} 100`} preserveAspectRatio="none"><path d={waveformPath(asset.waveform![0])} /></svg>
                    })}
                  </div>
                ) : <div className="clip-media-state" aria-hidden="true">Waveform unavailable</div>
              ) : (
                <div className="clip-notes" aria-hidden="true">
                  <svg viewBox="0 0 1000 100" preserveAspectRatio="none"><path d={midiPath} /></svg>
                </div>
              )}
              {sourceLoop && sourceSlices.slice(1).map((slice, sliceIndex) => <i key={`notch-${slice.placementStartBeat}-${sliceIndex}`} className="clip-loop-notch" style={{ left: `${(slice.placementStartBeat / duration) * 100}%` }} aria-hidden="true" />)}
              <button className="trim-handle trim-start" onClick={(event) => { event.stopPropagation(); onSelectClip(clip.id, track.id) }} onPointerDown={(event) => onBeginDrag(event, track, clip, 'trim-start')} onKeyDown={(event) => editTrimFromKeyboard(event, clip, 'start')} aria-label={`Trim start of ${clip.name}. Use left and right arrow keys`}><span /></button>
              {sourceLoop ? <>
                <button className="trim-handle trim-end cycle-end" style={{ left: `${(cycleBoundary / duration) * 100}%` }} onClick={(event) => { event.stopPropagation(); onSelectClip(clip.id, track.id) }} onPointerDown={(event) => onBeginDrag(event, track, clip, 'cycle-end')} onKeyDown={(event) => editTrimFromKeyboard(event, clip, 'end')} aria-label={`Change source cycle end of ${clip.name}. Use left and right arrow keys`}><span /></button>
                <button className="loop-extent-handle" onClick={(event) => { event.stopPropagation(); onSelectClip(clip.id, track.id) }} onPointerDown={(event) => onBeginDrag(event, track, clip, 'loop-end')} onKeyDown={(event) => editTrimFromKeyboard(event, { ...clip, sourceLoop: undefined }, 'end')} aria-label={`Change clip loop extent of ${clip.name}. Use left and right arrow keys`}><Repeat2 /></button>
              </> : <button className="trim-handle trim-end" onClick={(event) => { event.stopPropagation(); onSelectClip(clip.id, track.id) }} onPointerDown={(event) => onBeginDrag(event, track, clip, 'trim-end')} onKeyDown={(event) => editTrimFromKeyboard(event, clip, 'end')} aria-label={`Trim end of ${clip.name}. Use left and right arrow keys`}><span /></button>}
              {selected && <div className="clip-readout">{start.toFixed(2)} → {(start + duration).toFixed(2)} beats</div>}
            </div>
          )
        })}
      </div>
    </div>
  )
}
