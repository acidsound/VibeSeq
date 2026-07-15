import type { AudioClip, MidiClip, MidiPlaybackInstrumentId, MidiTrack, Project, Track } from '../../types';
import { getArrangedMidiNotes, getClipSourceSlices } from '../clip';
import { getMidiTrackPlaybackProfile } from '../midi/instrument';
import { beatsToSeconds, getProjectEndBeat, secondsToBeats } from '../time';
import {
  linearEdgeEnvelopePoints,
  type LinearEnvelopePoint,
  MIDI_SYNTH_GAIN,
  midiPeriodicWaveCoefficients,
  midiPitchFrequency,
  midiSynthEnvelopePoints,
} from './midiSynth';
import {
  audioSourceBeatToSeconds,
  getAudioClipPlaybackRate,
} from './timebase';

export interface PlannedEventBase {
  trackId: string;
  clipId: string;
  whenSeconds: number;
  durationSeconds: number;
  gain: number;
  pan: number;
}

export interface PlannedAudioEvent extends PlannedEventBase {
  kind: 'audio';
  assetId: string;
  offsetSeconds: number;
  /** Source-media seconds consumed before playback-rate scaling. */
  sourceDurationSeconds: number;
  /** Honest varispeed rate. Values other than 1 also repitch the source. */
  playbackRate: number;
  gainEnvelope: Array<{ atSeconds: number; gain: number }>;
}

export interface PlannedMidiEvent extends PlannedEventBase {
  kind: 'midi';
  noteId: string;
  pitch: number;
  velocity: number;
  /** Zero-based wire channel. Drum events are always channel 9 (displayed as 10). */
  midiChannel: number;
  instrumentKind: 'drums' | 'melodic';
  instrumentId: MidiPlaybackInstrumentId;
  /** Zero-based General MIDI program; absent for channel-10 drums. */
  midiProgram?: number;
  /** Elapsed time since the original note onset when this event begins. */
  noteOffsetSeconds: number;
  /** Full authored note duration, even when playback starts in the middle. */
  noteDurationSeconds: number;
  /** Final master/track/clip/velocity voice gain with the synth envelope applied. */
  voiceGainEnvelope: LinearEnvelopePoint[];
  /** Clip edge-fade factor, kept separate so its product with the voice envelope stays exact. */
  clipGainEnvelope: LinearEnvelopePoint[];
}

export type PlannedPlaybackEvent = PlannedAudioEvent | PlannedMidiEvent;

export interface PlaybackPlan {
  fromBeat: number;
  toBeat: number;
  durationSeconds: number;
  events: PlannedPlaybackEvent[];
}

export interface BuildPlaybackPlanOptions {
  fromBeat?: number;
  toBeat?: number;
  includeMuted?: boolean;
}

const isAudible = (track: Track, tracks: readonly Track[], includeMuted: boolean): boolean => {
  if (includeMuted) return true;
  if (track.mute) return false;
  const anySolo = tracks.some((candidate) => candidate.solo && !candidate.mute);
  return !anySolo || track.solo;
};

const fadeFactor = (position: number, duration: number, fadeIn: number, fadeOut: number): number => {
  const inFactor = fadeIn > 0 ? Math.min(1, Math.max(0, position / fadeIn)) : 1;
  const remaining = duration - position;
  const outFactor = fadeOut > 0 ? Math.min(1, Math.max(0, remaining / fadeOut)) : 1;
  return Math.min(inFactor, outFactor);
};

const envelopeValueAt = (
  points: readonly LinearEnvelopePoint[],
  atSeconds: number,
  fallback: number,
): number => {
  if (points.length === 0) return fallback;
  if (atSeconds <= points[0].atSeconds) return points[0].gain;
  for (let index = 1; index < points.length; index += 1) {
    const next = points[index];
    if (atSeconds > next.atSeconds) continue;
    const previous = points[index - 1];
    const span = next.atSeconds - previous.atSeconds;
    if (span <= 0) return next.gain;
    const progress = (atSeconds - previous.atSeconds) / span;
    return previous.gain + (next.gain - previous.gain) * progress;
  }
  return points.at(-1)?.gain ?? fallback;
};

