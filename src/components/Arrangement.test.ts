// @vitest-environment jsdom

import { createElement } from 'react'
import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArrangedMidiNote } from '../core'
import { createDemoProject, snapBeat } from '../core'
import { getArrangementTimelineBeats } from '../ui/music'
import { AUDIO_SOURCE_DRAG_TYPE } from '../ui/sourceDrag'
import { Arrangement, getRenderableWaveformSlice, midiThumbnailPath } from './Arrangement'

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
})

describe('getRenderableWaveformSlice', () => {
  it('keeps an in-range source read aligned with its placement', () => {
    expect(getRenderableWaveformSlice({
      placementStartBeat: 3,
      durationBeats: 2,
      sourceStartBeat: 4,
    }, 10)).toEqual({
      placementStartBeat: 3,
      durationBeats: 2,
      viewStart: 400,
      viewWidth: 200,
    })
  })

  it('renders only the valid portion of a read that crosses the asset end', () => {
    expect(getRenderableWaveformSlice({
      placementStartBeat: 3,
      durationBeats: 4,
      sourceStartBeat: 8,
    }, 10)).toEqual({
      placementStartBeat: 3,
      durationBeats: 2,
      viewStart: 800,
      viewWidth: 200,
    })
  })

  it('leaves a read entirely beyond the asset duration silent', () => {
    expect(getRenderableWaveformSlice({
      placementStartBeat: 3,
      durationBeats: 4,
      sourceStartBeat: 10,
    }, 10)).toBeNull()
  })

  it('preserves placement alignment when a read begins before the asset', () => {
    expect(getRenderableWaveformSlice({
      placementStartBeat: 3,
      durationBeats: 6,
      sourceStartBeat: -2,
    }, 10)).toEqual({
      placementStartBeat: 5,
      durationBeats: 4,
      viewStart: 0,
      viewWidth: 400,
    })
  })
})

describe('midiThumbnailPath', () => {
  it('bounds 50,000 notes to one deterministic density path', () => {
    const instances: ArrangedMidiNote[] = Array.from({ length: 50_000 }, (_, index) => ({
      note: {
        id: `note-${index}`,
        pitch: 36 + (index % 48),
        startBeat: (index % 2400) / 10,
        durationBeats: 0.125 + (index % 4) * 0.125,
        velocity: 0.8,
      },
      startBeat: (index % 2400) / 10,
      durationBeats: 0.125 + (index % 4) * 0.125,
      noteOffsetBeats: 0,
    }))

    const first = midiThumbnailPath(instances, 0, 240, 36, 83)
    const second = midiThumbnailPath(instances, 0, 240, 36, 83)
    expect(first).toBe(second)
    expect(first.length).toBeGreaterThan(0)
    expect(first.match(/M/g)?.length ?? 0).toBeLessThanOrEqual(96 * 16)
  })

  it('returns no invented geometry for an empty or invalid clip', () => {
    expect(midiThumbnailPath([], 0, 4, 48, 72)).toBe('')
    expect(midiThumbnailPath([{
      note: { id: 'note', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 1 },
      startBeat: 0,
      durationBeats: 1,
      noteOffsetBeats: 0,
    }], 0, 0, 48, 72)).toBe('')
  })
})

type ArrangementProps = Parameters<typeof Arrangement>[0]

const createArrangementProps = (overrides: Partial<ArrangementProps> = {}): ArrangementProps => ({
  project: createDemoProject({ now: '2026-07-15T00:00:00.000Z' }),
  selectedClipId: 'clip-extracted-motif',
  selectedTrackId: 'track-lead-midi',
  playheadBeat: 0,
  zoom: 1,
  snapping: true,
  trackLevels: {},
  canUndo: false,
  canRedo: false,
  onSelectClip: vi.fn(),
  onSelectTrack: vi.fn(),
  onSeek: vi.fn(),
  onEditClip: vi.fn(),
  onMoveClip: vi.fn(),
  onOpenClipDetail: vi.fn(),
  onOpenClipCommands: vi.fn(),
  onToggleTrack: vi.fn(),
  onTrackGain: vi.fn(),
  onMoveTrack: vi.fn(),
  onAddTrack: vi.fn(),
  onToggleLoop: vi.fn(),
  onEditLoop: vi.fn(),
  onUndo: vi.fn(),
  onRedo: vi.fn(),
  onZoomChange: vi.fn(),
  onDropAudioSource: vi.fn(),
  ...overrides,
})

const audioSourceDataTransfer = (payload: object) => ({
  types: [AUDIO_SOURCE_DRAG_TYPE],
  effectAllowed: 'copy',
  dropEffect: 'none',
  getData: (type: string) => type === AUDIO_SOURCE_DRAG_TYPE ? JSON.stringify(payload) : '',
})

