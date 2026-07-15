import type { AudioAsset, MidiClip, MidiNote, PcmAudioAsset, Project, Track } from '../types';
import { encodeWav } from './audio/mixdown';
import { sha256Media } from './audio/hash';
import { createMelodicMidiTrackSettings, MELODIC_MIDI_CHANNELS } from './midi/instrument';
import { getProjectEndBeat } from './time';

export const CAPACITY_REFERENCE_TARGET = Object.freeze({
  durationSeconds: 600,
  bpm: 120,
  durationBeats: 1_200,
  trackCount: 24,
  clipCount: 250,
  midiNoteCount: 50_000,
  automationTrackCount: 8,
  importedSampleRates: [44_100, 48_000] as const,
});

export interface CapacityReferenceSummary {
  durationSeconds: number;
  durationBeats: number;
  trackCount: number;
  clipCount: number;
  midiNoteCount: number;
  automationTrackCount: number;
  importedSampleRates: number[];
  unsupportedFeatures: string[];
}

export interface CapacityReferenceFixture {
  project: Project;
  pcmAssets: ReadonlyMap<string, PcmAudioAsset>;
  summary: CapacityReferenceSummary;
}

const CREATED_AT = '2026-07-15T00:00:00.000Z';
const AUDIO_TRACK_COUNT = 12;
const MIDI_TRACK_COUNT = CAPACITY_REFERENCE_TARGET.trackCount - AUDIO_TRACK_COUNT;
const AUDIO_CLIP_COUNT = 120;
const MIDI_CLIP_COUNT = CAPACITY_REFERENCE_TARGET.clipCount - AUDIO_CLIP_COUNT;
const CLIP_DURATION_BEATS = 8;
const COLORS = ['#50D6C9', '#A98BFF', '#FF704D', '#D8FF4F'];

const distribute = (total: number, bucketCount: number): number[] => {
  const base = Math.floor(total / bucketCount);
  const remainder = total % bucketCount;
  return Array.from({ length: bucketCount }, (_, index) => base + (index < remainder ? 1 : 0));
};

const clipStartBeat = (index: number, clipCount: number): number => {
  if (clipCount <= 1) return 0;
  const finalStart = CAPACITY_REFERENCE_TARGET.durationBeats - CLIP_DURATION_BEATS;
  if (index === clipCount - 1) return finalStart;
  return Number(((index * finalStart) / (clipCount - 1)).toFixed(9));
};

const makePcm = (sampleRate: number, stereo: boolean): PcmAudioAsset => {
  const id = sampleRate === 44_100 ? 'capacity-asset-44k' : 'capacity-asset-48k';
  const frameCount = sampleRate * 4;
  const left = new Float32Array(frameCount);
  const right = stereo ? new Float32Array(frameCount) : undefined;
  const frequency = sampleRate === 44_100 ? 110 : 165;
  for (let frame = 0; frame < frameCount; frame += 1) {
    const phase = (2 * Math.PI * frequency * frame) / sampleRate;
    left[frame] = Math.sin(phase) * 0.003;
    if (right) right[frame] = Math.sin(phase + Math.PI / 3) * 0.003;
  }
  return { id, sampleRate, channelData: right ? [left, right] : [left] };
};

const makeAudioAsset = async (pcm: PcmAudioAsset): Promise<AudioAsset> => {
  const bytes = encodeWav(pcm.channelData, pcm.sampleRate, { bitDepth: 16, dither: 'none' });
  const contentHashSha256 = await sha256Media(bytes);
  return {
    id: pcm.id,
    name: `${pcm.sampleRate / 1_000} kHz capacity source`,
    mimeType: 'audio/wav',
    durationSeconds: pcm.channelData[0].length / pcm.sampleRate,
    sampleRate: pcm.sampleRate,
    channelCount: pcm.channelData.length,
    createdAt: CREATED_AT,
    bytes,
    contentHashSha256,
    integrity: {
      state: 'available',
      expectedHashSha256: contentHashSha256,
      actualHashSha256: contentHashSha256,
    },
    provenance: { source: 'import', createdAt: CREATED_AT },
  };
};

const makeAudioTracks = (): Track[] => {
  const clipCounts = distribute(AUDIO_CLIP_COUNT, AUDIO_TRACK_COUNT);
  let globalClip = 0;
  return clipCounts.map((count, trackIndex) => ({
    id: `capacity-audio-track-${trackIndex + 1}`,
    name: `Audio ${trackIndex + 1}`,
    kind: 'audio',
    color: COLORS[trackIndex % COLORS.length],
    gain: 0.18,
    pan: ((trackIndex % 5) - 2) / 4,
    mute: false,
    solo: false,
    clips: Array.from({ length: count }, (_, clipIndex) => {
      const sequence = globalClip++;
      return {
        id: `capacity-audio-clip-${sequence + 1}`,
        name: `Audio region ${sequence + 1}`,
        kind: 'audio' as const,
        assetId: sequence % 2 === 0 ? 'capacity-asset-44k' : 'capacity-asset-48k',
        startBeat: clipStartBeat(clipIndex, count),
        durationBeats: CLIP_DURATION_BEATS,
        offsetBeats: 0,
        timebase: { mode: 'fixed-seconds' as const, sourceBpm: CAPACITY_REFERENCE_TARGET.bpm },
        gain: 0.8,
        fadeIn: 0.005,
        fadeOut: 0.005,
        provenance: { source: 'import' as const, createdAt: CREATED_AT },
      };
    }),
  }));
};