const cropEnvelope = (
  points: readonly LinearEnvelopePoint[],
  elapsedSeconds: number,
  fallback: number,
): LinearEnvelopePoint[] => [
  { atSeconds: 0, gain: envelopeValueAt(points, elapsedSeconds, fallback) },
  ...points
    .filter((point) => point.atSeconds > elapsedSeconds + 1e-9)
    .map((point) => ({ atSeconds: point.atSeconds - elapsedSeconds, gain: point.gain })),
];

const planAudioClip = (
  project: Project,
  track: Track,
  clip: AudioClip,
  fromBeat: number,
  toBeat: number,
): PlannedAudioEvent[] => {
  if (clip.muted) return [];
  const asset = project.assets.find((candidate) => candidate.id === clip.assetId);
  if (!asset || asset.integrity?.state === 'missing' || asset.integrity?.state === 'corrupt') return [];
  const clipEnd = clip.startBeat + clip.durationBeats;
  const eventStart = Math.max(fromBeat, clip.startBeat);
  const eventEnd = Math.min(toBeat, clipEnd);
  if (eventEnd <= eventStart) return [];
  const fadeInBeats = secondsToBeats(clip.fadeIn, project.bpm);
  const fadeOutBeats = secondsToBeats(clip.fadeOut, project.bpm);
  const peakGain = project.masterGain * track.gain * clip.gain;
  const playbackRate = getAudioClipPlaybackRate(clip, project.bpm);
  return getClipSourceSlices(
    clip,
    eventStart - clip.startBeat,
    eventEnd - clip.startBeat,
  ).map((slice) => {
    const startPosition = slice.placementStartBeat;
    const endPosition = startPosition + slice.durationBeats;
    const envelopePositions = [startPosition, endPosition];
    if (fadeInBeats > startPosition && fadeInBeats < endPosition) envelopePositions.push(fadeInBeats);
    const fadeOutPositionAbsolute = clip.durationBeats - fadeOutBeats;
    if (fadeOutPositionAbsolute > startPosition && fadeOutPositionAbsolute < endPosition) {
      envelopePositions.push(fadeOutPositionAbsolute);
    }
    if (fadeInBeats + fadeOutBeats > clip.durationBeats && fadeInBeats > 0 && fadeOutBeats > 0) {
      const intersection = (clip.durationBeats * fadeInBeats) / (fadeInBeats + fadeOutBeats);
      if (intersection > startPosition && intersection < endPosition) envelopePositions.push(intersection);
    }
    // Placement fades are outer-edge envelopes. They are intentionally not
    // retriggered at internal source-loop boundaries.
    const gainEnvelope = [...new Set(envelopePositions)]
      .sort((a, b) => a - b)
      .map((position) => ({
        atSeconds: beatsToSeconds(position - startPosition, project.bpm),
        gain: peakGain * fadeFactor(beatsToSeconds(position, project.bpm), beatsToSeconds(clip.durationBeats, project.bpm), clip.fadeIn, clip.fadeOut),
      }));
    return {
      kind: 'audio' as const,
      trackId: track.id,
      clipId: clip.id,
      assetId: clip.assetId,
      whenSeconds: beatsToSeconds(clip.startBeat + startPosition - fromBeat, project.bpm),
      durationSeconds: beatsToSeconds(slice.durationBeats, project.bpm),
      offsetSeconds: audioSourceBeatToSeconds(clip, slice.sourceStartBeat),
      sourceDurationSeconds: audioSourceBeatToSeconds(clip, slice.durationBeats),
      playbackRate,
      gain: peakGain,
      gainEnvelope,
      pan: Math.max(-1, Math.min(1, track.pan)),
    };
  });
};

