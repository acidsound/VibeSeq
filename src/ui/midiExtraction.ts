import type { TranscribedNote, TranscriptionResult } from '../api/inference'
import {
  createDrumMidiTrackSettings,
  createMelodicMidiTrackSettings,
} from '../core/midi/instrument'
import { beatsToSeconds, secondsToBeats } from '../core/time'
import type {
  AudioClip,
  MidiExtractionJobSnapshot,
  MidiClip,
  MidiNote,
  MidiTrackSettings,
} from '../types'

const MIN_TRANSCRIBED_NOTE_BEATS = 1 / 16
const NOTE_TIME_EPSILON_SECONDS = 1e-6
const DRUM_INSTRUMENT_PATTERN = /(?:^|\b)(?:drum(?:s| set)?|percussion|kick|snare|tom|cymbal|hi[ -]?hat)(?:\b|$)/i

export const classifyTranscribedMidiInstrument = (
  notes: readonly Pick<TranscribedNote, 'instrument'>[],
): 'drums' | 'melodic' => {
  const labels = notes
    .map((note) => note.instrument?.trim())
    .filter((label): label is string => Boolean(label))
  return labels.length > 0 && labels.every((label) => DRUM_INSTRUMENT_PATTERN.test(label))
    ? 'drums'
    : 'melodic'
}

export const createMidiTrackSettingsForTranscription = (
  notes: readonly Pick<TranscribedNote, 'instrument'>[],
): MidiTrackSettings => classifyTranscribedMidiInstrument(notes) === 'drums'
  ? createDrumMidiTrackSettings()
  : createMelodicMidiTrackSettings()

