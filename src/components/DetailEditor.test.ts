// @vitest-environment jsdom

import { createElement } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AudioAsset, AudioClip, MidiClip, Track } from '../types'
import { DetailEditor, getAudioDetailGridLines, getRenderableDetailSourceSlice } from './DetailEditor'

const createdAt = '2026-07-15T00:00:00.000Z'

const midiClip: MidiClip = {
  id: 'midi-clip',
  name: 'Observed MIDI',
  kind: 'midi',
  startBeat: 4,
  durationBeats: 4,
  offsetBeats: 0,
  gain: 1,
  fadeIn: 0,
  fadeOut: 0,
  provenance: { source: 'user', createdAt },
  notes: [{ id: 'note-c4', pitch: 60, startBeat: 0.5, durationBeats: 0.5, velocity: 0.8 }],
}

const midiTrack: Track = {
  id: 'midi-track',
  name: 'MIDI',
  kind: 'midi',
  midi: { channel: 0, instrument: { kind: 'melodic', playbackId: 'WebAudio-TinySynth', program: 0 } },
  color: '#5dd6d1',
  gain: 1,
  pan: 0,
  mute: false,
  solo: false,
  clips: [midiClip],
}

const baseProps = {
  playheadBeat: 4,
  bpm: 120,
  timeSignature: { numerator: 4, denominator: 4 } as const,
  snapping: true,
  open: true,
  expanded: false,
  onEditNote: vi.fn(),
  onDeleteNote: vi.fn(),
  onAddNote: vi.fn(),
  onQuantize: vi.fn(),
  onExpand: vi.fn(),
}

const setPianoBounds = (grid: HTMLElement, width = 400, height = 1536) => {
  grid.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: width,
    bottom: height,
    width,
    height,
    toJSON: () => ({}),
  })
}

const primaryPointer = (pointerId: number, clientX: number, clientY: number) => ({
  button: 0,
  isPrimary: true,
  pointerId,
  clientX,
  clientY,
})

