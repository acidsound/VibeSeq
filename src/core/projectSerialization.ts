import type {
  AIJob,
  AudioAsset,
  AudioTransform,
  AudioTimebase,
  Clip,
  ClipProvenance,
  ClipSourceLoop,
  GenerationLengthSnapshot,
  MidiExtractionJobSnapshot,
  MidiNote,
  MidiTrackSettings,
  Project,
  ProjectSampleRate,
  Track,
  WaveformPeakLevel,
} from '../types';
import { MIN_SOURCE_LOOP_CYCLE_BEATS } from './clip';
import { MAX_GENERATION_SEED, MIN_GENERATION_SEED } from './generationSeed';
import {
  inferLegacyMidiTrackSettings,
  isMidiChannel,
  isMidiProgram,
  MIDI_DRUM_CHANNEL,
  MIDI_DRUM_INSTRUMENT_ID,
  MIDI_MELODIC_INSTRUMENT_ID,
} from './midi/instrument';
import { assertProjectArrangementInvariants } from './projectInvariants';

export const PROJECT_SERIALIZATION_FORMAT = 'vibeseq-project';
export const PROJECT_SERIALIZATION_VERSION = 1;
export const PROJECT_SCHEMA_VERSION = 5;

export type ProjectImportErrorCode =
  | 'invalid-json'
  | 'invalid-project'
  | 'unsupported-version';

export class ProjectImportError extends Error {
  readonly code: ProjectImportErrorCode;

  constructor(code: ProjectImportErrorCode, message: string) {
    super(message);
    this.name = 'ProjectImportError';
    this.code = code;
  }
}

interface BinaryEnvelope {
  __vibeseqBinary: true;
  mimeType?: string;
  base64: string;
}

type EncodedAudioAsset = Omit<AudioAsset, 'blob' | 'bytes'> & {
  blob?: BinaryEnvelope;
  bytes?: BinaryEnvelope;
};

type EncodedProject = Omit<Project, 'assets'> & { assets: EncodedAudioAsset[] };

export interface GenerationCandidateSnapshot {
  id: string;
  name: string;
  prompt: string;
  duration: number;
  /** Exact Stable Audio seed. Optional only for backward-compatible legacy candidates. */
  seed?: number;
  generationLength?: GenerationLengthSnapshot;
  provider: string;
  device: string;
  model?: string;
  modelId?: string;
  modelRevision?: string;
  codeRevision?: string;
  runtime?: string;
  route?: string;
  sourcePeak?: number | null;
  outputPeak?: number | null;
  peakProtectionApplied?: boolean;
  peakAttenuationDb?: number;
  assetId?: string;
  assetUrl?: string;
  sampleRate?: number;
  mimeType?: string;
  peaks?: WaveformPeakLevel;
  jobId?: string;
  /** Candidate media can survive reload before it is placed in the arrangement. */
  blob?: Blob;
  bytes?: ArrayBuffer;
  contentHashSha256?: string;
  integrity?: AudioAsset['integrity'];
}

export interface InferenceJobSnapshot {
  id: string;
  kind: 'generate' | 'transcribe';
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  result?: unknown;
  error?: string;
}

export interface ActiveInferenceJobSnapshot {
  label: string;
  job: InferenceJobSnapshot;
}

export interface ProjectSessionSnapshot {
  candidates: GenerationCandidateSnapshot[];
  activeJob?: ActiveInferenceJobSnapshot | null;
}

export interface ProjectCheckpoint {
  checkpointId: string;
  /** Monotonic durability order. Equal revisions with different IDs are conflicts. */
  revision: number;
  savedAt: string;
  project: Project;
  session: ProjectSessionSnapshot;
}

type EncodedCandidate = Omit<GenerationCandidateSnapshot, 'blob' | 'bytes'> & {
  blob?: BinaryEnvelope;
  bytes?: BinaryEnvelope;
};

interface EncodedCheckpointEnvelope {
  format: typeof PROJECT_SERIALIZATION_FORMAT;
  serializationVersion: typeof PROJECT_SERIALIZATION_VERSION;
  checkpointId: string;
  revision: number;
  savedAt: string;
  project: EncodedProject;
  session: Omit<ProjectSessionSnapshot, 'candidates'> & {
    candidates: EncodedCandidate[];
  };
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const PROJECT_SOURCES = new Set(['stable-audio', 'muscriptor', 'import', 'recording', 'user', 'demo']);
const JOB_KINDS = new Set(['stable-audio-generation', 'midi-extraction']);
const JOB_STATES = new Set(['queued', 'running', 'completed', 'failed', 'cancelled']);
const COMPUTE_TARGETS = new Set(['local-gpu', 'local-cpu', 'colab-t4']);
const GENERATION_LENGTH_UNITS = new Set(['seconds', 'bars']);
const AUDIO_TIMEBASE_MODES = new Set(['fixed-seconds', 'tempo-follow-repitch']);
const MIDI_INSTRUMENT_KINDS = new Set(['drums', 'melodic']);
const INFERENCE_KINDS = new Set(['generate', 'transcribe']);
const DENOMINATORS = new Set([1, 2, 4, 8, 16, 32]);
const PROJECT_SAMPLE_RATES = new Set([44_100, 48_000]);
let fallbackCheckpointCounter = 0;
let lastCheckpointRevision = 0;

const fail = (path: string, message: string): never => {
  throw new ProjectImportError('invalid-project', `${path}: ${message}`);
};

const record = (value: unknown, path: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'expected an object');
  return value as Record<string, unknown>;
};

const stringValue = (value: unknown, path: string, allowEmpty = false): string => {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) fail(path, 'expected a string');
  return value as string;
};

const optionalString = (value: unknown, path: string): string | undefined =>
  value === undefined ? undefined : stringValue(value, path, true);

const optionalSha256 = (value: unknown, path: string): string | undefined => {
  if (value === undefined) return undefined;
  const hash = stringValue(value, path).toLowerCase();
  if (!SHA256_PATTERN.test(hash)) fail(path, 'expected a 64-character SHA-256 hex digest');
  return hash;
};

const numberValue = (value: unknown, path: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'expected a finite number');
  return value as number;
};

const booleanValue = (value: unknown, path: string): boolean => {
  if (typeof value !== 'boolean') fail(path, 'expected a boolean');
  return value as boolean;
};

const arrayValue = (value: unknown, path: string): unknown[] => {
  if (!Array.isArray(value)) fail(path, 'expected an array');
  return value as unknown[];
};

