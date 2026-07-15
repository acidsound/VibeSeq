import type { ClipProvenance, MidiNote, Project, ProjectSampleRate, WaveformPeakLevel } from '../types';

export interface DemoProjectOptions {
  now?: Date | string;
  id?: string;
  name?: string;
  sampleRate?: ProjectSampleRate;
}

export interface BlankProjectOptions extends DemoProjectOptions {
  bpm?: number;
}

/** Production-safe startup state. It contains no synthetic media or musical content. */
export function createBlankProject(options: BlankProjectOptions = {}): Project {
  const timestamp = new Date(options.now ?? Date.now()).toISOString();
  return {
    schemaVersion: 4,
    id: options.id ?? 'project-local-default',
    name: options.name ?? 'Untitled Sequence',
    bpm: options.bpm ?? 120,
    sampleRate: options.sampleRate ?? 44_100,
    timeSignature: { numerator: 4, denominator: 4 },
    arrangement: { overlapPolicy: 'prevent' },
    masterGain: 0.86,
    loop: { enabled: false, startBeat: 0, endBeat: 16 },
    createdAt: timestamp,
    updatedAt: timestamp,
    jobs: [],
    assets: [],
    tracks: [],
  };
}

const makeNotes = (
  prefix: string,
  pitches: number[],
  startBeat: number,
  step = 0.5,
  duration = 0.42,
  velocity = 0.78,
  channel = 0,
): MidiNote[] =>
  pitches.map((pitch, index) => ({
    id: `${prefix}-${index + 1}`,
    pitch,
    startBeat: startBeat + index * step,
    durationBeats: duration,
    velocity: Math.max(0.1, Math.min(1, velocity + ((index % 3) - 1) * 0.05)),
    channel,
  }));

const makeDemoPeaks = (count: number, phase: number): WaveformPeakLevel => {
  const min: number[] = [];
  const max: number[] = [];
  const rms: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const envelope = 0.25 + 0.65 * Math.pow(Math.sin((Math.PI * (index + 1)) / (count + 1)), 0.35);
    const transient = index % 8 === 0 ? 1 : 0.62 + 0.18 * Math.sin(index * 1.71 + phase);
    const peak = Math.max(0.08, Math.min(0.96, envelope * transient));
    min.push(-peak * (0.78 + 0.12 * Math.sin(index * 0.7)));
    max.push(peak);
    rms.push(peak * 0.48);
  }
  return { samplesPerPeak: 1024, min, max, rms };
};