describe('Arrangement source-card drop', () => {
  it('aligns placement to the dragged card left edge and then applies snap', () => {
    const base = createDemoProject({ now: '2026-07-15T00:00:00.000Z' })
    const audioTrack = base.tracks.find((track) => track.kind === 'audio')!
    const project = {
      ...base,
      tracks: base.tracks.map((track) => track.id === audioTrack.id ? { ...track, clips: [] } : track),
    }
    const onDropAudioSource = vi.fn()
    render(createElement(Arrangement, createArrangementProps({ project, onDropAudioSource })))
    const lane = screen.getByLabelText(`${audioTrack.name} timeline lane`)
    vi.spyOn(lane, 'getBoundingClientRect').mockReturnValue({
      x: 200, y: 0, left: 200, top: 0, right: 1000, bottom: 80, width: 800, height: 80,
      toJSON: () => ({}),
    })
    const payload = { source: 'candidate', id: 'candidate-1', durationBeats: 1, grabOffsetX: 100 }
    const dataTransfer = audioSourceDataTransfer(payload)

    const dragOver = createEvent.dragOver(lane)
    Object.defineProperties(dragOver, {
      clientX: { value: 500 },
      dataTransfer: { value: dataTransfer },
    })
    fireEvent(lane, dragOver)
    expect(dataTransfer.dropEffect).toBe('copy')
    const timelineBeats = getArrangementTimelineBeats(project, 0)
    const expectedStart = snapBeat(((500 - 100 - 200) / 800) * timelineBeats, '1/16')
    const preview = lane.querySelector<HTMLElement>('.source-drop-preview')
    expect(preview?.classList.contains('is-valid')).toBe(true)
    expect(preview?.style.left).toBe(`${(expectedStart / timelineBeats) * 100}%`)
    expect(preview?.style.width).toBe(`${(payload.durationBeats / timelineBeats) * 100}%`)
    const drop = createEvent.drop(lane)
    Object.defineProperties(drop, {
      clientX: { value: 500 },
      dataTransfer: { value: dataTransfer },
    })
    fireEvent(lane, drop)

    expect(onDropAudioSource).toHaveBeenCalledWith(payload, audioTrack.id, expectedStart)
    expect(lane.querySelector('.source-drop-preview')).toBeNull()
  })

  it('rejects an Audio source dropped on a MIDI track', () => {
    const project = createDemoProject({ now: '2026-07-15T00:00:00.000Z' })
    const midiTrack = project.tracks.find((track) => track.kind === 'midi')!
    const onDropAudioSource = vi.fn()
    render(createElement(Arrangement, createArrangementProps({ project, onDropAudioSource })))
    const lane = screen.getByLabelText(`${midiTrack.name} timeline lane`)
    vi.spyOn(lane, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 80, width: 800, height: 80,
      toJSON: () => ({}),
    })
    const dataTransfer = audioSourceDataTransfer({ source: 'library', id: 'sound-1', durationBeats: 4, grabOffsetX: 20 })

    const dragOver = createEvent.dragOver(lane)
    Object.defineProperties(dragOver, {
      clientX: { value: 400 },
      dataTransfer: { value: dataTransfer },
    })
    fireEvent(lane, dragOver)
    expect(dataTransfer.dropEffect).toBe('none')
    const drop = createEvent.drop(lane)
    Object.defineProperties(drop, {
      clientX: { value: 400 },
      dataTransfer: { value: dataTransfer },
    })
    fireEvent(lane, drop)
    expect(onDropAudioSource).not.toHaveBeenCalled()
  })

  it('shows only the proposed Region span in red when it collides', () => {
    const project = createDemoProject({ now: '2026-07-15T00:00:00.000Z' })
    const audioTrack = project.tracks.find((track) => track.kind === 'audio' && track.clips.length > 0)!
    const occupiedClip = audioTrack.clips[0]!
    const onDropAudioSource = vi.fn()
    render(createElement(Arrangement, createArrangementProps({ project, onDropAudioSource })))
    const lane = screen.getByLabelText(`${audioTrack.name} timeline lane`)
    vi.spyOn(lane, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 80, width: 800, height: 80,
      toJSON: () => ({}),
    })
    const timelineBeats = getArrangementTimelineBeats(project, 0)
    const clientX = (occupiedClip.startBeat / timelineBeats) * 800
    const payload = { source: 'candidate', id: 'candidate-collision', durationBeats: 1, grabOffsetX: 0 }
    const dataTransfer = audioSourceDataTransfer(payload)
    const dragOver = createEvent.dragOver(lane)
    Object.defineProperties(dragOver, {
      clientX: { value: clientX },
      dataTransfer: { value: dataTransfer },
    })
    fireEvent(lane, dragOver)

    expect(dataTransfer.dropEffect).toBe('none')
    expect(lane.classList.contains('is-invalid-drop-target')).toBe(false)
    expect(lane.querySelector('.source-drop-preview.is-collision')).not.toBeNull()
  })
})