const audioFixture = () => {
  const clip: AudioClip = {
    id: 'audio-clip',
    name: 'Looped Audio',
    kind: 'audio',
    startBeat: 0,
    durationBeats: 5,
    offsetBeats: 2,
    timebase: { mode: 'fixed-seconds', sourceBpm: 120 },
    sourceLoop: { cycleStartBeat: 2, cycleLengthBeats: 2, phaseBeats: 1 },
    assetId: 'audio-asset',
    gain: 1,
    fadeIn: 0.02,
    fadeOut: 0.04,
    provenance: { source: 'user', createdAt },
  }
  const track: Track = {
    id: 'audio-track',
    name: midiTrack.name,
    kind: 'audio',
    color: midiTrack.color,
    gain: midiTrack.gain,
    pan: midiTrack.pan,
    mute: midiTrack.mute,
    solo: midiTrack.solo,
    clips: [clip],
  }
  const asset: AudioAsset = {
    id: 'audio-asset',
    name: 'source.wav',
    mimeType: 'audio/wav',
    durationSeconds: 8,
    createdAt,
    provenance: { source: 'user', createdAt },
    waveform: [{ samplesPerPeak: 1024, min: [-0.4, -0.8], max: [0.5, 0.9] }],
  }
  return { clip, track, asset }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('DetailEditor MIDI selection semantics', () => {
  it('exposes a real collapse command without clearing the selected region', () => {
    const onClose = vi.fn()
    render(createElement(DetailEditor, { ...baseProps, clip: midiClip, track: midiTrack, onClose }))
    fireEvent.click(screen.getByRole('button', { name: 'Collapse detail editor' }))
    expect(onClose).toHaveBeenCalledOnce()
    expect(screen.getByRole('heading', { name: 'Observed MIDI' })).toBeTruthy()
  })

  it('clears only note selection when the blank piano grid is pressed', () => {
    render(createElement(DetailEditor, { ...baseProps, clip: midiClip, track: midiTrack }))

    const note = screen.getByRole('button', { name: /C4, starts at/ })
    fireEvent.click(note)
    expect(note.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText('1 selected')).toBeTruthy()

    const grid = screen.getByRole('group', { name: 'MIDI piano roll' })
    setPianoBounds(grid)
    fireEvent.pointerDown(grid, primaryPointer(1, 300, 100))
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 300, clientY: 100 })

    expect(note.getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByText('No selection')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Observed MIDI' })).toBeTruthy()
  })

  it('wires selected-note inspector and resize handle to real edit callbacks', () => {
    const onEditNote = vi.fn()
    const { container } = render(createElement(DetailEditor, { ...baseProps, clip: midiClip, track: midiTrack, onEditNote }))
    const note = screen.getByRole('button', { name: /C4, starts at/ })
    fireEvent.click(note)

    fireEvent.change(screen.getByLabelText('Selected note velocity'), { target: { value: '81' } })
    expect(onEditNote).toHaveBeenCalledWith('note-c4', { velocity: 81 / 127 })

    const grid = screen.getByRole('group', { name: 'MIDI piano roll' })
    setPianoBounds(grid, 400, 200)
    const resizeHandle = container.querySelector<HTMLElement>('.note-resize-handle')
    expect(resizeHandle).toBeTruthy()
    fireEvent.pointerDown(resizeHandle!, { clientX: 100, clientY: 50, pointerId: 1, isPrimary: true })
    fireEvent.pointerMove(window, { clientX: 150, clientY: 50, pointerId: 1 })
    fireEvent.pointerUp(window, { clientX: 150, clientY: 50, pointerId: 1 })

    expect(onEditNote).toHaveBeenCalledWith('note-c4', { durationBeats: 1 })
  })

  it('maps a trimmed clip between visible placement beats and source-note beats', () => {
    const onEditNote = vi.fn()
    const onAddNote = vi.fn()
    const trimmed: MidiClip = {
      ...midiClip,
      offsetBeats: 2,
      notes: [{ ...midiClip.notes[0], startBeat: 2.5 }],
    }
    const track: Track = { ...midiTrack, clips: [trimmed] }
    render(createElement(DetailEditor, {
      ...baseProps,
      clip: trimmed,
      track,
      playheadBeat: 5,
      onEditNote,
      onAddNote,
    }))

    const note = screen.getByRole('button', { name: /C4, starts at 0\.50 beats/ })
    fireEvent.click(note)
    fireEvent.change(screen.getByLabelText('Selected note start beat'), { target: { value: '1' } })
    expect(onEditNote).toHaveBeenCalledWith('note-c4', { startBeat: 3 })

    const grid = screen.getByRole('group', { name: 'MIDI piano roll' })
    setPianoBounds(grid)
    fireEvent.click(screen.getByRole('button', { name: 'Draw notes' }))
    fireEvent.pointerDown(grid, primaryPointer(1, 100, (127 - 72) * 12 + 1))
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 100, clientY: (127 - 72) * 12 + 1 })
    expect(onAddNote).toHaveBeenCalledWith(expect.objectContaining({ startBeat: 3 }))
  })

  it('renders one editable source note and locked derived occurrences for a MIDI loop', () => {
    const onEditNote = vi.fn()
    const looped: MidiClip = {
      ...midiClip,
      startBeat: 0,
      durationBeats: 4,
      sourceLoop: { cycleStartBeat: 0, cycleLengthBeats: 2, phaseBeats: 0 },
    }
    const track: Track = { ...midiTrack, clips: [looped] }
    const { container } = render(createElement(DetailEditor, { ...baseProps, clip: looped, track, onEditNote }))

    const editable = screen.getByRole('button', { name: /source note controls 2 loop occurrences/ })
    expect(container.querySelectorAll('.piano-note.is-derived')).toHaveLength(1)
    fireEvent.click(editable)
    expect(screen.getByText('2 loop occurrences · one shared source edit')).toBeTruthy()

    fireEvent.keyDown(editable, { key: 'ArrowRight' })
    expect(onEditNote).toHaveBeenCalledWith('note-c4', { startBeat: 0.75 })
  })

  it('keeps one fixed 128-row pitch geometry when the detail viewport expands', () => {
    const wideClip: MidiClip = {
      ...midiClip,
      notes: [
        { ...midiClip.notes[0], id: 'note-c3', pitch: 48 },
        { ...midiClip.notes[0], id: 'note-b4', pitch: 71 },
      ],
    }
    const track: Track = { ...midiTrack, clips: [wideClip] }
    const { container, rerender } = render(createElement(DetailEditor, {
      ...baseProps,
      clip: wideClip,
      track,
      expanded: false,
    }))

    const content = container.querySelector<HTMLElement>('.piano-roll-content')!
    const viewport = container.querySelector<HTMLElement>('.piano-roll-wrap')!
    const keys = [...container.querySelectorAll<HTMLButtonElement>('.piano-keys > button')]
    const lowerNote = screen.getByRole('button', { name: /C3, starts at/ })
    const upperNote = screen.getByRole('button', { name: /B4, starts at/ })

    expect(content.style.getPropertyValue('--piano-row-count')).toBe('128')
    expect(content.style.getPropertyValue('--piano-row-height')).toBe('12px')
    expect(content.style.getPropertyValue('--piano-content-height')).toBe('1536px')
    expect(keys).toHaveLength(128)
    expect(keys[0].classList.contains('black-key')).toBe(false)
    expect(keys[1].classList.contains('black-key')).toBe(true)
    expect(keys.at(-1)?.classList.contains('black-key')).toBe(false)
    expect(lowerNote.style.top).toBe('948px')
    expect(upperNote.style.top).toBe('672px')
    expect(viewport.scrollTop).toBe(816)

    rerender(createElement(DetailEditor, {
      ...baseProps,
      clip: wideClip,
      track,
      expanded: true,
    }))

    expect(container.querySelector<HTMLElement>('.piano-roll-content')!.style.getPropertyValue('--piano-row-height')).toBe('12px')
    expect(screen.getByRole('button', { name: /C3, starts at/ }).style.top).toBe('948px')
    expect(screen.getByRole('button', { name: /B4, starts at/ }).style.top).toBe('672px')
  })

  it('maps grid insertion and pitch dragging through the same twelve-pixel rows', () => {
    const onAddNote = vi.fn()
    const onEditNote = vi.fn()
    render(createElement(DetailEditor, { ...baseProps, clip: midiClip, track: midiTrack, onAddNote, onEditNote }))
    const grid = screen.getByRole('group', { name: 'MIDI piano roll' })
    setPianoBounds(grid)

    fireEvent.click(screen.getByRole('button', { name: 'Draw notes' }))
    fireEvent.pointerDown(grid, primaryPointer(1, 100, (127 - 72) * 12 + 1))
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 100, clientY: (127 - 72) * 12 + 1 })
    expect(onAddNote).toHaveBeenCalledWith(expect.objectContaining({ pitch: 72 }))

    fireEvent.click(screen.getByRole('button', { name: 'Range select notes' }))
    const note = screen.getByRole('button', { name: /C4, starts at/ })
    fireEvent.pointerDown(note, primaryPointer(2, 100, 804))
    fireEvent.pointerMove(window, { clientX: 100, clientY: 780, pointerId: 2 })
    fireEvent.pointerUp(window, { clientX: 100, clientY: 780, pointerId: 2 })
    expect(onEditNote).toHaveBeenCalledWith('note-c4', expect.objectContaining({ pitch: 62 }))
  })

  it('auditions notes and piano keys with balanced start-stop phases and current routing', () => {
    const onAuditionMidiNote = vi.fn()
    render(createElement(DetailEditor, {
      ...baseProps,
      clip: midiClip,
      track: midiTrack,
      onAuditionMidiNote,
    }))
    const note = screen.getByRole('button', { name: /C4, starts at/ })
    const c4Key = screen.getByRole('button', { name: 'Audition C4' })
    setPianoBounds(screen.getByRole('group', { name: 'MIDI piano roll' }))

    fireEvent.focus(note)
    expect(onAuditionMidiNote).not.toHaveBeenCalled()
    fireEvent.pointerDown(note, { clientX: 100, clientY: 804, pointerId: 1, isPrimary: true })
    fireEvent.pointerUp(window, { clientX: 100, clientY: 804, pointerId: 1 })
    expect(onAuditionMidiNote.mock.calls).toEqual([
      [60, 'start', midiTrack],
      [60, 'stop', midiTrack],
    ])

    onAuditionMidiNote.mockClear()
    fireEvent.keyDown(note, { key: 'Enter' })
    fireEvent.keyDown(note, { key: 'Enter', repeat: true })
    fireEvent.keyUp(note, { key: 'Enter' })
    expect(onAuditionMidiNote.mock.calls).toEqual([
      [60, 'start', midiTrack],
      [60, 'stop', midiTrack],
    ])

    onAuditionMidiNote.mockClear()
    fireEvent.pointerDown(c4Key, { button: 0, isPrimary: true, pointerId: 2 })
    fireEvent.pointerUp(c4Key, { pointerId: 2 })
    expect(onAuditionMidiNote.mock.calls).toEqual([
      [60, 'start', midiTrack],
      [60, 'stop', midiTrack],
    ])

    fireEvent.keyDown(c4Key, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Audition C♯4' }))
    expect(document.querySelectorAll('.piano-keys > button[tabindex="0"]')).toHaveLength(1)
  })

  it('keeps pointer selection history-neutral and gives one primary pointer ownership of a drag', () => {
    const onEditNote = vi.fn()
    const onAuditionMidiNote = vi.fn()
    render(createElement(DetailEditor, {
      ...baseProps,
      clip: midiClip,
      track: midiTrack,
      onEditNote,
      onAuditionMidiNote,
    }))
    const grid = screen.getByRole('group', { name: 'MIDI piano roll' })
    setPianoBounds(grid)
    const note = screen.getByRole('button', { name: /C4, starts at/ })

    fireEvent.pointerDown(note, { button: 0, isPrimary: true, clientX: 100, clientY: 804, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 102, clientY: 804, pointerId: 1 })
    fireEvent.pointerUp(window, { clientX: 300, clientY: 804, pointerId: 2 })
    expect(onEditNote).not.toHaveBeenCalled()
    expect(onAuditionMidiNote.mock.calls).toEqual([[60, 'start', midiTrack]])

    fireEvent.pointerUp(window, { clientX: 102, clientY: 804, pointerId: 1 })
    expect(onEditNote).not.toHaveBeenCalled()
    expect(onAuditionMidiNote.mock.calls).toEqual([
      [60, 'start', midiTrack],
      [60, 'stop', midiTrack],
    ])

    onAuditionMidiNote.mockClear()
    fireEvent.pointerDown(note, { button: 2, isPrimary: true, clientX: 100, clientY: 804, pointerId: 3 })
    expect(onAuditionMidiNote).not.toHaveBeenCalled()

    fireEvent.pointerDown(note, { button: 0, isPrimary: true, clientX: 100, clientY: 804, pointerId: 4 })
    fireEvent.pointerMove(window, { clientX: 130, clientY: 780, pointerId: 4 })
    fireEvent.pointerUp(window, { clientX: 130, clientY: 780, pointerId: 4 })
    expect(onEditNote).toHaveBeenCalledWith('note-c4', { startBeat: 0.75, pitch: 62 })
  })

  it('cancels an active drag and audition on clip changes, window blur, and hidden visibility', () => {
    const onEditNote = vi.fn()
    const onAuditionMidiNote = vi.fn()
    const { rerender } = render(createElement(DetailEditor, {
      ...baseProps,
      clip: midiClip,
      track: midiTrack,
      onEditNote,
      onAuditionMidiNote,
    }))
    const beginOnCurrentNote = (pointerId: number) => {
      const note = screen.getByRole('button', { name: /C4, starts at/ })
      const grid = screen.getByRole('group', { name: 'MIDI piano roll' })
      setPianoBounds(grid)
      fireEvent.pointerDown(note, { button: 0, isPrimary: true, clientX: 100, clientY: 804, pointerId })
    }

    beginOnCurrentNote(1)
    const nextClip: MidiClip = { ...midiClip, id: 'next-midi-clip' }
    const nextTrack: Track = { ...midiTrack, clips: [nextClip] }
    rerender(createElement(DetailEditor, {
      ...baseProps,
      clip: nextClip,
      track: nextTrack,
      onEditNote,
      onAuditionMidiNote,
    }))
    expect(onAuditionMidiNote.mock.calls.slice(0, 2)).toEqual([
      [60, 'start', midiTrack],
      [60, 'stop', midiTrack],
    ])

    beginOnCurrentNote(2)
    fireEvent.blur(window)
    expect(onAuditionMidiNote.mock.calls.slice(-2)).toEqual([
      [60, 'start', nextTrack],
      [60, 'stop', nextTrack],
    ])

    beginOnCurrentNote(3)
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    visibility.mockRestore()
    expect(onAuditionMidiNote.mock.calls.slice(-2)).toEqual([
      [60, 'start', nextTrack],
      [60, 'stop', nextTrack],
    ])
    fireEvent.pointerUp(window, { clientX: 180, clientY: 780, pointerId: 3 })
    expect(onEditNote).not.toHaveBeenCalled()
  })

  it('uses the latest clip selection when blur cancels a marquee after rerender', () => {
    const { rerender } = render(createElement(DetailEditor, {
      ...baseProps,
      clip: midiClip,
      track: midiTrack,
    }))
    const nextClip: MidiClip = {
      ...midiClip,
      id: 'next-midi-clip',
      notes: [{ id: 'note-d4', pitch: 62, startBeat: 1, durationBeats: 0.5, velocity: 0.7 }],
    }
    const nextTrack: Track = { ...midiTrack, clips: [nextClip] }
    rerender(createElement(DetailEditor, {
      ...baseProps,
      clip: nextClip,
      track: nextTrack,
    }))

    const note = screen.getByRole('button', { name: /D4, starts at/ })
    fireEvent.click(note)
    expect(note.getAttribute('aria-pressed')).toBe('true')

    const grid = screen.getByRole('group', { name: 'MIDI piano roll' })
    setPianoBounds(grid)
    fireEvent.pointerDown(grid, primaryPointer(17, 320, 100))
    fireEvent.pointerMove(window, { pointerId: 17, clientX: 380, clientY: 140 })
    expect(note.getAttribute('aria-pressed')).toBe('false')

    fireEvent.blur(window)
    expect(note.getAttribute('aria-pressed')).toBe('true')
    fireEvent.pointerUp(window, { pointerId: 17, clientX: 380, clientY: 140 })
    expect(note.getAttribute('aria-pressed')).toBe('true')
  })

  it('exposes mutually exclusive draw, range-select, and erase tools with local shortcuts', () => {
    const { container } = render(createElement(DetailEditor, { ...baseProps, clip: midiClip, track: midiTrack }))
    const toolbar = screen.getByRole('toolbar', { name: 'Piano roll editing mode' })
    const draw = screen.getByRole('button', { name: 'Draw notes' })
    const select = screen.getByRole('button', { name: 'Range select notes' })
    const erase = screen.getByRole('button', { name: 'Erase notes' })
    const grid = screen.getByRole('group', { name: 'MIDI piano roll' })

    expect(select.getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByRole('button', { name: 'Add note' })).toBeNull()
    fireEvent.click(draw)
    expect(draw.getAttribute('aria-pressed')).toBe('true')
    expect(toolbar.querySelectorAll('[aria-pressed="true"]')).toHaveLength(1)
    fireEvent.keyDown(grid, { key: 'e' })
    expect(erase.getAttribute('aria-pressed')).toBe('true')
    fireEvent.keyDown(grid, { key: 'v' })
    expect(select.getAttribute('aria-pressed')).toBe('true')
    fireEvent.keyDown(grid, { key: 'b' })
    expect(draw.getAttribute('aria-pressed')).toBe('true')

    const quantizeControls = container.querySelector<HTMLElement>('.midi-quantize-controls')!
    expect([...quantizeControls.children].map((child) => child.textContent)).toEqual([
      expect.stringContaining('QUANTIZE'),
      expect.stringContaining('STRENGTH'),
      expect.stringContaining('Apply quantize'),
    ])
  })

  it('quantizes only the disclosed note selection', () => {
    const onQuantize = vi.fn()
    render(createElement(DetailEditor, { ...baseProps, clip: midiClip, track: midiTrack, onQuantize }))
    const apply = screen.getByRole('button', { name: 'Apply quantize, select notes first' })
    expect(apply.hasAttribute('disabled')).toBe(true)

    fireEvent.focus(screen.getByRole('button', { name: /C4, starts at/ }))
    const selectedApply = screen.getByRole('button', { name: 'Apply quantize to 1 selected note' })
    expect(selectedApply.hasAttribute('disabled')).toBe(false)
    fireEvent.click(selectedApply)
    expect(onQuantize).toHaveBeenCalledOnce()
    expect(onQuantize).toHaveBeenCalledWith('1/16', 0.78, ['note-c4'])
  })

  it('marquee-selects rendered loop occurrences as unique source notes and unions with Shift', () => {
    const looped: MidiClip = {
      ...midiClip,
      startBeat: 0,
      sourceLoop: { cycleStartBeat: 0, cycleLengthBeats: 2, phaseBeats: 0 },
      notes: [
        { id: 'note-c4', pitch: 60, startBeat: 0.5, durationBeats: 0.5, velocity: 0.8 },
        { id: 'note-e4', pitch: 64, startBeat: 1, durationBeats: 0.5, velocity: 0.7 },
      ],
    }
    render(createElement(DetailEditor, { ...baseProps, clip: looped, track: { ...midiTrack, clips: [looped] } }))
    const grid = screen.getByRole('group', { name: 'MIDI piano roll' })
    setPianoBounds(grid)

    fireEvent.pointerDown(grid, primaryPointer(1, 0, 800))
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 400, clientY: 816 })
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 400, clientY: 816 })
    expect(screen.getByText('1 selected')).toBeTruthy()
    expect(document.querySelectorAll('.piano-note.is-source-selected')).toHaveLength(1)

    fireEvent.pointerDown(grid, { ...primaryPointer(2, 0, 752), shiftKey: true })
    fireEvent.pointerMove(window, { pointerId: 2, clientX: 400, clientY: 768, shiftKey: true })
    fireEvent.pointerUp(window, { pointerId: 2, clientX: 400, clientY: 768, shiftKey: true })
    expect(screen.getByText('2 selected')).toBeTruthy()

    fireEvent.pointerDown(grid, { ...primaryPointer(3, 300, 100), shiftKey: true })
    fireEvent.pointerUp(window, { pointerId: 3, clientX: 300, clientY: 100, shiftKey: true })
    expect(screen.getByText('2 selected')).toBeTruthy()
  })

  it('toggles individual source notes with Shift without collapsing the rest of the selection', () => {
    const clip: MidiClip = {
      ...midiClip,
      notes: [
        midiClip.notes[0],
        { id: 'note-e4', pitch: 64, startBeat: 1.5, durationBeats: 0.5, velocity: 0.7 },
      ],
    }
    render(createElement(DetailEditor, { ...baseProps, clip, track: { ...midiTrack, clips: [clip] } }))
    const grid = screen.getByRole('group', { name: 'MIDI piano roll' })
    setPianoBounds(grid)
    const c4 = screen.getByRole('button', { name: /C4, starts at/ })
    const e4 = screen.getByRole('button', { name: /E4, starts at/ })

    fireEvent.click(c4)
    fireEvent.pointerDown(e4, { ...primaryPointer(1, 150, 756), shiftKey: true })
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 150, clientY: 756, shiftKey: true })
    expect(screen.getByText('2 selected')).toBeTruthy()
    fireEvent.pointerDown(e4, { ...primaryPointer(2, 150, 756), shiftKey: true })
    fireEvent.pointerUp(window, { pointerId: 2, clientX: 150, clientY: 756, shiftKey: true })
    expect(screen.getByText('1 selected')).toBeTruthy()
    expect(c4.getAttribute('aria-pressed')).toBe('true')
    expect(e4.getAttribute('aria-pressed')).toBe('false')
  })

  it('moves a multi-selection as one source-note transaction and deletes it atomically', () => {
    const clip: MidiClip = {
      ...midiClip,
      notes: [
        midiClip.notes[0],
        { id: 'note-e4', pitch: 64, startBeat: 1, durationBeats: 0.5, velocity: 0.7 },
      ],
    }
    const onEditNotes = vi.fn()
    const onDeleteNotes = vi.fn()
    const onEditNote = vi.fn()
    const onDeleteNote = vi.fn()
    render(createElement(DetailEditor, {
      ...baseProps,
      clip,
      track: { ...midiTrack, clips: [clip] },
      onEditNote,
      onDeleteNote,
      onEditNotes,
      onDeleteNotes,
    }))
    const grid = screen.getByRole('group', { name: 'MIDI piano roll' })
    setPianoBounds(grid)
    fireEvent.keyDown(grid, { key: 'a', ctrlKey: true })
    expect(screen.getByText('2 selected')).toBeTruthy()

    const c4 = screen.getByRole('button', { name: /C4, starts at/ })
    fireEvent.pointerDown(c4, primaryPointer(1, 50, 804))
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 75, clientY: 792 })
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 75, clientY: 792 })
    expect(onEditNotes).toHaveBeenCalledOnce()
    expect(onEditNotes).toHaveBeenCalledWith([
      { id: 'note-c4', patch: { startBeat: 0.75, pitch: 61 } },
      { id: 'note-e4', patch: { startBeat: 1.25, pitch: 65 } },
    ])
    expect(onEditNote).not.toHaveBeenCalled()

    fireEvent.keyDown(grid, { key: 'Delete' })
    expect(onDeleteNotes).toHaveBeenCalledOnce()
    expect(onDeleteNotes).toHaveBeenCalledWith(['note-c4', 'note-e4'])
    expect(onDeleteNote).not.toHaveBeenCalled()
  })

  it('does not create a no-op history entry when a grouped pitch move is clamped', () => {
    const clip: MidiClip = {
      ...midiClip,
      notes: [
        { id: 'note-g9', pitch: 127, startBeat: 0.5, durationBeats: 0.5, velocity: 0.8 },
        { id: 'note-f9', pitch: 125, startBeat: 1, durationBeats: 0.5, velocity: 0.7 },
      ],
    }
    const onEditNotes = vi.fn()
    render(createElement(DetailEditor, { ...baseProps, clip, track: { ...midiTrack, clips: [clip] }, onEditNotes }))
    const grid = screen.getByRole('group', { name: 'MIDI piano roll' })
    fireEvent.keyDown(grid, { key: 'a', metaKey: true })
    fireEvent.keyDown(grid, { key: 'ArrowUp' })
    expect(onEditNotes).not.toHaveBeenCalled()
  })

  it('selects all source notes at a piano-key pitch on double click and unions with Shift', () => {
    const clip: MidiClip = {
      ...midiClip,
      notes: [
        { id: 'note-c4-a', pitch: 60, startBeat: 0.25, durationBeats: 0.25, velocity: 0.8 },
        { id: 'note-c4-b', pitch: 60, startBeat: 1, durationBeats: 0.25, velocity: 0.7 },
        { id: 'note-d4', pitch: 62, startBeat: 1.5, durationBeats: 0.25, velocity: 0.6 },
      ],
    }
    render(createElement(DetailEditor, { ...baseProps, clip, track: { ...midiTrack, clips: [clip] } }))

    fireEvent.doubleClick(screen.getByRole('button', { name: 'Audition C4' }))
    expect(screen.getByText('2 selected')).toBeTruthy()
    fireEvent.doubleClick(screen.getByRole('button', { name: 'Audition D4' }), { shiftKey: true })
    expect(screen.getByText('3 selected')).toBeTruthy()
    expect(screen.queryByLabelText('Selected note start beat')).toBeNull()
  })

  it('draws one default or dragged note on blank space', () => {
    const onAddNote = vi.fn()
    const { container } = render(createElement(DetailEditor, { ...baseProps, clip: midiClip, track: midiTrack, onAddNote }))
    const grid = screen.getByRole('group', { name: 'MIDI piano roll' })
    setPianoBounds(grid)
    fireEvent.click(screen.getByRole('button', { name: 'Draw notes' }))

    fireEvent.pointerDown(grid, primaryPointer(1, 75, 805))
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 75, clientY: 805 })
    expect(onAddNote).not.toHaveBeenCalled()

    fireEvent.pointerDown(grid, primaryPointer(2, 200, (127 - 72) * 12 + 1))
    expect(container.querySelector('.piano-note.is-draw-preview')).toBeTruthy()
    fireEvent.pointerUp(window, { pointerId: 2, clientX: 200, clientY: (127 - 72) * 12 + 1 })
    expect(onAddNote).toHaveBeenNthCalledWith(1, {
      pitch: 72,
      startBeat: 2,
      durationBeats: 0.5,
      velocity: 0.75,
    })

    fireEvent.pointerDown(grid, primaryPointer(3, 250, (127 - 74) * 12 + 1))
    fireEvent.pointerMove(window, { pointerId: 3, clientX: 350, clientY: (127 - 74) * 12 + 1 })
    fireEvent.pointerUp(window, { pointerId: 3, clientX: 350, clientY: (127 - 74) * 12 + 1 })
    expect(onAddNote).toHaveBeenNthCalledWith(2, {
      pitch: 74,
      startBeat: 2.5,
      durationBeats: 1,
      velocity: 0.75,
    })
    expect(onAddNote).toHaveBeenCalledTimes(2)
  })

  it('uses Pencil click to delete, body drag to move, and the right edge to resize', () => {
    const onDeleteNotes = vi.fn()
    const onEditNotes = vi.fn()
    const { container } = render(createElement(DetailEditor, {
      ...baseProps,
      clip: midiClip,
      track: midiTrack,
      onDeleteNotes,
      onEditNotes,
    }))
    const grid = screen.getByRole('group', { name: 'MIDI piano roll' })
    setPianoBounds(grid)
    fireEvent.click(screen.getByRole('button', { name: 'Draw notes' }))
    const note = screen.getByRole('button', { name: /C4, starts at/ })

    fireEvent.pointerDown(note, primaryPointer(1, 75, 805))
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 75, clientY: 805 })
    expect(onDeleteNotes).not.toHaveBeenCalled()
    expect(note.getAttribute('aria-pressed')).toBe('true')

    fireEvent.pointerDown(note, primaryPointer(2, 75, 805))
    fireEvent.pointerUp(window, { pointerId: 2, clientX: 75, clientY: 805 })
    expect(onDeleteNotes).toHaveBeenCalledOnce()
    expect(onDeleteNotes).toHaveBeenCalledWith(['note-c4'])
    expect(onEditNotes).not.toHaveBeenCalled()

    onDeleteNotes.mockClear()
    fireEvent.pointerDown(note, primaryPointer(3, 75, 805))
    fireEvent.pointerMove(window, { pointerId: 3, clientX: 175, clientY: 805 })
    fireEvent.pointerUp(window, { pointerId: 3, clientX: 175, clientY: 805 })
    expect(onDeleteNotes).not.toHaveBeenCalled()
    expect(onEditNotes).toHaveBeenNthCalledWith(1, [{ id: 'note-c4', patch: { startBeat: 1.5 } }])

    const resize = container.querySelector<HTMLElement>('.note-resize-handle')!
    fireEvent.pointerDown(resize, primaryPointer(4, 100, 805))
    fireEvent.pointerMove(window, { pointerId: 4, clientX: 150, clientY: 805 })
    fireEvent.pointerUp(window, { pointerId: 4, clientX: 150, clientY: 805 })
    expect(onEditNotes).toHaveBeenNthCalledWith(2, [{ id: 'note-c4', patch: { durationBeats: 1 } }])
    expect(onDeleteNotes).not.toHaveBeenCalled()
  })

  it('erases primary and derived loop occurrences by source id without auditioning', () => {
    const looped: MidiClip = {
      ...midiClip,
      startBeat: 0,
      sourceLoop: { cycleStartBeat: 0, cycleLengthBeats: 2, phaseBeats: 0 },
    }
    const onDeleteNotes = vi.fn()
    const onAuditionMidiNote = vi.fn()
    render(createElement(DetailEditor, {
      ...baseProps,
      clip: looped,
      track: { ...midiTrack, clips: [looped] },
      onDeleteNotes,
      onAuditionMidiNote,
    }))
    fireEvent.click(screen.getByRole('button', { name: 'Erase notes' }))
    const primary = screen.getByRole('button', { name: /C4, starts at/ })
    const derived = screen.getByRole('button', { name: 'Erase C4 repeated source note' })

    const grid = screen.getByRole('group', { name: 'MIDI piano roll' })
    setPianoBounds(grid)
    fireEvent.pointerDown(primary, primaryPointer(1, 75, 805))
    expect(onDeleteNotes).not.toHaveBeenCalled()
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 75, clientY: 805 })
    expect(onDeleteNotes).toHaveBeenLastCalledWith(['note-c4'])
    expect(onDeleteNotes).toHaveBeenCalledTimes(1)
    onDeleteNotes.mockClear()
    fireEvent.pointerDown(derived, primaryPointer(2, 275, 805))
    fireEvent.pointerUp(window, { pointerId: 2, clientX: 275, clientY: 805 })
    expect(onDeleteNotes).toHaveBeenCalledOnce()
    expect(onDeleteNotes).toHaveBeenCalledWith(['note-c4'])
    expect(onAuditionMidiNote).not.toHaveBeenCalled()
  })

  it('collects every source note crossed by one Eraser drag and deletes atomically', () => {
    const clip: MidiClip = {
      ...midiClip,
      notes: [
        { id: 'note-a', pitch: 60, startBeat: 0.5, durationBeats: 0.25, velocity: 0.8 },
        { id: 'note-b', pitch: 60, startBeat: 1.5, durationBeats: 0.25, velocity: 0.7 },
        { id: 'note-c', pitch: 60, startBeat: 3, durationBeats: 0.25, velocity: 0.6 },
      ],
    }
    const onDeleteNotes = vi.fn()
    const { container } = render(createElement(DetailEditor, {
      ...baseProps,
      clip,
      track: { ...midiTrack, clips: [clip] },
      onDeleteNotes,
    }))
    const grid = screen.getByRole('group', { name: 'MIDI piano roll' })
    setPianoBounds(grid)
    fireEvent.click(screen.getByRole('button', { name: 'Erase notes' }))

    fireEvent.pointerDown(grid, primaryPointer(9, 40, 810))
    fireEvent.pointerMove(window, { pointerId: 9, clientX: 330, clientY: 810 })
    expect(container.querySelectorAll('.piano-note.is-erasing')).toHaveLength(3)
    expect(onDeleteNotes).not.toHaveBeenCalled()
    fireEvent.pointerUp(window, { pointerId: 9, clientX: 330, clientY: 810 })

    expect(onDeleteNotes).toHaveBeenCalledOnce()
    expect(onDeleteNotes).toHaveBeenCalledWith(['note-a', 'note-b', 'note-c'])
  })

  it('batch-edits mixed pitch, source length, and velocity while keeping start single-note only', () => {
    const clip: MidiClip = {
      ...midiClip,
      notes: [
        { id: 'note-c4', pitch: 60, startBeat: 0.5, durationBeats: 0.5, velocity: 0.5 },
        { id: 'note-e4', pitch: 64, startBeat: 1.5, durationBeats: 0.75, velocity: 0.8 },
      ],
    }
    const onEditNotes = vi.fn()
    render(createElement(DetailEditor, { ...baseProps, clip, track: { ...midiTrack, clips: [clip] }, onEditNotes }))
    const grid = screen.getByRole('group', { name: 'MIDI piano roll' })
    fireEvent.keyDown(grid, { key: 'a', ctrlKey: true })

    const pitch = screen.getByLabelText<HTMLInputElement>('Selected note pitch')
    const duration = screen.getByLabelText<HTMLInputElement>('Selected note duration beats')
    const velocity = screen.getByLabelText<HTMLInputElement>('Selected note velocity')
    expect(pitch.value).toBe('')
    expect(pitch.placeholder).toBe('MIXED')
    expect(duration.value).toBe('')
    expect(duration.placeholder).toBe('MIXED')
    expect(velocity.getAttribute('aria-valuetext')).toBe('Mixed velocities')
    expect(screen.queryByLabelText('Selected note start beat')).toBeNull()

    fireEvent.keyDown(pitch, { key: 'ArrowUp' })
    expect(onEditNotes).toHaveBeenNthCalledWith(1, [
      { id: 'note-c4', patch: { pitch: 61 } },
      { id: 'note-e4', patch: { pitch: 65 } },
    ])
    fireEvent.keyDown(duration, { key: 'ArrowDown' })
    expect(onEditNotes).toHaveBeenNthCalledWith(2, [
      { id: 'note-c4', patch: { durationBeats: 0.25 } },
      { id: 'note-e4', patch: { durationBeats: 0.5 } },
    ])
    fireEvent.change(pitch, { target: { value: '70' } })
    expect(onEditNotes).toHaveBeenNthCalledWith(3, [
      { id: 'note-c4', patch: { pitch: 70 } },
      { id: 'note-e4', patch: { pitch: 70 } },
    ])
    fireEvent.change(duration, { target: { value: '1' } })
    expect(onEditNotes).toHaveBeenNthCalledWith(4, [
      { id: 'note-c4', patch: { durationBeats: 1 } },
      { id: 'note-e4', patch: { durationBeats: 1 } },
    ])
    fireEvent.change(velocity, { target: { value: '100' } })
    expect(onEditNotes).toHaveBeenNthCalledWith(5, [
      { id: 'note-c4', patch: { velocity: 100 / 127 } },
      { id: 'note-e4', patch: { velocity: 100 / 127 } },
    ])
  })

  it('keeps the selected or keyboard-focused pitch inside the fixed-height viewport', () => {
    const { container, rerender } = render(createElement(DetailEditor, {
      ...baseProps,
      clip: midiClip,
      track: midiTrack,
    }))
    const viewport = container.querySelector<HTMLElement>('.piano-roll-wrap')!
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 120 })
    fireEvent.click(screen.getByRole('button', { name: /C4, starts at/ }))
    viewport.scrollTop = 700

    const raisedClip: MidiClip = {
      ...midiClip,
      notes: [{ ...midiClip.notes[0], pitch: 100 }],
    }
    rerender(createElement(DetailEditor, {
      ...baseProps,
      clip: raisedClip,
      track: { ...midiTrack, clips: [raisedClip] },
    }))
    expect(viewport.scrollTop).toBe(312)

    viewport.scrollTop = 700
    const raisedKey = screen.getByRole('button', { name: 'Audition E7' })
    raisedKey.focus()
    fireEvent.keyDown(raisedKey, { key: 'End' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Audition G9' }))
    expect(viewport.scrollTop).toBe(0)
  })
})