const planMidiClip = (
  project: Project,
  track: MidiTrack,
  clip: MidiClip,
  fromBeat: number,
  toBeat: number,
): PlannedMidiEvent[] => {
  if (clip.muted) return [];
  const events: PlannedMidiEvent[] = [];
  const playbackProfile = getMidiTrackPlaybackProfile(track);
  for (const instance of getArrangedMidiNotes(clip, fromBeat, toBeat)) {
    const { note } = instance;
    const durationSeconds = beatsToSeconds(instance.durationBeats, project.bpm);
    const noteOffsetSeconds = beatsToSeconds(instance.noteOffsetBeats, project.bpm);
    const noteDurationSeconds = beatsToSeconds(note.durationBeats, project.bpm);
    const clipOffsetSeconds = beatsToSeconds(instance.startBeat - clip.startBeat, project.bpm);
    const clipDurationSeconds = beatsToSeconds(clip.durationBeats, project.bpm);
    const gain = project.masterGain * track.gain * clip.gain;
    const velocity = Math.max(0, Math.min(1, note.velocity));
    const voiceBaseGain = gain * velocity * MIDI_SYNTH_GAIN;
    events.push({
      kind: 'midi',
      trackId: track.id,
      clipId: clip.id,
      noteId: note.id,
      pitch: Math.max(0, Math.min(127, Math.round(note.pitch))),
      velocity,
      midiChannel: playbackProfile.channel,
      instrumentKind: playbackProfile.instrumentKind,
      instrumentId: playbackProfile.instrumentId,
      midiProgram: playbackProfile.program,
      whenSeconds: beatsToSeconds(instance.startBeat - fromBeat, project.bpm),
      durationSeconds,
      noteOffsetSeconds,
      noteDurationSeconds,
      voiceGainEnvelope: midiSynthEnvelopePoints(noteOffsetSeconds, durationSeconds, noteDurationSeconds)
        .map((point) => ({ ...point, gain: point.gain * voiceBaseGain })),
      clipGainEnvelope: linearEdgeEnvelopePoints(
        clipOffsetSeconds,
        durationSeconds,
        clipDurationSeconds,
        clip.fadeIn,
        clip.fadeOut,
      ),
      gain,
      pan: Math.max(-1, Math.min(1, track.pan)),
    });
  }
  return events;
};

export function buildPlaybackPlan(project: Project, options: BuildPlaybackPlanOptions = {}): PlaybackPlan {
  const fromBeat = Math.max(0, options.fromBeat ?? 0);
  const projectEnd = getProjectEndBeat(project.tracks);
  const toBeat = Math.max(fromBeat, options.toBeat ?? projectEnd);
  const events: PlannedPlaybackEvent[] = [];
  for (const track of project.tracks) {
    if (!isAudible(track, project.tracks, options.includeMuted ?? false)) continue;
    for (const clip of track.clips) {
      if (clip.kind === 'audio') {
        events.push(...planAudioClip(project, track, clip, fromBeat, toBeat));
      } else if (track.kind === 'midi') {
        events.push(...planMidiClip(project, track, clip, fromBeat, toBeat));
      }
    }
  }
  events.sort((a, b) => a.whenSeconds - b.whenSeconds || a.trackId.localeCompare(b.trackId));
  return {
    fromBeat,
    toBeat,
    durationSeconds: beatsToSeconds(toBeat - fromBeat, project.bpm),
    events,
  };
}

export type PlaybackState = 'idle' | 'playing' | 'paused';

export interface PlaybackOptions {
  fromBeat?: number;
  toBeat?: number;
  loop?: boolean;
}

export interface WebAudioPlaybackEngineOptions {
  context?: AudioContext;
  scheduleAheadSeconds?: number;
  startLatencySeconds?: number;
  onPosition?: (beat: number) => void;
  onStateChange?: (state: PlaybackState) => void;
  onEnded?: () => void;
  onMeter?: (snapshot: PlaybackMeterSnapshot) => void;
}

export interface PlaybackMeterSnapshot {
  master: number;
  tracks: Record<string, number>;
}

export class WebAudioPlaybackEngine {
  private project?: Project;
  private context?: AudioContext;
  private readonly ownsContext: boolean;
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly sources = new Set<AudioScheduledSourceNode>();
  private auditionSource?: AudioBufferSourceNode;
  private auditionMeter?: ReturnType<typeof setInterval>;
  private masterInput?: GainNode;
  private masterAnalyser?: AnalyserNode;
  private readonly trackBuses = new Map<string, { input: GainNode; analyser: AnalyserNode }>();
  private readonly meterData = new Float32Array(512);
  private scheduler?: ReturnType<typeof setInterval>;
  private state: PlaybackState = 'idle';
  private positionBeat = 0;
  private startedAt = 0;
  private activePlan?: PlaybackPlan;
  private loopPlan?: PlaybackPlan;
  private activeEventCursor = 0;
  private loopEventCursor = 0;
  private loopEnabled = false;
  private nextLoopStart = 0;
  private readonly options: Required<Pick<WebAudioPlaybackEngineOptions, 'scheduleAheadSeconds' | 'startLatencySeconds'>> &
    Omit<WebAudioPlaybackEngineOptions, 'scheduleAheadSeconds' | 'startLatencySeconds' | 'context'>;