describe('Arrangement add-track entries', () => {
  it('offers functional direct Audio and MIDI buttons in the header and empty state', () => {
    const onAddTrack = vi.fn()
    const project = { ...createDemoProject({ now: '2026-07-15T00:00:00.000Z' }), tracks: [] }
    render(createElement(Arrangement, createArrangementProps({
      project,
      selectedClipId: null,
      selectedTrackId: null,
      onAddTrack,
    })))

    const audioButtons = screen.getAllByRole('button', { name: 'Add audio track' })
    const midiButtons = screen.getAllByRole('button', { name: 'Add MIDI track' })
    expect(audioButtons).toHaveLength(2)
    expect(midiButtons).toHaveLength(2)
    expect(audioButtons[0]?.closest('.arrangement-heading')).not.toBeNull()
    expect(audioButtons[1]?.closest('.arrangement-empty')).not.toBeNull()

    fireEvent.click(audioButtons[0]!)
    fireEvent.click(midiButtons[0]!)
    fireEvent.click(audioButtons[1]!)
    fireEvent.click(midiButtons[1]!)
    expect(onAddTrack.mock.calls).toEqual([['audio'], ['midi'], ['audio'], ['midi']])
  })
})

describe('Arrangement linked-region reveal', () => {
  it('scrolls the requested region into view and focuses its main control', () => {
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    })
    const props = createArrangementProps()
    const { rerender } = render(createElement(Arrangement, props))

    rerender(createElement(Arrangement, {
      ...props,
      selectedClipId: 'clip-dream-drift',
      selectedTrackId: 'track-atmosphere',
      revealRequest: { clipId: 'clip-dream-drift', requestId: 1 },
    }))

    const sourceRegionControl = screen.getByRole('button', { name: /^Selected, Dream Drift 01, audio region/ })
    expect(sourceRegionControl).toBe(document.activeElement)
    expect(sourceRegionControl.closest('[data-clip-id]')?.getAttribute('data-clip-id')).toBe('clip-dream-drift')
    expect(scrollIntoView).toHaveBeenCalledOnce()
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'center', inline: 'center' })
  })
})

const setArrangementGestureBounds = (container: HTMLElement) => {
  const scroll = container.querySelector<HTMLElement>('.arrangement-scroll')!
  const stage = container.querySelector<HTMLElement>('.timeline-stage')!
  const corner = container.querySelector<HTMLElement>('.ruler-corner')!
  const ruler = container.querySelector<HTMLElement>('.timeline-ruler')!
  Object.defineProperty(scroll, 'clientWidth', { configurable: true, value: 800 })
  scroll.getBoundingClientRect = () => ({
    x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 500, width: 800, height: 500, toJSON: () => ({}),
  })
  stage.getBoundingClientRect = () => ({
    x: 0, y: 0, left: 0, top: 0, right: 1600, bottom: 500, width: 1600, height: 500, toJSON: () => ({}),
  })
  corner.getBoundingClientRect = () => ({
    x: 0, y: 0, left: 0, top: 0, right: 200, bottom: 40, width: 200, height: 40, toJSON: () => ({}),
  })
  ruler.getBoundingClientRect = () => ({
    x: 200, y: 0, left: 200, top: 0, right: 1600, bottom: 40, width: 1400, height: 40, toJSON: () => ({}),
  })
  return { scroll, stage, ruler }
}