const timestampValue = (value: unknown, path: string): string => {
  const timestamp = stringValue(value, path);
  if (!Number.isFinite(Date.parse(timestamp))) fail(path, 'expected an ISO-compatible timestamp');
  return timestamp;
};

const enumValue = <T extends string>(value: unknown, allowed: Set<string>, path: string): T => {
  const text = stringValue(value, path);
  if (!allowed.has(text)) fail(path, `unsupported value "${text}"`);
  return text as T;
};

const optionalBoolean = (value: unknown, path: string): boolean | undefined =>
  value === undefined ? undefined : booleanValue(value, path);

const optionalNumber = (value: unknown, path: string): number | undefined =>
  value === undefined ? undefined : numberValue(value, path);

const optionalGenerationSeed = (value: unknown, path: string): number | undefined => {
  if (value === undefined) return undefined;
  const seed = numberValue(value, path);
  if (!Number.isInteger(seed) || seed < MIN_GENERATION_SEED || seed > MAX_GENERATION_SEED) {
    fail(path, `expected an integer in range ${MIN_GENERATION_SEED}..${MAX_GENERATION_SEED}`);
  }
  return seed;
};

const metadataValue = (
  value: unknown,
  path: string,
): Record<string, string | number | boolean | null> | undefined => {
  if (value === undefined) return undefined;
  const source = record(value, path);
  const result: Record<string, string | number | boolean | null> = Object.create(null);
  for (const [key, entry] of Object.entries(source)) {
    if (entry !== null && !['string', 'number', 'boolean'].includes(typeof entry)) {
      fail(`${path}.${key}`, 'expected a JSON primitive');
    }
    if (typeof entry === 'number' && !Number.isFinite(entry)) fail(`${path}.${key}`, 'expected a finite number');
    result[key] = entry as string | number | boolean | null;
  }
  return result;
};

const jsonValue = (value: unknown, path: string, seen = new Set<object>()): unknown => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return numberValue(value, path);
  if (Array.isArray(value)) {
    if (seen.has(value)) fail(path, 'cyclic JSON value');
    seen.add(value);
    const result = value.map((entry, index) => jsonValue(entry, `${path}[${index}]`, seen));
    seen.delete(value);
    return result;
  }
  if (value && typeof value === 'object') {
    if (seen.has(value)) fail(path, 'cyclic JSON value');
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail(path, 'expected JSON-compatible data');
    seen.add(value);
    const result: Record<string, unknown> = Object.create(null);
    for (const [key, entry] of Object.entries(value)) result[key] = jsonValue(entry, `${path}.${key}`, seen);
    seen.delete(value);
    return result;
  }
  fail(path, 'expected JSON-compatible data');
};

const provenanceValue = (value: unknown, path: string): ClipProvenance => {
  const source = record(value, path);
  return {
    source: enumValue(source.source, PROJECT_SOURCES, `${path}.source`),
    createdAt: timestampValue(source.createdAt, `${path}.createdAt`),
    model: optionalString(source.model, `${path}.model`),
    prompt: optionalString(source.prompt, `${path}.prompt`),
    jobId: optionalString(source.jobId, `${path}.jobId`),
    parentAssetId: optionalString(source.parentAssetId, `${path}.parentAssetId`),
    parentClipId: optionalString(source.parentClipId, `${path}.parentClipId`),
    metadata: metadataValue(source.metadata, `${path}.metadata`),
  };
};

const noteValue = (value: unknown, path: string): MidiNote => {
  const source = record(value, path);
  const pitch = numberValue(source.pitch, `${path}.pitch`);
  const durationBeats = numberValue(source.durationBeats, `${path}.durationBeats`);
  const velocity = numberValue(source.velocity, `${path}.velocity`);
  const channel = optionalNumber(source.channel, `${path}.channel`);
  if (!Number.isInteger(pitch) || pitch < 0 || pitch > 127) fail(`${path}.pitch`, 'expected MIDI pitch 0..127');
  if (durationBeats <= 0) fail(`${path}.durationBeats`, 'expected a positive duration');
  if (velocity < 0 || velocity > 1) fail(`${path}.velocity`, 'expected normalized velocity 0..1');
  if (channel !== undefined && (!Number.isInteger(channel) || channel < 0 || channel > 15)) {
    fail(`${path}.channel`, 'expected MIDI channel 0..15');
  }
  return {
    id: stringValue(source.id, `${path}.id`),
    pitch,
    startBeat: numberValue(source.startBeat, `${path}.startBeat`),
    durationBeats,
    velocity,
    channel,
  };
};

const sourceLoopValue = (value: unknown, path: string): ClipSourceLoop | undefined => {
  if (value === undefined) return undefined;
  const source = record(value, path);
  const cycleStartBeat = numberValue(source.cycleStartBeat, `${path}.cycleStartBeat`);
  const cycleLengthBeats = numberValue(source.cycleLengthBeats, `${path}.cycleLengthBeats`);
  const phaseBeats = numberValue(source.phaseBeats, `${path}.phaseBeats`);
  if (cycleStartBeat < 0) fail(`${path}.cycleStartBeat`, 'expected a non-negative source beat');
  if (cycleLengthBeats < MIN_SOURCE_LOOP_CYCLE_BEATS) {
    fail(`${path}.cycleLengthBeats`, `expected at least ${MIN_SOURCE_LOOP_CYCLE_BEATS} beat (1/64 beat)`);
  }
  if (phaseBeats < 0 || phaseBeats >= cycleLengthBeats) {
    fail(`${path}.phaseBeats`, 'expected phase in range 0..<cycleLengthBeats');
  }
  return { cycleStartBeat, cycleLengthBeats, phaseBeats };
};

const audioTransformValue = (value: unknown, path: string): AudioTransform | undefined => {
  if (value === undefined) return undefined;
  const source = record(value, path);
  const pitchSemitones = numberValue(source.pitchSemitones, `${path}.pitchSemitones`);
  const stretchRatio = numberValue(source.stretchRatio, `${path}.stretchRatio`);
  if (pitchSemitones < -12 || pitchSemitones > 12) {
    fail(`${path}.pitchSemitones`, 'expected pitch shift in range -12..12 semitones');
  }
  if (stretchRatio < 0.125 || stretchRatio > 2) {
    fail(`${path}.stretchRatio`, 'expected stretch ratio in range 0.125..2');
  }
  return {
    sourceAssetId: stringValue(source.sourceAssetId, `${path}.sourceAssetId`),
    pitchSemitones,
    stretchRatio,
  };
};

