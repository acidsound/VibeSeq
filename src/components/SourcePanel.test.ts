// @vitest-environment jsdom

import { createElement } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SourcePanel } from './SourcePanel'

afterEach(cleanup)

type SourcePanelProps = Parameters<typeof SourcePanel>[0]

const createSourcePanelProps = (overrides: Partial<SourcePanelProps> = {}): SourcePanelProps => ({
  prompt: '',
  generationLength: { unit: 'seconds', value: 4 },
  seed: 1,
  bpm: 120,
  timeSignature: { numerator: 4, denominator: 4 },
  candidates: [],
  previewingCandidateId: null,
  job: null,
  open: true,
  onPromptChange: vi.fn(),
  onGenerationLengthChange: vi.fn(),
  onSeedChange: vi.fn(),
  onGenerate: vi.fn(),
  onCancel: vi.fn(),
  onPlace: vi.fn(),
  onPreview: vi.fn(),
  onDownload: vi.fn(),
  onImport: vi.fn(),
  onClose: vi.fn(),
  ...overrides,
})

const renderImportPanel = () => {
  const onImport = vi.fn()
  render(createElement(SourcePanel, createSourcePanelProps({ onImport })))
  fireEvent.click(screen.getByRole('button', { name: 'Import' }))
  return onImport
}

describe('SourcePanel audio import', () => {
  it('shows a file drop target and passes the dropped file to the import handler', () => {
    const onImport = renderImportPanel()
    const dropzone = screen.getByRole('region', { name: 'Import audio drop zone' })
    const file = new File(['audio'], 'loop.wav', { type: 'audio/wav' })
    const dataTransfer = {
      types: ['Files'],
      items: [{ kind: 'file' }],
      files: [file],
      dropEffect: 'none',
    }

    expect(dropzone.getAttribute('aria-describedby')).toBe('source-import-drop-help')
    fireEvent.dragEnter(dropzone, { dataTransfer })
    expect(dropzone.classList.contains('is-dragging')).toBe(true)
    expect(screen.getByText('Drop to import this audio')).toBeTruthy()

    fireEvent.dragOver(dropzone, { dataTransfer })
    expect(dataTransfer.dropEffect).toBe('copy')
    fireEvent.dragLeave(dropzone, { dataTransfer })
    expect(dropzone.classList.contains('is-dragging')).toBe(false)

    fireEvent.dragEnter(dropzone, { dataTransfer })
    fireEvent.drop(dropzone, { dataTransfer })
    expect(onImport).toHaveBeenCalledOnce()
    expect(onImport).toHaveBeenCalledWith(file)
    expect(dropzone.classList.contains('is-dragging')).toBe(false)
  })

  it('opens the existing file chooser flow without manufacturing a file', () => {
    const onImport = renderImportPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Choose audio file' }))
    expect(onImport).toHaveBeenCalledOnce()
    expect(onImport).toHaveBeenCalledWith()
  })

  it('keeps the preview control and waveform in one bounded flex row', () => {
    render(createElement(SourcePanel, createSourcePanelProps({
      candidates: [{
        id: 'candidate-1',
        name: 'Wide Loop',
        prompt: 'wide loop',
        duration: 4,
        provider: 'local',
        device: 'gpu',
        blob: new Blob(['audio'], { type: 'audio/wav' }),
        peaks: { samplesPerPeak: 128, min: [-0.5, -0.25], max: [0.5, 0.25] },
      }],
    })))

    const preview = screen.getByRole('button', { name: 'Preview Wide Loop' })
    expect(preview.firstElementChild?.classList.contains('preview-icon')).toBe(true)
    const visual = preview.querySelector('.candidate-waveform-visual')
    expect(visual).toBeTruthy()
    expect(visual?.querySelector('svg')).toBeTruthy()
  })
})

describe('SourcePanel prompt focus requests', () => {
  it('returns to Generate and focuses the reused prompt at its end', () => {
    const initialProps = createSourcePanelProps({ prompt: 'old prompt' })
    const view = render(createElement(SourcePanel, initialProps))
    fireEvent.click(screen.getByRole('button', { name: 'Library' }))
    expect(screen.getByRole('heading', { name: 'Sound Library' })).toBeTruthy()

    const reusedPrompt = 'granular glass pulse'
    view.rerender(createElement(SourcePanel, {
      ...initialProps,
      prompt: reusedPrompt,
      promptFocusRequest: 1,
    }))

    expect(screen.getByRole('heading', { name: 'Generate sound' })).toBeTruthy()
    const input = screen.getByRole('textbox') as HTMLTextAreaElement
    expect(document.activeElement).toBe(input)
    expect(input.value).toBe(reusedPrompt)
    expect(input.selectionStart).toBe(reusedPrompt.length)
    expect(input.selectionEnd).toBe(reusedPrompt.length)

    input.blur()
    view.rerender(createElement(SourcePanel, {
      ...initialProps,
      prompt: reusedPrompt,
      promptFocusRequest: 2,
    }))
    expect(document.activeElement).toBe(input)
    expect(input.selectionStart).toBe(reusedPrompt.length)
  })

  it('returns from Import and blocks only prompts outside the server contract', () => {
    const props = createSourcePanelProps({ prompt: 'same prompt' })
    const view = render(createElement(SourcePanel, props))
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    expect(screen.getByRole('heading', { name: 'Import audio' })).toBeTruthy()

    view.rerender(createElement(SourcePanel, { ...props, promptFocusRequest: 1 }))
    expect(screen.getByRole('heading', { name: 'Generate sound' })).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('textbox'))

    const oversized = 'x'.repeat(2_001)
    view.rerender(createElement(SourcePanel, { ...props, prompt: oversized, promptFocusRequest: 1 }))
    const input = screen.getByRole('textbox')
    expect(input.getAttribute('maxlength')).toBe('2000')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByText('2001 / 2000 characters · prompt is too long')).toBeTruthy()
    const generate = screen.getAllByRole('button', { name: 'Generate' }).find((button) => button.classList.contains('primary-button'))
    expect(generate?.hasAttribute('disabled')).toBe(true)
  })
})