  constructor(project?: Project, options: WebAudioPlaybackEngineOptions = {}) {
    this.project = project;
    this.context = options.context;
    this.ownsContext = !options.context;
    this.options = {
      scheduleAheadSeconds: options.scheduleAheadSeconds ?? 0.2,
      startLatencySeconds: options.startLatencySeconds ?? 0.035,
      onPosition: options.onPosition,
      onStateChange: options.onStateChange,
      onEnded: options.onEnded,
      onMeter: options.onMeter,
    };
  }

  setProject(project: Project): void {
    const restartBeat = this.state === 'playing' ? this.getPositionBeat() : undefined;
    this.project = project;
    this.positionBeat = Math.min(this.positionBeat, getProjectEndBeat(project.tracks));
    if (restartBeat !== undefined) void this.play({ fromBeat: restartBeat, loop: this.loopEnabled });
  }

  getState(): PlaybackState {
    return this.state;
  }

  getPositionBeat(): number {
    if (this.state !== 'playing' || !this.context || !this.activePlan) return this.positionBeat;
    const elapsed = Math.max(0, this.context.currentTime - this.startedAt);
    if (this.loopEnabled && this.loopPlan && elapsed >= this.activePlan.durationSeconds) {
      const loopElapsed = (elapsed - this.activePlan.durationSeconds) % this.loopPlan.durationSeconds;
      return this.loopPlan.fromBeat + secondsToBeats(loopElapsed, this.project?.bpm ?? 120);
    }
    const positionSeconds = Math.min(elapsed, this.activePlan.durationSeconds);
    return this.activePlan.fromBeat + secondsToBeats(positionSeconds, this.project?.bpm ?? 120);
  }

  seek(beat: number): void {
    const wasPlaying = this.state === 'playing';
    if (wasPlaying) this.pause();
    this.positionBeat = Math.max(0, beat);
    this.options.onPosition?.(this.positionBeat);
    this.emitMeter(true);
    if (wasPlaying) void this.play({ fromBeat: this.positionBeat, loop: this.loopEnabled });
  }

  registerAudioBuffer(assetId: string, buffer: AudioBuffer): void {
    this.buffers.set(assetId, buffer);
  }

  unregisterAudioBuffer(assetId: string): void {
    this.buffers.delete(assetId);
  }

  async decodeAndRegister(assetId: string, media: Blob | ArrayBuffer): Promise<AudioBuffer> {
    const context = this.ensureContext();
    const bytes = media instanceof Blob ? await media.arrayBuffer() : media;
    const buffer = await context.decodeAudioData(bytes.slice(0));
    this.registerAudioBuffer(assetId, buffer);
    return buffer;
  }

  async audition(
    assetId: string,
    media?: Blob | ArrayBuffer,
    onEnded?: () => void,
  ): Promise<void> {
    const context = this.ensureContext();
    if (context.state === 'suspended') await context.resume();
    if (media) await this.decodeAndRegister(assetId, media);
    const buffer = this.buffers.get(assetId);
    if (!buffer) throw new Error('Audition media has not been decoded');
    this.stopAudition();
    const source = context.createBufferSource();
    const gain = context.createGain();
    const startAt = context.currentTime + 0.015;
    const endAt = startAt + buffer.duration;
    source.buffer = buffer;
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(0.86, startAt + 0.012);
    gain.gain.setValueAtTime(0.86, Math.max(startAt + 0.012, endAt - 0.025));
    gain.gain.exponentialRampToValueAtTime(0.0001, endAt);
    source.connect(gain).connect(this.masterInput!);
    source.addEventListener('ended', () => {
      if (this.auditionSource !== source) return;
      this.auditionSource = undefined;
      this.clearAuditionMeter();
      if (this.state !== 'playing') this.emitMeter(true);
      onEnded?.();
    }, { once: true });
    this.auditionSource = source;
    this.auditionMeter = setInterval(() => this.emitMeter(), 30);
    source.start(startAt);
  }