/** A self-contained visual demo. Audio assets contain peaks but no encoded media. */
export function createDemoProject(options: DemoProjectOptions = {}): Project {
  const timestamp = new Date(options.now ?? Date.now()).toISOString();
  const provenance = (
    source: 'demo' | 'stable-audio' | 'muscriptor' | 'user',
    extra: Partial<ClipProvenance> = {},
  ): ClipProvenance => ({
    source,
    createdAt: timestamp,
    ...extra,
  });
  const leadNotes = [60, 63, 67, 70, 67, 63, 58, 60, 63, 67, 72, 70, 67, 63, 60, 58];
  const bassNotes = [36, 36, 43, 43, 41, 41, 38, 38];

  return {
    schemaVersion: 4,
    id: options.id ?? 'demo-neon-afterglow',
    name: options.name ?? 'Neon Afterglow',
    bpm: 118,
    sampleRate: options.sampleRate ?? 44_100,
    timeSignature: { numerator: 4, denominator: 4 },
    arrangement: { overlapPolicy: 'prevent' },
    masterGain: 0.86,
    loop: { enabled: true, startBeat: 0, endBeat: 16 },
    createdAt: timestamp,
    updatedAt: timestamp,
    jobs: [],
    assets: [
      {
        id: 'asset-dream-drift',
        name: 'Dream Drift 01',
        mimeType: 'audio/wav',
        durationSeconds: 16.27,
        sampleRate: 44_100,
        channelCount: 2,
        createdAt: timestamp,
        waveform: [makeDemoPeaks(128, 0.3)],
        provenance: provenance('demo', {
          model: 'visual-demo-fixture',
          prompt: 'hazy analog pads, granular shimmer, nocturnal pulse, 118 bpm',
        }),
      },
      {
        id: 'asset-tape-percussion',
        name: 'Tape Percussion',
        mimeType: 'audio/wav',
        durationSeconds: 8.13,
        sampleRate: 44_100,
        channelCount: 2,
        createdAt: timestamp,
        waveform: [makeDemoPeaks(64, 1.8)],
        provenance: provenance('demo', {
          model: 'visual-demo-fixture',
          prompt: 'dry tape drum loop, soft transient, swung ghost notes, 118 bpm',
        }),
      },
    ],
    tracks: [
      {
        id: 'track-atmosphere',
        name: 'Afterglow',
        kind: 'audio',
        color: '#F6A84B',
        gain: 0.82,
        pan: -0.1,
        mute: false,
        solo: false,
        clips: [
          {
            id: 'clip-dream-drift',
            name: 'Dream Drift 01',
            kind: 'audio',
            startBeat: 0,
            durationBeats: 32,
            offsetBeats: 0,
            assetId: 'asset-dream-drift',
            timebase: { mode: 'fixed-seconds', sourceBpm: 118 },
            gain: 0.9,
            fadeIn: 0.5,
            fadeOut: 1,
            provenance: provenance('demo', {
              model: 'visual-demo-fixture',
              prompt: 'hazy analog pads, granular shimmer, nocturnal pulse, 118 bpm',
            }),
          },
        ],
      },
      {
        id: 'track-percussion',
        name: 'Soft Machine',
        kind: 'audio',
        color: '#E98657',
        gain: 0.88,
        pan: 0.08,
        mute: false,
        solo: false,
        clips: [0, 16].map((startBeat, index) => ({
          id: `clip-tape-percussion-${index + 1}`,
          name: 'Tape Percussion',
          kind: 'audio' as const,
          startBeat,
          durationBeats: 16,
          offsetBeats: 0,
          assetId: 'asset-tape-percussion',
          timebase: { mode: 'fixed-seconds' as const, sourceBpm: 118 },
          gain: 0.92,
          fadeIn: 0.04,
          fadeOut: 0.08,
          provenance: provenance('demo', {
            model: 'visual-demo-fixture',
            prompt: 'dry tape drum loop, soft transient, swung ghost notes, 118 bpm',
          }),
        })),
      },
      {
        id: 'track-lead-midi',
        name: 'Extracted Motif',
        kind: 'midi',
        midi: {
          channel: 0,
          instrument: { kind: 'melodic', playbackId: 'WebAudio-TinySynth', program: 80 },
        },
        color: '#5DD6D1',
        gain: 0.72,
        pan: 0.14,
        mute: false,
        solo: false,
        clips: [
          {
            id: 'clip-extracted-motif',
            name: 'Motif · visual demo',
            kind: 'midi',
            startBeat: 8,
            durationBeats: 16,
            offsetBeats: 0,
            assetId: 'asset-dream-drift',
            gain: 0.86,
            fadeIn: 0,
            fadeOut: 0,
            notes: makeNotes('note-lead', leadNotes, 0),
            provenance: provenance('demo', {
              model: 'visual-demo-fixture',
              parentAssetId: 'asset-dream-drift',
            }),
          },
        ],
      },
      {
        id: 'track-bass-midi',
        name: 'Sub Figures',
        kind: 'midi',
        midi: {
          channel: 1,
          instrument: { kind: 'melodic', playbackId: 'WebAudio-TinySynth', program: 38 },
        },
        color: '#9B7CEB',
        gain: 0.68,
        pan: -0.04,
        mute: false,
        solo: false,
        clips: [
          {
            id: 'clip-sub-figures',
            name: 'Sub Figures',
            kind: 'midi',
            startBeat: 0,
            durationBeats: 32,
            offsetBeats: 0,
            gain: 0.76,
            fadeIn: 0,
            fadeOut: 0,
            notes: makeNotes('note-bass', bassNotes, 0, 4, 1.7, 0.68, 1),
            provenance: provenance('user'),
          },
        ],
      },
    ],
  };
}
