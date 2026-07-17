import { useEffect, useMemo, useRef, useState } from 'react'
import { AudioLines, BoxSelect, ChevronDown, Eraser, Expand, Minimize2, Music2, Pencil, SlidersHorizontal, Waves } from 'lucide-react'
import {
  beatsToSeconds,
  getArrangedMidiNotes,
  getAudioClipPlaybackRate,
  getAudioSourceDurationBeats,
  getClipSourceSlices,
  secondsToBeats,
  snapBeat,
  sourceBeatAtClipPosition,
} from '../core'
import type { ArrangedMidiNote, ClipSourceSlice, NoteDivision } from '../core'
import type { AudioAsset, AudioClip, Clip, ClipSourceLoop, MidiClip, MidiNote, MidiTrack, TimeSignature, Track } from '../types'
import { midiNoteName, waveformPath } from '../ui/music'

type DetailEditorProps = {
  clip?: Clip
  track?: Track
  asset?: AudioAsset
  playheadBeat: number
  bpm: number
  timeSignature: TimeSignature
  snapping: boolean
  snapDivision?: number
  open: boolean
  expanded: boolean
  onEditNote: (noteId: string, patch: Partial<MidiNote>) => void
  onDeleteNote: (noteId: string) => void
  onEditNotes?: (edits: readonly { id: string; patch: Partial<MidiNote> }[]) => void
  onDeleteNotes?: (noteIds: readonly string[]) => void
  onAddNote: (note: Omit<MidiNote, 'id'>) => void
  onQuantize: (division: NoteDivision, strength: number, noteIds: readonly string[]) => void
  onSeek?: (beat: number) => void
  onEditAudio?: (patch: Partial<Pick<AudioClip, 'fadeIn' | 'fadeOut'>>) => void
  onAuditionMidiNote?: (pitch: number, phase: 'start' | 'stop', track: MidiTrack) => void
  onExpand: () => void
  onClose?: () => void
}

type RenderedNoteInstance = ArrangedMidiNote & {
  instanceKey: string
  placementStartBeat: number
  primary: boolean
  repeatCount: number
}

type MidiTool = 'draw' | 'select' | 'erase'

type MidiNoteEdit = { id: string; patch: Partial<MidiNote> }

type PointerOwner = {
  pointerId: number
  pointerTarget: HTMLElement
  originX: number
  originY: number
  moved: boolean
  surfaceLeft: number
  surfaceTop: number
  width: number
  height: number
}

type NoteMoveInteraction = PointerOwner & {
  kind: 'move'
  anchorNoteId: string
  anchorPitch: number
  anchorPlacementStartBeat: number
  anchorPlacementDurationBeats: number
  selectedIds: readonly string[]
  previewEdits: readonly MidiNoteEdit[]
  clickAction?: 'delete'
}

type NoteResizeInteraction = PointerOwner & {
  kind: 'resize'
  noteId: string
  originalPitch: number
  previewEdits: readonly MidiNoteEdit[]
}

type MarqueeInteraction = PointerOwner & {
  kind: 'marquee'
  currentX: number
  currentY: number
  union: boolean
  baseSelection: ReadonlySet<string>
  baseActiveNoteId: string | null
}

type DrawInteraction = PointerOwner & {
  kind: 'draw'
  placementStartBeat: number
  sourceStartBeat: number
  pitch: number
  previewDurationBeats: number
}

type EraseInteraction = PointerOwner & {
  kind: 'erase'
  previousX: number
  previousY: number
  noteIds: readonly string[]
}

type MidiPointerInteraction = NoteMoveInteraction | NoteResizeInteraction | MarqueeInteraction | DrawInteraction | EraseInteraction

type ActiveMidiAudition = {
  pitch: number
  track: MidiTrack
  callback: NonNullable<DetailEditorProps['onAuditionMidiNote']>
}

type RenderableSourceSlice = {
  placementStartBeat: number
  durationBeats: number
  viewStart: number
  viewWidth: number
}

const MIN_NOTE_BEATS = 1 / 16
const NOTE_EPSILON = 1e-9
const PIANO_PITCH_COUNT = 128
const PIANO_ROW_HEIGHT_PX = 12
const PIANO_CONTENT_HEIGHT_PX = PIANO_PITCH_COUNT * PIANO_ROW_HEIGHT_PX
const ERASER_RADIUS_PX = 4

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.max(minimum, Math.min(maximum, value))

export function getRenderableDetailSourceSlice(
  slice: ClipSourceSlice,
  sourceDurationBeats: number,
  waveformWidth: number,
): RenderableSourceSlice | null {
  if (!Number.isFinite(sourceDurationBeats) || sourceDurationBeats <= 0) return null
  const sourceEndBeat = slice.sourceStartBeat + slice.durationBeats
  const validSourceStartBeat = Math.max(0, slice.sourceStartBeat)
  const validSourceEndBeat = Math.min(sourceDurationBeats, sourceEndBeat)
  if (validSourceEndBeat - validSourceStartBeat <= NOTE_EPSILON) return null
  const clippedFromStart = validSourceStartBeat - slice.sourceStartBeat
  return {
    placementStartBeat: slice.placementStartBeat + clippedFromStart,
    durationBeats: validSourceEndBeat - validSourceStartBeat,
    viewStart: (validSourceStartBeat / sourceDurationBeats) * waveformWidth,
    viewWidth: ((validSourceEndBeat - validSourceStartBeat) / sourceDurationBeats) * waveformWidth,
  }
}

const renderedNoteInstances = (clip: MidiClip): RenderedNoteInstance[] => {
  const arranged = getArrangedMidiNotes(clip)
  const groups = new Map<string, Array<ArrangedMidiNote & { instanceKey: string; placementStartBeat: number }>>()
  arranged.forEach((instance, index) => {
    const entry = {
      ...instance,
      instanceKey: `${instance.note.id}:${instance.startBeat.toFixed(9)}:${instance.noteOffsetBeats.toFixed(9)}:${index}`,
      placementStartBeat: instance.startBeat - clip.startBeat,
    }
    const group = groups.get(instance.note.id) ?? []
    group.push(entry)
    groups.set(instance.note.id, group)
  })

  return [...groups.values()].flatMap((group) => {
    const primary = group.find((instance) => instance.noteOffsetBeats <= NOTE_EPSILON) ?? group[0]
    return group.map((instance) => ({
      ...instance,
      primary: instance.instanceKey === primary.instanceKey,
      repeatCount: group.length,
    }))
  }).sort((left, right) => left.startBeat - right.startBeat || left.note.pitch - right.note.pitch)
}

const sourceWindow = (clip: MidiClip): { startBeat: number; endBeat: number } => {
  if (clip.sourceLoop) {
    return {
      startBeat: clip.sourceLoop.cycleStartBeat,
      endBeat: clip.sourceLoop.cycleStartBeat + clip.sourceLoop.cycleLengthBeats,
    }
  }
  return {
    startBeat: clip.offsetBeats,
    endBeat: clip.offsetBeats + clip.durationBeats,
  }
}

const sourceStartForPlacement = (
  clip: MidiClip,
  note: MidiNote,
  instancePlacementStartBeat: number,
  desiredPlacementStartBeat: number,
): { sourceStartBeat: number; placementStartBeat: number } => {
  const window = sourceWindow(clip)
  const minimum = Math.max(0, window.startBeat - note.durationBeats + MIN_NOTE_BEATS)
  const maximum = Math.max(minimum, window.endBeat - MIN_NOTE_BEATS)
  const requestedSourceStart = note.startBeat + desiredPlacementStartBeat - instancePlacementStartBeat
  const sourceStartBeat = clamp(requestedSourceStart, minimum, maximum)
  return {
    sourceStartBeat,
    placementStartBeat: instancePlacementStartBeat + sourceStartBeat - note.startBeat,
  }
}

const extractionGhostMapping = (
  clip: MidiClip,
  projectBpm: number,
): { durationBeats: number; offsetBeats: number; sourceLoop?: ClipSourceLoop; bpm: number } => {
  const metadata = clip.provenance.metadata
  const submittedOffset = metadata?.submittedOffsetBeats
  const submittedBpm = metadata?.submittedBpm
  const loopEnabled = metadata?.submittedSourceLoop === true
  const cycleStartBeat = metadata?.submittedLoopCycleStartBeat
  const cycleLengthBeats = metadata?.submittedLoopCycleLengthBeats
  const phaseBeats = metadata?.submittedLoopPhaseBeats
  const sourceLoop = loopEnabled
    && typeof cycleStartBeat === 'number'
    && typeof cycleLengthBeats === 'number'
    && typeof phaseBeats === 'number'
    && cycleStartBeat >= 0
    && cycleLengthBeats >= 1 / 64
    && phaseBeats >= 0
    && phaseBeats < cycleLengthBeats
    ? { cycleStartBeat, cycleLengthBeats, phaseBeats }
    : clip.sourceLoop

  return {
    durationBeats: clip.durationBeats,
    offsetBeats: typeof submittedOffset === 'number' && submittedOffset >= 0
      ? submittedOffset
      : clip.offsetBeats,
    sourceLoop,
    bpm: typeof submittedBpm === 'number' && submittedBpm > 0 ? submittedBpm : projectBpm,
  }
}