  stopAudition(): void {
    const source = this.auditionSource;
    this.auditionSource = undefined;
    if (source) {
      try { source.stop(); } catch { /* It may have ended between frames. */ }
      source.disconnect();
    }
    this.clearAuditionMeter();
    if (this.state !== 'playing') this.emitMeter(true);
  }

  async play(options: PlaybackOptions = {}): Promise<void> {
    if (!this.project) throw new Error('A project must be set before playback');
    const context = this.ensureContext();
    if (context.state === 'suspended') await context.resume();
    this.stopSources();
    this.clearScheduler();
    const loop = options.loop ?? this.project.loop.enabled;
    let fromBeat = Math.max(0, options.fromBeat ?? this.positionBeat);
    let toBeat = options.toBeat ?? getProjectEndBeat(this.project.tracks);
    if (loop) {
      const loopStart = this.project.loop.startBeat;
      const loopEnd = this.project.loop.endBeat;
      if (loopEnd <= loopStart) throw new Error('Loop end must be later than loop start');
      if (fromBeat < loopStart || fromBeat >= loopEnd) fromBeat = loopStart;
      toBeat = loopEnd;
    }
    if (toBeat <= fromBeat) return;
    const plan = buildPlaybackPlan(this.project, { fromBeat, toBeat });
    const startAt = context.currentTime + this.options.startLatencySeconds;
    this.activePlan = plan;
    this.loopEnabled = loop;
    this.loopPlan = loop
      ? buildPlaybackPlan(this.project, {
          fromBeat: this.project.loop.startBeat,
          toBeat: this.project.loop.endBeat,
        })
      : undefined;
    this.positionBeat = fromBeat;
    this.startedAt = startAt;
    this.nextLoopStart = startAt + plan.durationSeconds;
    this.activeEventCursor = 0;
    this.loopEventCursor = 0;
    this.scheduleThrough(startAt + this.options.scheduleAheadSeconds);
    this.setState('playing');
    this.scheduler = setInterval(() => this.tick(), 30);
  }

  pause(): void {
    if (this.state !== 'playing') return;
    this.positionBeat = this.getPositionBeat();
    this.stopSources();
    this.clearScheduler();
    this.setState('paused');
    this.options.onPosition?.(this.positionBeat);
    this.emitMeter(true);
  }

  stop(resetToBeat = 0): void {
    this.stopSources();
    this.clearScheduler();
    this.activePlan = undefined;
    this.loopPlan = undefined;
    this.activeEventCursor = 0;
    this.loopEventCursor = 0;
    this.positionBeat = Math.max(0, resetToBeat);
    this.setState('idle');
    this.options.onPosition?.(this.positionBeat);
    this.emitMeter(true);
  }

  async dispose(): Promise<void> {
    this.stopAudition();
    this.stop();
    this.buffers.clear();
    for (const bus of this.trackBuses.values()) {
      bus.input.disconnect();
      bus.analyser.disconnect();
    }
    this.trackBuses.clear();
    this.masterInput?.disconnect();
    this.masterAnalyser?.disconnect();
    this.masterInput = undefined;
    this.masterAnalyser = undefined;
    if (this.ownsContext && this.context && this.context.state !== 'closed') await this.context.close();
    this.context = undefined;
  }

  private ensureContext(): AudioContext {
    if (this.context) {
      this.ensureRouting(this.context);
      return this.context;
    }
    const constructors = globalThis as typeof globalThis & {
      AudioContext?: typeof AudioContext;
      webkitAudioContext?: typeof AudioContext;
    };
    const Context = constructors.AudioContext ?? constructors.webkitAudioContext;
    if (!Context) throw new Error('Web Audio is not available in this environment');
    this.context = new Context();
    this.ensureRouting(this.context);
    return this.context;
  }