const audioTimebaseValue = (
  value: unknown,
  path: string,
  sourceSchemaVersion: number,
  projectBpm: number,
  provenance: ClipProvenance,
): AudioTimebase => {
  if (value === undefined) {
    if (sourceSchemaVersion >= 4) fail(path, 'expected an explicit Audio timebase');
    const metadata = provenance.metadata;
    const generatedInBars = metadata?.generationLengthUnit === 'bars';
    const generatedBpm = metadata?.generationLengthBpm;
    if (generatedInBars && typeof generatedBpm === 'number' && Number.isFinite(generatedBpm) && generatedBpm > 0) {
      return { mode: 'tempo-follow-repitch', sourceBpm: generatedBpm };
    }
    return { mode: 'fixed-seconds', sourceBpm: projectBpm };
  }
  const source = record(value, path);
  const sourceBpm = numberValue(source.sourceBpm, `${path}.sourceBpm`);
  if (sourceBpm <= 0 || sourceBpm > 1_000) fail(`${path}.sourceBpm`, 'expected tempo in range 0..1000');
  return {
    mode: enumValue(source.mode, AUDIO_TIMEBASE_MODES, `${path}.mode`),
    sourceBpm,
  };
};

const clipValue = (
  value: unknown,
  path: string,
  sourceSchemaVersion: number,
  projectBpm: number,
): Clip => {
  const source = record(value, path);
  const kind = enumValue<'audio' | 'midi'>(source.kind, new Set(['audio', 'midi']), `${path}.kind`);
  const durationBeats = numberValue(source.durationBeats, `${path}.durationBeats`);
  if (durationBeats <= 0) fail(`${path}.durationBeats`, 'expected a positive duration');
  const startBeat = numberValue(source.startBeat, `${path}.startBeat`);
  const offsetBeats = numberValue(source.offsetBeats, `${path}.offsetBeats`);
  if (startBeat < 0) fail(`${path}.startBeat`, 'expected a non-negative arrangement beat');
  if (offsetBeats < 0) fail(`${path}.offsetBeats`, 'expected a non-negative source beat');
  const provenance = provenanceValue(source.provenance, `${path}.provenance`);
  const base = {
    id: stringValue(source.id, `${path}.id`),
    name: stringValue(source.name, `${path}.name`, true),
    kind,
    startBeat,
    durationBeats,
    offsetBeats,
    sourceLoop: sourceLoopValue(source.sourceLoop, `${path}.sourceLoop`),
    gain: numberValue(source.gain, `${path}.gain`),
    fadeIn: numberValue(source.fadeIn, `${path}.fadeIn`),
    fadeOut: numberValue(source.fadeOut, `${path}.fadeOut`),
    muted: optionalBoolean(source.muted, `${path}.muted`),
    color: optionalString(source.color, `${path}.color`),
    provenance,
  };
  if (base.gain < 0 || base.fadeIn < 0 || base.fadeOut < 0) fail(path, 'gain and fades cannot be negative');
  if (kind === 'audio') {
    return {
      ...base,
      kind,
      assetId: stringValue(source.assetId, `${path}.assetId`),
      timebase: audioTimebaseValue(
        source.timebase,
        `${path}.timebase`,
        sourceSchemaVersion,
        projectBpm,
        provenance,
      ),
      transform: audioTransformValue(source.transform, `${path}.transform`),
    };
  }
  const notes = arrayValue(source.notes, `${path}.notes`).map((note, index) =>
    noteValue(note, `${path}.notes[${index}]`));
  ensureUniqueIds(notes, `${path}.notes`);
  return {
    ...base,
    kind,
    assetId: optionalString(source.assetId, `${path}.assetId`),
    notes,
  };
};

const midiTrackSettingsValue = (
  value: unknown,
  path: string,
  legacyNotes: readonly MidiNote[],
): MidiTrackSettings => {
  if (value === undefined) return inferLegacyMidiTrackSettings(legacyNotes);
  const source = record(value, path);
  const channel = numberValue(source.channel, `${path}.channel`);
  if (!isMidiChannel(channel)) fail(`${path}.channel`, 'expected a zero-based MIDI channel in range 0..15');
  const instrument = record(source.instrument, `${path}.instrument`);
  const kind = enumValue<'drums' | 'melodic'>(
    instrument.kind,
    MIDI_INSTRUMENT_KINDS,
    `${path}.instrument.kind`,
  );
  const playbackId = stringValue(instrument.playbackId, `${path}.instrument.playbackId`);
  if (kind === 'drums') {
    if (channel !== MIDI_DRUM_CHANNEL) {
      fail(`${path}.channel`, 'drum tracks must use MIDI wire channel 10 (zero-based channel 9)');
    }
    if (playbackId !== MIDI_DRUM_INSTRUMENT_ID) {
      fail(`${path}.instrument.playbackId`, `expected "${MIDI_DRUM_INSTRUMENT_ID}"`);
    }
    return {
      channel,
      instrument: { kind, playbackId: MIDI_DRUM_INSTRUMENT_ID },
    };
  }
  if (channel === MIDI_DRUM_CHANNEL) {
    fail(`${path}.channel`, 'zero-based channel 9 is reserved for drum tracks');
  }
  if (playbackId !== MIDI_MELODIC_INSTRUMENT_ID) {
    fail(`${path}.instrument.playbackId`, `expected "${MIDI_MELODIC_INSTRUMENT_ID}"`);
  }
  const program = numberValue(instrument.program, `${path}.instrument.program`);
  if (!isMidiProgram(program)) fail(`${path}.instrument.program`, 'expected a General MIDI program in range 0..127');
  return {
    channel,
    instrument: { kind, playbackId: MIDI_MELODIC_INSTRUMENT_ID, program },
  };
};