const makeMidiTracks = (): Track[] => {
  const clipCounts = distribute(MIDI_CLIP_COUNT, MIDI_TRACK_COUNT);
  const noteCounts = distribute(CAPACITY_REFERENCE_TARGET.midiNoteCount, MIDI_CLIP_COUNT);
  let globalClip = 0;
  let globalNote = 0;
  return clipCounts.map((count, trackIndex) => ({
    id: `capacity-midi-track-${trackIndex + 1}`,
    name: `MIDI ${trackIndex + 1}`,
    kind: 'midi',
    midi: createMelodicMidiTrackSettings(
      MELODIC_MIDI_CHANNELS[trackIndex % MELODIC_MIDI_CHANNELS.length],
    ),
    color: COLORS[(trackIndex + AUDIO_TRACK_COUNT) % COLORS.length],
    gain: 0.22,
    pan: ((trackIndex % 5) - 2) / 4,
    mute: false,
    solo: false,
    clips: Array.from({ length: count }, (_, clipIndex): MidiClip => {
      const sequence = globalClip++;
      const noteCount = noteCounts[sequence];
      const spacing = CLIP_DURATION_BEATS / noteCount;
      const notes: MidiNote[] = Array.from({ length: noteCount }, (_, noteIndex) => {
        const noteSequence = globalNote++;
        const startBeat = Number((noteIndex * spacing).toFixed(9));
        return {
          id: `capacity-note-${noteSequence + 1}`,
          pitch: 36 + (noteSequence % 48),
          channel: MELODIC_MIDI_CHANNELS[trackIndex % MELODIC_MIDI_CHANNELS.length],
          startBeat,
          durationBeats: Number(Math.min(1 / 64, spacing * 0.75, CLIP_DURATION_BEATS - startBeat).toFixed(9)),
          velocity: 0.5 + ((noteSequence * 17) % 40) / 100,
        };
      });
      return {
        id: `capacity-midi-clip-${sequence + 1}`,
        name: `MIDI region ${sequence + 1}`,
        kind: 'midi',
        startBeat: clipStartBeat(clipIndex, count),
        durationBeats: CLIP_DURATION_BEATS,
        offsetBeats: 0,
        gain: 0.8,
        fadeIn: 0,
        fadeOut: 0,
        notes,
        provenance: { source: 'user', createdAt: CREATED_AT },
      };
    }),
  }));
};

export function inspectCapacityReference(project: Project): CapacityReferenceSummary {
  const clipCount = project.tracks.reduce((total, track) => total + track.clips.length, 0);
  const midiNoteCount = project.tracks.reduce((total, track) => total + track.clips.reduce(
    (trackTotal, clip) => trackTotal + (clip.kind === 'midi' ? clip.notes.length : 0),
    0,
  ), 0);
  const automationTrackCount = project.tracks.filter((track) => {
    const automation = (track as Track & { automation?: unknown[] }).automation;
    return Array.isArray(automation) && automation.length > 0;
  }).length;
  const importedSampleRates = [...new Set(project.assets
    .map((asset) => asset.sampleRate)
    .filter((sampleRate): sampleRate is number => sampleRate !== undefined))].sort((a, b) => a - b);
  const durationBeats = getProjectEndBeat(project.tracks);
  return {
    durationSeconds: (durationBeats * 60) / project.bpm,
    durationBeats,
    trackCount: project.tracks.length,
    clipCount,
    midiNoteCount,
    automationTrackCount,
    importedSampleRates,
    unsupportedFeatures: automationTrackCount < CAPACITY_REFERENCE_TARGET.automationTrackCount
      ? ['Track automation is not represented in the current Project schema.']
      : [],
  };
}

/**
 * Deterministic capacity fixture for core/storage/export measurements.
 * It intentionally reports automation as unsupported instead of fabricating
 * automation fields that the shipping schema, playback, and export paths ignore.
 */
export async function createCapacityReferenceFixture(): Promise<CapacityReferenceFixture> {
  const pcm44 = makePcm(44_100, false);
  const pcm48 = makePcm(48_000, true);
  const assets = await Promise.all([makeAudioAsset(pcm44), makeAudioAsset(pcm48)]);
  const project: Project = {
    schemaVersion: 4,
    id: 'capacity-reference-project',
    name: 'Capacity reference 10 minute',
    bpm: CAPACITY_REFERENCE_TARGET.bpm,
    sampleRate: 44_100,
    timeSignature: { numerator: 4, denominator: 4 },
    arrangement: { overlapPolicy: 'prevent' },
    tracks: [...makeAudioTracks(), ...makeMidiTracks()],
    loop: { enabled: false, startBeat: 0, endBeat: CAPACITY_REFERENCE_TARGET.durationBeats },
    assets,
    jobs: [],
    masterGain: 0.8,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
  return {
    project,
    pcmAssets: new Map([[pcm44.id, pcm44], [pcm48.id, pcm48]]),
    summary: inspectCapacityReference(project),
  };
}