export function DetailEditor({
  clip,
  track,
  asset,
  playheadBeat,
  bpm,
  timeSignature,
  snapping,
  snapDivision = 0.25,
  open,
  expanded,
  onEditNote,
  onDeleteNote,
  onEditNotes,
  onDeleteNotes,
  onAddNote,
  onQuantize,
  onSeek,
  onEditAudio,
  onAuditionMidiNote,
  onExpand,
  onClose,
}: DetailEditorProps) {
  const [midiTool, setMidiTool] = useState<MidiTool>('select')

  return (
    <section className={`detail-panel panel ${open ? 'is-open' : ''} ${expanded ? 'is-expanded' : ''}`} aria-label="Detail editor">
      <button className="mobile-sheet-grabber" onClick={onExpand} aria-label={expanded ? 'Collapse detail sheet' : 'Expand detail sheet'} aria-expanded={expanded}><span /></button>
      <header className="detail-heading">
        <div className="detail-title">
          <p className="eyebrow">DETAIL</p>
          {clip ? <>
            <span style={{ '--clip-color': clip.color ?? track?.color } as React.CSSProperties}>{clip.kind === 'audio' ? <AudioLines /> : <Music2 />}</span>
            <h2>{clip.name}</h2>
          </> : <h2>Select a region</h2>}
        </div>
        <div className="detail-toolbar">
          {clip?.kind === 'midi' && <div className="midi-edit-toolbar" role="toolbar" aria-label="Piano roll editing mode">
            <button type="button" className={`icon-button midi-tool-button ${midiTool === 'draw' ? 'is-active' : ''}`} aria-label="Draw notes" aria-pressed={midiTool === 'draw'} onClick={() => setMidiTool('draw')}><Pencil /></button>
            <button type="button" className={`icon-button midi-tool-button ${midiTool === 'select' ? 'is-active' : ''}`} aria-label="Range select notes" aria-pressed={midiTool === 'select'} onClick={() => setMidiTool('select')}><BoxSelect /></button>
            <button type="button" className={`icon-button midi-tool-button ${midiTool === 'erase' ? 'is-active' : ''}`} aria-label="Erase notes" aria-pressed={midiTool === 'erase'} onClick={() => setMidiTool('erase')}><Eraser /></button>
          </div>}
          <button className="icon-button" onClick={onExpand} aria-label={expanded ? 'Restore detail editor' : 'Expand detail editor'} aria-expanded={expanded}>{expanded ? <Minimize2 /> : <Expand />}</button>
          {onClose && <button className="icon-button" onClick={onClose} aria-label="Collapse detail editor"><ChevronDown /></button>}
        </div>
      </header>
      {!clip ? <div className="detail-empty"><Waves /><p>Waveform and MIDI editing stay anchored to the Arrangement selection.</p></div> : clip.kind === 'audio' ? (
        <AudioDetail
          clip={clip}
          asset={asset}
          playheadBeat={playheadBeat}
          bpm={bpm}
          timeSignature={timeSignature}
          snapping={snapping}
          snapDivision={snapDivision}
          onSeek={onSeek}
          onEditAudio={onEditAudio}
        />
      ) : (
        <MidiDetail
          clip={clip}
          track={track?.kind === 'midi' ? track : undefined}
          asset={asset}
          playheadBeat={playheadBeat}
          bpm={bpm}
          snapping={snapping}
          snapDivision={snapDivision}
          onEditNote={onEditNote}
          onDeleteNote={onDeleteNote}
          onEditNotes={onEditNotes}
          onDeleteNotes={onDeleteNotes}
          onAddNote={onAddNote}
          onQuantize={onQuantize}
          onAuditionMidiNote={onAuditionMidiNote}
          tool={midiTool}
          onToolChange={setMidiTool}
        />
      )}
    </section>
  )
}

type FadeEdge = 'fadeIn' | 'fadeOut'

type FadeDrag = {
  edge: FadeEdge
  pointerId: number
  pointerTarget: HTMLElement
  surfaceLeft: number
  surfaceWidth: number
}

const POINTER_DRAG_THRESHOLD_PX = 3

export type AudioDetailGridLine = { beat: number; positionPercent: number; kind: 'bar' | 'beat' }

/** Aligns the Audio Detail grid to project bars, even when the region starts mid-bar. */
export function getAudioDetailGridLines(
  clipStartBeat: number,
  clipDurationBeats: number,
  timeSignature: TimeSignature,
): AudioDetailGridLine[] {
  if (!Number.isFinite(clipDurationBeats) || clipDurationBeats <= 0) return []
  const beatUnit = 4 / timeSignature.denominator
  const barLength = timeSignature.numerator * beatUnit
  if (!Number.isFinite(beatUnit) || beatUnit <= 0 || !Number.isFinite(barLength) || barLength <= 0) return []
  const clipEndBeat = clipStartBeat + clipDurationBeats
  const firstIndex = Math.ceil((clipStartBeat - NOTE_EPSILON) / beatUnit)
  const lastIndex = Math.floor((clipEndBeat + NOTE_EPSILON) / beatUnit)
  const boundaryCount = Math.max(0, lastIndex - firstIndex + 1)
  const showBeatLines = boundaryCount <= 512
  const lines: AudioDetailGridLine[] = []
  for (let index = firstIndex; index <= lastIndex; index += 1) {
    const beat = index * beatUnit
    const barRatio = beat / barLength
    const kind = Math.abs(barRatio - Math.round(barRatio)) < NOTE_EPSILON ? 'bar' : 'beat'
    if (kind === 'beat' && !showBeatLines) continue
    lines.push({
      beat,
      positionPercent: ((beat - clipStartBeat) / clipDurationBeats) * 100,
      kind,
    })
  }
  return lines
}

const capturePointer = (target: HTMLElement, pointerId: number) => {
  try {
    target.setPointerCapture?.(pointerId)
  } catch {
    // A browser can reject capture when the pointer has already been cancelled.
  }
}

const releasePointer = (target: HTMLElement, pointerId: number) => {
  try {
    if (target.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId)
  } catch {
    // Releasing an already-lost capture is harmless to the edit transaction.
  }
}