const trackValue = (
  value: unknown,
  path: string,
  sourceSchemaVersion: number,
  projectBpm: number,
): Track => {
  const source = record(value, path);
  const kind = enumValue<'audio' | 'midi'>(source.kind, new Set(['audio', 'midi']), `${path}.kind`);
  const pan = numberValue(source.pan, `${path}.pan`);
  const gain = numberValue(source.gain, `${path}.gain`);
  if (pan < -1 || pan > 1) fail(`${path}.pan`, 'expected normalized pan -1..1');
  if (gain < 0) fail(`${path}.gain`, 'expected a non-negative gain');
  const clips = arrayValue(source.clips, `${path}.clips`).map((clip, index) =>
    clipValue(clip, `${path}.clips[${index}]`, sourceSchemaVersion, projectBpm));
  if (clips.some((clip) => clip.kind !== kind)) fail(`${path}.clips`, 'clip kind must match track kind');
  const base = {
    id: stringValue(source.id, `${path}.id`),
    name: stringValue(source.name, `${path}.name`, true),
    color: stringValue(source.color, `${path}.color`),
    gain,
    pan,
    mute: booleanValue(source.mute, `${path}.mute`),
    solo: booleanValue(source.solo, `${path}.solo`),
    armed: optionalBoolean(source.armed, `${path}.armed`),
    collapsed: optionalBoolean(source.collapsed, `${path}.collapsed`),
    clips,
  };
  if (kind === 'audio') return { ...base, kind };
  const legacyNotes = clips.flatMap((clip) => clip.kind === 'midi' ? clip.notes : []);
  return {
    ...base,
    kind,
    midi: midiTrackSettingsValue(source.midi, `${path}.midi`, legacyNotes),
  };
};

const peakLevelValue = (value: unknown, path: string): WaveformPeakLevel => {
  const source = record(value, path);
  const numbers = (entry: unknown, entryPath: string): number[] =>
    arrayValue(entry, entryPath).map((item, index) => numberValue(item, `${entryPath}[${index}]`));
  const min = numbers(source.min, `${path}.min`);
  const max = numbers(source.max, `${path}.max`);
  const rms = source.rms === undefined ? undefined : numbers(source.rms, `${path}.rms`);
  if (min.length !== max.length || (rms && rms.length !== max.length)) fail(path, 'waveform arrays must have equal lengths');
  const rawSamplesPerPeak = numberValue(source.samplesPerPeak, `${path}.samplesPerPeak`);
  if (rawSamplesPerPeak <= 0) fail(`${path}.samplesPerPeak`, 'expected a positive integer');
  // Waveforms are a derived cache. Affected live-recording builds calculated
  // this stride as frameCount / bucketCount, which can be fractional. Repair
  // that in-memory value at the durability boundary so the take can still be
  // checkpointed instead of being discarded after a failed save.
  const samplesPerPeak = Math.max(1, Math.ceil(rawSamplesPerPeak));
  return { samplesPerPeak, min, max, rms };
};

const integrityValue = (value: unknown, path: string): AudioAsset['integrity'] => {
  if (value === undefined) return undefined;
  const source = record(value, path);
  return {
    state: enumValue(source.state, new Set(['available', 'missing', 'corrupt', 'unverified']), `${path}.state`),
    expectedHashSha256: optionalSha256(source.expectedHashSha256, `${path}.expectedHashSha256`),
    actualHashSha256: optionalSha256(source.actualHashSha256, `${path}.actualHashSha256`),
    message: optionalString(source.message, `${path}.message`),
  };
};

/** Validation is synchronous, so it can preserve a failure but never claim a fresh byte-level success. */
const pendingMediaIntegrity = (
  declared: AudioAsset['integrity'],
  contentHashSha256: string | undefined,
  hasMedia: boolean,
): AudioAsset['integrity'] => {
  if (contentHashSha256 && declared?.expectedHashSha256
    && contentHashSha256 !== declared.expectedHashSha256) {
    return {
      state: 'corrupt',
      expectedHashSha256: contentHashSha256,
      actualHashSha256: declared.actualHashSha256,
      message: 'Stored integrity metadata disagrees with the source content hash.',
    };
  }
  if (declared?.state === 'corrupt') {
    return {
      ...declared,
      expectedHashSha256: contentHashSha256 ?? declared.expectedHashSha256,
    };
  }
  if (!hasMedia) {
    return {
      state: 'missing',
      expectedHashSha256: contentHashSha256,
      message: 'Local media bytes are missing; integrity cannot be verified.',
    };
  }
  if (!contentHashSha256) {
    return {
      state: 'unverified',
      message: 'No SHA-256 content hash is stored; media remains unverified.',
    };
  }
  return {
    state: 'unverified',
    expectedHashSha256: contentHashSha256,
    message: 'Media requires asynchronous SHA-256 verification after validation or load.',
  };
};

const assetValue = (value: unknown, path: string): AudioAsset => {
  const source = record(value, path);
  const durationSeconds = numberValue(source.durationSeconds, `${path}.durationSeconds`);
  if (durationSeconds < 0) fail(`${path}.durationSeconds`, 'expected a non-negative duration');
  const blob = source.blob;
  const bytes = source.bytes;
  if (blob !== undefined && !(blob instanceof Blob)) fail(`${path}.blob`, 'expected Blob media');
  if (bytes !== undefined && !(bytes instanceof ArrayBuffer)) fail(`${path}.bytes`, 'expected ArrayBuffer media');
  const sampleRate = optionalNumber(source.sampleRate, `${path}.sampleRate`);
  const channelCount = optionalNumber(source.channelCount, `${path}.channelCount`);
  const contentHashSha256 = optionalSha256(source.contentHashSha256, `${path}.contentHashSha256`);
  const declaredIntegrity = integrityValue(source.integrity, `${path}.integrity`);
  if (sampleRate !== undefined && (!Number.isInteger(sampleRate) || sampleRate <= 0)) {
    fail(`${path}.sampleRate`, 'expected a positive integer');
  }
  if (channelCount !== undefined && (!Number.isInteger(channelCount) || channelCount <= 0)) {
    fail(`${path}.channelCount`, 'expected a positive integer');
  }
  return {
    id: stringValue(source.id, `${path}.id`),
    name: stringValue(source.name, `${path}.name`, true),
    mimeType: stringValue(source.mimeType, `${path}.mimeType`),
    durationSeconds,
    sampleRate,
    channelCount,
    createdAt: timestampValue(source.createdAt, `${path}.createdAt`),
    blob: blob as Blob | undefined,
    bytes: bytes as ArrayBuffer | undefined,
    contentHashSha256,
    waveform: source.waveform === undefined
      ? undefined
      : arrayValue(source.waveform, `${path}.waveform`).map((entry, index) => peakLevelValue(entry, `${path}.waveform[${index}]`)),
    integrity: pendingMediaIntegrity(declaredIntegrity, contentHashSha256, blob !== undefined || bytes !== undefined),
    provenance: provenanceValue(source.provenance, `${path}.provenance`),
  };
};