  private ensureRouting(context: AudioContext): void {
    if (this.masterInput && this.masterAnalyser) return;
    const input = context.createGain();
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.72;
    input.connect(analyser).connect(context.destination);
    this.masterInput = input;
    this.masterAnalyser = analyser;
  }

  private trackBus(trackId: string): GainNode {
    const existing = this.trackBuses.get(trackId);
    if (existing) return existing.input;
    const context = this.ensureContext();
    const input = context.createGain();
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.68;
    input.connect(analyser).connect(this.masterInput!);
    this.trackBuses.set(trackId, { input, analyser });
    return input;
  }

  private analyserPeak(analyser: AnalyserNode): number {
    analyser.getFloatTimeDomainData(this.meterData);
    let peak = 0;
    for (const sample of this.meterData) peak = Math.max(peak, Math.abs(sample));
    return Math.min(1, peak);
  }

  private emitMeter(reset = false): void {
    if (!this.options.onMeter) return;
    const tracks: Record<string, number> = {};
    for (const [trackId, bus] of this.trackBuses) tracks[trackId] = reset ? 0 : this.analyserPeak(bus.analyser);
    this.options.onMeter({ master: reset || !this.masterAnalyser ? 0 : this.analyserPeak(this.masterAnalyser), tracks });
  }

  private clearAuditionMeter(): void {
    if (this.auditionMeter !== undefined) clearInterval(this.auditionMeter);
    this.auditionMeter = undefined;
  }

  private tick(): void {
    if (!this.context || !this.activePlan || this.state !== 'playing') return;
    const currentTime = this.context.currentTime;
    this.scheduleThrough(currentTime + this.options.scheduleAheadSeconds);
    if (!this.loopEnabled && currentTime >= this.startedAt + this.activePlan.durationSeconds) {
      this.positionBeat = this.activePlan.toBeat;
      this.stopSources();
      this.clearScheduler();
      this.setState('idle');
      this.options.onPosition?.(this.positionBeat);
      this.emitMeter(true);
      this.options.onEnded?.();
      return;
    }
    this.options.onPosition?.(this.getPositionBeat());
    this.emitMeter();
  }

  private schedulePlanWindow(
    plan: PlaybackPlan,
    cycleStart: number,
    cursor: number,
    horizon: number,
  ): number {
    let nextCursor = cursor;
    while (nextCursor < plan.events.length) {
      const event = plan.events[nextCursor];
      if (cycleStart + event.whenSeconds > horizon) break;
      const eventStart = cycleStart + event.whenSeconds;
      const lateBy = Math.max(0, (this.context?.currentTime ?? eventStart) - eventStart);
      if (lateBy < event.durationSeconds - 1e-9) {
        if (event.kind === 'audio') this.scheduleAudio(event, cycleStart, lateBy);
        else this.scheduleMidi(event, cycleStart, lateBy);
      }
      nextCursor += 1;
    }
    return nextCursor;
  }

  /**
   * Keep scheduled WebAudio nodes inside a bounded horizon. The PlaybackPlan is
   * still a deterministic snapshot, but a long project no longer creates every
   * oscillator/source node during the Play gesture.
   */
  private scheduleThrough(horizon: number): void {
    const activePlan = this.activePlan;
    if (!activePlan) return;
    this.activeEventCursor = this.schedulePlanWindow(
      activePlan,
      this.startedAt,
      this.activeEventCursor,
      horizon,
    );
    if (!this.loopEnabled || !this.loopPlan) return;

    const loopPlan = this.loopPlan;
    if (loopPlan.events.length === 0) {
      if (this.nextLoopStart <= horizon) {
        const elapsedCycles = Math.floor((horizon - this.nextLoopStart) / loopPlan.durationSeconds) + 1;
        this.nextLoopStart += elapsedCycles * loopPlan.durationSeconds;
      }
      return;
    }
    while (this.nextLoopStart <= horizon) {
      this.loopEventCursor = this.schedulePlanWindow(
        loopPlan,
        this.nextLoopStart,
        this.loopEventCursor,
        horizon,
      );
      if (this.loopEventCursor < loopPlan.events.length) break;
      this.loopEventCursor = 0;
      this.nextLoopStart += loopPlan.durationSeconds;
    }
  }