function AudioDetail({
  clip,
  asset,
  playheadBeat,
  bpm,
  timeSignature,
  snapping,
  snapDivision,
  onSeek,
  onEditAudio,
}: {
  clip: Clip & { kind: 'audio' }
  asset?: AudioAsset
  playheadBeat: number
  bpm: number
  timeSignature: TimeSignature
  snapping: boolean
  snapDivision: number
  onSeek?: DetailEditorProps['onSeek']
  onEditAudio?: DetailEditorProps['onEditAudio']
}) {
  const waveformStageRef = useRef<HTMLDivElement>(null)
  const seekingPointerRef = useRef<number | null>(null)
  const fadeDragRef = useRef<FadeDrag | null>(null)
  const [fadeDrag, setFadeDrag] = useState<FadeDrag | null>(null)
  const [fadePreview, setFadePreview] = useState<number | null>(null)
  const relative = (playheadBeat - clip.startBeat) / Math.max(0.001, clip.durationBeats)
  const waveform = asset?.waveform?.[0]
  const peakValues = waveform?.max ?? []
  const sourceSlices = getClipSourceSlices(clip)
  const sourceDurationBeats = asset ? getAudioSourceDurationBeats(clip, asset) : 0
  const playbackRate = getAudioClipPlaybackRate(clip, bpm)
  const renderedSlices = sourceSlices
    .slice(0, 256)
    .map((slice) => getRenderableDetailSourceSlice(slice, sourceDurationBeats, 1000))
    .filter((slice): slice is RenderableSourceSlice => Boolean(slice))
  const waveformD = waveformPath(waveform, 1000, 150)
  const clipDurationSeconds = Math.max(0, beatsToSeconds(clip.durationBeats, bpm))
  const displayedFadeIn = clamp(
    fadeDrag?.edge === 'fadeIn' && fadePreview !== null ? fadePreview : clip.fadeIn,
    0,
    clipDurationSeconds,
  )
  const displayedFadeOut = clamp(
    fadeDrag?.edge === 'fadeOut' && fadePreview !== null ? fadePreview : clip.fadeOut,
    0,
    clipDurationSeconds,
  )
  const fadeInRatio = clipDurationSeconds > 0 ? displayedFadeIn / clipDurationSeconds : 0
  const fadeOutRatio = clipDurationSeconds > 0 ? displayedFadeOut / clipDurationSeconds : 0
  const sourceReadLabel = sourceSlices.length === 1
    ? `Source ${sourceSlices[0].sourceStartBeat.toFixed(2)}–${(sourceSlices[0].sourceStartBeat + sourceSlices[0].durationBeats).toFixed(2)} beats`
    : `${sourceSlices.length} source reads${clip.sourceLoop ? ` · ${clip.sourceLoop.cycleLengthBeats.toFixed(2)}-beat loop` : ''}`
  const musicalGridLines = getAudioDetailGridLines(clip.startBeat, clip.durationBeats, timeSignature)

  const cancelFadeDrag = () => {
    const active = fadeDragRef.current
    fadeDragRef.current = null
    if (active) releasePointer(active.pointerTarget, active.pointerId)
    setFadeDrag(null)
    setFadePreview(null)
  }
  const cancelFadeDragRef = useRef(cancelFadeDrag)
  cancelFadeDragRef.current = cancelFadeDrag

  useEffect(() => {
    cancelFadeDragRef.current()
  }, [clip.id])

  useEffect(() => {
    const cancel = () => cancelFadeDragRef.current()
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') cancel()
    }
    window.addEventListener('blur', cancel)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.removeEventListener('blur', cancel)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      const active = fadeDragRef.current
      fadeDragRef.current = null
      if (active) releasePointer(active.pointerTarget, active.pointerId)
    }
  }, [])

  useEffect(() => {
    if (!fadeDrag) return
    const valueAtPointer = (clientX: number) => {
      const ratio = clamp((clientX - fadeDrag.surfaceLeft) / fadeDrag.surfaceWidth, 0, 1)
      return clipDurationSeconds * (fadeDrag.edge === 'fadeIn' ? ratio : 1 - ratio)
    }
    const onMove = (event: PointerEvent) => {
      if (event.pointerId !== fadeDrag.pointerId) return
      const next = valueAtPointer(event.clientX)
      setFadePreview(next)
    }
    const onUp = (event: PointerEvent) => {
      if (event.pointerId !== fadeDrag.pointerId) return
      const next = valueAtPointer(event.clientX)
      releasePointer(fadeDrag.pointerTarget, fadeDrag.pointerId)
      fadeDragRef.current = null
      setFadeDrag(null)
      setFadePreview(null)
      onEditAudio?.({ [fadeDrag.edge]: next })
    }
    const onCancel = (event: PointerEvent) => {
      if (event.pointerId !== fadeDrag.pointerId) return
      cancelFadeDrag()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
    }
  }, [fadeDrag, clipDurationSeconds, onEditAudio])

  const seekAtPointer = (clientX: number) => {
    const bounds = waveformStageRef.current?.getBoundingClientRect()
    if (!bounds?.width) return
    const ratio = clamp((clientX - bounds.left) / bounds.width, 0, 1)
    onSeek?.(clip.startBeat + ratio * clip.durationBeats)
  }

  const seekByKeyboard = (event: React.KeyboardEvent) => {
    let next: number | null = null
    const step = snapping ? snapDivision : 0.05
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = playheadBeat - step
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = playheadBeat + step
    if (event.key === 'Home') next = clip.startBeat
    if (event.key === 'End') next = clip.startBeat + clip.durationBeats
    if (next === null) return
    event.preventDefault()
    onSeek?.(clamp(next, clip.startBeat, clip.startBeat + clip.durationBeats))
  }

  const beginFadeDrag = (event: React.PointerEvent<HTMLElement>, edge: FadeEdge) => {
    if ((typeof event.button === 'number' && event.button !== 0) || event.isPrimary === false || fadeDragRef.current) return
    const bounds = waveformStageRef.current?.getBoundingClientRect()
    if (!bounds?.width || clipDurationSeconds <= 0) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.focus()
    capturePointer(event.currentTarget, event.pointerId)
    const initial = edge === 'fadeIn' ? displayedFadeIn : displayedFadeOut
    const nextDrag = {
      edge,
      pointerId: event.pointerId,
      pointerTarget: event.currentTarget,
      surfaceLeft: bounds.left,
      surfaceWidth: bounds.width,
    }
    setFadePreview(initial)
    fadeDragRef.current = nextDrag
    setFadeDrag(nextDrag)
  }

  const editFadeByKeyboard = (
    event: React.KeyboardEvent,
    edge: FadeEdge,
    current: number,
  ) => {
    const step = event.shiftKey ? 0.1 : 0.01
    let next: number | null = null
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = current - step
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = current + step
    if (event.key === 'Home') next = 0
    if (event.key === 'End') next = clipDurationSeconds
    if (next === null) return
    event.preventDefault()
    onEditAudio?.({ [edge]: clamp(next, 0, clipDurationSeconds) })
  }

  return (
    <div className="audio-detail-canvas timeline-grid">
      <div className="detail-ruler" aria-hidden="true">{Array.from({ length: 9 }, (_, index) => <span key={index} style={{ left: `${(index / 8) * 100}%` }}>{(clip.startBeat + (clip.durationBeats * index) / 8).toFixed(1)}</span>)}</div>
      <div className="detail-waveform-stage" ref={waveformStageRef}>
        {waveform && sourceDurationBeats > 0 ? (
          <div className="detail-waveform-slices" role="img" aria-label={`${clip.name} non-destructive clip-slice waveform. ${sourceReadLabel}.`}>
            {renderedSlices.map((slice, index) => (
              <svg
                key={`${slice.placementStartBeat}-${index}`}
                className="detail-waveform-slice"
                viewBox={`${slice.viewStart} 0 ${slice.viewWidth} 150`}
                preserveAspectRatio="none"
                aria-hidden="true"
                style={{
                  left: `${(slice.placementStartBeat / clip.durationBeats) * 100}%`,
                  width: `${(slice.durationBeats / clip.durationBeats) * 100}%`,
                }}
              >
                <path d={waveformD} />
              </svg>
            ))}
          </div>
        ) : <div className="detail-media-state" role="note">Waveform unavailable for this source</div>}
        <div className="audio-detail-musical-grid" aria-hidden="true">
          {musicalGridLines.map((line) => <i
            key={`${line.kind}-${line.beat}`}
            className={`is-${line.kind}`}
            style={{ left: `${line.positionPercent}%` }}
          />)}
        </div>
        <div
          className="detail-waveform-seek"
          role="slider"
          tabIndex={0}
          aria-label={`${clip.name} waveform playhead`}
          aria-valuemin={clip.startBeat}
          aria-valuemax={clip.startBeat + clip.durationBeats}
          aria-valuenow={clamp(playheadBeat, clip.startBeat, clip.startBeat + clip.durationBeats)}
          aria-valuetext={`${clamp(playheadBeat - clip.startBeat, 0, clip.durationBeats).toFixed(2)} beats into region`}
          onKeyDown={seekByKeyboard}
          onPointerDown={(event) => {
            seekingPointerRef.current = event.pointerId
            event.currentTarget.setPointerCapture?.(event.pointerId)
            event.currentTarget.focus()
            seekAtPointer(event.clientX)
          }}
          onPointerMove={(event) => {
            if (seekingPointerRef.current === event.pointerId) seekAtPointer(event.clientX)
          }}
          onPointerUp={(event) => {
            if (seekingPointerRef.current !== event.pointerId) return
            seekAtPointer(event.clientX)
            seekingPointerRef.current = null
            if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
          }}
          onPointerCancel={() => { seekingPointerRef.current = null }}
        />
        <svg className="fade-curve fade-in-curve" style={{ width: `${fadeInRatio * 100}%` }} viewBox="0 0 100 72" preserveAspectRatio="none" aria-hidden="true"><path d="M 0 72 L 100 0" /></svg>
        <svg className="fade-curve fade-out-curve" style={{ width: `${fadeOutRatio * 100}%` }} viewBox="0 0 100 72" preserveAspectRatio="none" aria-hidden="true"><path d="M 0 0 L 100 72" /></svg>
        <div
          className="fade-handle fade-in-handle"
          style={{ left: `${fadeInRatio * 100}%` }}
          role="slider"
          tabIndex={0}
          aria-label="Audio fade in"
          aria-orientation="horizontal"
          aria-valuemin={0}
          aria-valuemax={clipDurationSeconds}
          aria-valuenow={Number(displayedFadeIn.toFixed(3))}
          aria-valuetext={`${displayedFadeIn.toFixed(2)} seconds`}
          onPointerDown={(event) => beginFadeDrag(event, 'fadeIn')}
          onKeyDown={(event) => editFadeByKeyboard(event, 'fadeIn', displayedFadeIn)}
        />
        <div
          className="fade-handle fade-out-handle"
          style={{ right: `${fadeOutRatio * 100}%` }}
          role="slider"
          tabIndex={0}
          aria-label="Audio fade out"
          aria-orientation="horizontal"
          aria-valuemin={0}
          aria-valuemax={clipDurationSeconds}
          aria-valuenow={Number(displayedFadeOut.toFixed(3))}
          aria-valuetext={`${displayedFadeOut.toFixed(2)} seconds`}
          onPointerDown={(event) => beginFadeDrag(event, 'fadeOut')}
          onKeyDown={(event) => editFadeByKeyboard(event, 'fadeOut', displayedFadeOut)}
        />
        {relative >= 0 && relative <= 1 && <div className="detail-playhead audio-detail-playhead" style={{ left: `${relative * 100}%` }} aria-hidden="true" />}
      </div>
      {peakValues.length > 0 && <div className="onset-reference" role="img" aria-label={`Read-only source peak overview, ${Math.min(22, peakValues.length)} bins`}><span>READ-ONLY SOURCE PEAK OVERVIEW</span>{Array.from({ length: Math.min(22, peakValues.length) }, (_, index) => { const peak = Math.abs(peakValues[Math.floor((index / Math.min(22, peakValues.length)) * peakValues.length)] ?? 0); return <i key={index} style={{ left: `${3 + index * (94 / Math.min(22, peakValues.length))}%`, height: `${Math.max(8, peak * 92)}%` }} /> })}</div>}
      <footer className="detail-footer" role="note" aria-label="Clip-slice edits are non-destructive. Source audio bytes are immutable.">
        <span className="detail-mode-label is-active">CLIP SLICE</span>
        <span className="detail-source-read" aria-label={clip.timebase.mode === 'fixed-seconds'
          ? 'Fixed seconds, original speed'
          : `Follow tempo with repitch, ${playbackRate.toFixed(2)} times playback rate`}>
          {clip.timebase.mode === 'fixed-seconds' ? 'FIXED SECONDS · 1.00×' : `TEMPO FOLLOW · REPITCH ${playbackRate.toFixed(2)}×`}
        </span>
        <span className="detail-source-read" title={`${sourceReadLabel}. Fade in ${clip.fadeIn.toFixed(3)} seconds, fade out ${clip.fadeOut.toFixed(3)} seconds.`}>{sourceReadLabel}</span>
        <span className="detail-footer-spacer" />
        <span>SOURCE BYTES IMMUTABLE</span>
      </footer>
    </div>
  )
}

