// @vitest-environment jsdom

import { createElement } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TrackPropertiesControls } from './TrackPropertiesControls'

afterEach(cleanup)

describe('Track properties controls', () => {
  it('commits rename on Enter or blur and cancels with Escape', () => {
    const onRename = vi.fn()
    const onDelete = vi.fn()
    const { rerender } = render(createElement(TrackPropertiesControls, {
      trackId: 'track-1',
      trackName: 'New MIDI',
      description: 'MIDI track · 0 regions',
      onRename,
      onDelete,
    }))
    fireEvent.click(screen.getByRole('button', { name: 'Edit New MIDI track name' }))
    let name = screen.getByLabelText('Track name') as HTMLInputElement

    name.focus()
    fireEvent.change(name, { target: { value: '  Lead Route  ' } })
    fireEvent.keyDown(name, { key: 'Enter' })
    expect(onRename).toHaveBeenCalledOnce()
    expect(onRename).toHaveBeenLastCalledWith('Lead Route')

    rerender(createElement(TrackPropertiesControls, {
      trackId: 'track-1',
      trackName: 'Lead Route',
      description: 'MIDI track · 0 regions',
      onRename,
      onDelete,
    }))
    fireEvent.click(screen.getByRole('button', { name: 'Edit Lead Route track name' }))
    name = screen.getByLabelText('Track name') as HTMLInputElement
    name.focus()
    fireEvent.change(name, { target: { value: 'Cancelled name' } })
    fireEvent.keyDown(name, { key: 'Escape' })
    expect(screen.queryByLabelText('Track name')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Lead Route' })).toBeTruthy()
    expect(onRename).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Edit Lead Route track name' }))
    name = screen.getByLabelText('Track name') as HTMLInputElement
    name.focus()
    fireEvent.change(name, { target: { value: 'Glass Lead' } })
    fireEvent.blur(name)
    expect(onRename).toHaveBeenLastCalledWith('Glass Lead')
  })

  it('restores an empty name and exposes real track deletion', () => {
    const onRename = vi.fn()
    const onDelete = vi.fn()
    render(createElement(TrackPropertiesControls, {
      trackId: 'track-1',
      trackName: 'Bass',
      description: 'Audio track · 2 regions',
      onRename,
      onDelete,
    }))
    expect(screen.getByText('Audio track · 2 regions')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Edit Bass track name' }))
    const name = screen.getByLabelText('Track name') as HTMLInputElement
    fireEvent.change(name, { target: { value: '   ' } })
    fireEvent.blur(name)
    expect(screen.queryByLabelText('Track name')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Bass' })).toBeTruthy()
    expect(onRename).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Delete Bass track' }))
    expect(onDelete).toHaveBeenCalledOnce()
  })

  it('allows the same rename to be retried until the parent prop confirms it', () => {
    const onRename = vi.fn()
    render(createElement(TrackPropertiesControls, {
      trackId: 'track-1',
      trackName: 'Bass',
      description: 'Audio track · 0 regions',
      onRename,
      onDelete: vi.fn(),
    }))

    const submitName = () => {
      fireEvent.click(screen.getByRole('button', { name: 'Edit Bass track name' }))
      const input = screen.getByLabelText('Track name')
      fireEvent.change(input, { target: { value: 'Retry Name' } })
      fireEvent.keyDown(input, { key: 'Enter' })
    }

    submitName()
    submitName()
    expect(onRename.mock.calls).toEqual([['Retry Name'], ['Retry Name']])
  })
})
