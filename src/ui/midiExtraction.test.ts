import { describe, expect, it } from 'vitest'
import type { AudioClip } from '../types'
import {
  captureMidiExtractionSnapshot,
  classifyTranscribedMidiInstrument,
  createExtractedMidiClip,
  createMidiTrackSettingsForTranscription,
} from './midiExtraction'

const sourceClip: AudioClip = {
  id: 'source-clip',
  name: 'Looped source',
  kind: 'audio',
  startBeat: 12,
  durationBeats: 8,
  offsetBeats: 2,
  timebase: { mode: 'tempo-follow-repitch', sourceBpm: 120 },
  sourceLoop: { cycleStartBeat: 1, cycleLengthBeats: 4, phaseBeats: 1 },
  assetId: 'source-asset',
  gain: 1,
  fadeIn: 0,
  fadeOut: 0,
  provenance: { source: 'user', createdAt: '2026-07-15T00:00:00.000Z' },
}

describe('MuScriptor submission snapshots', () => {
  it('classifies only supported all-drum labels as a channel-10 drum track', () => {
    const drums = [{ instrument: 'kick drum' }, { instrument: 'hi hat' }, { instrument: 'snare' }]
    expect(classifyTranscribedMidiInstrument(drums)).toBe('drums')
    expect(createMidiTrackSettingsForTranscription(drums)).toEqual({
      channel: 9,
      instrument: { kind: 'drums', playbackId: 'WebAudioFont 128_0_Chaos_sf2_file' },
    })
    expect(classifyTranscribedMidiInstrument([{ instrument: 'drums' }, { instrument: 'electric bass' }]))
      .toBe('melodic')
    expect(classifyTranscribedMidiInstrument([{ instrument: undefined }])).toBe('melodic')
  })

  it('copies the exact source mapping instead of retaining mutable clip objects', () => {
    const mutableClip: AudioClip = {
      ...sourceClip,
      sourceLoop: sourceClip.sourceLoop ? { ...sourceClip.sourceLoop } : undefined,
    }
    const snapshot = captureMidiExtractionSnapshot(mutableClip, 'source-track', 120)
    mutableClip.startBeat = 40
    mutableClip.sourceLoop!.phaseBeats = 3

    expect(snapshot).toEqual({
      sourceAssetId: 'source-asset',
      sourceTrackId: 'source-track',
      sourceClipId: 'source-clip',
      sourceClipName: 'Looped source',
      startBeat: 12,
      durationBeats: 8,
      offsetBeats: 2,
      sourceLoop: { cycleStartBeat: 1, cycleLengthBeats: 4, phaseBeats: 1 },
      timebase: { mode: 'tempo-follow-repitch', sourceBpm: 120 },
      bpm: 120,
    })
  })

  it('places and converts the result with submitted tempo and geometry', () => {
    const snapshot = captureMidiExtractionSnapshot(
      { ...sourceClip, startBeat: 12, sourceLoop: { cycleStartBeat: 1, cycleLengthBeats: 4, phaseBeats: 1 } },
      'source-track',
      120,
    )
    const clip = createExtractedMidiClip({
      clipId: 'derived-midi',
      jobId: 'muscriptor-job',
      createdAt: '2026-07-15T01:00:00.000Z',
      snapshot,
      result: {
        midiAssetId: 'midi-asset',
        midiAssetUrl: '/api/assets/midi-asset',
        provider: 'muscriptor',
        device: 'mps',
        modelId: 'MuScriptor/muscriptor-medium',
        notes: [{ pitch: 64, startTime: 1, endTime: 1.5, velocity: 100 }],
      },
    })

    expect(clip).toMatchObject({
      id: 'derived-midi',
      startBeat: 12,
      durationBeats: 8,
      offsetBeats: 0,
      assetId: 'source-asset',
      notes: [{ startBeat: 2, durationBeats: 1, velocity: 100 / 127 }],
      provenance: {
        parentAssetId: 'source-asset',
        parentClipId: 'source-clip',
        metadata: {
          submittedBpm: 120,
          submittedStartBeat: 12,
          submittedOffsetBeats: 2,
          submittedSourceLoop: true,
          submittedLoopPhaseBeats: 1,
          submittedAudioTimebaseMode: 'tempo-follow-repitch',
          submittedAudioSourceBpm: 120,
          extractedMidiInstrumentKind: 'melodic',
          extractedMidiChannel: 0,
          extractedMidiPlaybackId: 'WebAudio-TinySynth',
          extractedMidiProgram: 0,
        },
      },
    })
  })

  it('writes classified drum notes on zero-based channel 9', () => {
    const snapshot = captureMidiExtractionSnapshot(sourceClip, 'source-track', 120)
    const clip = createExtractedMidiClip({
      clipId: 'derived-drums',
      jobId: 'muscriptor-drums',
      createdAt: '2026-07-15T01:00:00.000Z',
      snapshot,
      result: {
        midiAssetId: 'midi-asset',
        midiAssetUrl: '/api/assets/midi-asset',
        provider: 'muscriptor',
        device: 'mps',
        notes: [{ pitch: 36, startTime: 0, endTime: 0.25, velocity: 100, instrument: 'kick drum' }],
      },
    })
    expect(clip.notes[0].channel).toBe(9)
    expect(clip.provenance.metadata).toMatchObject({
      extractedMidiInstrumentKind: 'drums',
      extractedMidiChannel: 9,
      extractedMidiPlaybackId: 'WebAudioFont 128_0_Chaos_sf2_file',
      extractedMidiProgram: null,
    })
  })

  it('excludes padded tail notes and records every normalization decision', () => {
    const snapshot = captureMidiExtractionSnapshot(
      { ...sourceClip, durationBeats: 4, sourceLoop: undefined },
      'source-track',
      120,
    )
    const clip = createExtractedMidiClip({
      clipId: 'bounded-midi',
      jobId: 'muscriptor-boundary-job',
      createdAt: '2026-07-15T01:00:00.000Z',
      snapshot,
      result: {
        midiAssetId: 'midi-asset',
        midiAssetUrl: '/api/assets/midi-asset',
        provider: 'muscriptor',
        device: 'mps',
        notes: [
          { pitch: 60, startTime: -0.1, endTime: 0.1, velocity: 100 },
          { pitch: 61, startTime: 0.5, endTime: 0.51, velocity: 100 },
          { pitch: 62, startTime: 1.95, endTime: 2.1, velocity: 100 },
          { pitch: 63, startTime: 2.01, endTime: 2.1, velocity: 100 },
          { pitch: 64, startTime: 1, endTime: 1, velocity: 100 },
          { pitch: 200, startTime: 1.2, endTime: 1.3, velocity: 200 },
        ],
      },
    })

    expect(clip.notes).toMatchObject([
      { id: 'bounded-midi-note-1', pitch: 60, startBeat: 0 },
      { id: 'bounded-midi-note-2', pitch: 61, startBeat: 1, durationBeats: 0.0625 },
      { id: 'bounded-midi-note-3', pitch: 62, startBeat: 3.9 },
      { id: 'bounded-midi-note-6', pitch: 127, startBeat: 2.4, velocity: 1 },
    ])
    expect(clip.notes[0].durationBeats).toBeCloseTo(0.2)
    expect(clip.notes[2].durationBeats).toBeCloseTo(0.1)
    expect(clip.notes[3].durationBeats).toBeCloseTo(0.2)
    expect(clip.provenance.metadata).toMatchObject({
      returnedNoteCount: 6,
      committedNoteCount: 4,
      droppedInvalidNoteCount: 1,
      droppedOutOfBoundsNoteCount: 1,
      boundaryClampedNoteCount: 2,
      minimumDurationExpandedNoteCount: 1,
      sanitizedValueNoteCount: 1,
    })
    expect(clip.notes.every((note) => note.startBeat + note.durationBeats <= clip.durationBeats)).toBe(true)
  })

  it('regresses the observed 3.875-second MuScriptor padding boundary', () => {
    const snapshot = captureMidiExtractionSnapshot(
      { ...sourceClip, durationBeats: 7.75, sourceLoop: undefined },
      'source-track',
      120,
    )
    const clip = createExtractedMidiClip({
      clipId: 'real-boundary-midi',
      jobId: 'real-boundary-job',
      createdAt: '2026-07-15T01:00:00.000Z',
      snapshot,
      result: {
        midiAssetId: 'midi-asset',
        midiAssetUrl: '/api/assets/midi-asset',
        provider: 'muscriptor',
        device: 'mps',
        notes: [
          { pitch: 42, startTime: 3.77, endTime: 3.78, velocity: 100 },
          { pitch: 42, startTime: 3.89, endTime: 3.9, velocity: 100 },
        ],
      },
    })

    expect(clip.notes).toHaveLength(1)
    expect(clip.notes[0]).toMatchObject({ id: 'real-boundary-midi-note-1', pitch: 42, startBeat: 7.54 })
    expect(clip.provenance.metadata).toMatchObject({
      returnedNoteCount: 2,
      committedNoteCount: 1,
      droppedOutOfBoundsNoteCount: 1,
    })
  })
})