const midiExtractionJobSnapshotValue = (
  value: unknown,
  path: string,
): MidiExtractionJobSnapshot => {
  const source = record(value, path);
  const startBeat = numberValue(source.startBeat, `${path}.startBeat`);
  const durationBeats = numberValue(source.durationBeats, `${path}.durationBeats`);
  const offsetBeats = numberValue(source.offsetBeats, `${path}.offsetBeats`);
  const bpm = numberValue(source.bpm, `${path}.bpm`);
  if (startBeat < 0) fail(`${path}.startBeat`, 'expected a non-negative arrangement beat');
  if (durationBeats <= 0) fail(`${path}.durationBeats`, 'expected a positive duration');
  if (offsetBeats < 0) fail(`${path}.offsetBeats`, 'expected a non-negative source beat');
  if (bpm <= 0 || bpm > 1_000) fail(`${path}.bpm`, 'expected tempo in range 0..1000');
  const timebase = source.timebase === undefined
    ? { mode: 'fixed-seconds' as const, sourceBpm: bpm }
    : audioTimebaseValue(source.timebase, `${path}.timebase`, PROJECT_SCHEMA_VERSION, bpm, {
        source: 'user',
        createdAt: new Date(0).toISOString(),
      });
  if (timebase.mode === 'fixed-seconds' && Math.abs(timebase.sourceBpm - bpm) > 1e-9) {
    fail(`${path}.timebase`, 'fixed-seconds Audio must be rescaled to the submitted BPM');
  }
  return {
    sourceAssetId: stringValue(source.sourceAssetId, `${path}.sourceAssetId`),
    sourceTrackId: stringValue(source.sourceTrackId, `${path}.sourceTrackId`),
    sourceClipId: stringValue(source.sourceClipId, `${path}.sourceClipId`),
    sourceClipName: stringValue(source.sourceClipName, `${path}.sourceClipName`, true),
    startBeat,
    durationBeats,
    offsetBeats,
    sourceLoop: sourceLoopValue(source.sourceLoop, `${path}.sourceLoop`),
    timebase,
    transform: audioTransformValue(source.transform, `${path}.transform`),
    bpm,
  };
};

const generationLengthSnapshotValue = (
  value: unknown,
  path: string,
): GenerationLengthSnapshot => {
  const source = record(value, path);
  const unit = enumValue<'seconds' | 'bars'>(source.unit, GENERATION_LENGTH_UNITS, `${path}.unit`);
  const numericValue = numberValue(source.value, `${path}.value`);
  const durationSeconds = numberValue(source.durationSeconds, `${path}.durationSeconds`);
  const bpm = numberValue(source.bpm, `${path}.bpm`);
  const signature = record(source.timeSignature, `${path}.timeSignature`);
  const numerator = numberValue(signature.numerator, `${path}.timeSignature.numerator`);
  const denominator = numberValue(signature.denominator, `${path}.timeSignature.denominator`);
  if (numericValue <= 0) fail(`${path}.value`, 'expected a positive length');
  if (durationSeconds <= 0) fail(`${path}.durationSeconds`, 'expected a positive duration');
  if (bpm < 30 || bpm > 300) fail(`${path}.bpm`, 'expected tempo in range 30..300');
  if (!Number.isInteger(numerator) || numerator <= 0) fail(`${path}.timeSignature.numerator`, 'expected a positive integer');
  if (!DENOMINATORS.has(denominator)) fail(`${path}.timeSignature.denominator`, 'unsupported denominator');
  const expectedSeconds = unit === 'seconds'
    ? numericValue
    : (numericValue * ((numerator * 4) / denominator) * 60) / bpm;
  if (Math.abs(expectedSeconds - durationSeconds) > 1e-6) {
    fail(`${path}.durationSeconds`, 'does not match the submitted length, BPM, and time signature');
  }
  return {
    unit,
    value: numericValue,
    durationSeconds,
    bpm,
    timeSignature: { numerator, denominator: denominator as 1 | 2 | 4 | 8 | 16 | 32 },
  };
};

const jobValue = (value: unknown, path: string): AIJob => {
  const source = record(value, path);
  const input = record(source.input, `${path}.input`);
  const output = source.output === undefined ? undefined : record(source.output, `${path}.output`);
  const error = source.error === undefined ? undefined : record(source.error, `${path}.error`);
  const progress = numberValue(source.progress, `${path}.progress`);
  if (progress < 0 || progress > 1) fail(`${path}.progress`, 'expected progress 0..1');
  return {
    id: stringValue(source.id, `${path}.id`),
    kind: enumValue(source.kind, JOB_KINDS, `${path}.kind`),
    state: enumValue(source.state, JOB_STATES, `${path}.state`),
    computeTarget: enumValue(source.computeTarget, COMPUTE_TARGETS, `${path}.computeTarget`),
    progress,
    createdAt: timestampValue(source.createdAt, `${path}.createdAt`),
    updatedAt: timestampValue(source.updatedAt, `${path}.updatedAt`),
    input: {
      prompt: optionalString(input.prompt, `${path}.input.prompt`),
      assetId: optionalString(input.assetId, `${path}.input.assetId`),
      trackId: optionalString(input.trackId, `${path}.input.trackId`),
      clipId: optionalString(input.clipId, `${path}.input.clipId`),
      durationSeconds: optionalNumber(input.durationSeconds, `${path}.input.durationSeconds`),
      seed: optionalGenerationSeed(input.seed, `${path}.input.seed`),
      generationLength: input.generationLength === undefined
        ? undefined
        : generationLengthSnapshotValue(input.generationLength, `${path}.input.generationLength`),
      midiExtraction: input.midiExtraction === undefined
        ? undefined
        : midiExtractionJobSnapshotValue(input.midiExtraction, `${path}.input.midiExtraction`),
    },
    output: output && {
      assetId: optionalString(output.assetId, `${path}.output.assetId`),
      clipId: optionalString(output.clipId, `${path}.output.clipId`),
      trackId: optionalString(output.trackId, `${path}.output.trackId`),
    },
    error: error && {
      code: optionalString(error.code, `${path}.error.code`),
      message: stringValue(error.message, `${path}.error.message`, true),
      retryable: optionalBoolean(error.retryable, `${path}.error.retryable`),
    },
  };
};

const ensureUniqueIds = (values: Array<{ id: string }>, path: string): void => {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value.id)) fail(path, `duplicate id "${value.id}"`);
    seen.add(value.id);
  }
};