describe('DetailEditor audio source boundary', () => {
  it('aligns visible beat and bar lines to the project meter instead of the region edge', () => {
    expect(getAudioDetailGridLines(2, 4, { numerator: 4, denominator: 4 })).toEqual([
      { beat: 2, positionPercent: 0, kind: 'beat' },
      { beat: 3, positionPercent: 25, kind: 'beat' },
      { beat: 4, positionPercent: 50, kind: 'bar' },
      { beat: 5, positionPercent: 75, kind: 'beat' },
      { beat: 6, positionPercent: 100, kind: 'beat' },
    ])
    const sixEight = getAudioDetailGridLines(0.5, 1.5, { numerator: 6, denominator: 8 })
    expect(sixEight.map(({ beat, kind }) => ({ beat, kind }))).toEqual([
      { beat: 0.5, kind: 'beat' },
      { beat: 1, kind: 'beat' },
      { beat: 1.5, kind: 'beat' },
      { beat: 2, kind: 'beat' },
    ])
    expect(sixEight.map((line) => line.positionPercent)).toEqual([
      0,
      expect.closeTo(100 / 3),
      expect.closeTo(200 / 3),
      100,
    ])
  })

  it('renders bar and beat grid lines over the selected Audio Region waveform', () => {
    const { clip, track, asset } = audioFixture()
    const { container } = render(createElement(DetailEditor, { ...baseProps, clip, track, asset }))
    expect(container.querySelectorAll('.audio-detail-musical-grid .is-bar')).toHaveLength(2)
    expect(container.querySelectorAll('.audio-detail-musical-grid .is-beat')).toHaveLength(4)
    expect(screen.queryByRole('button', { name: /Toggle snap, 1\/16 grid/i })).toBeNull()
  })

  it('renders actual looped source slices and exposes an immutable-source boundary', () => {
    const { clip, track, asset } = audioFixture()

    const { container } = render(createElement(DetailEditor, { ...baseProps, clip, track, asset }))

    expect(screen.getByRole('img', { name: /non-destructive clip-slice waveform.*3 source reads.*2.00-beat loop/i })).toBeTruthy()
    expect(container.querySelectorAll('.detail-waveform-slice')).toHaveLength(3)
    expect(screen.getByRole('note', { name: /Source audio bytes are immutable/i })).toBeTruthy()
    expect(screen.getByText('SOURCE BYTES IMMUTABLE')).toBeTruthy()
  })

  it('turns the waveform into pointer and keyboard playhead controls', () => {
    const { clip, track, asset } = audioFixture()
    const onSeek = vi.fn()
    const { container } = render(createElement(DetailEditor, {
      ...baseProps,
      clip,
      track,
      asset,
      playheadBeat: 0,
      onSeek,
    }))
    const stage = container.querySelector<HTMLElement>('.detail-waveform-stage')!
    stage.getBoundingClientRect = () => ({
      x: 100,
      y: 0,
      left: 100,
      top: 0,
      right: 600,
      bottom: 115,
      width: 500,
      height: 115,
      toJSON: () => ({}),
    })
    const seek = screen.getByRole('slider', { name: 'Looped Audio waveform playhead' })

    fireEvent.pointerDown(seek, { clientX: 350, pointerId: 1 })
    expect(onSeek).toHaveBeenLastCalledWith(2.5)
    fireEvent.keyDown(seek, { key: 'ArrowRight' })
    expect(onSeek).toHaveBeenLastCalledWith(0.25)
    fireEvent.keyDown(seek, { key: 'End' })
    expect(onSeek).toHaveBeenLastCalledWith(5)
  })

  it('anchors the audio playhead to the same inset waveform stage used for seeking', () => {
    const { clip, track, asset } = audioFixture()
    const { container } = render(createElement(DetailEditor, {
      ...baseProps,
      clip,
      track,
      asset,
      playheadBeat: 2.5,
    }))
    const stage = container.querySelector<HTMLElement>('.detail-waveform-stage')!
    const playhead = container.querySelector<HTMLElement>('.audio-detail-playhead')!
    expect(playhead.parentElement).toBe(stage)
    expect(playhead.style.left).toBe('50%')
  })

  it('commits each pointer fade gesture once and clamps keyboard edits to clip seconds', () => {
    const { clip, track, asset } = audioFixture()
    const onEditAudio = vi.fn()
    const { container } = render(createElement(DetailEditor, {
      ...baseProps,
      clip,
      track,
      asset,
      onEditAudio,
    }))
    const stage = container.querySelector<HTMLElement>('.detail-waveform-stage')!
    stage.getBoundingClientRect = () => ({
      x: 100,
      y: 0,
      left: 100,
      top: 0,
      right: 600,
      bottom: 115,
      width: 500,
      height: 115,
      toJSON: () => ({}),
    })
    const fadeIn = screen.getByRole('slider', { name: 'Audio fade in' })
    const fadeOut = screen.getByRole('slider', { name: 'Audio fade out' })

    expect(fadeIn.getAttribute('aria-valuemax')).toBe('2.5')
    fireEvent.pointerDown(fadeIn, { button: 0, clientX: 104, pointerId: 1, isPrimary: true })
    fireEvent.pointerMove(window, { clientX: 500, pointerId: 2 })
    fireEvent.pointerUp(window, { clientX: 500, pointerId: 2 })
    expect(onEditAudio).not.toHaveBeenCalled()
    fireEvent.pointerMove(window, { clientX: 350, pointerId: 1 })
    fireEvent.pointerUp(window, { clientX: 350, pointerId: 1 })
    expect(onEditAudio).toHaveBeenCalledOnce()
    expect(onEditAudio).toHaveBeenLastCalledWith({ fadeIn: 1.25 })

    onEditAudio.mockClear()
    fireEvent.keyDown(fadeOut, { key: 'End' })
    expect(onEditAudio).toHaveBeenCalledOnce()
    expect(onEditAudio).toHaveBeenLastCalledWith({ fadeOut: 2.5 })
  })

  it('cancels an owned fade gesture on blur without committing it', () => {
    const { clip, track, asset } = audioFixture()
    const onEditAudio = vi.fn()
    const { container } = render(createElement(DetailEditor, {
      ...baseProps,
      clip,
      track,
      asset,
      onEditAudio,
    }))
    const stage = container.querySelector<HTMLElement>('.detail-waveform-stage')!
    stage.getBoundingClientRect = () => ({
      x: 100,
      y: 0,
      left: 100,
      top: 0,
      right: 600,
      bottom: 115,
      width: 500,
      height: 115,
      toJSON: () => ({}),
    })
    const fadeIn = screen.getByRole('slider', { name: 'Audio fade in' })
    fireEvent.pointerDown(fadeIn, { button: 0, clientX: 104, pointerId: 1, isPrimary: true })
    fireEvent.pointerMove(window, { clientX: 350, pointerId: 1 })
    fireEvent.blur(window)
    fireEvent.pointerUp(window, { clientX: 350, pointerId: 1 })
    expect(onEditAudio).not.toHaveBeenCalled()
  })

  it('leaves source-overrun space blank instead of stretching the last waveform samples', () => {
    expect(getRenderableDetailSourceSlice({
      placementStartBeat: 3,
      durationBeats: 4,
      sourceStartBeat: 8,
    }, 10, 1000)).toEqual({
      placementStartBeat: 3,
      durationBeats: 2,
      viewStart: 800,
      viewWidth: 200,
    })
    expect(getRenderableDetailSourceSlice({
      placementStartBeat: 3,
      durationBeats: 4,
      sourceStartBeat: 10,
    }, 10, 1000)).toBeNull()
  })
})
