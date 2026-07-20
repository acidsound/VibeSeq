import processorModuleUrl from './vibeseqAudioProcessor.ts?worker&url';
import type { Project } from '../../types';
import {
  BUILTIN_CHAOS_DRUM_ASSETS,
  decodeBuiltinMidiAsset,
  type BuiltinMidiAssetLoader,
} from './builtinMidiAssets';
import {
  WebAudioPlaybackEngine,
  type PlaybackMeterSnapshot,
  type PlaybackOptions,
  type PlaybackState,
  type WebAudioPlaybackEngineOptions,
} from './playback';
import {
  combineRecordingChunks,
} from './inputRecording';
import {
  createWorkletProjectSnapshot,
  MAX_MIDI_AUDITION_SECONDS,
  MIN_MIDI_AUDITION_SECONDS,
  requiredWorkletAssetIds,
  VIBESEQ_AUDIO_PROCESSOR_NAME,
  workletRenderGraphKey,
  type WorkletAssetPayload,
  type WorkletCommand,
  type WorkletEvent,
  type WorkletProjectSnapshot,
  type WorkletRecordingResult,
  type WorkletRecordingStart,
  type WorkletTrackParameterPatch,
} from './workletProtocol';

export type AudioWorkletEngineErrorCode =
  | 'unsupported'
  | 'insecure-context'
  | 'context-closed'
  | 'context-resume-failed'
  | 'module-load-failed'
  | 'processor-create-failed'
  | 'processor-crashed'
  | 'processor-error'
  | 'asset-load-failed'
  | 'asset-missing'
  | 'disposed';

export class AudioWorkletEngineError extends Error {
  constructor(
    readonly code: AudioWorkletEngineErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'AudioWorkletEngineError';
  }
}

export interface AudioWorkletSupport {
  supported: boolean;
  code?: Extract<AudioWorkletEngineErrorCode, 'unsupported' | 'insecure-context'>;
  reason?: string;
}

type AudioContextFactory = () => AudioContext;
type AudioWorkletNodeFactory = (
  context: BaseAudioContext,
  name: string,
  options: AudioWorkletNodeOptions,
) => AudioWorkletNode;

export interface AudioWorkletPlaybackEngineOptions {
  context?: AudioContext;
  /** Injectable for deterministic harnesses and embedders with a context policy. */
  contextFactory?: AudioContextFactory;
  /** Injectable for browser harnesses; production uses the native constructor. */
  nodeFactory?: AudioWorkletNodeFactory;
  /** Test/embedding seam; production fetches the pinned local instrument files. */
  builtinMidiAssetLoader?: BuiltinMidiAssetLoader;
  processorModuleUrl?: string;
  onPosition?: (beat: number) => void;
  onStateChange?: (state: PlaybackState) => void;
  onEnded?: () => void;
  onMeter?: (snapshot: PlaybackMeterSnapshot) => void;
  onError?: (error: AudioWorkletEngineError) => void;
}

export type PlaybackBackend = 'audio-worklet' | 'web-audio-compatibility';

export interface CreatePlaybackEngineOptions extends AudioWorkletPlaybackEngineOptions {
  /** Compatibility is opt-in; no runtime failure silently changes the audio engine. */
  backend?: PlaybackBackend;
}

export interface RecordingLatencyEstimate {
  baseLatencySeconds: number;
  outputLatencySeconds: number;
  inputLatencySeconds: number;
  totalSeconds: number;
}

type ActiveInputRecording = {
  sessionId: string;
  sourceNode: MediaStreamAudioSourceNode;
  chunks: Float32Array[][];
  started: Promise<WorkletRecordingStart>;
  resolveStarted: (start: WorkletRecordingStart) => void;
  rejectStarted: (error: Error) => void;
  completed: Promise<WorkletRecordingResult>;
  resolveCompleted: (result: WorkletRecordingResult) => void;
  rejectCompleted: (error: Error) => void;
  start?: WorkletRecordingStart;
};

type BrowserAudioGlobals = typeof globalThis & {
  AudioContext?: typeof AudioContext;
  webkitAudioContext?: typeof AudioContext;
  AudioWorkletNode?: typeof AudioWorkletNode;
  isSecureContext?: boolean;
};

export function detectAudioWorkletSupport(environment: BrowserAudioGlobals = globalThis): AudioWorkletSupport {
  if (environment.isSecureContext === false) {
    return {
      supported: false,
      code: 'insecure-context',
      reason: 'AudioWorklet requires a secure context (HTTPS or a trustworthy localhost origin)',
    };
  }
  if (!(environment.AudioContext ?? environment.webkitAudioContext)) {
    return { supported: false, code: 'unsupported', reason: 'Web Audio AudioContext is unavailable' };
  }
  if (!environment.AudioWorkletNode) {
    return { supported: false, code: 'unsupported', reason: 'AudioWorkletNode is unavailable' };
  }
  return { supported: true };
}