export function validateProject(value: unknown): Project {
  const source = record(value, 'project');
  const sourceSchemaVersion = numberValue(source.schemaVersion, 'project.schemaVersion');
  if (![1, 2, 3, 4, PROJECT_SCHEMA_VERSION].includes(sourceSchemaVersion)) {
    throw new ProjectImportError(
      'unsupported-version',
      `Unsupported VibeSeq project schema ${String(source.schemaVersion)}`,
    );
  }
  const bpm = numberValue(source.bpm, 'project.bpm');
  if (bpm <= 0 || bpm > 1_000) fail('project.bpm', 'expected tempo in range 0..1000');
  const sampleRate = source.sampleRate === undefined && sourceSchemaVersion === 1
    ? 44_100
    : numberValue(source.sampleRate, 'project.sampleRate');
  if (!PROJECT_SAMPLE_RATES.has(sampleRate)) {
    fail('project.sampleRate', 'supported values are 44100 or 48000 Hz');
  }
  const signature = record(source.timeSignature, 'project.timeSignature');
  const numerator = numberValue(signature.numerator, 'project.timeSignature.numerator');
  const denominator = numberValue(signature.denominator, 'project.timeSignature.denominator');
  if (!Number.isInteger(numerator) || numerator <= 0) fail('project.timeSignature.numerator', 'expected a positive integer');
  if (!DENOMINATORS.has(denominator)) fail('project.timeSignature.denominator', 'unsupported denominator');
  const loop = record(source.loop, 'project.loop');
  const startBeat = numberValue(loop.startBeat, 'project.loop.startBeat');
  const endBeat = numberValue(loop.endBeat, 'project.loop.endBeat');
  if (endBeat <= startBeat) fail('project.loop', 'loop end must be after loop start');
  const tracks = arrayValue(source.tracks, 'project.tracks').map((track, index) =>
    trackValue(track, `project.tracks[${index}]`, sourceSchemaVersion, bpm));
  const assets = arrayValue(source.assets, 'project.assets').map((asset, index) => assetValue(asset, `project.assets[${index}]`));
  const jobs = arrayValue(source.jobs, 'project.jobs').map((job, index) => jobValue(job, `project.jobs[${index}]`));
  ensureUniqueIds(tracks, 'project.tracks');
  ensureUniqueIds(assets, 'project.assets');
  ensureUniqueIds(jobs, 'project.jobs');
  ensureUniqueIds(tracks.flatMap((track) => track.clips), 'project clips');
  assertProjectArrangementInvariants({
    bpm,
    arrangement: { overlapPolicy: 'prevent' },
    tracks,
  });
  const masterGain = numberValue(source.masterGain, 'project.masterGain');
  if (masterGain < 0) fail('project.masterGain', 'expected a non-negative gain');
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: stringValue(source.id, 'project.id'),
    name: stringValue(source.name, 'project.name', true),
    bpm,
    sampleRate: sampleRate as ProjectSampleRate,
    timeSignature: { numerator, denominator: denominator as 1 | 2 | 4 | 8 | 16 | 32 },
    arrangement: { overlapPolicy: 'prevent' },
    tracks,
    loop: { enabled: booleanValue(loop.enabled, 'project.loop.enabled'), startBeat, endBeat },
    assets,
    jobs,
    masterGain,
    createdAt: timestampValue(source.createdAt, 'project.createdAt'),
    updatedAt: timestampValue(source.updatedAt, 'project.updatedAt'),
  };
}

const candidateValue = (value: unknown, path: string): GenerationCandidateSnapshot => {
  const source = record(value, path);
  const duration = numberValue(source.duration, `${path}.duration`);
  if (duration <= 0) fail(`${path}.duration`, 'expected a positive duration');
  const blob = source.blob;
  const bytes = source.bytes;
  if (blob !== undefined && !(blob instanceof Blob)) fail(`${path}.blob`, 'expected Blob media');
  if (bytes !== undefined && !(bytes instanceof ArrayBuffer)) fail(`${path}.bytes`, 'expected ArrayBuffer media');
  const sampleRate = optionalNumber(source.sampleRate, `${path}.sampleRate`);
  const contentHashSha256 = optionalSha256(source.contentHashSha256, `${path}.contentHashSha256`);
  const declaredIntegrity = integrityValue(source.integrity, `${path}.integrity`);
  if (sampleRate !== undefined && (!Number.isInteger(sampleRate) || sampleRate <= 0)) {
    fail(`${path}.sampleRate`, 'expected a positive integer');
  }
  return {
    id: stringValue(source.id, `${path}.id`),
    name: stringValue(source.name, `${path}.name`, true),
    prompt: stringValue(source.prompt, `${path}.prompt`, true),
    duration,
    seed: optionalGenerationSeed(source.seed, `${path}.seed`),
    generationLength: source.generationLength === undefined
      ? undefined
      : generationLengthSnapshotValue(source.generationLength, `${path}.generationLength`),
    provider: stringValue(source.provider, `${path}.provider`),
    device: stringValue(source.device, `${path}.device`),
    model: optionalString(source.model, `${path}.model`),
    modelId: optionalString(source.modelId, `${path}.modelId`),
    modelRevision: optionalString(source.modelRevision, `${path}.modelRevision`),
    codeRevision: optionalString(source.codeRevision, `${path}.codeRevision`),
    runtime: optionalString(source.runtime, `${path}.runtime`),
    route: optionalString(source.route, `${path}.route`),
    sourcePeak: source.sourcePeak === null ? null : optionalNumber(source.sourcePeak, `${path}.sourcePeak`),
    outputPeak: source.outputPeak === null ? null : optionalNumber(source.outputPeak, `${path}.outputPeak`),
    peakProtectionApplied: source.peakProtectionApplied === undefined
      ? undefined
      : booleanValue(source.peakProtectionApplied, `${path}.peakProtectionApplied`),
    peakAttenuationDb: optionalNumber(source.peakAttenuationDb, `${path}.peakAttenuationDb`),
    assetId: optionalString(source.assetId, `${path}.assetId`),
    assetUrl: optionalString(source.assetUrl, `${path}.assetUrl`),
    sampleRate,
    mimeType: optionalString(source.mimeType, `${path}.mimeType`),
    peaks: source.peaks === undefined ? undefined : peakLevelValue(source.peaks, `${path}.peaks`),
    jobId: optionalString(source.jobId, `${path}.jobId`),
    blob: blob as Blob | undefined,
    bytes: bytes as ArrayBuffer | undefined,
    contentHashSha256,
    integrity: pendingMediaIntegrity(declaredIntegrity, contentHashSha256, blob !== undefined || bytes !== undefined),
  };
};

