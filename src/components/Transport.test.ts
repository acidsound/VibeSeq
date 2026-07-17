// @vitest-environment jsdom

import { createElement } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBlankProject } from '../core'
import { Transport } from './Transport'

const renderTransport = (onBpmChange = vi.fn()) => {
  const project = createBlankProject({ now: '2026-07-15T00:00:00.000Z' })
  const onSnapGridChange = vi.fn()
  render(createElement(Transport, {
    project,
    playheadBeat: 0,
    playing: false,
    snapGrid: 'bar',
    canUndo: false,
    canRedo: false,
    health: null,
    generationProvider: 'procedural-demo',
    masterLevel: 0,
    onTogglePlay: vi.fn(),
    onStop: vi.fn(),
    onSeekStart: vi.fn(),
    onToggleLoop: vi.fn(),
    onSnapGridChange,
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    onBpmChange,
    onExport: vi.fn(),
    onOpenProject: vi.fn(),
    onOpenSettings: vi.fn(),
  }))
  return { input: screen.getByRole('spinbutton', { name: 'Tempo' }), onBpmChange, onSnapGridChange }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Transport tempo commit behavior', () => {
  it('keeps typing local and commits exactly once on Enter', () => {
    const { input, onBpmChange } = renderTransport()

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '90' } })
    expect(onBpmChange).not.toHaveBeenCalled()

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onBpmChange).toHaveBeenCalledTimes(1)
    expect(onBpmChange).toHaveBeenCalledWith(90)
  })

  it('commits exactly once on blur', () => {
    const { input, onBpmChange } = renderTransport()

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '105.04' } })
    fireEvent.blur(input)

    expect(onBpmChange).toHaveBeenCalledTimes(1)
    expect(onBpmChange).toHaveBeenCalledWith(105)
  })

  it('restores the committed tempo on Escape without committing', () => {
    const { input, onBpmChange } = renderTransport()

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '80' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect((input as HTMLInputElement).value).toBe('120.0')
    expect(onBpmChange).not.toHaveBeenCalled()
  })

  it('restores the committed tempo when arrangement preflight rejects the edit', () => {
    const { input, onBpmChange } = renderTransport(vi.fn(() => false))

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '240' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onBpmChange).toHaveBeenCalledWith(240)
    expect((input as HTMLInputElement).value).toBe('120.0')
  })
})

describe('Transport snap grid', () => {
  it('exposes the full grid list with Bar selected by default', () => {
    const { onSnapGridChange } = renderTransport()
    const select = screen.getByRole('combobox', { name: 'Snap grid' }) as HTMLSelectElement

    expect(select.value).toBe('bar')
    expect([...select.options].map((option) => option.text)).toEqual(['Bar', '1/2', '1/4', '1/8', '1/16', 'Free'])

    fireEvent.change(select, { target: { value: '1/8' } })
    expect(onSnapGridChange).toHaveBeenCalledWith('1/8')
  })
})
