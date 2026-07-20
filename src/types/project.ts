export type EntityId = string;

export const PROJECT_SAMPLE_RATES = [44_100, 48_000] as const;
export type ProjectSampleRate = (typeof PROJECT_SAMPLE_RATES)[number];

export type TrackKind = 'audio' | 'midi';
export type ClipKind = TrackKind;

export interface TimeSignature {
  numerator: number;
  denominator: 1 | 2 | 4 | 8 | 16 | 32;
}

export interface ProjectLoop {
  enabled: boolean;
  startBeat: number;
  endBeat: number;
}

export interface ArrangementSettings {
  /** VibeSeq currently permits only deterministic, non-overlapping clip placement. */
  overlapPolicy: 'prevent';
}

export type ProvenanceSource =
  | 'stable-audio'
  | 'muscriptor'
  | 'import'
  | 'recording'
  | 'user'
  | 'demo';

export interface ClipProvenance {
  source: ProvenanceSource;
  createdAt: string;
  model?: string;
  prompt?: string;
  jobId?: EntityId;
  parentAssetId?: EntityId;
  parentClipId?: EntityId;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface MidiNote {
  id: EntityId;
  pitch: number;
  startBeat: number;
  durationBeats: number;
  velocity: number;
  channel?: number;
}

/**
 * A source cycle repeated inside one arrangement clip.
 *
 * `durationBeats` remains the placement span. The source cycle is independent,
 * so extending the upper/right loop edge does not destructively extend the
 * source region. `phaseBeats` is the position inside the cycle at the clip's
 * arrangement start and is kept explicit so split/left-trim edits remain exact.
 */
export interface ClipSourceLoop {
  cycleStartBeat: number;
  cycleLengthBeats: number;
  /** Normalized to the half-open range [0, cycleLengthBeats). */
  phaseBeats: number;
}

export type AudioTimebaseMode = 'fixed-seconds' | 'tempo-follow-repitch';

/**
 * Defines how source-audio beats map to project time.
 *
 * `fixed-seconds` keeps playback at 1x. A project-tempo edit must rescale the
 * clip's beat geometry and advance `sourceBpm` to the new project tempo.
 * `tempo-follow-repitch` keeps beat geometry fixed and derives playback rate as
 * `projectBpm / sourceBpm`; this is honest varispeed/repitch, not
 * pitch-preserving time stretch.
 */
export interface AudioTimebase {
  mode: AudioTimebaseMode;
  sourceBpm: number;
}

/**
 * A non-destructive transform backed by a rendered derivative of the immutable
 * source asset. Source coordinates stay in the original asset's beat space;
 * `stretchRatio` is output duration / source duration.
 */
export interface AudioTransform {
  sourceAssetId: EntityId;
  pitchSemitones: number;
  stretchRatio: number;
}

export interface ClipBase {
  id: EntityId;
  name: string;
  kind: ClipKind;
  startBeat: number;
  durationBeats: number;
  offsetBeats: number;
  /** Presence enables source-region repetition; this is distinct from project cycle playback. */
  sourceLoop?: ClipSourceLoop;
  gain: number;
  /** Non-destructive edge fades, measured in seconds. */
  fadeIn: number;
  /** Non-destructive edge fades, measured in seconds. */
  fadeOut: number;
  muted?: boolean;
  color?: string;
  provenance: ClipProvenance;
}

export interface AudioClip extends ClipBase {
  kind: 'audio';
  assetId: EntityId;
  timebase: AudioTimebase;
  transform?: AudioTransform;
  notes?: never;
}

export interface MidiClip extends ClipBase {
  kind: 'midi';
  notes: MidiNote[];
  /** Optional source audio for a MuScriptor-derived MIDI clip. */
  assetId?: EntityId;
}

export type Clip = AudioClip | MidiClip;

export type MidiPlaybackInstrumentId =
  | 'WebAudioFont 128_0_Chaos_sf2_file'
  | 'WebAudio-TinySynth';

export interface MidiDrumInstrumentProfile {
  kind: 'drums';
  playbackId: 'WebAudioFont 128_0_Chaos_sf2_file';
}

export interface MidiMelodicInstrumentProfile {
  kind: 'melodic';
  playbackId: 'WebAudio-TinySynth';
  /** Zero-based General MIDI program number written to Standard MIDI Files. */
  program: number;
}

export type MidiInstrumentProfile = MidiDrumInstrumentProfile | MidiMelodicInstrumentProfile;

/**
 * MIDI routing is track-wide. Channels are zero-based internally, so channel 9
 * is the General MIDI percussion wire channel commonly displayed as channel 10.
 */
export interface MidiTrackSettings {
  channel: number;
  instrument: MidiInstrumentProfile;
}

export interface TrackBase {
  id: EntityId;
  name: string;
  color: string;
  gain: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  armed?: boolean;
  collapsed?: boolean;
  clips: Clip[];
}

export interface AudioTrack extends TrackBase {
  kind: 'audio';
  midi?: never;
}

export interface MidiTrack extends TrackBase {
  kind: 'midi';
  midi: MidiTrackSettings;
}

export type Track = AudioTrack | MidiTrack;

export interface WaveformPeakLevel {
  samplesPerPeak: number;
  min: number[];
  max: number[];
  rms?: number[];
}

export interface MediaIntegrity {
  /** `available` is only produced after an asynchronous byte-level verification. */
  state: 'available' | 'missing' | 'corrupt' | 'unverified';
  expectedHashSha256?: string;
  actualHashSha256?: string;
  message?: string;
}

export interface AudioAsset {
  id: EntityId;
  name: string;
  mimeType: string;
  durationSeconds: number;
  sampleRate?: number;
  channelCount?: number;
  createdAt: string;
  /** Raw media. IndexedDB stores this directly; the localStorage adapter encodes it. */
  blob?: Blob;
  bytes?: ArrayBuffer;
  /** SHA-256 of the immutable encoded source media, independent of arrangement edits. */
  contentHashSha256?: string;
  waveform?: WaveformPeakLevel[];
  /** A damaged encoded payload is isolated instead of making the project unreadable. */
  integrity?: MediaIntegrity;
  provenance: ClipProvenance;
}

export type JobKind = 'stable-audio-generation' | 'midi-extraction';
export type JobState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type ComputeTarget = 'local-gpu' | 'local-cpu' | 'colab-t4';

export interface GenerationLengthSnapshot {
  unit: 'seconds' | 'bars';
  value: number;
  /** Exact seconds submitted to Stable Audio after resolving BPM and meter. */
  durationSeconds: number;
  bpm: number;
  timeSignature: TimeSignature;
}

/**
 * Immutable musical mapping submitted to MuScriptor.
 *
 * The source region can be edited or removed while inference is running, so a
 * completed result must not derive its placement or tempo conversion from the
 * current arrangement state.
 */
export interface MidiExtractionJobSnapshot {
  sourceAssetId: EntityId;
  sourceTrackId: EntityId;
  sourceClipId: EntityId;
  sourceClipName: string;
  startBeat: number;
  durationBeats: number;
  offsetBeats: number;
  sourceLoop?: ClipSourceLoop;
  timebase: AudioTimebase;
  transform?: AudioTransform;
  bpm: number;
}

export interface AIJob {
  id: EntityId;
  kind: JobKind;
  state: JobState;
  computeTarget: ComputeTarget;
  progress: number;
  createdAt: string;
  updatedAt: string;
  input: {
    prompt?: string;
    assetId?: EntityId;
    trackId?: EntityId;
    clipId?: EntityId;
    durationSeconds?: number;
    seed?: number;
    generationLength?: GenerationLengthSnapshot;
    /** Present on newly submitted MuScriptor jobs; absent on legacy jobs. */
    midiExtraction?: MidiExtractionJobSnapshot;
  };
  output?: {
    assetId?: EntityId;
    clipId?: EntityId;
    trackId?: EntityId;
  };
  error?: {
    code?: string;
    message: string;
    retryable?: boolean;
  };
}

export interface Project {
  schemaVersion: 5;
  id: EntityId;
  name: string;
  bpm: number;
  sampleRate: ProjectSampleRate;
  timeSignature: TimeSignature;
  arrangement: ArrangementSettings;
  tracks: Track[];
  loop: ProjectLoop;
  assets: AudioAsset[];
  jobs: AIJob[];
  masterGain: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectSummary {
  id: EntityId;
  name: string;
  bpm: number;
  trackCount: number;
  updatedAt: string;
}

export interface PcmAudioAsset {
  id: EntityId;
  sampleRate: number;
  channelData: Float32Array[];
}

export type PcmAssetSource =
  | ReadonlyMap<EntityId, PcmAudioAsset>
  | Record<EntityId, PcmAudioAsset>
  | ((assetId: EntityId) => PcmAudioAsset | undefined | Promise<PcmAudioAsset | undefined>);