const inferenceJobValue = (value: unknown, path: string): InferenceJobSnapshot => {
  const source = record(value, path);
  const progress = numberValue(source.progress, `${path}.progress`);
  if (progress < 0 || progress > 1) fail(`${path}.progress`, 'expected progress 0..1');
  return {
    id: stringValue(source.id, `${path}.id`),
    kind: enumValue(source.kind, INFERENCE_KINDS, `${path}.kind`),
    status: enumValue(source.status, JOB_STATES, `${path}.status`),
    progress,
    result: source.result === undefined ? undefined : jsonValue(source.result, `${path}.result`),
    error: optionalString(source.error, `${path}.error`),
  };
};

export function validateProjectSession(value: unknown = {}): ProjectSessionSnapshot {
  const source = record(value, 'session');
  const candidates = arrayValue(source.candidates ?? [], 'session.candidates').map((candidate, index) => candidateValue(candidate, `session.candidates[${index}]`));
  ensureUniqueIds(candidates, 'session.candidates');
  let activeJob: ActiveInferenceJobSnapshot | null | undefined;
  if (source.activeJob === null) activeJob = null;
  else if (source.activeJob !== undefined) {
    const job = record(source.activeJob, 'session.activeJob');
    activeJob = {
      label: stringValue(job.label, 'session.activeJob.label', true),
      job: inferenceJobValue(job.job, 'session.activeJob.job'),
    };
  }
  return { candidates, activeJob };
}

const checkpointId = (): string => {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (randomUuid) return randomUuid;
  fallbackCheckpointCounter += 1;
  return `${Date.now().toString(36)}-${fallbackCheckpointCounter.toString(36)}`;
};

const legacyRevisionFromTimestamp = (savedAt: string): number => {
  const timestamp = Date.parse(savedAt);
  return Number.isFinite(timestamp) ? Math.max(1, Math.trunc(timestamp) * 1_000) : 1;
};

const checkpointRevision = (savedAt: string, minimum = 0): number => {
  const wallRevision = legacyRevisionFromTimestamp(savedAt);
  lastCheckpointRevision = Math.max(lastCheckpointRevision + 1, wallRevision, minimum);
  if (!Number.isSafeInteger(lastCheckpointRevision)) {
    throw new RangeError('Project checkpoint revision exceeded the safe integer range');
  }
  return lastCheckpointRevision;
};

const validatedCheckpointRevision = (value: unknown, savedAt: string, path: string): number => {
  if (value === undefined) return legacyRevisionFromTimestamp(savedAt);
  const revision = numberValue(value, path);
  if (!Number.isSafeInteger(revision) || revision < 1) fail(path, 'expected a positive safe integer');
  lastCheckpointRevision = Math.max(lastCheckpointRevision, revision);
  return revision;
};

export function createProjectCheckpoint(
  project: Project,
  session: ProjectSessionSnapshot = { candidates: [] },
  options: { checkpointId?: string; revision?: number; minimumRevision?: number; savedAt?: string } = {},
): ProjectCheckpoint {
  const savedAt = options.savedAt ?? new Date().toISOString();
  const revision = options.revision ?? checkpointRevision(savedAt, options.minimumRevision);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new RangeError('Project checkpoint revision must be a positive safe integer');
  }
  lastCheckpointRevision = Math.max(lastCheckpointRevision, revision);
  return {
    checkpointId: options.checkpointId ?? checkpointId(),
    revision,
    savedAt,
    project: validateProject(structuredClone(project)),
    session: validateProjectSession(structuredClone(session)),
  };
}

export function validateProjectCheckpoint(value: unknown): ProjectCheckpoint {
  const source = record(value, 'checkpoint');
  const savedAt = timestampValue(source.savedAt, 'checkpoint.savedAt');
  return createProjectCheckpoint(
    validateProject(source.project),
    validateProjectSession(source.session),
    {
      checkpointId: stringValue(source.checkpointId, 'checkpoint.checkpointId'),
      revision: validatedCheckpointRevision(source.revision, savedAt, 'checkpoint.revision'),
      savedAt,
    },
  );
}

export function bytesToBase64(bytes: Uint8Array): string {
  let result = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const b = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const c = index + 2 < bytes.length ? bytes[index + 2] : 0;
    const merged = (a << 16) | (b << 8) | c;
    result += BASE64_ALPHABET[(merged >>> 18) & 63];
    result += BASE64_ALPHABET[(merged >>> 12) & 63];
    result += index + 1 < bytes.length ? BASE64_ALPHABET[(merged >>> 6) & 63] : '=';
    result += index + 2 < bytes.length ? BASE64_ALPHABET[merged & 63] : '=';
  }
  return result;
}

export function base64ToBytes(value: string): Uint8Array {
  const clean = value.replace(/\s/g, '');
  if (clean.length % 4 !== 0 || !BASE64_PATTERN.test(clean)) {
    throw new ProjectImportError('invalid-project', 'Invalid base64 payload');
  }
  const outputLength = (clean.length / 4) * 3 - (clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0);
  const output = new Uint8Array(outputLength);
  let writeIndex = 0;
  for (let index = 0; index < clean.length; index += 4) {
    const values = [0, 1, 2, 3].map((offset) => {
      const character = clean[index + offset];
      return character === '=' ? 0 : BASE64_ALPHABET.indexOf(character);
    });
    const merged = (values[0] << 18) | (values[1] << 12) | (values[2] << 6) | values[3];
    if (writeIndex < output.length) output[writeIndex++] = (merged >>> 16) & 255;
    if (writeIndex < output.length) output[writeIndex++] = (merged >>> 8) & 255;
    if (writeIndex < output.length) output[writeIndex++] = merged & 255;
  }
  return output;
}

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
};

const encodeBinary = async (blob?: Blob, bytes?: ArrayBuffer, mimeType?: string) => {
  const encoded: { blob?: BinaryEnvelope; bytes?: BinaryEnvelope } = {};
  if (blob) {
    encoded.blob = {
      __vibeseqBinary: true,
      mimeType: blob.type || mimeType,
      base64: bytesToBase64(new Uint8Array(await blob.arrayBuffer())),
    };
  }
  if (bytes) encoded.bytes = { __vibeseqBinary: true, base64: bytesToBase64(new Uint8Array(bytes)) };
  return encoded;
};

