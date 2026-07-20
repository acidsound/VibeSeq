// @vitest-environment jsdom

import { createElement } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AudioClip, AudioTrack, MidiClip, MidiTrack } from '../types'
import { Inspector } from './Inspector'

afterEach(cleanup)

const sourceClipId = 'audio-source-region'

const midiClip = (parentClipId: string | null = sourceClipId): MidiClip => ({
  id: 'midi-region',
  name: 'Extracted Notes',
  kind: 'midi',
  startBeat: 0,
  durationBeats: 4,
  offsetBeats: 0,
  gain: 1,
  fadeIn: 0,
  fadeOut: 0,
  notes: [],
  provenance: {
    source: 'muscriptor',
    createdAt: '2026-07-15T00:00:00.000Z',
    ...(parentClipId ? { parentClipId } : {}),
  },
})

const midiTrack = (clip: MidiClip): MidiTrack => ({
  id: 'midi-track',
  name: 'Extracted MIDI',
  kind: 'midi',
  midi: { channel: 0, instrument: { kind: 'melodic', playbackId: 'WebAudio-TinySynth', program: 0 } },
  color: '#5DD6D1',
  gain: 1,
  pan: 0,
  mute: false,
  solo: false,
  clips: [clip],
})

const audioClip = (prompt?: string): AudioClip => ({
  id: 'audio-region',
  name: 'Generated Texture',
  kind: 'audio',
  assetId: 'audio-asset',
  startBeat: 0,
  durationBeats: 4,
  offsetBeats: 0,
  gain: 1,
  fadeIn: 0,
  fadeOut: 0,
  timebase: { mode: 'fixed-seconds', sourceBpm: 120 },
  provenance: {
    source: 'stable-audio',
    createdAt: '2026-07-15T00:00:00.000Z',
    ...(prompt ? { prompt } : {}),
  },
})

const audioTrack = (clip: AudioClip): AudioTrack => ({
  id: 'audio-track',
  name: 'Generated Audio',
  kind: 'audio',
  color: '#F6A84B',
  gain: 1,
  pan: 0,
  mute: false,
  solo: false,
  clips: [clip],
})

type InspectorProps = Parameters<typeof Inspector>[0]

const renderInspector = (overrides: Partial<InspectorProps> = {}) => {
  const clip = overrides.clip ?? midiClip()
  const track = overrides.track ?? midiTrack(clip as MidiClip)
  const props: InspectorProps = {
    track,
    clip,
    playheadBeat: 1,
    bpm: 120,
    open: true,
    extracting: false,
    busy: false,
    onGain: vi.fn(),
    onTrackGain: vi.fn(),
    onTrackPan: vi.fn(),
    onToggleTrack: vi.fn(),
    onMidiSettings: vi.fn(),
    onRenameTrack: vi.fn(),
    onDeleteTrack: vi.fn(),
    onRenameRegion: vi.fn(),
    onFade: vi.fn(),
    onAudioTransform: vi.fn(),
    onToggleClipMute: vi.fn(),
    onToggleSourceLoop: vi.fn(),
    onExtract: vi.fn(),
    onSplit: vi.fn(),
    onDuplicate: vi.fn(),
    onDelete: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  }
  render(createElement(Inspector, props))
  return props
}