export type NormalizedTranscription = {
  notes: MidiNote[]
  returnedNoteCount: number
  committedNoteCount: number
  droppedInvalidNoteCount: number
  droppedOutOfBoundsNoteCount: number
  boundaryClampedNoteCount: number
  minimumDurationExpandedNoteCount: number
  sanitizedValueNoteCount: number
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.max(minimum, Math.min(maximum, value))

/**
 * Restricts model output to the exact audio segment sent for transcription.
 * Some transcription runtimes pad their input and can report a final onset
 * just beyond the submitted segment. Those notes must not survive as hidden,
 * inaudible source data in the committed MIDI clip.
 */
export const normalizeTranscriptionNotes = (
  clipId: string,
  notes: TranscribedNote[],
  durationBeats: number,
  bpm: number,
): NormalizedTranscription => {
  const durationSeconds = beatsToSeconds(durationBeats, bpm)
  const committed: MidiNote[] = []
  let droppedInvalidNoteCount = 0
  let droppedOutOfBoundsNoteCount = 0
  let boundaryClampedNoteCount = 0
  let minimumDurationExpandedNoteCount = 0
  let sanitizedValueNoteCount = 0

  notes.forEach((note, index) => {
    if (
      !Number.isFinite(note.pitch)
      || !Number.isFinite(note.startTime)
      || !Number.isFinite(note.endTime)
      || !Number.isFinite(note.velocity)
      || note.endTime - note.startTime <= NOTE_TIME_EPSILON_SECONDS
    ) {
      droppedInvalidNoteCount += 1
      return
    }

    const startTime = clamp(note.startTime, 0, durationSeconds)
    const endTime = clamp(note.endTime, 0, durationSeconds)
    if (endTime - startTime <= NOTE_TIME_EPSILON_SECONDS) {
      droppedOutOfBoundsNoteCount += 1
      return
    }

    if (
      Math.abs(startTime - note.startTime) > NOTE_TIME_EPSILON_SECONDS
      || Math.abs(endTime - note.endTime) > NOTE_TIME_EPSILON_SECONDS
    ) {
      boundaryClampedNoteCount += 1
    }

    const startBeat = secondsToBeats(startTime, bpm)
    const detectedDurationBeats = secondsToBeats(endTime - startTime, bpm)
    const remainingBeats = durationBeats - startBeat
    const duration = Math.min(
      remainingBeats,
      Math.max(MIN_TRANSCRIBED_NOTE_BEATS, detectedDurationBeats),
    )
    if (duration <= 0) {
      droppedOutOfBoundsNoteCount += 1
      return
    }
    if (duration - detectedDurationBeats > 1e-12) {
      minimumDurationExpandedNoteCount += 1
    }

    const pitch = clamp(Math.round(note.pitch), 0, 127)
    const normalizedVelocity = note.velocity > 1 ? note.velocity / 127 : note.velocity
    const velocity = clamp(normalizedVelocity, 0, 1)
    if (pitch !== note.pitch || velocity !== normalizedVelocity) {
      sanitizedValueNoteCount += 1
    }

    committed.push({
      id: `${clipId}-note-${index + 1}`,
      pitch,
      startBeat,
      durationBeats: duration,
      velocity,
    })
  })

  return {
    notes: committed,
    returnedNoteCount: notes.length,
    committedNoteCount: committed.length,
    droppedInvalidNoteCount,
    droppedOutOfBoundsNoteCount,
    boundaryClampedNoteCount,
    minimumDurationExpandedNoteCount,
    sanitizedValueNoteCount,
  }
}

export const captureMidiExtractionSnapshot = (
  clip: AudioClip,
  sourceTrackId: string,
  bpm: number,
): MidiExtractionJobSnapshot => ({
  sourceAssetId: clip.assetId,
  sourceTrackId,
  sourceClipId: clip.id,
  sourceClipName: clip.name,
  startBeat: clip.startBeat,
  durationBeats: clip.durationBeats,
  offsetBeats: clip.offsetBeats,
  sourceLoop: clip.sourceLoop ? { ...clip.sourceLoop } : undefined,
  timebase: { ...clip.timebase },
  bpm,
})

export const createExtractedMidiClip = ({
  clipId,
  jobId,
  createdAt,
  snapshot,
  result,
}: {
  clipId: string
  jobId: string
  createdAt: string
  snapshot: MidiExtractionJobSnapshot
  result: TranscriptionResult
}): MidiClip => {
  const normalized = normalizeTranscriptionNotes(
    clipId,
    result.notes,
    snapshot.durationBeats,
    snapshot.bpm,
  )
  const sourceLoop = snapshot.sourceLoop
  const midi = createMidiTrackSettingsForTranscription(result.notes)

  return {
    id: clipId,
    name: `${snapshot.sourceClipName} · MIDI`,
    kind: 'midi',
    startBeat: snapshot.startBeat,
    durationBeats: snapshot.durationBeats,
    offsetBeats: 0,
    assetId: snapshot.sourceAssetId,
    gain: 0.8,
    fadeIn: 0,
    fadeOut: 0,
    notes: normalized.notes.map((note) => ({ ...note, channel: midi.channel })),
    provenance: {
      source: result.provider === 'muscriptor' ? 'muscriptor' : 'demo',
      createdAt,
      model: result.modelId ?? result.model ?? result.provider,
      jobId,
      parentAssetId: snapshot.sourceAssetId,
      parentClipId: snapshot.sourceClipId,
      metadata: {
        modelRevision: result.modelRevision ?? null,
        codeRevision: result.codeRevision ?? null,
        runtime: result.runtime ?? null,
        route: result.route ?? null,
        submittedBpm: snapshot.bpm,
        submittedStartBeat: snapshot.startBeat,
        submittedDurationBeats: snapshot.durationBeats,
        submittedOffsetBeats: snapshot.offsetBeats,
        submittedSourceTrackId: snapshot.sourceTrackId,
        submittedSourceClipName: snapshot.sourceClipName,
        submittedSourceLoop: Boolean(sourceLoop),
        submittedLoopCycleStartBeat: sourceLoop?.cycleStartBeat ?? null,
        submittedLoopCycleLengthBeats: sourceLoop?.cycleLengthBeats ?? null,
        submittedLoopPhaseBeats: sourceLoop?.phaseBeats ?? null,
        submittedAudioTimebaseMode: snapshot.timebase.mode,
        submittedAudioSourceBpm: snapshot.timebase.sourceBpm,
        extractedMidiInstrumentKind: midi.instrument.kind,
        extractedMidiChannel: midi.channel,
        extractedMidiPlaybackId: midi.instrument.playbackId,
        extractedMidiProgram: midi.instrument.kind === 'melodic' ? midi.instrument.program : null,
        returnedNoteCount: normalized.returnedNoteCount,
        committedNoteCount: normalized.committedNoteCount,
        droppedInvalidNoteCount: normalized.droppedInvalidNoteCount,
        droppedOutOfBoundsNoteCount: normalized.droppedOutOfBoundsNoteCount,
        boundaryClampedNoteCount: normalized.boundaryClampedNoteCount,
        minimumDurationExpandedNoteCount: normalized.minimumDurationExpandedNoteCount,
        sanitizedValueNoteCount: normalized.sanitizedValueNoteCount,
      },
    },
  }
}
