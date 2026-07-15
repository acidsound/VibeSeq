// @vitest-environment jsdom

import { createElement } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDrumMidiTrackSettings, createMelodicMidiTrackSettings } from '../core'
import { MidiRoutingControls } from './MidiRoutingControls'

afterEach(cleanup)

describe('MIDI track routing controls', () => {
  it('commits melodic channel and named program in zero-based project form', () => {
    const onChange = vi.fn()
    const settings = createMelodicMidiTrackSettings(0, 0)
    const { rerender } = render(createElement(MidiRoutingControls, { settings, onChange }))

    fireEvent.change(screen.getByLabelText('MIDI channel'), { target: { value: '4' } })
    expect(onChange).toHaveBeenLastCalledWith(createMelodicMidiTrackSettings(4, 0))

    rerender(createElement(MidiRoutingControls, {
      settings: createMelodicMidiTrackSettings(4, 0),
      onChange,
    }))
    fireEvent.change(screen.getByLabelText('TinySynth program'), { target: { value: '80' } })
    expect(onChange).toHaveBeenLastCalledWith(createMelodicMidiTrackSettings(4, 80))
  })

  it('switches drums atomically to wire channel 9 and locks the displayed channel 10', () => {
    const onChange = vi.fn()
    const { rerender } = render(createElement(MidiRoutingControls, {
      settings: createMelodicMidiTrackSettings(2, 40),
      onChange,
    }))

    fireEvent.change(screen.getByLabelText('MIDI instrument profile'), { target: { value: 'drums' } })
    expect(onChange).toHaveBeenCalledWith(createDrumMidiTrackSettings())

    rerender(createElement(MidiRoutingControls, { settings: createDrumMidiTrackSettings(), onChange }))
    const channel = screen.getByLabelText('MIDI channel') as HTMLSelectElement
    expect(channel.disabled).toBe(true)
    expect(channel.value).toBe('9')
    expect(screen.queryByLabelText('TinySynth program')).toBeNull()
  })
})