describe('Inspector linked audio region provenance', () => {
  it('places rename and delete beside the region name without a duplicate bottom delete', () => {
    const onRenameRegion = vi.fn()
    const onDelete = vi.fn()
    renderInspector({ onRenameRegion, onDelete })

    fireEvent.click(screen.getByRole('button', { name: 'Edit Extracted Notes region name' }))
    const name = screen.getByRole('textbox', { name: 'Region name' })
    fireEvent.change(name, { target: { value: '  Edited Notes  ' } })
    fireEvent.keyDown(name, { key: 'Enter' })
    expect(onRenameRegion).toHaveBeenCalledWith('Edited Notes')

    fireEvent.click(screen.getByRole('button', { name: 'Delete Extracted Notes region' }))
    expect(onDelete).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull()
  })

  it('makes both the provenance icon and named region row actionable', () => {
    const onOpenLinkedRegion = vi.fn()
    renderInspector({
      linkedRegion: {
        clipId: sourceClipId,
        clipName: 'Warm Source Take',
        trackId: 'audio-track',
        trackName: 'Generated Audio',
      },
      onOpenLinkedRegion,
    })

    expect(screen.getByText('Warm Source Take')).toBeTruthy()
    expect(screen.getByText(`Generated Audio · ${sourceClipId}`)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Reveal linked audio region Warm Source Take in Arrangement' }))
    fireEvent.click(screen.getByRole('button', { name: 'Go to linked audio region Warm Source Take on Generated Audio track' }))

    expect(onOpenLinkedRegion.mock.calls).toEqual([
      [sourceClipId, 'audio-track'],
      [sourceClipId, 'audio-track'],
    ])
  })

  it('shows a missing parent ID as non-interactive unavailable lineage', () => {
    renderInspector({ clip: midiClip('deleted-audio-region') })

    expect(screen.getByRole('img', { name: 'Linked audio region unavailable' })).toBeTruthy()
    expect(screen.getByRole('status', { name: 'Linked audio region unavailable: deleted-audio-region' })).toBeTruthy()
    expect(screen.getByText('Source audio unavailable')).toBeTruthy()
    expect(screen.getByText('deleted-audio-region')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /linked audio region/i })).toBeNull()
  })

  it('shows no link affordance when the clip has no parent region', () => {
    renderInspector({ clip: midiClip(null) })

    expect(screen.queryByText('Linked region')).toBeNull()
    expect(screen.queryByRole('img', { name: 'Linked audio region unavailable' })).toBeNull()
    expect(screen.queryByRole('button', { name: /linked audio region/i })).toBeNull()
  })
})

describe('Inspector audio transform controls', () => {
  it('stages clip-local pitch and stretch before applying them together', () => {
    const onAudioTransform = vi.fn()
    renderInspector({
      clip: audioClip(),
      track: audioTrack(audioClip()),
      onAudioTransform,
    })

    fireEvent.change(screen.getByRole('slider', { name: /^Pitch/ }), { target: { value: '7' } })
    fireEvent.change(screen.getByRole('slider', { name: /^Stretch/ }), { target: { value: '1.5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply to clip' }))
    expect(onAudioTransform).toHaveBeenCalledWith(7, 1.5)
  })

  it('offers reset for a transformed clip', () => {
    const clip = audioClip()
    clip.assetId = 'derived-asset'
    clip.transform = { sourceAssetId: 'audio-asset', pitchSemitones: -5, stretchRatio: 2 }
    const onAudioTransform = vi.fn()
    renderInspector({ clip, track: audioTrack(clip), onAudioTransform })

    fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
    expect(onAudioTransform).toHaveBeenCalledWith(0, 1)
  })
})

describe('Inspector audio prompt provenance', () => {
  it('reuses an audio-region prompt through an explicit action', () => {
    const clip = audioClip('granular glass pulse')
    const onReusePrompt = vi.fn()
    renderInspector({ clip, track: audioTrack(clip), onReusePrompt })

    fireEvent.click(screen.getByRole('button', { name: 'Reuse prompt in Generate sound' }))
    expect(onReusePrompt).toHaveBeenCalledOnce()
    expect(onReusePrompt).toHaveBeenCalledWith('granular glass pulse')
  })

  it('does not show a fake reuse affordance without an audio prompt', () => {
    const clip = audioClip()
    renderInspector({ clip, track: audioTrack(clip), onReusePrompt: vi.fn() })
    expect(screen.queryByRole('button', { name: 'Reuse prompt in Generate sound' })).toBeNull()

    cleanup()
    renderInspector({ onReusePrompt: vi.fn() })
    expect(screen.queryByRole('button', { name: 'Reuse prompt in Generate sound' })).toBeNull()

    cleanup()
    const midiWithPrompt = midiClip(null)
    midiWithPrompt.provenance.prompt = 'midi lineage prompt'
    renderInspector({ clip: midiWithPrompt, track: midiTrack(midiWithPrompt), onReusePrompt: vi.fn() })
    expect(screen.queryByRole('button', { name: 'Reuse prompt in Generate sound' })).toBeNull()

    cleanup()
    const whitespacePrompt = audioClip('   ')
    renderInspector({ clip: whitespacePrompt, track: audioTrack(whitespacePrompt), onReusePrompt: vi.fn() })
    expect(screen.queryByRole('button', { name: 'Reuse prompt in Generate sound' })).toBeNull()
  })
})
