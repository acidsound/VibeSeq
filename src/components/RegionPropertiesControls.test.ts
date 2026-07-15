// @vitest-environment jsdom

import { createElement } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RegionPropertiesControls } from './RegionPropertiesControls'

afterEach(cleanup)

describe('Region properties controls', () => {
  it('commits a trimmed rename on Enter or blur and cancels with Escape', () => {
    const onRename = vi.fn()
    const onDelete = vi.fn()
    const { rerender } = render(createElement(RegionPropertiesControls, {
      regionId: 'region-1',
      regionName: 'Verse Take',
      description: 'Audio Track · 4.00 beats',
      onRename,
      onDelete,
    }))

    fireEvent.click(screen.getByRole('button', { name: 'Edit Verse Take region name' }))
    let name = screen.getByLabelText('Region name') as HTMLInputElement
    fireEvent.change(name, { target: { value: '  Lead Verse  ' } })
    fireEvent.keyDown(name, { key: 'Enter' })
    expect(onRename).toHaveBeenCalledOnce()
    expect(onRename).toHaveBeenLastCalledWith('Lead Verse')

    rerender(createElement(RegionPropertiesControls, {
      regionId: 'region-1',
      regionName: 'Lead Verse',
      description: 'Audio Track · 4.00 beats',
      onRename,
      onDelete,
    }))
    fireEvent.click(screen.getByRole('button', { name: 'Edit Lead Verse region name' }))
    name = screen.getByLabelText('Region name') as HTMLInputElement
    fireEvent.change(name, { target: { value: 'Cancelled name' } })
    fireEvent.keyDown(name, { key: 'Escape' })
    expect(screen.queryByLabelText('Region name')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Lead Verse' })).toBeTruthy()
    expect(onRename).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Edit Lead Verse region name' }))
    name = screen.getByLabelText('Region name') as HTMLInputElement
    fireEvent.change(name, { target: { value: 'Glass Verse' } })
    fireEvent.blur(name)
    expect(onRename).toHaveBeenLastCalledWith('Glass Verse')
  })

  it('restores an empty name and exposes one real region delete action', () => {
    const onRename = vi.fn()
    const onDelete = vi.fn()
    render(createElement(RegionPropertiesControls, {
      regionId: 'region-1',
      regionName: 'Bass Fill',
      description: 'MIDI Track · 2.00 beats',
      onRename,
      onDelete,
    }))

    expect(screen.getByText('MIDI Track · 2.00 beats')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Edit Bass Fill region name' }))
    const name = screen.getByLabelText('Region name') as HTMLInputElement
    fireEvent.change(name, { target: { value: '   ' } })
    fireEvent.blur(name)
    expect(screen.queryByLabelText('Region name')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Bass Fill' })).toBeTruthy()
    expect(onRename).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Delete Bass Fill region' }))
    expect(onDelete).toHaveBeenCalledOnce()
  })

  it('allows the same rename to be retried until the parent prop confirms it', () => {
    const onRename = vi.fn()
    render(createElement(RegionPropertiesControls, {
      regionId: 'region-1',
      regionName: 'Bass Fill',
      description: 'MIDI Track · 2.00 beats',
      onRename,
      onDelete: vi.fn(),
    }))

    const submitName = () => {
      fireEvent.click(screen.getByRole('button', { name: 'Edit Bass Fill region name' }))
      const input = screen.getByLabelText('Region name')
      fireEvent.change(input, { target: { value: 'Retry Region' } })
      fireEvent.keyDown(input, { key: 'Enter' })
    }

    submitName()
    submitName()
    expect(onRename.mock.calls).toEqual([['Retry Region'], ['Retry Region']])
  })
})