const finiteNonNegative = (value: number, label: string): number => {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${label} must be finite and non-negative`);
  return value;
};

const finitePan = (value: number): number => {
  if (!Number.isFinite(value) || value < -1 || value > 1) throw new RangeError('Track pan must be in range -1..1');
  return value;
};

/**
 * Default realtime backend. The UI sends immutable project/asset snapshots and
 * lightweight parameter commands; sample rendering, transport and mixing stay
 * on the browser audio rendering thread.
 */
export class AudioWorkletPlaybackEngine {
  readonly backend = 'audio-worklet' as const;
  private project?: WorkletProjectSnapshot;
  private projectRenderGraphKey?: string;
  private context?: AudioContext;
  private node?: AudioWorkletNode;
  private readonly ownsContext: boolean;
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly loadedContexts = new WeakSet<BaseAudioContext>();
  private initialization?: Promise<void>;
  private builtinAssetInitialization?: Promise<void>;
  private nodeFaulted = false;
  private disposed = false;
  private state: PlaybackState = 'idle';
  private positionBeat = 0;
  private telemetryContextTime = 0;
  private transportEndBeat = 0;
  private loopEnabled = false;
  private resumeAfterContextRecreation = false;
  private operationEpoch = 0;
  private auditionEpoch = 0;
  private auditionToken = 0;
  private midiAuditionToken = 0;
  private recordingSequence = 0;
  private inputRecording?: ActiveInputRecording;
  private auditionEnded?: () => void;
  private activeAudition?: { assetId: string; token: number; ephemeral: boolean };
  private contextStateListener?: () => void;
  private readonly options: Omit<AudioWorkletPlaybackEngineOptions, 'context'>;

  constructor(project?: Project, options: AudioWorkletPlaybackEngineOptions = {}) {
    this.context = options.context;
    this.ownsContext = !options.context;
    this.options = {
      contextFactory: options.contextFactory,
      nodeFactory: options.nodeFactory,
      builtinMidiAssetLoader: options.builtinMidiAssetLoader ?? decodeBuiltinMidiAsset,
      processorModuleUrl: options.processorModuleUrl ?? processorModuleUrl,
      onPosition: options.onPosition,
      onStateChange: options.onStateChange,
      onEnded: options.onEnded,
      onMeter: options.onMeter,
      onError: options.onError,
    };
    if (project) this.setProject(project);
  }

  async initialize(): Promise<void> {
    this.assertNotDisposed();
    if (this.node && !this.nodeFaulted && this.context?.state !== 'closed') {
      await this.ensureBuiltinMidiAssets();
      return;
    }
    if (this.initialization) return this.initialization;
    const attempt = this.initializeInternal();
    this.initialization = attempt;
    try {
      await attempt;
    } finally {
      if (this.initialization === attempt) this.initialization = undefined;
    }
  }

  setProject(project: Project): void {
    this.assertNotDisposed();
    const previous = this.project;
    const next = createWorkletProjectSnapshot(project);
    const nextRenderGraphKey = workletRenderGraphKey(next);
    const renderGraphChanged = this.projectRenderGraphKey !== nextRenderGraphKey;
    const previousEndBeat = previous?.endBeat;
    this.project = next;
    this.projectRenderGraphKey = nextRenderGraphKey;
    this.positionBeat = Math.min(this.positionBeat, next.endBeat);
    if (this.state !== 'playing' || !previousEndBeat || this.transportEndBeat >= previousEndBeat) {
      this.transportEndBeat = next.endBeat;
    } else {
      this.transportEndBeat = Math.min(this.transportEndBeat, next.endBeat);
    }

    if (!this.node || this.nodeFaulted) return;
    if (renderGraphChanged || !previous) {
      this.post({ type: 'sync-project', project: next });
    } else {
      if (previous.masterGain !== next.masterGain) {
        this.post({ type: 'set-master-gain', gain: next.masterGain });
      }
      const previousTracks = new Map(previous.tracks.map((track) => [track.id, track]));
      for (const track of next.tracks) {
        const before = previousTracks.get(track.id);
        if (!before) continue;
        const parameters: WorkletTrackParameterPatch = {};
        if (before.gain !== track.gain) parameters.gain = track.gain;
        if (before.pan !== track.pan) parameters.pan = track.pan;
        if (before.mute !== track.mute) parameters.mute = track.mute;
        if (before.solo !== track.solo) parameters.solo = track.solo;
        if (Object.keys(parameters).length > 0) {
          this.post({ type: 'set-track-parameters', trackId: track.id, parameters });
        }
      }
    }

    if (!previous
      || previous.loop.enabled !== next.loop.enabled
      || previous.loop.startBeat !== next.loop.startBeat
      || previous.loop.endBeat !== next.loop.endBeat) {
      this.loopEnabled = next.loop.enabled;
      this.transportEndBeat = next.loop.enabled ? next.loop.endBeat : next.endBeat;
      this.post({
        type: 'set-loop',
        enabled: next.loop.enabled,
        startBeat: next.loop.startBeat,
        endBeat: next.loop.endBeat,
      });
    }
    if (this.projectRequiresChaosDrums()) {
      void this.ensureBuiltinMidiAssets().catch((error: unknown) => {
        this.reportError(this.normalizeBuiltinAssetError(error));
      });
    }
  }

  getState(): PlaybackState { return this.state; }

  isInputRecording(): boolean { return Boolean(this.inputRecording); }

  getRecordingLatencyEstimate(inputLatencySeconds = 0): RecordingLatencyEstimate {
    const context = this.context;
    const baseLatencySeconds = context && Number.isFinite(context.baseLatency) ? Math.max(0, context.baseLatency) : 0;
    const outputLatencySeconds = context && Number.isFinite(context.outputLatency) ? Math.max(0, context.outputLatency) : 0;
    const normalizedInputLatency = Number.isFinite(inputLatencySeconds) ? Math.max(0, inputLatencySeconds) : 0;
    return {
      baseLatencySeconds,
      outputLatencySeconds,
      inputLatencySeconds: normalizedInputLatency,
      totalSeconds: baseLatencySeconds + outputLatencySeconds + normalizedInputLatency,
    };
  }

  /** Reports the engine-owned PCM cache, not merely UI-side decode metadata. */
  hasAudioBuffer(assetId: string): boolean {
    return this.buffers.has(assetId);
  }

  needsReentry(): boolean {
    return this.state === 'playing' || this.resumeAfterContextRecreation;
  }

  getPositionBeat(): number {
    const project = this.project;
    const context = this.context;
    if (!project || !context || this.state !== 'playing' || context.state !== 'running') return this.positionBeat;
    const elapsedSeconds = Math.max(0, context.currentTime - this.telemetryContextTime);
    let position = this.positionBeat + (elapsedSeconds * project.bpm) / 60;
    if (this.loopEnabled) {
      const length = project.loop.endBeat - project.loop.startBeat;
      if (length > 0 && position >= project.loop.endBeat) {
        position = project.loop.startBeat + ((position - project.loop.startBeat) % length);
      }
    } else {
      position = Math.min(position, this.transportEndBeat || project.endBeat);
    }
    return position;
  }

  seek(beat: number): void {
    this.assertNotDisposed();
    this.positionBeat = Math.max(0, beat);
    this.telemetryContextTime = this.context?.currentTime ?? 0;
    this.post({ type: 'seek', positionBeat: this.positionBeat });
    this.options.onPosition?.(this.positionBeat);
  }

  setLoop(enabled: boolean, startBeat: number, endBeat: number): void {
    this.assertNotDisposed();
    if (!Number.isFinite(startBeat) || startBeat < 0 || !Number.isFinite(endBeat) || endBeat <= startBeat) {
      throw new RangeError('Loop end must be after loop start');
    }
    if (this.project) this.project.loop = { enabled, startBeat, endBeat };
    this.loopEnabled = enabled;
    this.transportEndBeat = enabled ? endBeat : this.project?.endBeat ?? endBeat;
    this.post({ type: 'set-loop', enabled, startBeat, endBeat });
  }

  setMasterGain(gain: number): void {
    this.assertNotDisposed();
    const normalized = finiteNonNegative(gain, 'Master gain');
    if (this.project) this.project.masterGain = normalized;
    this.post({ type: 'set-master-gain', gain: normalized });
  }

  setTrackParameters(trackId: string, parameters: WorkletTrackParameterPatch): void {
    this.assertNotDisposed();
    const track = this.project?.tracks.find((candidate) => candidate.id === trackId);
    if (!track) throw new Error(`Unknown track "${trackId}"`);
    const normalized: WorkletTrackParameterPatch = {};
    if (parameters.gain !== undefined) normalized.gain = finiteNonNegative(parameters.gain, 'Track gain');
    if (parameters.pan !== undefined) normalized.pan = finitePan(parameters.pan);
    if (parameters.mute !== undefined) normalized.mute = parameters.mute;
    if (parameters.solo !== undefined) normalized.solo = parameters.solo;
    Object.assign(track, normalized);
    this.post({ type: 'set-track-parameters', trackId, parameters: normalized });
  }

  registerAudioBuffer(assetId: string, buffer: AudioBuffer): void {
    this.assertNotDisposed();
    if (!assetId || buffer.numberOfChannels < 1 || !Number.isFinite(buffer.sampleRate) || buffer.sampleRate <= 0) {
      throw new RangeError('Audio buffer requires an id, channels, and a positive sample rate');
    }
    this.buffers.set(assetId, buffer);
    this.postAsset(assetId, buffer);
  }

  unregisterAudioBuffer(assetId: string): void {
    this.buffers.delete(assetId);
    this.post({ type: 'remove-asset', assetId });
  }

  async decodeAndRegister(assetId: string, media: Blob | ArrayBuffer): Promise<AudioBuffer> {
    const buffer = await this.decodeAudioMedia(media);
    this.registerAudioBuffer(assetId, buffer);
    return buffer;
  }

  async startInputRecording(stream: MediaStream, channelCount = 1): Promise<WorkletRecordingStart> {
    this.assertNotDisposed();
    if (this.inputRecording) throw new Error('An audio input recording is already active');
    if (!stream.getAudioTracks().some((track) => track.readyState === 'live')) {
      throw new Error('Recording requires a live audio input track');
    }
    await this.initialize();
    await this.resumeContext();
    const context = this.context;
    const node = this.node;
    if (!context || !node) throw new AudioWorkletEngineError('unsupported', 'Audio input recording requires an initialized AudioWorklet');
    const sourceNode = context.createMediaStreamSource(stream);
    sourceNode.connect(node);
    const sessionId = `input-recording-${++this.recordingSequence}`;
    let resolveStarted!: (start: WorkletRecordingStart) => void;
    let rejectStarted!: (error: Error) => void;
    let resolveCompleted!: (result: WorkletRecordingResult) => void;
    let rejectCompleted!: (error: Error) => void;
    const started = new Promise<WorkletRecordingStart>((resolve, reject) => {
      resolveStarted = resolve;
      rejectStarted = reject;
    });
    const completed = new Promise<WorkletRecordingResult>((resolve, reject) => {
      resolveCompleted = resolve;
      rejectCompleted = reject;
    });
    // A completion rejection can precede the caller's stop request (processor
    // crash/device removal). Attach a handler now so the browser never reports
    // an unhandled promise while start is still pending.
    void completed.catch(() => undefined);
    this.inputRecording = {
      sessionId,
      sourceNode,
      chunks: [],
      started,
      resolveStarted,
      rejectStarted,
      completed,
      resolveCompleted,
      rejectCompleted,
    };
    this.post({
      type: 'start-recording',
      sessionId,
      channelCount: Math.max(1, Math.min(2, Math.round(channelCount))),
    });
    return started;
  }

  async stopInputRecording(): Promise<WorkletRecordingResult> {
    const active = this.inputRecording;
    if (!active) throw new Error('No audio input recording is active');
    this.post({ type: 'stop-recording', sessionId: active.sessionId });
    return active.completed;
  }

  cancelInputRecording(): void {
    const active = this.inputRecording;
    if (!active) return;
    this.post({ type: 'cancel-recording', sessionId: active.sessionId });
    this.rejectInputRecording(new DOMException('Audio input recording was cancelled', 'AbortError'));
  }

  async audition(assetId: string, media?: Blob | ArrayBuffer, onEnded?: () => void): Promise<void> {
    this.assertNotDisposed();
    const epoch = ++this.auditionEpoch;
    this.auditionToken += 1;
    this.auditionEnded = undefined;
    this.releaseActiveAudition(true);

    let auditionAssetId = assetId;
    let ephemeral = false;
    let decoded: AudioBuffer | undefined;
    if (media) {
      decoded = await this.decodeAudioMedia(media);
      if (epoch !== this.auditionEpoch || this.disposed) return;
      auditionAssetId = `__vibeseq_audition__:${epoch}:${assetId}`;
      ephemeral = true;
    } else {
      await this.initialize();
    }
    await this.resumeContext();
    if (epoch !== this.auditionEpoch || this.disposed) return;
    if (decoded) this.postAsset(auditionAssetId, decoded);
    if (!ephemeral && !this.buffers.has(auditionAssetId)) {
      throw new AudioWorkletEngineError('asset-missing', `Audition asset "${assetId}" is not synchronized`);
    }
    const token = ++this.auditionToken;
    this.activeAudition = { assetId: auditionAssetId, token, ephemeral };
    this.auditionEnded = onEnded;
    this.post({ type: 'audition', assetId: auditionAssetId, token });
  }

  stopAudition(): void {
    this.auditionEpoch += 1;
    this.auditionToken += 1;
    this.auditionEnded = undefined;
    this.releaseActiveAudition(true);
  }

  /**
   * Auditions a resolved project MIDI route on the audio rendering thread.
   * This preview is independent from candidate-audio audition: both may sound
   * together, and stopping either one never truncates the other.
   */
  async auditionMidiNote(
    trackId: string,
    pitch: number,
    velocity = 0.8,
    durationSeconds = 0.35,
  ): Promise<void> {
    this.assertNotDisposed();
    const track = this.project?.tracks.find((candidate) => candidate.id === trackId);
    if (!track || track.kind !== 'midi' || !track.midiProfile) {
      throw new Error(`Unknown MIDI track "${trackId}"`);
    }
    if (!Number.isFinite(pitch) || !Number.isFinite(velocity) || !Number.isFinite(durationSeconds)) {
      throw new RangeError('MIDI audition pitch, velocity, and duration must be finite');
    }
    const normalizedPitch = Math.max(0, Math.min(127, Math.round(pitch)));
    const normalizedVelocity = Math.max(0, Math.min(1, velocity));
    const normalizedDuration = Math.max(
      MIN_MIDI_AUDITION_SECONDS,
      Math.min(MAX_MIDI_AUDITION_SECONDS, durationSeconds),
    );
    const profile = { ...track.midiProfile };
    const token = ++this.midiAuditionToken;
    await this.initialize();
    await this.resumeContext();
    if (token !== this.midiAuditionToken) return;
    const currentTrack = this.project?.tracks.find((candidate) => candidate.id === trackId);
    if (!currentTrack || currentTrack.kind !== 'midi') return;
    this.post({
      type: 'audition-midi-note',
      audition: {
        token,
        trackId,
        pitch: normalizedPitch,
        velocity: normalizedVelocity,
        durationSeconds: normalizedDuration,
        profile,
      },
    });
  }

  /** Begins a short click-free release for every active MIDI preview voice. */
  stopMidiNoteAudition(): void {
    this.midiAuditionToken += 1;
    this.post({ type: 'stop-midi-note-audition' });
  }

  async play(options: PlaybackOptions = {}): Promise<void> {
    this.assertNotDisposed();
    if (!this.project) throw new Error('A project must be set before playback');
    const epoch = ++this.operationEpoch;
    await this.initialize();
    await this.resumeContext();
    if (epoch !== this.operationEpoch) return;
    this.assertRequiredAssets();
    const loop = options.loop ?? this.project.loop.enabled;
    let fromBeat = Math.max(0, options.fromBeat ?? this.positionBeat);
    let toBeat = Math.max(fromBeat, options.toBeat ?? this.project.endBeat);
    if (loop) {
      if (this.project.loop.endBeat <= this.project.loop.startBeat) throw new Error('Loop end must be later than loop start');
      if (fromBeat < this.project.loop.startBeat || fromBeat >= this.project.loop.endBeat) {
        fromBeat = this.project.loop.startBeat;
      }
      toBeat = this.project.loop.endBeat;
    }
    toBeat = Math.min(toBeat, this.project.endBeat);
    if (toBeat <= fromBeat) return;
    this.positionBeat = fromBeat;
    this.transportEndBeat = toBeat;
    this.loopEnabled = loop;
    this.telemetryContextTime = this.context?.currentTime ?? 0;
    this.resumeAfterContextRecreation = false;
    this.post({ type: 'play', fromBeat, toBeat, loop });
    this.updateState('playing');
    this.options.onPosition?.(fromBeat);
  }

  pause(): void {
    if (this.state !== 'playing') return;
    this.operationEpoch += 1;
    this.positionBeat = this.getPositionBeat();
    this.telemetryContextTime = this.context?.currentTime ?? 0;
    this.post({ type: 'pause' });
    this.resumeAfterContextRecreation = false;
    this.updateState('paused');
    this.options.onPosition?.(this.positionBeat);
  }

  stop(resetToBeat = 0): void {
    this.operationEpoch += 1;
    this.positionBeat = Math.max(0, resetToBeat);
    this.telemetryContextTime = this.context?.currentTime ?? 0;
    this.loopEnabled = false;
    this.resumeAfterContextRecreation = false;
    this.post({ type: 'stop', positionBeat: this.positionBeat });
    this.updateState('idle');
    this.options.onPosition?.(this.positionBeat);
    this.options.onMeter?.({ master: 0, tracks: {} });
  }

  /**
   * Re-enter after a browser visibility or output-device interruption. A
   * suspended context continues from its audio-thread transport. If an owned
   * context was closed by the browser, the render graph and PCM are rebuilt and
   * playback resumes from the most recently reported beat.
   */
  async reenter(): Promise<void> {
    this.assertNotDisposed();
    const shouldRestart = this.resumeAfterContextRecreation;
    await this.initialize();
    await this.resumeContext();
    if (!shouldRestart || !this.project || this.state === 'playing') return;
    this.resumeAfterContextRecreation = false;
    await this.play({
      fromBeat: this.positionBeat,
      toBeat: this.transportEndBeat || this.project.endBeat,
      loop: this.loopEnabled,
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.operationEpoch += 1;
    this.auditionEpoch += 1;
    this.auditionToken += 1;
    this.midiAuditionToken += 1;
    this.auditionEnded = undefined;
    this.activeAudition = undefined;
    if (this.inputRecording) {
      this.post({ type: 'cancel-recording', sessionId: this.inputRecording.sessionId });
      this.rejectInputRecording(new Error('Audio engine disposed during input recording'));
    }
    this.post({ type: 'dispose' });
    this.detachNode();
    this.detachContextListener();
    this.buffers.clear();
    this.builtinAssetInitialization = undefined;
    this.resumeAfterContextRecreation = false;
    const context = this.context;
    this.context = undefined;
    if (this.ownsContext && context && context.state !== 'closed') await context.close();
  }

  private async initializeInternal(): Promise<void> {
    let context = this.context;
    if (context?.state === 'closed') {
      if (!this.ownsContext) {
        throw new AudioWorkletEngineError('context-closed', 'The provided AudioContext is closed and cannot be re-entered');
      }
      this.detachNode();
      this.detachContextListener();
      this.context = undefined;
      context = undefined;
    }
    if (!context) {
      context = this.createContext();
      this.context = context;
      this.attachContextListener(context);
    } else if (!this.contextStateListener) {
      this.attachContextListener(context);
    }
    if (this.node && !this.nodeFaulted) return;
    this.detachNode();

    const worklet = context.audioWorklet;
    if (!worklet || typeof worklet.addModule !== 'function') {
      throw new AudioWorkletEngineError('unsupported', 'AudioContext.audioWorklet is unavailable');
    }
    if (!this.loadedContexts.has(context)) {
      try {
        await worklet.addModule(this.options.processorModuleUrl!);
        this.loadedContexts.add(context);
      } catch (error) {
        throw new AudioWorkletEngineError(
          'module-load-failed',
          'The VibeSeq AudioWorklet module could not be loaded',
          { cause: error },
        );
      }
    }

    let node: AudioWorkletNode;
    try {
      const factory = this.options.nodeFactory ?? this.nativeNodeFactory();
      node = factory(context, VIBESEQ_AUDIO_PROCESSOR_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: 'max',
      });
    } catch (error) {
      throw new AudioWorkletEngineError(
        'processor-create-failed',
        'The VibeSeq AudioWorkletProcessor could not be created',
        { cause: error },
      );
    }
    node.port.onmessage = (event: MessageEvent<WorkletEvent>) => this.handleEvent(event.data);
    node.port.start?.();
    node.onprocessorerror = (event) => this.handleProcessorCrash(event);
    node.connect(context.destination);
    this.node = node;
    this.nodeFaulted = false;
    if (this.project) this.post({ type: 'sync-project', project: this.project });
    for (const [assetId, buffer] of this.buffers) this.postAsset(assetId, buffer);
    await this.ensureBuiltinMidiAssets();
  }

  private createContext(): AudioContext {
    if (this.options.contextFactory) return this.options.contextFactory();
    const support = detectAudioWorkletSupport();
    if (!support.supported) {
      throw new AudioWorkletEngineError(support.code!, support.reason!);
    }
    const environment = globalThis as BrowserAudioGlobals;
    const Context = environment.AudioContext ?? environment.webkitAudioContext!;
    return new Context({ latencyHint: 'interactive' });
  }

  private nativeNodeFactory(): AudioWorkletNodeFactory {
    const Node = (globalThis as BrowserAudioGlobals).AudioWorkletNode;
    if (!Node) throw new AudioWorkletEngineError('unsupported', 'AudioWorkletNode is unavailable');
    return (context, name, options) => new Node(context, name, options);
  }

  private async resumeContext(): Promise<void> {
    const context = this.context;
    if (!context) throw new AudioWorkletEngineError('unsupported', 'AudioContext is unavailable');
    if (context.state === 'closed') {
      if (!this.ownsContext) throw new AudioWorkletEngineError('context-closed', 'The provided AudioContext is closed');
      this.detachNode();
      this.context = undefined;
      await this.initialize();
      return this.resumeContext();
    }
    if (context.state !== 'running') {
      try {
        await context.resume();
      } catch (error) {
        throw new AudioWorkletEngineError('context-resume-failed', 'AudioContext resume was rejected', { cause: error });
      }
    }
    if (context.state !== 'running') {
      throw new AudioWorkletEngineError(
        'context-resume-failed',
        `AudioContext remained ${String(context.state)} after resume; a user gesture may be required`,
      );
    }
  }

  private async decodeAudioMedia(media: Blob | ArrayBuffer): Promise<AudioBuffer> {
    await this.initialize();
    const context = this.context;
    if (!context) throw new AudioWorkletEngineError('unsupported', 'AudioContext could not be initialized');
    const bytes = media instanceof Blob ? await media.arrayBuffer() : media;
    return context.decodeAudioData(bytes.slice(0));
  }

  private assertRequiredAssets(): void {
    const required = requiredWorkletAssetIds(this.project!);
    if (this.projectRequiresChaosDrums()) {
      for (const source of BUILTIN_CHAOS_DRUM_ASSETS) required.add(source.id);
    }
    const missing = [...required].filter((assetId) => !this.buffers.has(assetId));
    if (missing.length > 0) {
      throw new AudioWorkletEngineError(
        'asset-missing',
        `Playback requires synchronized PCM for: ${missing.join(', ')}`,
      );
    }
  }

  private projectRequiresChaosDrums(): boolean {
    return this.project?.tracks.some((track) => (
      track.kind === 'midi' && track.midiProfile?.instrumentKind === 'drums'
    )) ?? false;
  }

  private async ensureBuiltinMidiAssets(): Promise<void> {
    if (!this.projectRequiresChaosDrums()) return;
    const missing = BUILTIN_CHAOS_DRUM_ASSETS.filter((source) => !this.buffers.has(source.id));
    if (missing.length === 0) return;
    if (this.builtinAssetInitialization) return this.builtinAssetInitialization;
    const context = this.context;
    if (!context || context.state === 'closed') {
      throw new AudioWorkletEngineError('context-closed', 'Cannot decode built-in MIDI assets without an open AudioContext');
    }
    const loader = this.options.builtinMidiAssetLoader!;
    const operation = (async () => {
      try {
        const decoded = await Promise.all(missing.map(async (source) => ({
          source,
          buffer: await loader(context, source),
        })));
        if (this.disposed) return;
        for (const { source, buffer } of decoded) this.registerAudioBuffer(source.id, buffer);
      } catch (error) {
        throw this.normalizeBuiltinAssetError(error);
      }
    })();
    this.builtinAssetInitialization = operation;
    try {
      await operation;
    } finally {
      if (this.builtinAssetInitialization === operation) this.builtinAssetInitialization = undefined;
    }
  }

  private normalizeBuiltinAssetError(error: unknown): AudioWorkletEngineError {
    if (error instanceof AudioWorkletEngineError) return error;
    return new AudioWorkletEngineError(
      'asset-load-failed',
      `The built-in WebAudioFont Chaos drum samples could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  private postAsset(assetId: string, buffer: AudioBuffer): void {
    if (!this.node) return;
    const channelData = Array.from({ length: buffer.numberOfChannels }, (_, channel) =>
      new Float32Array(buffer.getChannelData(channel)));
    const asset: WorkletAssetPayload = { id: assetId, sampleRate: buffer.sampleRate, channelData };
    this.node.port.postMessage(
      { type: 'sync-asset', asset } satisfies WorkletCommand,
      channelData.map((channel) => channel.buffer),
    );
  }

  private post(command: WorkletCommand): void {
    this.node?.port.postMessage(command);
  }

  private handleEvent(event: WorkletEvent): void {
    if (event.type === 'recording-started') {
      const active = this.inputRecording;
      if (!active || event.sessionId !== active.sessionId) return;
      active.start = event;
      active.resolveStarted(event);
      return;
    }
    if (event.type === 'recording-chunk') {
      const active = this.inputRecording;
      if (!active || event.sessionId !== active.sessionId) return;
      active.chunks.push(event.channelData);
      return;
    }
    if (event.type === 'recording-complete') {
      const active = this.inputRecording;
      if (!active || event.sessionId !== active.sessionId) return;
      try {
        if (!active.start) throw new Error('Recording completed before its start frame was acknowledged');
        active.resolveCompleted(combineRecordingChunks(
          active.start,
          active.chunks,
          event.endFrame,
          event.frameCount,
        ));
        this.releaseInputRecording();
      } catch (error) {
        this.rejectInputRecording(error instanceof Error ? error : new Error(String(error)));
      }
      return;
    }
    if (event.type === 'recording-cancelled') {
      const active = this.inputRecording;
      if (!active || event.sessionId !== active.sessionId) return;
      this.rejectInputRecording(new DOMException('Audio input recording was cancelled', 'AbortError'));
      return;
    }
    if (event.type === 'telemetry') {
      this.positionBeat = event.positionBeat;
      this.telemetryContextTime = this.context?.currentTime ?? 0;
      this.updateState(event.state);
      this.options.onPosition?.(event.positionBeat);
      this.options.onMeter?.({ master: event.masterPeak, tracks: event.trackPeaks });
      return;
    }
    if (event.type === 'state') {
      this.positionBeat = event.positionBeat;
      this.telemetryContextTime = this.context?.currentTime ?? 0;
      this.updateState(event.state);
      this.options.onPosition?.(event.positionBeat);
      return;
    }
    if (event.type === 'ended') {
      this.positionBeat = event.positionBeat;
      this.telemetryContextTime = this.context?.currentTime ?? 0;
      this.updateState('idle');
      this.options.onPosition?.(event.positionBeat);
      this.options.onEnded?.();
      return;
    }
    if (event.type === 'audition-ended') {
      if (event.token !== this.auditionToken) return;
      if (this.activeAudition?.token !== event.token) return;
      const onEnded = this.auditionEnded;
      this.auditionEnded = undefined;
      this.releaseActiveAudition(false);
      onEnded?.();
      return;
    }
    if (event.type === 'midi-audition-ended') return;
    if (event.code === 'recording-command' && this.inputRecording) {
      this.rejectInputRecording(new AudioWorkletEngineError('processor-error', event.message));
    }
    this.reportError(new AudioWorkletEngineError('processor-error', event.message));
  }

  private handleProcessorCrash(event: Event): void {
    this.auditionEpoch += 1;
    this.auditionToken += 1;
    this.auditionEnded = undefined;
    this.activeAudition = undefined;
    if (this.inputRecording) {
      this.rejectInputRecording(new AudioWorkletEngineError(
        'processor-crashed',
        'The AudioWorkletProcessor crashed during input recording',
        { cause: event },
      ));
    }
    this.nodeFaulted = true;
    this.positionBeat = this.getPositionBeat();
    this.telemetryContextTime = this.context?.currentTime ?? 0;
    this.updateState('paused');
    this.reportError(new AudioWorkletEngineError(
      'processor-crashed',
      'The AudioWorkletProcessor crashed and was disconnected; call play again to re-enter explicitly',
      { cause: event },
    ));
  }

  private attachContextListener(context: AudioContext): void {
    this.detachContextListener();
    const listener = () => {
      if (this.disposed || context.state !== 'closed') return;
      this.auditionEpoch += 1;
      this.auditionToken += 1;
      this.auditionEnded = undefined;
      this.activeAudition = undefined;
      this.resumeAfterContextRecreation = this.state === 'playing';
      this.telemetryContextTime = context.currentTime;
      this.detachNode();
      if (this.state === 'playing') this.updateState('paused');
    };
    context.addEventListener('statechange', listener);
    this.contextStateListener = () => context.removeEventListener('statechange', listener);
  }

  private detachContextListener(): void {
    this.contextStateListener?.();
    this.contextStateListener = undefined;
  }

  private detachNode(): void {
    const node = this.node;
    this.node = undefined;
    this.nodeFaulted = false;
    if (!node) return;
    node.onprocessorerror = null;
    node.port.onmessage = null;
    node.port.close();
    node.disconnect();
  }

  private releaseInputRecording(): void {
    const active = this.inputRecording;
    this.inputRecording = undefined;
    if (!active) return;
    try { active.sourceNode.disconnect(); } catch { /* The input node may already be detached. */ }
  }

  private rejectInputRecording(error: Error): void {
    const active = this.inputRecording;
    if (!active) return;
    active.rejectStarted(error);
    active.rejectCompleted(error);
    this.releaseInputRecording();
  }

  private releaseActiveAudition(stopProcessor: boolean): void {
    const active = this.activeAudition;
    this.activeAudition = undefined;
    if (!active) return;
    if (stopProcessor) this.post({ type: 'stop-audition', token: active.token });
    if (active.ephemeral) this.post({ type: 'remove-asset', assetId: active.assetId });
  }

  private updateState(state: PlaybackState): void {
    if (this.state === state) return;
    this.state = state;
    this.options.onStateChange?.(state);
  }

  private reportError(error: AudioWorkletEngineError): void {
    this.options.onError?.(error);
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new AudioWorkletEngineError('disposed', 'The AudioWorklet engine has been disposed');
  }
}

/**
 * Default selection is AudioWorklet. The compatibility backend must be named
 * deliberately by the caller, so a capability or processor failure is never
 * disguised as successful realtime isolation.
 */
export function createPlaybackEngine(
  project?: Project,
  options?: AudioWorkletPlaybackEngineOptions & { backend?: 'audio-worklet' },
): AudioWorkletPlaybackEngine;
export function createPlaybackEngine(
  project: Project | undefined,
  options: AudioWorkletPlaybackEngineOptions & { backend: 'web-audio-compatibility' },
): WebAudioPlaybackEngine;
export function createPlaybackEngine(
  project?: Project,
  options: CreatePlaybackEngineOptions = {},
): AudioWorkletPlaybackEngine | WebAudioPlaybackEngine {
  if ((options.backend ?? 'audio-worklet') === 'web-audio-compatibility') {
    const compatibilityOptions: WebAudioPlaybackEngineOptions = {
      context: options.context,
      onPosition: options.onPosition,
      onStateChange: options.onStateChange,
      onEnded: options.onEnded,
      onMeter: options.onMeter,
    };
    return new WebAudioPlaybackEngine(project, compatibilityOptions);
  }
  return new AudioWorkletPlaybackEngine(project, options);
}