describe('Arrangement gesture cancellation', () => {
  it('scrubs the playhead continuously while dragging the bar ruler', () => {
    const onSeek = vi.fn()
    const { container } = render(createElement(Arrangement, createArrangementProps({ onSeek })))
    const { ruler } = setArrangementGestureBounds(container)

    fireEvent.pointerDown(ruler, { button: 0, pointerId: 7, pointerType: 'mouse', clientX: 550, clientY: 20 })
    expect(onSeek).toHaveBeenLastCalledWith(16)
    fireEvent.pointerMove(window, { pointerId: 7, pointerType: 'mouse', clientX: 900, clientY: 20 })
    expect(onSeek).toHaveBeenLastCalledWith(32)
    fireEvent.pointerUp(window, { pointerId: 7, pointerType: 'mouse', clientX: 1_250, clientY: 20 })
    expect(onSeek).toHaveBeenLastCalledWith(48)
    const callCount = onSeek.mock.calls.length
    fireEvent.pointerMove(window, { pointerId: 7, pointerType: 'mouse', clientX: 1_500, clientY: 20 })
    expect(onSeek).toHaveBeenCalledTimes(callCount)
  })

  it('cancels clip and loop edits on blur or hidden visibility before stale pointerup', () => {
    const onEditClip = vi.fn()
    const onEditLoop = vi.fn()
    const { container } = render(createElement(Arrangement, createArrangementProps({ onEditClip, onEditLoop })))
    const { ruler } = setArrangementGestureBounds(container)

    const trim = screen.getByRole('button', { name: 'Trim end of Dream Drift 01. Use left and right arrow keys' })
    fireEvent.pointerDown(trim, { button: 0, pointerId: 11, pointerType: 'mouse', clientX: 900, clientY: 80 })
    fireEvent.pointerMove(window, { pointerId: 11, clientX: 980, clientY: 80 })
    expect(trim.closest('.timeline-clip')?.classList.contains('is-dragging')).toBe(true)
    fireEvent.blur(window)
    expect(trim.closest('.timeline-clip')?.classList.contains('is-dragging')).toBe(false)
    fireEvent.pointerUp(window, { pointerId: 11, clientX: 980, clientY: 80 })
    expect(onEditClip).not.toHaveBeenCalled()

    const loopEnd = screen.getByRole('slider', { name: 'Loop end' })
    fireEvent.pointerDown(loopEnd, { button: 0, pointerId: 12, pointerType: 'mouse', clientX: 600, clientY: 20 })
    fireEvent.pointerMove(window, { pointerId: 12, clientX: 700, clientY: 20 })
    expect(ruler.querySelector('.loop-brace')?.getAttribute('style')).toContain('width')
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    visibility.mockRestore()
    fireEvent.pointerUp(window, { pointerId: 12, clientX: 700, clientY: 20 })
    expect(onEditLoop).not.toHaveBeenCalled()
  })

  it('cancels an owned drag on lost pointer capture and removes its listeners on unmount', () => {
    const onEditClip = vi.fn()
    const rendered = render(createElement(Arrangement, createArrangementProps({ onEditClip })))
    setArrangementGestureBounds(rendered.container)
    const trim = screen.getByRole('button', { name: 'Trim end of Dream Drift 01. Use left and right arrow keys' })

    fireEvent.pointerDown(trim, { button: 0, pointerId: 21, pointerType: 'mouse', clientX: 900, clientY: 80 })
    fireEvent.pointerMove(window, { pointerId: 21, clientX: 980, clientY: 80 })
    fireEvent.lostPointerCapture(trim, { pointerId: 21, pointerType: 'mouse' })
    fireEvent.pointerUp(window, { pointerId: 21, clientX: 980, clientY: 80 })
    expect(onEditClip).not.toHaveBeenCalled()

    fireEvent.pointerDown(trim, { button: 0, pointerId: 22, pointerType: 'mouse', clientX: 900, clientY: 80 })
    fireEvent.pointerMove(window, { pointerId: 22, clientX: 980, clientY: 80 })
    rendered.unmount()
    fireEvent.pointerUp(window, { pointerId: 22, clientX: 980, clientY: 80 })
    expect(onEditClip).not.toHaveBeenCalled()
  })

  it('clears pinch pointers and wheel zoom state through the same cancellation path', () => {
    const onZoomChange = vi.fn()
    const cancelAnimationFrame = vi.spyOn(window, 'cancelAnimationFrame')
    const { container } = render(createElement(Arrangement, createArrangementProps({ onZoomChange })))
    const { scroll, stage } = setArrangementGestureBounds(container)

    fireEvent.pointerDown(scroll, { pointerId: 31, pointerType: 'touch', clientX: 300, clientY: 120 })
    fireEvent.pointerDown(scroll, { pointerId: 32, pointerType: 'touch', clientX: 500, clientY: 120 })
    expect(stage.classList.contains('is-gesture-zooming')).toBe(true)
    fireEvent.lostPointerCapture(scroll, { pointerId: 31, pointerType: 'touch' })
    expect(stage.classList.contains('is-gesture-zooming')).toBe(false)
    onZoomChange.mockClear()
    fireEvent.pointerMove(scroll, { pointerId: 32, pointerType: 'touch', clientX: 650, clientY: 120 })
    expect(onZoomChange).not.toHaveBeenCalled()

    fireEvent.wheel(scroll, { ctrlKey: true, clientX: 400, deltaY: -100 })
    expect(stage.classList.contains('is-gesture-zooming')).toBe(true)
    fireEvent.blur(window)
    expect(stage.classList.contains('is-gesture-zooming')).toBe(false)
    expect(cancelAnimationFrame).toHaveBeenCalled()

    fireEvent.pointerDown(scroll, { pointerId: 33, pointerType: 'touch', clientX: 300, clientY: 120 })
    expect(stage.classList.contains('is-gesture-zooming')).toBe(false)
  })
})