const binaryEnvelope = (value: unknown, path: string): BinaryEnvelope | undefined => {
  if (value === undefined) return undefined;
  const source = record(value, path);
  if (source.__vibeseqBinary !== true) fail(path, 'unknown binary encoding');
  return {
    __vibeseqBinary: true,
    mimeType: optionalString(source.mimeType, `${path}.mimeType`),
    base64: stringValue(source.base64, `${path}.base64`, true),
  };
};

const decodeEncodedAsset = (value: unknown, path: string): AudioAsset => {
  const source = record(value, path);
  const blob = binaryEnvelope(source.blob, `${path}.blob`);
  const bytes = binaryEnvelope(source.bytes, `${path}.bytes`);
  const raw: Record<string, unknown> = { ...source };
  delete raw.blob;
  delete raw.bytes;
  try {
    if (blob) {
      const decoded = base64ToBytes(blob.base64);
      raw.blob = new Blob([toArrayBuffer(decoded)], { type: blob.mimeType ?? String(source.mimeType ?? '') });
    }
    if (bytes) raw.bytes = toArrayBuffer(base64ToBytes(bytes.base64));
  } catch (error) {
    raw.integrity = {
      state: 'corrupt',
      message: error instanceof Error ? error.message : 'Encoded media is corrupt',
    };
  }
  return assetValue(raw, path);
};

const decodeEncodedCandidate = (value: unknown, path: string): GenerationCandidateSnapshot => {
  const source = record(value, path);
  const blob = binaryEnvelope(source.blob, `${path}.blob`);
  const bytes = binaryEnvelope(source.bytes, `${path}.bytes`);
  const raw: Record<string, unknown> = { ...source };
  delete raw.blob;
  delete raw.bytes;
  try {
    if (blob) raw.blob = new Blob([toArrayBuffer(base64ToBytes(blob.base64))], { type: blob.mimeType });
    if (bytes) raw.bytes = toArrayBuffer(base64ToBytes(bytes.base64));
  } catch (error) {
    raw.integrity = {
      state: 'corrupt',
      message: error instanceof Error ? error.message : 'Encoded candidate media is corrupt',
    };
  }
  return candidateValue(raw, path);
};

export async function serializeProjectCheckpoint(checkpoint: ProjectCheckpoint): Promise<string> {
  const validated = validateProjectCheckpoint(checkpoint);
  const assets: EncodedAudioAsset[] = await Promise.all(
    validated.project.assets.map(async ({ blob, bytes, ...asset }) => ({
      ...asset,
      ...(await encodeBinary(blob, bytes, asset.mimeType)),
    })),
  );
  const candidates: EncodedCandidate[] = await Promise.all(
    validated.session.candidates.map(async ({ blob, bytes, ...candidate }) => ({
      ...candidate,
      ...(await encodeBinary(blob, bytes, candidate.mimeType)),
    })),
  );
  const envelope: EncodedCheckpointEnvelope = {
    format: PROJECT_SERIALIZATION_FORMAT,
    serializationVersion: PROJECT_SERIALIZATION_VERSION,
    checkpointId: validated.checkpointId,
    revision: validated.revision,
    savedAt: validated.savedAt,
    project: { ...validated.project, assets },
    session: { ...validated.session, candidates },
  };
  return JSON.stringify(envelope);
}

const legacyCheckpoint = (projectValue: unknown): ProjectCheckpoint => {
  const source = record(projectValue, 'project');
  const encodedAssets = arrayValue(source.assets, 'project.assets');
  const project = validateProject({
    ...source,
    assets: encodedAssets.map((asset, index) => {
      const candidate = record(asset, `project.assets[${index}]`);
      const hasEncodedMedia =
        (candidate.blob !== undefined && !(candidate.blob instanceof Blob))
        || (candidate.bytes !== undefined && !(candidate.bytes instanceof ArrayBuffer));
      return hasEncodedMedia
        ? decodeEncodedAsset(candidate, `project.assets[${index}]`)
        : candidate;
    }),
  });
  return createProjectCheckpoint(project, { candidates: [] }, {
    checkpointId: `legacy-${project.id}-${project.updatedAt}`,
    revision: legacyRevisionFromTimestamp(project.updatedAt),
    savedAt: project.updatedAt,
  });
};

export function deserializeProjectCheckpoint(serialized: string): ProjectCheckpoint {
  let decoded: unknown;
  try {
    decoded = JSON.parse(serialized);
  } catch {
    throw new ProjectImportError('invalid-json', 'Invalid VibeSeq project JSON');
  }
  const source = record(decoded, 'document');
  if (source.format === undefined && source.schemaVersion !== undefined) return legacyCheckpoint(source);
  if (source.format !== PROJECT_SERIALIZATION_FORMAT) fail('document.format', 'not a VibeSeq project');
  if (source.serializationVersion !== PROJECT_SERIALIZATION_VERSION) {
    throw new ProjectImportError(
      'unsupported-version',
      `Unsupported VibeSeq serialization version ${String(source.serializationVersion)}`,
    );
  }
  const encodedProject = record(source.project, 'document.project');
  const encodedAssets = arrayValue(encodedProject.assets, 'document.project.assets');
  const project = validateProject({
    ...encodedProject,
    assets: encodedAssets.map((asset, index) => decodeEncodedAsset(asset, `document.project.assets[${index}]`)),
  });
  const encodedSession = record(source.session ?? { candidates: [] }, 'document.session');
  const encodedCandidates = arrayValue(encodedSession.candidates ?? [], 'document.session.candidates');
  const session = validateProjectSession({
    ...encodedSession,
    candidates: encodedCandidates.map((candidate, index) => decodeEncodedCandidate(candidate, `document.session.candidates[${index}]`)),
  });
  const savedAt = timestampValue(source.savedAt, 'document.savedAt');
  return createProjectCheckpoint(project, session, {
    checkpointId: stringValue(source.checkpointId, 'document.checkpointId'),
    revision: validatedCheckpointRevision(source.revision, savedAt, 'document.revision'),
    savedAt,
  });
}

export async function serializeProject(project: Project): Promise<string> {
  return serializeProjectCheckpoint(createProjectCheckpoint(project));
}

export function deserializeProject(serialized: string): Project {
  return deserializeProjectCheckpoint(serialized).project;
}