  private scheduleAudio(event: PlannedAudioEvent, cycleStart: number, lateBy = 0): void {
    const context = this.context;
    const buffer = this.buffers.get(event.assetId);
    if (!context || !buffer) return;
    const source = context.createBufferSource();
    const gain = context.createGain();
    const panner = context.createStereoPanner();
    const when = Math.max(cycleStart + event.whenSeconds, context.currentTime);
    source.buffer = buffer;
    source.playbackRate.setValueAtTime(event.playbackRate, when);
    panner.pan.setValueAtTime(event.pan, when);
    this.scheduleLinearEnvelope(gain.gain, cropEnvelope(event.gainEnvelope, lateBy, event.gain), when, event.gain);
    source.connect(gain).connect(panner).connect(this.trackBus(event.trackId));
    const offset = event.offsetSeconds + lateBy * event.playbackRate;
    const availableSourceSeconds = Math.min(
      Math.max(0, buffer.duration - offset),
      Math.max(0, event.sourceDurationSeconds - lateBy * event.playbackRate),
    );
    const remainingOutputSeconds = Math.max(0, event.durationSeconds - lateBy);
    const outputDuration = Math.min(
      remainingOutputSeconds,
      availableSourceSeconds / event.playbackRate,
    );
    if (outputDuration > 0) {
      this.trackSource(source);
      source.start(when, offset, outputDuration * event.playbackRate);
    } else {
      source.disconnect();
    }
  }

  private scheduleMidi(event: PlannedMidiEvent, cycleStart: number, lateBy = 0): void {
    const context = this.context;
    if (!context) return;
    const oscillator = context.createOscillator();
    const voiceGain = context.createGain();
    const clipGain = context.createGain();
    const panner = context.createStereoPanner();
    const when = Math.max(cycleStart + event.whenSeconds, context.currentTime);
    const remainingDuration = event.durationSeconds - lateBy;
    const noteEnd = when + remainingDuration;
    const frequency = midiPitchFrequency(event.pitch);
    const phaseRadians = 2 * Math.PI * frequency * (event.noteOffsetSeconds + lateBy);
    const coefficients = midiPeriodicWaveCoefficients(phaseRadians, frequency, context.sampleRate);
    oscillator.setPeriodicWave(context.createPeriodicWave(coefficients.real, coefficients.imag, {
      disableNormalization: true,
    }));
    oscillator.frequency.setValueAtTime(frequency, when);
    panner.pan.setValueAtTime(event.pan, when);
    this.scheduleLinearEnvelope(
      voiceGain.gain,
      cropEnvelope(event.voiceGainEnvelope, lateBy, 0),
      when,
      0,
    );
    this.scheduleLinearEnvelope(
      clipGain.gain,
      cropEnvelope(event.clipGainEnvelope, lateBy, 1),
      when,
      1,
    );
    oscillator.connect(voiceGain).connect(clipGain).connect(panner).connect(this.trackBus(event.trackId));
    this.trackSource(oscillator);
    oscillator.start(when);
    oscillator.stop(noteEnd);
  }

  private scheduleLinearEnvelope(
    parameter: AudioParam,
    points: readonly LinearEnvelopePoint[],
    when: number,
    fallback: number,
  ): void {
    parameter.cancelScheduledValues(when);
    const [firstPoint, ...remainingPoints] = points;
    parameter.setValueAtTime(Math.max(0, firstPoint?.gain ?? fallback), when);
    for (const point of remainingPoints) {
      parameter.linearRampToValueAtTime(Math.max(0, point.gain), when + point.atSeconds);
    }
  }

  private trackSource(source: AudioScheduledSourceNode): void {
    this.sources.add(source);
    source.addEventListener('ended', () => this.sources.delete(source), { once: true });
  }

  private stopSources(): void {
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // It may already have ended between scheduler ticks.
      }
      source.disconnect();
    }
    this.sources.clear();
  }

  private clearScheduler(): void {
    if (this.scheduler !== undefined) clearInterval(this.scheduler);
    this.scheduler = undefined;
  }

  private setState(state: PlaybackState): void {
    if (this.state === state) return;
    this.state = state;
    this.options.onStateChange?.(state);
  }
}
