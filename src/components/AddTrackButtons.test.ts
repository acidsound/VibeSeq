// @vitest-environment jsdom

import { createElement } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AddTrackButtons } from './AddTrackButtons'

afterEach(cleanup)

describe('AddTrackButtons', () => {
  it('adds either track type directly without opening a menu', () => {
    const onAddTrack = vi.fn()
    render(createElement(AddTrackButtons, { onAddTrack }))

    fireEvent.click(screen.getByRole('button', { name: 'Add audio track' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add MIDI track' }))

    expect(onAddTrack.mock.calls).toEqual([['audio'], ['midi']])
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('exposes exact accessible names, tooltips, and paired icons', () => {
    render(createElement(AddTrackButtons, { onAddTrack: vi.fn() }))

    const audio = screen.getByRole('button', { name: 'Add audio track' })
    const midi = screen.getByRole('button', { name: 'Add MIDI track' })

    expect(audio.getAttribute('title')).toBe('Add audio track')
    expect(audio.querySelector('.lucide-plus')).not.toBeNull()
    expect(audio.querySelector('.lucide-audio-lines')).not.toBeNull()
    expect(midi.getAttribute('title')).toBe('Add MIDI track')
    expect(midi.querySelector('.lucide-plus')).not.toBeNull()
    expect(midi.querySelector('.lucide-music-2')).not.toBeNull()
  })
})