function MidiDetail({
  clip,
  track,
  asset,
  playheadBeat,
  bpm,
  snapping,
  snapDivision,
  tool,
  onToolChange,
  onEditNote,
  onDeleteNote,
  onEditNotes,
  onDeleteNotes,
  onAddNote,
  onQuantize,
  onAuditionMidiNote,
}: {
  clip: MidiClip
  track?: MidiTrack
  asset?: AudioAsset
  playheadBeat: number
  bpm: number
  snapping: boolean
  snapDivision: number
  tool: MidiTool
  onToolChange: (tool: MidiTool) => void
  onEditNote: DetailEditorProps['onEditNote']
  onDeleteNote: DetailEditorProps['onDeleteNote']
  onEditNotes?: DetailEditorProps['onEditNotes']
  onDeleteNotes?: DetailEditorProps['onDeleteNotes']
  onAddNote: DetailEditorProps['onAddNote']
  onQuantize: DetailEditorProps['onQuantize']
  onAuditionMidiNote?: DetailEditorProps['onAuditionMidiNote']
}) {
  const pianoScrollRef = useRef<HTMLDivElement>(null)
  const pianoKeyRefs = useRef(new Map<number, HTMLButtonElement>())
  const gridRef = useRef<HTMLDivElement>(null)
  const velocityRef = useRef<HTMLDivElement>(null)
  const activeAuditionRef = useRef<ActiveMidiAudition | null>(null)
  const interactionRef = useRef<MidiPointerInteraction | null>(null)
  const [interaction, setInteraction] = useState<MidiPointerInteraction | null>(null)
  const [selectedNoteIds, setSelectedNoteIds] = useState<ReadonlySet<string>>(() => new Set())
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null)
  const [focusedPianoPitch, setFocusedPianoPitch] = useState(60)
  const [quantizeDivision, setQuantizeDivision] = useState<NoteDivision>('1/16')
  const [quantizeStrength, setQuantizeStrength] = useState(0.78)

  const actualInstances = useMemo(() => renderedNoteInstances(clip), [clip])
  const previewEdits = interaction && (interaction.kind === 'move' || interaction.kind === 'resize')
    ? interaction.previewEdits
    : []
  const previewClip = useMemo(() => {
    if (previewEdits.length === 0) return clip
    const patches = new Map(previewEdits.map((edit) => [edit.id, edit.patch]))
    return {
      ...clip,
      notes: clip.notes.map((note) => ({ ...note, ...patches.get(note.id) })),
    }
  }, [clip, previewEdits])
  const instances = useMemo(() => renderedNoteInstances(previewClip), [previewClip])
  const actualPrimaryInstances = actualInstances.filter((instance) => instance.primary)
  const primaryInstances = instances.filter((instance) => instance.primary)
  const visibleNotes = actualInstances.length > 0 ? actualInstances.map((instance) => instance.note) : clip.notes
  const visibleSourceIds = [...new Set(actualInstances.map((instance) => instance.note.id))]
  const selectedNotes = clip.notes.filter((note) => selectedNoteIds.has(note.id))
  const selectedNote = selectedNotes.length === 1 ? selectedNotes[0] : undefined
  const selectedInstance = selectedNote
    ? actualPrimaryInstances.find((instance) => instance.note.id === selectedNote.id)
    : undefined
  const selectedRepeatCount = selectedInstance?.repeatCount ?? 0
  const pitchGridStyle = {
    '--piano-row-count': PIANO_PITCH_COUNT,
    '--piano-row-height': `${PIANO_ROW_HEIGHT_PX}px`,
    '--piano-content-height': `${PIANO_CONTENT_HEIGHT_PX}px`,
  } as React.CSSProperties
  const ghostMapping = extractionGhostMapping(clip, bpm)
  const ghostSourceDuration = asset ? secondsToBeats(asset.durationSeconds, ghostMapping.bpm) : 0
  const ghostSlices = getClipSourceSlices(ghostMapping)
    .slice(0, 256)
    .map((slice) => getRenderableDetailSourceSlice(slice, ghostSourceDuration, 1000))
    .filter((slice): slice is RenderableSourceSlice => Boolean(slice))
  const ghostPath = waveformPath(asset?.waveform?.[0], 1000, 100)
  const auditionRouteKey = track
    ? `${track.id}:${track.midi.channel}:${JSON.stringify(track.midi.instrument)}`
    : 'no-midi-track'
  const noteStep = snapping ? snapDivision : 0.05

  const replaceSelection = (ids: Iterable<string>, activeId?: string | null) => {
    const available = new Set(clip.notes.map((note) => note.id))
    const next = new Set([...ids].filter((id) => available.has(id)))
    setSelectedNoteIds(next)
    setActiveNoteId(activeId && next.has(activeId) ? activeId : next.values().next().value ?? null)
  }

  const toggleSelection = (noteId: string) => {
    const next = new Set(selectedNoteIds)
    if (next.has(noteId)) next.delete(noteId)
    else next.add(noteId)
    replaceSelection(next, next.has(noteId) ? noteId : activeNoteId)
    return next
  }

  const commitEdits = (candidateEdits: readonly MidiNoteEdit[]) => {
    const notesById = new Map(clip.notes.map((note) => [note.id, note]))
    const merged = new Map<string, Partial<MidiNote>>()
    candidateEdits.forEach(({ id, patch }) => {
      if (!notesById.has(id)) return
      merged.set(id, { ...merged.get(id), ...patch })
    })
    const edits = [...merged].flatMap(([id, patch]) => {
      const note = notesById.get(id)!
      const changed = Object.fromEntries(Object.entries(patch).filter(([key, value]) => (
        typeof value !== 'number'
        || Math.abs(value - Number(note[key as keyof MidiNote])) > NOTE_EPSILON
      ))) as Partial<MidiNote>
      return Object.keys(changed).length > 0 ? [{ id, patch: changed }] : []
    })
    if (edits.length === 0) return
    if (onEditNotes) onEditNotes(edits)
    else edits.forEach(({ id, patch }) => onEditNote(id, patch))
  }

  const commitDeletes = (ids: Iterable<string>) => {
    const existing = new Set(clip.notes.map((note) => note.id))
    const unique = [...new Set(ids)].filter((id) => existing.has(id))
    if (unique.length === 0) return
    if (onDeleteNotes) onDeleteNotes(unique)
    else unique.forEach(onDeleteNote)
  }

  const selectedFor = (ids: Iterable<string> = selectedNoteIds) => {
    const wanted = new Set(ids)
    return clip.notes.filter((note) => wanted.has(note.id))
  }

  const groupMoveEdits = (ids: Iterable<string>, requestedStartDelta: number, requestedPitchDelta: number): MidiNoteEdit[] => {
    const notes = selectedFor(ids)
    if (notes.length === 0) return []
    const window = sourceWindow(clip)
    let minimumStartDelta = -Infinity
    let maximumStartDelta = Infinity
    let minimumPitchDelta = -Infinity
    let maximumPitchDelta = Infinity
    notes.forEach((note) => {
      const minimumStart = Math.max(0, window.startBeat - note.durationBeats + MIN_NOTE_BEATS)
      const maximumStart = Math.max(minimumStart, window.endBeat - MIN_NOTE_BEATS)
      minimumStartDelta = Math.max(minimumStartDelta, minimumStart - note.startBeat)
      maximumStartDelta = Math.min(maximumStartDelta, maximumStart - note.startBeat)
      minimumPitchDelta = Math.max(minimumPitchDelta, -note.pitch)
      maximumPitchDelta = Math.min(maximumPitchDelta, 127 - note.pitch)
    })
    const startDelta = clamp(requestedStartDelta, minimumStartDelta, maximumStartDelta)
    const pitchDelta = clamp(Math.round(requestedPitchDelta), minimumPitchDelta, maximumPitchDelta)
    return notes.map((note) => ({
      id: note.id,
      patch: {
        startBeat: note.startBeat + startDelta,
        pitch: note.pitch + pitchDelta,
      },
    }))
  }

  const editSelectedPitchDelta = (delta: number) => commitEdits(groupMoveEdits(selectedNoteIds, 0, delta))
  const editSelectedStartDelta = (delta: number) => commitEdits(groupMoveEdits(selectedNoteIds, delta, 0))

  const editSelectedLengthDelta = (requestedDelta: number) => {
    if (selectedNotes.length === 0) return
    const window = sourceWindow(clip)
    let minimumDelta = -Infinity
    let maximumDelta = Infinity
    selectedNotes.forEach((note) => {
      minimumDelta = Math.max(minimumDelta, MIN_NOTE_BEATS - note.durationBeats)
      maximumDelta = Math.min(maximumDelta, Math.max(MIN_NOTE_BEATS, window.endBeat - note.startBeat) - note.durationBeats)
    })
    const delta = clamp(requestedDelta, minimumDelta, maximumDelta)
    commitEdits(selectedNotes.map((note) => ({ id: note.id, patch: { durationBeats: note.durationBeats + delta } })))
  }

  const setSelectedPitch = (value: number) => {
    const pitch = clamp(Math.round(value), 0, 127)
    commitEdits(selectedNotes.map((note) => ({ id: note.id, patch: { pitch } })))
  }

  const setSelectedLength = (value: number) => {
    const window = sourceWindow(clip)
    commitEdits(selectedNotes.map((note) => ({
      id: note.id,
      patch: { durationBeats: clamp(value, MIN_NOTE_BEATS, Math.max(MIN_NOTE_BEATS, window.endBeat - note.startBeat)) },
    })))
  }

  const setSelectedVelocity = (value: number) => {
    const velocity = clamp(value, 1 / 127, 1)
    commitEdits(selectedNotes.map((note) => ({ id: note.id, patch: { velocity } })))
  }

  const stopActiveAudition = () => {
    const active = activeAuditionRef.current
    activeAuditionRef.current = null
    if (active) active.callback(active.pitch, 'stop', active.track)
  }

  const auditionPitch = (pitch: number, phase: 'start' | 'stop') => {
    const active = activeAuditionRef.current
    if (phase === 'stop') {
      if (!active || active.pitch !== pitch) return
      stopActiveAudition()
      return
    }
    if (active?.pitch === pitch) return
    if (active) stopActiveAudition()
    if (!track || !onAuditionMidiNote) return
    const next = { pitch, track, callback: onAuditionMidiNote }
    activeAuditionRef.current = next
    next.callback(pitch, 'start', track)
  }

  const clearInteraction = (restoreMarquee = false) => {
    const current = interactionRef.current
    interactionRef.current = null
    if (current) releasePointer(current.pointerTarget, current.pointerId)
    if (restoreMarquee && current?.kind === 'marquee') {
      replaceSelection(current.baseSelection, current.baseActiveNoteId)
    }
    setInteraction(null)
  }

  const cancelMidiInteraction = () => {
    clearInteraction(true)
    stopActiveAudition()
  }
  const cancelMidiInteractionRef = useRef(cancelMidiInteraction)
  cancelMidiInteractionRef.current = cancelMidiInteraction

  const keepPitchInView = (pitch: number) => {
    const viewport = pianoScrollRef.current
    if (!viewport || viewport.clientHeight <= 0) return
    const rowTop = (127 - clamp(pitch, 0, 127)) * PIANO_ROW_HEIGHT_PX
    const rowBottom = rowTop + PIANO_ROW_HEIGHT_PX
    const margin = Math.min(PIANO_ROW_HEIGHT_PX, viewport.clientHeight / 4)
    const maximumScroll = Math.max(0, PIANO_CONTENT_HEIGHT_PX - viewport.clientHeight)
    if (rowTop < viewport.scrollTop + margin) viewport.scrollTop = clamp(rowTop - margin, 0, maximumScroll)
    else if (rowBottom > viewport.scrollTop + viewport.clientHeight - margin) {
      viewport.scrollTop = clamp(rowBottom + margin - viewport.clientHeight, 0, maximumScroll)
    }
  }

  const interactionPoint = (current: PointerOwner, event: PointerEvent | React.PointerEvent) => ({
    x: clamp(event.clientX - current.surfaceLeft, 0, current.width),
    y: clamp(event.clientY - current.surfaceTop, 0, current.height),
  })

  const instanceBounds = (instance: RenderedNoteInstance, width: number) => {
    const noteLeft = (instance.placementStartBeat / clip.durationBeats) * width
    const noteWidth = Math.max(5, (instance.durationBeats / clip.durationBeats) * width)
    const noteTop = (127 - instance.note.pitch) * PIANO_ROW_HEIGHT_PX
    return {
      left: noteLeft,
      top: noteTop,
      right: noteLeft + noteWidth,
      bottom: noteTop + PIANO_ROW_HEIGHT_PX,
    }
  }

  const instanceIntersectsRect = (
    instance: RenderedNoteInstance,
    left: number,
    top: number,
    right: number,
    bottom: number,
    width: number,
  ) => {
    const bounds = instanceBounds(instance, width)
    return bounds.left < right && bounds.right > left
      && bounds.top < bottom && bounds.bottom > top
  }

  const segmentIntersectsRect = (
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    left: number,
    top: number,
    right: number,
    bottom: number,
  ) => {
    const deltaX = endX - startX
    const deltaY = endY - startY
    let minimumT = 0
    let maximumT = 1
    const boundaries: ReadonlyArray<readonly [number, number]> = [
      [-deltaX, startX - left],
      [deltaX, right - startX],
      [-deltaY, startY - top],
      [deltaY, bottom - startY],
    ]
    for (const [direction, distance] of boundaries) {
      if (Math.abs(direction) <= NOTE_EPSILON) {
        if (distance < 0) return false
        continue
      }
      const ratio = distance / direction
      if (direction < 0) minimumT = Math.max(minimumT, ratio)
      else maximumT = Math.min(maximumT, ratio)
      if (minimumT > maximumT) return false
    }
    return true
  }

  const idsInsideMarquee = (current: MarqueeInteraction) => {
    const left = Math.min(current.originX, current.currentX)
    const right = Math.max(current.originX, current.currentX)
    const top = Math.min(current.originY, current.currentY)
    const bottom = Math.max(current.originY, current.currentY)
    return new Set(actualInstances
      .filter((instance) => instanceIntersectsRect(instance, left, top, right, bottom, current.width))
      .map((instance) => instance.note.id))
  }

  const pointHitsNote = (x: number, y: number, width: number) => actualInstances.some((instance) => (
    instanceIntersectsRect(instance, x, y, x + 1, y + 1, width)
  ))

  const idsAlongEraser = (current: EraseInteraction, nextX: number, nextY: number) => {
    const ids = new Set(current.noteIds)
    actualInstances.forEach((instance) => {
      const bounds = instanceBounds(instance, current.width)
      if (segmentIntersectsRect(
        current.previousX,
        current.previousY,
        nextX,
        nextY,
        bounds.left - ERASER_RADIUS_PX,
        bounds.top - ERASER_RADIUS_PX,
        bounds.right + ERASER_RADIUS_PX,
        bounds.bottom + ERASER_RADIUS_PX,
      )) ids.add(instance.note.id)
    })
    return [...ids]
  }

  useEffect(() => () => {
    const current = interactionRef.current
    interactionRef.current = null
    if (current) releasePointer(current.pointerTarget, current.pointerId)
    stopActiveAudition()
  }, [])

  useEffect(() => {
    cancelMidiInteractionRef.current()
  }, [clip.id, auditionRouteKey])

  useEffect(() => {
    const cancel = () => cancelMidiInteractionRef.current()
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') cancel()
    }
    window.addEventListener('blur', cancel)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.removeEventListener('blur', cancel)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])

  useEffect(() => {
    replaceSelection([])
    setFocusedPianoPitch(visibleNotes[0]?.pitch ?? 60)
  }, [clip.id])

  useEffect(() => {
    const viewport = pianoScrollRef.current
    if (!viewport) return
    const pitches = visibleNotes.map((note) => note.pitch)
    const minimumPitch = pitches.length > 0 ? Math.min(...pitches) : 60
    const maximumPitch = pitches.length > 0 ? Math.max(...pitches) : 60
    const centerY = (127 - (minimumPitch + maximumPitch) / 2 + 0.5) * PIANO_ROW_HEIGHT_PX
    viewport.scrollTop = clamp(centerY - viewport.clientHeight / 2, 0, Math.max(0, PIANO_CONTENT_HEIGHT_PX - viewport.clientHeight))
  }, [clip.id])

  useEffect(() => {
    const existing = new Set(clip.notes.map((note) => note.id))
    const next = new Set([...selectedNoteIds].filter((id) => existing.has(id)))
    if (next.size !== selectedNoteIds.size) replaceSelection(next, activeNoteId)
  }, [clip.notes])

  useEffect(() => {
    const focusedKey = pianoKeyRefs.current.get(focusedPianoPitch)
    const activePitch = clip.notes.find((note) => note.id === activeNoteId)?.pitch
    keepPitchInView(focusedKey === document.activeElement ? focusedPianoPitch : activePitch ?? focusedPianoPitch)
  }, [focusedPianoPitch, activeNoteId, clip.notes])

  useEffect(() => {
    if (!interaction) return
    const onMove = (event: PointerEvent) => {
      const current = interactionRef.current
      if (!current || event.pointerId !== current.pointerId) return
      const point = interactionPoint(current, event)
      const moved = current.moved || Math.hypot(point.x - current.originX, point.y - current.originY) >= POINTER_DRAG_THRESHOLD_PX
      let next: MidiPointerInteraction = { ...current, moved }
      if (moved && current.kind === 'move') {
        const anchor = clip.notes.find((note) => note.id === current.anchorNoteId)
        if (anchor) {
          const beatDelta = ((point.x - current.originX) / current.width) * clip.durationBeats
          const rawPlacement = clamp(current.anchorPlacementStartBeat + beatDelta, 0, Math.max(0, clip.durationBeats - current.anchorPlacementDurationBeats))
          const desiredPlacement = snapping ? snapBeat(rawPlacement, snapDivision) : rawPlacement
          const mapped = sourceStartForPlacement(clip, anchor, current.anchorPlacementStartBeat, desiredPlacement)
          const pitchDelta = Math.round((current.originY - point.y) / PIANO_ROW_HEIGHT_PX)
          next = { ...current, moved, previewEdits: groupMoveEdits(current.selectedIds, mapped.sourceStartBeat - anchor.startBeat, pitchDelta) }
        }
      } else if (moved && current.kind === 'resize') {
        const note = clip.notes.find((candidate) => candidate.id === current.noteId)
        if (note) {
          const requested = note.durationBeats + ((point.x - current.originX) / current.width) * clip.durationBeats
          const maximum = Math.max(MIN_NOTE_BEATS, sourceWindow(clip).endBeat - note.startBeat)
          const durationBeats = clamp(snapping ? Math.max(MIN_NOTE_BEATS, snapBeat(requested, snapDivision)) : requested, MIN_NOTE_BEATS, maximum)
          next = { ...current, moved, previewEdits: [{ id: note.id, patch: { durationBeats } }] }
        }
      } else if (current.kind === 'marquee') {
        next = { ...current, moved, currentX: point.x, currentY: point.y }
        if (moved) {
          const hits = idsInsideMarquee(next)
          const ids = current.union ? new Set([...current.baseSelection, ...hits]) : hits
          replaceSelection(ids, hits.values().next().value ?? current.baseActiveNoteId)
        }
      } else if (current.kind === 'draw') {
        const rawDuration = Math.max(MIN_NOTE_BEATS, ((point.x / current.width) * clip.durationBeats) - current.placementStartBeat)
        const maximum = Math.max(MIN_NOTE_BEATS, Math.min(
          clip.durationBeats - current.placementStartBeat,
          sourceWindow(clip).endBeat - current.sourceStartBeat,
        ))
        const durationBeats = moved
          ? clamp(snapping ? Math.max(MIN_NOTE_BEATS, snapBeat(rawDuration, snapDivision)) : rawDuration, MIN_NOTE_BEATS, maximum)
          : current.previewDurationBeats
        next = { ...current, moved, previewDurationBeats: durationBeats }
      } else if (current.kind === 'erase') {
        next = {
          ...current,
          moved,
          previousX: point.x,
          previousY: point.y,
          noteIds: idsAlongEraser(current, point.x, point.y),
        }
      }
      interactionRef.current = next
      setInteraction(next)
    }
    const onUp = (event: PointerEvent) => {
      const current = interactionRef.current
      if (!current || event.pointerId !== current.pointerId) return
      clearInteraction()
      if (current.kind === 'move' || current.kind === 'resize') {
        stopActiveAudition()
        if (current.moved) commitEdits(current.previewEdits)
        else if (current.kind === 'move' && current.clickAction === 'delete') {
          commitDeletes([current.anchorNoteId])
          replaceSelection(
            [...selectedNoteIds].filter((id) => id !== current.anchorNoteId),
            activeNoteId === current.anchorNoteId ? null : activeNoteId,
          )
        }
      } else if (current.kind === 'marquee' && !current.moved && !current.union) {
        replaceSelection([])
      } else if (current.kind === 'draw') {
        onAddNote({
          pitch: current.pitch,
          startBeat: current.sourceStartBeat,
          durationBeats: current.previewDurationBeats,
          velocity: 0.75,
        })
      } else if (current.kind === 'erase') {
        commitDeletes(current.noteIds)
        const deleting = new Set(current.noteIds)
        replaceSelection(
          [...selectedNoteIds].filter((id) => !deleting.has(id)),
          activeNoteId && deleting.has(activeNoteId) ? null : activeNoteId,
        )
      }
    }
    const onCancel = (event: PointerEvent) => {
      if (interactionRef.current?.pointerId !== event.pointerId) return
      cancelMidiInteraction()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
    }
  }, [interaction?.kind, interaction?.pointerId, clip, snapDivision, snapping, selectedNoteIds, onEditNotes, onDeleteNotes])

  const pointerOwner = (event: React.PointerEvent<HTMLElement>, bounds: DOMRect): PointerOwner => {
    capturePointer(event.currentTarget, event.pointerId)
    return {
      pointerId: event.pointerId,
      pointerTarget: event.currentTarget,
      originX: clamp(event.clientX - bounds.left, 0, bounds.width),
      originY: clamp(event.clientY - bounds.top, 0, bounds.height),
      moved: false,
      surfaceLeft: bounds.left,
      surfaceTop: bounds.top,
      width: bounds.width,
      height: bounds.height,
    }
  }

  const isOwnedPrimaryPointer = (event: React.PointerEvent) => (
    !(typeof event.button === 'number' && event.button !== 0)
    && event.isPrimary !== false
    && !interactionRef.current
  )

  const beginNotePointer = (
    event: React.PointerEvent<HTMLElement>,
    instance: RenderedNoteInstance,
    kind: 'move' | 'resize' = 'move',
  ) => {
    if (!isOwnedPrimaryPointer(event)) return
    event.stopPropagation()
    if (tool === 'erase') {
      event.preventDefault()
      const bounds = gridRef.current?.getBoundingClientRect()
      if (!bounds?.width) return
      const owner = pointerOwner(event, bounds)
      const next: EraseInteraction = {
        ...owner,
        kind: 'erase',
        previousX: owner.originX,
        previousY: owner.originY,
        noteIds: [instance.note.id],
      }
      interactionRef.current = next
      setInteraction(next)
      return
    }
    if (tool !== 'select' && tool !== 'draw') return
    const bounds = gridRef.current?.getBoundingClientRect()
    if (!bounds?.width) return
    const wasSelected = selectedNoteIds.has(instance.note.id)
    let ids = selectedNoteIds
    if (kind === 'resize') {
      ids = new Set([instance.note.id])
      replaceSelection(ids, instance.note.id)
    } else if (event.shiftKey) {
      ids = toggleSelection(instance.note.id)
    } else if (!selectedNoteIds.has(instance.note.id)) {
      ids = new Set([instance.note.id])
      replaceSelection(ids, instance.note.id)
    } else {
      setActiveNoteId(instance.note.id)
    }
    if (tool === 'select') auditionPitch(instance.note.pitch, 'start')
    const owner = pointerOwner(event, bounds)
    const next: MidiPointerInteraction = kind === 'resize'
      ? { ...owner, kind, noteId: instance.note.id, originalPitch: instance.note.pitch, previewEdits: [] }
      : {
          ...owner,
          kind,
          anchorNoteId: instance.note.id,
          anchorPitch: instance.note.pitch,
          anchorPlacementStartBeat: instance.placementStartBeat,
          anchorPlacementDurationBeats: instance.durationBeats,
          selectedIds: ids.has(instance.note.id) ? [...ids] : [],
          previewEdits: [],
          clickAction: tool === 'draw' && wasSelected ? 'delete' : undefined,
        }
    interactionRef.current = next
    setInteraction(next)
  }

  const beginGridPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || !isOwnedPrimaryPointer(event)) return
    const bounds = event.currentTarget.getBoundingClientRect()
    if (!bounds.width || !bounds.height) return
    event.currentTarget.focus()
    const owner = pointerOwner(event, bounds)
    if (tool === 'select') {
      const next: MarqueeInteraction = {
        ...owner,
        kind: 'marquee',
        currentX: owner.originX,
        currentY: owner.originY,
        union: event.shiftKey,
        baseSelection: new Set(selectedNoteIds),
        baseActiveNoteId: activeNoteId,
      }
      interactionRef.current = next
      setInteraction(next)
      return
    }
    if (tool === 'erase') {
      const next: EraseInteraction = {
        ...owner,
        kind: 'erase',
        previousX: owner.originX,
        previousY: owner.originY,
        noteIds: [],
      }
      interactionRef.current = next
      setInteraction(next)
      return
    }
    if (tool !== 'draw' || pointHitsNote(owner.originX, owner.originY, owner.width)) {
      releasePointer(owner.pointerTarget, owner.pointerId)
      return
    }
    const placementStartBeat = clamp(
      snapping ? snapBeat((owner.originX / owner.width) * clip.durationBeats, snapDivision) : (owner.originX / owner.width) * clip.durationBeats,
      0,
      Math.max(0, clip.durationBeats - MIN_NOTE_BEATS),
    )
    const window = sourceWindow(clip)
    const sourceStartBeat = clamp(
      sourceBeatAtClipPosition(clip, placementStartBeat),
      Math.max(0, window.startBeat),
      Math.max(Math.max(0, window.startBeat), window.endBeat - MIN_NOTE_BEATS),
    )
    const maximum = Math.max(MIN_NOTE_BEATS, Math.min(clip.durationBeats - placementStartBeat, window.endBeat - sourceStartBeat))
    const next: DrawInteraction = {
      ...owner,
      kind: 'draw',
      placementStartBeat,
      sourceStartBeat,
      pitch: 127 - clamp(Math.floor(owner.originY / PIANO_ROW_HEIGHT_PX), 0, 127),
      previewDurationBeats: Math.min(0.5, maximum),
    }
    interactionRef.current = next
    setInteraction(next)
  }

  const editNoteStartFromPlacement = (instance: RenderedNoteInstance, desiredPlacement: number) => {
    const mapped = sourceStartForPlacement(clip, instance.note, instance.placementStartBeat, desiredPlacement)
    commitEdits([{ id: instance.note.id, patch: { startBeat: mapped.sourceStartBeat } }])
  }

  const velocityFromPointer = (event: React.PointerEvent, noteId: string) => {
    const bounds = velocityRef.current?.getBoundingClientRect()
    if (!bounds) return
    replaceSelection([noteId], noteId)
    commitEdits([{ id: noteId, patch: { velocity: clamp(1 - (event.clientY - bounds.top) / bounds.height, 0.01, 1) } }])
  }

  const focusPianoKey = (pitch: number) => {
    const nextPitch = clamp(pitch, 0, 127)
    setFocusedPianoPitch(nextPitch)
    keepPitchInView(nextPitch)
    pianoKeyRefs.current.get(nextPitch)?.focus({ preventScroll: true })
  }

  const handleAuditionKeyUp = (event: React.KeyboardEvent, pitch: number) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    auditionPitch(pitch, 'stop')
  }

  const handleSelectionKeyDown = (event: React.KeyboardEvent, focusedInstance?: RenderedNoteInstance) => {
    const lower = event.key.toLowerCase()
    if (!event.metaKey && !event.ctrlKey && !event.altKey && (lower === 'b' || lower === 'v' || lower === 'e')) {
      event.preventDefault()
      event.stopPropagation()
      onToolChange(lower === 'b' ? 'draw' : lower === 'v' ? 'select' : 'erase')
      return
    }
    if ((event.metaKey || event.ctrlKey) && lower === 'a') {
      event.preventDefault()
      event.stopPropagation()
      replaceSelection(visibleSourceIds, visibleSourceIds[0] ?? null)
      return
    }
    const anchor = focusedInstance?.note ?? clip.notes.find((note) => note.id === activeNoteId)
    if ((event.metaKey || event.ctrlKey) && event.key === ' ' && anchor) {
      event.preventDefault()
      event.stopPropagation()
      toggleSelection(anchor.id)
      return
    }
    if ((event.key === 'Enter' || event.key === ' ') && anchor) {
      event.preventDefault()
      if (!event.repeat) auditionPitch(anchor.pitch, 'start')
      return
    }
    if (event.key === 'Escape') {
      if (selectedNoteIds.size > 0) {
        event.preventDefault()
        replaceSelection([])
      }
      return
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (selectedNoteIds.size > 0) {
        event.preventDefault()
        commitDeletes(selectedNoteIds)
        replaceSelection([])
      }
      return
    }
    if (event.shiftKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight') && selectedNotes.length === 1) {
      event.preventDefault()
      editSelectedLengthDelta(event.key === 'ArrowRight' ? noteStep : -noteStep)
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      if (selectedNoteIds.size === 0) return
      event.preventDefault()
      editSelectedPitchDelta(event.key === 'ArrowUp' ? 1 : -1)
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      if (selectedNoteIds.size === 0) return
      event.preventDefault()
      editSelectedStartDelta(event.key === 'ArrowRight' ? noteStep : -noteStep)
    }
  }

  const noteStyle = (instance: RenderedNoteInstance, derived: boolean): React.CSSProperties => ({
    left: `${(instance.placementStartBeat / clip.durationBeats) * 100}%`,
    width: `${Math.max(1.5, (instance.durationBeats / clip.durationBeats) * 100)}%`,
    top: `${(127 - instance.note.pitch) * PIANO_ROW_HEIGHT_PX}px`,
    opacity: derived ? 0.28 + instance.note.velocity * 0.24 : 0.5 + instance.note.velocity * 0.5,
  })

  const sharedValue = (key: 'pitch' | 'durationBeats' | 'velocity') => {
    if (selectedNotes.length === 0) return undefined
    const first = selectedNotes[0][key]
    return selectedNotes.every((note) => Math.abs(note[key] - first) <= NOTE_EPSILON) ? first : null
  }
  const sharedPitch = sharedValue('pitch')
  const sharedLength = sharedValue('durationBeats')
  const sharedVelocity = sharedValue('velocity')
  const marquee = interaction?.kind === 'marquee' && interaction.moved ? interaction : null
  const drawPreview = interaction?.kind === 'draw' ? interaction : null
  const erasingNoteIds = new Set(interaction?.kind === 'erase' ? interaction.noteIds : [])

  return (
    <div className="midi-detail-layout">
      <p id="midi-note-keyboard-help" className="sr-only">Focus a source note. Enter or Space auditions it. Arrow keys move the full selection, Shift plus left or right resizes one selected note, Delete removes the full selection, and Control or Command plus A selects all visible source notes. With Pencil, click once to select an unfocused note, click the selected note again to delete it, drag its body to move, or drag its right edge to resize. Eraser deletes every source note crossed by one drag.</p>
      <p id="midi-selection-status" className="sr-only" aria-live="polite">{selectedNoteIds.size === 0 ? 'No source notes selected' : `${selectedNoteIds.size} source notes selected`}</p>
      <aside className="midi-tools">
        <section className="selected-note-inspector" aria-live="polite" aria-label="Selected note inspector">
          <header><span>NOTE</span><strong>{selectedNoteIds.size > 0 ? `${selectedNoteIds.size} selected` : 'No selection'}</strong></header>
          {selectedNotes.length > 0 ? (
            <div className="selected-note-fields">
              {selectedNote && selectedRepeatCount > 1 && <p className="midi-source-scope">{selectedRepeatCount} loop occurrences · one shared source edit</p>}
              <label><span>PITCH{sharedPitch === null ? ' · MIXED' : ''}</span><input aria-label="Selected note pitch" type="number" min="0" max="127" step="1" placeholder={sharedPitch === null ? 'MIXED' : undefined} value={sharedPitch === null ? '' : sharedPitch ?? ''} onKeyDown={(event) => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); editSelectedPitchDelta(event.key === 'ArrowUp' ? 1 : -1) } }} onChange={(event) => { if (event.target.value !== '') setSelectedPitch(Number(event.target.value)) }} /></label>
              {selectedNote && selectedInstance && <label><span>START</span><input aria-label="Selected note start beat" type="number" min="0" max={Math.max(0, clip.durationBeats - selectedInstance.durationBeats)} step={noteStep} value={Number(selectedInstance.placementStartBeat.toFixed(3))} onChange={(event) => { const value = Number(event.target.value); if (Number.isFinite(value)) editNoteStartFromPlacement(selectedInstance, clamp(value, 0, clip.durationBeats - selectedInstance.durationBeats)) }} /></label>}
              <label><span>SOURCE LENGTH{sharedLength === null ? ' · MIXED' : ''}</span><input aria-label="Selected note duration beats" type="number" min={MIN_NOTE_BEATS} step={noteStep} placeholder={sharedLength === null ? 'MIXED' : undefined} value={sharedLength === null ? '' : sharedLength === undefined ? '' : Number(sharedLength.toFixed(3))} onKeyDown={(event) => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); editSelectedLengthDelta(event.key === 'ArrowUp' ? noteStep : -noteStep) } }} onChange={(event) => { if (event.target.value !== '') setSelectedLength(Number(event.target.value)) }} /></label>
              <label><span>VELOCITY · {sharedVelocity === null ? 'MIXED' : Math.round((sharedVelocity ?? 0) * 127)}</span><input aria-label="Selected note velocity" type="range" min="1" max="127" step="1" value={sharedVelocity === null ? 64 : Math.round((sharedVelocity ?? 1 / 127) * 127)} aria-valuetext={sharedVelocity === null ? 'Mixed velocities' : `${Math.round((sharedVelocity ?? 0) * 127)} of 127`} onChange={(event) => setSelectedVelocity(Number(event.target.value) / 127)} /></label>
            </div>
          ) : <p>Select source notes to edit pitch, timing, length, and velocity.</p>}
        </section>
        <div className="midi-quantize-controls">
          <label><span>QUANTIZE</span><select value={quantizeDivision} onChange={(event) => setQuantizeDivision(event.target.value as NoteDivision)}><option value="1/4">1/4</option><option value="1/8">1/8</option><option value="1/8T">1/8 triplet</option><option value="1/16">1/16</option><option value="1/16T">1/16 triplet</option><option value="1/32">1/32</option></select></label>
          <label><span>STRENGTH · {Math.round(quantizeStrength * 100)}%</span><input aria-label="Quantize strength" type="range" min="0" max="1" step="0.01" value={quantizeStrength} onChange={(event) => setQuantizeStrength(Number(event.target.value))} /></label>
          <button
            className="text-button"
            disabled={selectedNoteIds.size === 0}
            aria-label={selectedNoteIds.size === 0 ? 'Apply quantize, select notes first' : `Apply quantize to ${selectedNoteIds.size} selected ${selectedNoteIds.size === 1 ? 'note' : 'notes'}`}
            onClick={() => onQuantize(quantizeDivision, quantizeStrength, [...selectedNoteIds])}
          ><SlidersHorizontal />Apply quantize{selectedNoteIds.size > 0 ? ` · ${selectedNoteIds.size}` : ''}</button>
        </div>
      </aside>
      <div className="piano-roll-wrap" ref={pianoScrollRef}>
        <div className="piano-roll-content" style={pitchGridStyle}>
          <div className="piano-keys" role="group" aria-label="Piano keys">{Array.from({ length: PIANO_PITCH_COUNT }, (_, index) => {
            const pitch = 127 - index
            const noteName = midiNoteName(pitch)
            return <button
              key={pitch}
              ref={(element) => { if (element) pianoKeyRefs.current.set(pitch, element); else pianoKeyRefs.current.delete(pitch) }}
              type="button"
              className={[1, 3, 6, 8, 10].includes(pitch % 12) ? 'black-key' : ''}
              tabIndex={pitch === focusedPianoPitch ? 0 : -1}
              aria-label={`Audition ${noteName}`}
              onFocus={() => setFocusedPianoPitch(pitch)}
              onDoubleClick={(event) => {
                const ids = new Set(actualInstances.filter((instance) => instance.note.pitch === pitch).map((instance) => instance.note.id))
                replaceSelection(event.shiftKey ? new Set([...selectedNoteIds, ...ids]) : ids, ids.values().next().value ?? null)
              }}
              onPointerDown={(event) => {
                if (!isOwnedPrimaryPointer(event)) return
                event.preventDefault()
                event.currentTarget.focus()
                capturePointer(event.currentTarget, event.pointerId)
                auditionPitch(pitch, 'start')
              }}
              onPointerUp={(event) => { auditionPitch(pitch, 'stop'); releasePointer(event.currentTarget, event.pointerId) }}
              onPointerCancel={() => auditionPitch(pitch, 'stop')}
              onLostPointerCapture={() => auditionPitch(pitch, 'stop')}
              onKeyDown={(event) => {
                if ((event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); if (!event.repeat) auditionPitch(pitch, 'start'); return }
                if (event.key === 'ArrowUp' || event.key === 'ArrowRight') { event.preventDefault(); focusPianoKey(pitch + 1) }
                if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') { event.preventDefault(); focusPianoKey(pitch - 1) }
                if (event.key === 'Home') { event.preventDefault(); focusPianoKey(0) }
                if (event.key === 'End') { event.preventDefault(); focusPianoKey(127) }
              }}
              onKeyUp={(event) => handleAuditionKeyUp(event, pitch)}
              onBlur={() => auditionPitch(pitch, 'stop')}
            >{pitch % 12 === 0 ? noteName : ''}</button>
          })}</div>
          <div className={`piano-roll timeline-grid is-tool-${tool}`} ref={gridRef} tabIndex={0} onPointerDown={beginGridPointer} onKeyDown={(event) => handleSelectionKeyDown(event)} role="group" aria-label="MIDI piano roll" aria-describedby="midi-note-keyboard-help midi-selection-status">
            {asset?.waveform?.[0] && ghostSlices.length > 0 && <div className="ghost-waveform" aria-hidden="true">
              {ghostSlices.map((slice, index) => <svg key={`${slice.placementStartBeat}-${index}`} className="ghost-waveform-slice" viewBox={`${slice.viewStart} 0 ${slice.viewWidth} 100`} preserveAspectRatio="none" style={{ left: `${(slice.placementStartBeat / clip.durationBeats) * 100}%`, width: `${(slice.durationBeats / clip.durationBeats) * 100}%` }}><path d={ghostPath} /></svg>)}
            </div>}
            {marquee && <div className="piano-selection-marquee" aria-hidden="true" style={{ left: Math.min(marquee.originX, marquee.currentX), top: Math.min(marquee.originY, marquee.currentY), width: Math.abs(marquee.currentX - marquee.originX), height: Math.abs(marquee.currentY - marquee.originY) }} />}
            {drawPreview && <div className="piano-note is-draw-preview" aria-hidden="true" style={{ left: `${(drawPreview.placementStartBeat / clip.durationBeats) * 100}%`, width: `${Math.max(1.5, (drawPreview.previewDurationBeats / clip.durationBeats) * 100)}%`, top: `${(127 - drawPreview.pitch) * PIANO_ROW_HEIGHT_PX}px` }} />}
            {instances.map((instance) => {
              const selectedSource = selectedNoteIds.has(instance.note.id)
              const erasingSource = erasingNoteIds.has(instance.note.id)
              if (!instance.primary) {
                const editable = tool === 'erase' || tool === 'draw'
                const actionLabel = tool === 'erase'
                  ? `Erase ${midiNoteName(instance.note.pitch)} repeated source note`
                  : `Edit ${midiNoteName(instance.note.pitch)} repeated source note with Draw tool`
                return <div key={instance.instanceKey} className={`piano-note is-derived ${selectedSource ? 'is-source-selected' : ''} ${tool === 'erase' ? 'is-erasable' : editable ? 'is-draw-editable' : ''} ${erasingSource ? 'is-erasing' : ''}`} role={editable ? 'button' : undefined} aria-label={editable ? actionLabel : undefined} aria-hidden={!editable} title={`${midiNoteName(instance.note.pitch)} · derived loop occurrence`} style={noteStyle(instance, true)} onPointerDown={editable ? (event) => beginNotePointer(event, instance) : undefined} />
              }
              const verticalTouchClass = instance.note.pitch >= 126 ? 'is-touch-top' : instance.note.pitch <= 1 ? 'is-touch-bottom' : ''
              const horizontalTouchClass = instance.placementStartBeat <= NOTE_EPSILON ? 'is-touch-left' : instance.placementStartBeat + instance.durationBeats >= clip.durationBeats - NOTE_EPSILON ? 'is-touch-right' : ''
              return <div key={instance.instanceKey} className={`piano-note ${selectedSource ? 'is-selected' : ''} ${tool === 'erase' ? 'is-erasable' : ''} ${erasingSource ? 'is-erasing' : ''} ${verticalTouchClass} ${horizontalTouchClass}`} role="button" tabIndex={0} aria-pressed={selectedSource} aria-describedby="midi-note-keyboard-help" aria-label={`${midiNoteName(instance.note.pitch)}, starts at ${instance.placementStartBeat.toFixed(2)} beats, duration ${instance.durationBeats.toFixed(2)} beats, velocity ${Math.round(instance.note.velocity * 127)}${instance.repeatCount > 1 ? `, source note controls ${instance.repeatCount} loop occurrences` : ''}`} title={`${midiNoteName(instance.note.pitch)} · ${instance.placementStartBeat.toFixed(2)} beats`} style={noteStyle(instance, false)} onClick={(event) => { if (event.detail === 0 && tool === 'select') replaceSelection([instance.note.id], instance.note.id) }} onFocus={() => { setActiveNoteId(instance.note.id); if (!selectedNoteIds.has(instance.note.id)) replaceSelection([instance.note.id], instance.note.id) }} onBlur={() => auditionPitch(instance.note.pitch, 'stop')} onKeyUp={(event) => handleAuditionKeyUp(event, instance.note.pitch)} onKeyDown={(event) => handleSelectionKeyDown(event, instance)} onPointerDown={(event) => beginNotePointer(event, instance)}><span className="note-move-touch-target" aria-hidden="true" />{(tool === 'select' || tool === 'draw') && selectedNoteIds.size <= 1 && <span className="note-resize-handle" role="presentation" aria-hidden="true" onPointerDown={(event) => beginNotePointer(event, instance, 'resize')} />}</div>
            })}
            {playheadBeat >= clip.startBeat && playheadBeat <= clip.startBeat + clip.durationBeats && <div className="detail-playhead" style={{ left: `${((playheadBeat - clip.startBeat) / clip.durationBeats) * 100}%` }} aria-hidden="true" />}
          </div>
        </div>
      </div>
      <div className="velocity-lane" ref={velocityRef}><span>VELOCITY · SOURCE NOTES</span>{primaryInstances.map((instance) => { const velocity = Math.round(instance.note.velocity * 127); const touchEdge = instance.placementStartBeat <= NOTE_EPSILON ? 'is-touch-left' : instance.placementStartBeat >= clip.durationBeats - NOTE_EPSILON ? 'is-touch-right' : ''; return <button key={instance.note.id} className={`${selectedNoteIds.has(instance.note.id) ? 'is-selected' : ''} ${touchEdge}`} role="slider" aria-orientation="vertical" aria-label={`${midiNoteName(instance.note.pitch)} velocity`} aria-valuemin={1} aria-valuemax={127} aria-valuenow={velocity} aria-valuetext={`${velocity} of 127`} style={{ left: `${(instance.placementStartBeat / clip.durationBeats) * 100}%`, height: `${instance.note.velocity * 100}%` }} onFocus={() => replaceSelection([instance.note.id], instance.note.id)} onPointerDown={(event) => { capturePointer(event.currentTarget, event.pointerId); velocityFromPointer(event, instance.note.id) }} onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture?.(event.pointerId)) velocityFromPointer(event, instance.note.id) }} onPointerUp={(event) => releasePointer(event.currentTarget, event.pointerId)} onPointerCancel={(event) => releasePointer(event.currentTarget, event.pointerId)} onKeyDown={(event) => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); commitEdits([{ id: instance.note.id, patch: { velocity: clamp(instance.note.velocity + (event.key === 'ArrowUp' ? 0.05 : -0.05), 0.01, 1) } }]) } }}><span className="velocity-touch-target" aria-hidden="true" /></button> })}</div>
    </div>
  )
}
