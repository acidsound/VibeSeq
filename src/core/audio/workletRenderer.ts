import type {
  WorkletAssetPayload,
  WorkletAudioClip,
  WorkletCommand,
  WorkletEvent,
  WorkletMidiAudition,
  WorkletPlaybackState,
  WorkletProjectSnapshot,
  WorkletTrackSnapshot,
} from './workletProtocol';
import {
  MAX_MIDI_AUDITION_SECONDS,
  MIN_MIDI_AUDITION_SECONDS,
} from './workletProtocol';
import {
  getChaosDrumVoice,
  tinySynthNoiseSeed,
  tinySynthReleaseTailSeconds,
  tinySynthSampleAtTime,
  WEBAUDIOFONT_CHAOS_DRUM_GAIN,
} from './midiInstrumentRender';

const PARAMETER_SMOOTHING_SECONDS = 0.005;
const TRACK_GATE_RAMP_SECONDS = 0.005;
// Chaos assets are synchronized after the project snapshot. The pinned compact
// kit is shorter than this conservative scan window; melodic tails use their
// exact shared TinySynth envelope boundary instead of this fallback.
const MAX_UNSYNCED_DRUM_TAIL_SECONDS = 4;
const TELEMETRY_HZ = 30;
const EPSILON = 1e-9;
const MIDI_AUDITION_ATTACK_SECONDS = 0.008;
const MIDI_AUDITION_RELEASE_SECONDS = 0.035;

interface SmoothedParameter {
  current: number;
  target: number;
}

interface TrackGateEnvelope extends SmoothedParameter {
  step: number;
  remainingFrames: number;
}

interface RenderTrack extends WorkletTrackSnapshot {
  gainState: SmoothedParameter;
  panState: SmoothedParameter;
  gateState: TrackGateEnvelope;
  maxMidiDurationBeats: number;
  peak: number;
}

interface RenderProject extends Omit<WorkletProjectSnapshot, 'tracks'> {
  tracks: RenderTrack[];
  masterGainState: SmoothedParameter;
}

interface AuditionState {
  assetId: string;
  token: number;
  elapsedSeconds: number;
}

interface MidiAuditionState extends WorkletMidiAudition {
  elapsedSeconds: number;
  noiseSeed: number;
  releaseAtSeconds?: number;
  releaseLevel?: number;
  lastTrackGain: number;
  lastTrackPan: number;
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.max(minimum, Math.min(maximum, value));

const positiveModulo = (value: number, modulus: number): number => {
  const result = value % modulus;
  return result < 0 ? result + modulus : result;
};

const secondsAtBeats = (beats: number, bpm: number): number => (beats * 60) / bpm;

const linearEdgeEnvelope = (
  positionSeconds: number,
  durationSeconds: number,
  fadeInSeconds: number,
  fadeOutSeconds: number,
): number => {
  const position = clamp(positionSeconds, 0, Math.max(0, durationSeconds));
  const inFactor = fadeInSeconds > 0 ? clamp(position / fadeInSeconds, 0, 1) : 1;
  const remaining = durationSeconds - position;
  const outFactor = fadeOutSeconds > 0 ? clamp(remaining / fadeOutSeconds, 0, 1) : 1;
  return Math.min(inFactor, outFactor);
};

const sampleLinear = (channel: Float32Array, position: number): number => {
  if (position < 0 || position >= channel.length) return 0;
  const lower = Math.floor(position);
  const upper = Math.min(channel.length - 1, lower + 1);
  const fraction = position - lower;
  const sample = channel[lower] * (1 - fraction) + channel[upper] * fraction;
  return Number.isFinite(sample) ? sample : 0;
};

const sampleAssetMono = (asset: WorkletAssetPayload, position: number): number => {
  if (asset.channelData.length === 1) return sampleLinear(asset.channelData[0], position);
  return (sampleLinear(asset.channelData[0], position) + sampleLinear(asset.channelData[1], position)) * 0.5;
};

const upperBoundStart = <T extends { startBeat: number }>(values: readonly T[], beat: number): number => {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle].startBeat <= beat + EPSILON) low = middle + 1;
    else high = middle;
  }
  return low;
};

const sourceBeatAtPosition = (clip: WorkletAudioClip, positionBeat: number): number => {
  if (!clip.sourceLoop) return clip.offsetBeats + positionBeat;
  return clip.sourceLoop.cycleStartBeat + positiveModulo(
    clip.sourceLoop.phaseBeats + positionBeat,
    clip.sourceLoop.cycleLengthBeats,
  );
};

const monoPan = (sample: number, pan: number): [number, number] => {
  const angle = ((clamp(pan, -1, 1) + 1) * Math.PI) / 4;
  return [sample * Math.cos(angle), sample * Math.sin(angle)];
};

const stereoPan = (left: number, right: number, pan: number): [number, number] => {
  const normalized = clamp(pan, -1, 1);
  if (normalized === 0) return [left, right];
  const x = normalized <= 0 ? normalized + 1 : normalized;
  const gainLeft = Math.cos(x * Math.PI / 2);
  const gainRight = Math.sin(x * Math.PI / 2);
  return normalized <= 0
    ? [left + right * gainLeft, right * gainRight]
    : [left * gainLeft, left * gainRight + right];
};

const validFinite = (value: unknown, minimum = Number.NEGATIVE_INFINITY): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= minimum;

const smoothStep = (value: number): number => {
  const normalized = clamp(value, 0, 1);
  return normalized * normalized * (3 - 2 * normalized);
};

const midiAuditionEnvelope = (elapsedSeconds: number, durationSeconds: number): number => {
  if (elapsedSeconds < 0 || elapsedSeconds >= durationSeconds) return 0;
  const attack = Math.min(MIDI_AUDITION_ATTACK_SECONDS, durationSeconds * 0.25);
  const release = Math.min(MIDI_AUDITION_RELEASE_SECONDS, durationSeconds * 0.4);
  const attackGain = attack > 0 ? smoothStep(elapsedSeconds / attack) : 1;
  const releaseGain = release > 0
    ? smoothStep((durationSeconds - elapsedSeconds) / release)
    : 1;
  return Math.min(attackGain, releaseGain);
};

/**
 * Pure realtime render kernel. The AudioWorklet wrapper is deliberately thin,
 * so sample-domain behavior can be regression-tested without emulating a browser
 * audio device.
 */
export class VibeSeqWorkletRenderer {
  private project?: RenderProject;
  private readonly assets = new Map<string, WorkletAssetPayload>();
  private state: WorkletPlaybackState = 'idle';
  private positionBeat = 0;
  private transportEndBeat = 0;
  private loopEnabled = false;
  private audition?: AuditionState;
  private midiAuditions: MidiAuditionState[] = [];
  private disposed = false;
  private telemetryFrames = 0;
  private masterPeak = 0;
  private readonly reportedMissingAssets = new Set<string>();
  private reportedRenderError = false;
  private readonly smoothingCoefficient: number;
  private readonly trackGateRampFrames: number;

  constructor(
    readonly sampleRate: number,
    private readonly emit: (event: WorkletEvent) => void = () => undefined,
  ) {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new RangeError('AudioWorklet sample rate must be positive');
    this.smoothingCoefficient = 1 - Math.exp(-1 / (sampleRate * PARAMETER_SMOOTHING_SECONDS));
    this.trackGateRampFrames = Math.max(1, Math.round(sampleRate * TRACK_GATE_RAMP_SECONDS));
  }

  getState(): WorkletPlaybackState { return this.state; }
  getPositionBeat(): number { return this.positionBeat; }

  handleCommand(command: WorkletCommand): void {
    try {
      switch (command.type) {
        case 'sync-project': this.syncProject(command.project); break;
        case 'sync-asset': this.syncAsset(command.asset); break;
        case 'remove-asset': this.removeAsset(command.assetId); break;
        case 'play': this.play(command.fromBeat, command.toBeat, command.loop); break;
        case 'pause':
          if (this.state === 'playing') this.setState('paused');
          break;
        case 'stop':
          this.positionBeat = Math.max(0, command.positionBeat);
          this.setState('idle');
          break;
        case 'seek':
          this.positionBeat = Math.max(0, command.positionBeat);
          this.emitState();
          break;
        case 'set-loop': this.setLoop(command.enabled, command.startBeat, command.endBeat); break;
        case 'set-master-gain': this.setMasterGain(command.gain); break;
        case 'set-track-parameters': this.setTrackParameters(command.trackId, command.parameters); break;
        case 'audition': this.startAudition(command.assetId, command.token); break;
        case 'stop-audition':
          if (command.token === undefined || command.token === this.audition?.token) this.audition = undefined;
          break;
        case 'audition-midi-note': this.startMidiAudition(command.audition); break;
        case 'stop-midi-note-audition': this.releaseMidiAuditions(command.token); break;
        case 'dispose':
          this.disposed = true;
          this.assets.clear();
          this.project = undefined;
          this.audition = undefined;
          this.midiAuditions = [];
          break;
      }
    } catch (error) {
      this.emit({
        type: 'error',
        code: 'invalid-command',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  process(output: readonly Float32Array[]): boolean {
    for (const channel of output) channel.fill(0);
    if (this.disposed) return false;
    if (output.length === 0 || output[0].length === 0) return true;
    const frameCount = Math.min(...output.map((channel) => channel.length));
    try {
      for (let frame = 0; frame < frameCount; frame += 1) {
        let left = 0;
        let right = 0;
        if (this.project && (this.state === 'playing' || this.midiAuditions.length > 0)) {
          this.smoothMixerFrame();
          this.advanceTrackGatesFrame();
        }
        if (this.state === 'playing' && this.project) {
          const rendered = this.renderProjectFrame(this.positionBeat);
          left += rendered[0];
          right += rendered[1];
          this.advanceTransport();
        }
        if (this.audition) {
          const rendered = this.renderAuditionFrame();
          left += rendered[0];
          right += rendered[1];
        }
        if (this.midiAuditions.length > 0) {
          const rendered = this.renderMidiAuditionsFrame();
          left += rendered[0];
          right += rendered[1];
        }
        if (!Number.isFinite(left) || !Number.isFinite(right)) {
          left = 0;
          right = 0;
          if (!this.reportedRenderError) {
            this.reportedRenderError = true;
            this.emit({ type: 'error', code: 'non-finite-output', message: 'Realtime renderer suppressed non-finite PCM output' });
          }
        }
        if (output.length === 1) output[0][frame] = (left + right) * 0.5;
        else {
          output[0][frame] = left;
          output[1][frame] = right;
        }
        this.masterPeak = Math.max(this.masterPeak, Math.abs(left), Math.abs(right));
      }
      this.telemetryFrames += frameCount;
      if (this.telemetryFrames >= this.sampleRate / TELEMETRY_HZ) this.emitTelemetry();
    } catch (error) {
      if (!this.reportedRenderError) {
        this.reportedRenderError = true;
        this.emit({
          type: 'error',
          code: 'render-failed',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return true;
  }

  private syncProject(snapshot: WorkletProjectSnapshot): void {
    if (!validFinite(snapshot.bpm, Number.MIN_VALUE)) throw new RangeError('Project BPM must be positive');
    const previousTracks = new Map(this.project?.tracks.map((track) => [track.id, track]));
    const previousMaster = this.project?.masterGainState;
    const anySolo = snapshot.tracks.some((track) => track.solo && !track.mute);
    const tracks: RenderTrack[] = snapshot.tracks.map((track) => {
      const previous = previousTracks.get(track.id);
      const audioClips = [...track.audioClips].sort((left, right) => left.startBeat - right.startBeat || left.id.localeCompare(right.id));
      const midiEvents = [...track.midiEvents].sort((left, right) =>
        left.startBeat - right.startBeat || left.pitch - right.pitch || left.noteId.localeCompare(right.noteId));
      const gateTarget = track.mute || (anySolo && !track.solo) ? 0 : 1;
      return {
        ...track,
        audioClips,
        midiEvents,
        gainState: { current: previous?.gainState.current ?? track.gain, target: track.gain },
        panState: { current: previous?.panState.current ?? track.pan, target: track.pan },
        gateState: previous
          ? { ...previous.gateState }
          : { current: gateTarget, target: gateTarget, step: 0, remainingFrames: 0 },
        maxMidiDurationBeats: midiEvents.reduce((maximum, event) => Math.max(
          maximum,
          event.durationBeats + (snapshot.bpm * (
            event.instrumentKind === 'drums'
              ? MAX_UNSYNCED_DRUM_TAIL_SECONDS
              : tinySynthReleaseTailSeconds(event.midiProgram ?? 0)
          )) / 60,
        ), 0),
        peak: previous?.peak ?? 0,
      };
    });
    this.project = {
      ...snapshot,
      loop: { ...snapshot.loop },
      tracks,
      masterGainState: {
        current: previousMaster?.current ?? snapshot.masterGain,
        target: snapshot.masterGain,
      },
    };
    this.refreshTrackGateTargets();
    this.transportEndBeat = Math.max(0, Math.min(this.transportEndBeat || snapshot.endBeat, snapshot.endBeat));
    this.positionBeat = Math.min(this.positionBeat, snapshot.endBeat);
    if (this.state === 'playing' && this.positionBeat >= this.transportEndBeat - EPSILON) {
      this.setState('idle');
      this.emit({ type: 'ended', positionBeat: this.positionBeat });
    }
  }

  private syncAsset(asset: WorkletAssetPayload): void {
    if (!asset.id || !validFinite(asset.sampleRate, Number.MIN_VALUE) || asset.channelData.length === 0) {
      throw new RangeError('Audio asset requires an id, positive sample rate, and channel data');
    }
    if (asset.channelData.some((channel) => !(channel instanceof Float32Array))) {
      throw new TypeError('Audio asset channels must be Float32Array PCM');
    }
    this.assets.set(asset.id, asset);
    this.reportedMissingAssets.delete(asset.id);
  }

  private removeAsset(assetId: string): void {
    this.assets.delete(assetId);
    if (this.audition?.assetId === assetId) this.audition = undefined;
  }

  private play(fromBeat: number, toBeat: number, loop: boolean): void {
    const project = this.project;
    if (!project) throw new Error('A project must be synchronized before playback');
    let start = Math.max(0, fromBeat);
    let end = Math.min(project.endBeat, Math.max(start, toBeat));
    this.loopEnabled = loop;
    if (loop) {
      if (project.loop.endBeat <= project.loop.startBeat) throw new RangeError('Loop end must be after loop start');
      if (start < project.loop.startBeat || start >= project.loop.endBeat) start = project.loop.startBeat;
      end = project.loop.endBeat;
    }
    this.positionBeat = start;
    this.transportEndBeat = end;
    if (end <= start + EPSILON) {
      this.setState('idle');
      return;
    }
    this.setState('playing');
  }

  private setLoop(enabled: boolean, startBeat: number, endBeat: number): void {
    if (!this.project) return;
    if (!validFinite(startBeat, 0) || !validFinite(endBeat, 0) || endBeat <= startBeat) {
      throw new RangeError('Loop end must be after loop start');
    }
    this.project.loop = { enabled, startBeat, endBeat };
    this.loopEnabled = enabled;
    this.transportEndBeat = enabled ? endBeat : this.project.endBeat;
  }

  private setMasterGain(gain: number): void {
    if (!validFinite(gain, 0)) throw new RangeError('Master gain must be non-negative');
    if (this.project) {
      this.project.masterGain = gain;
      this.project.masterGainState.target = gain;
    }
  }

  private setTrackParameters(trackId: string, parameters: Partial<Pick<RenderTrack, 'gain' | 'pan' | 'mute' | 'solo'>>): void {
    const track = this.project?.tracks.find((candidate) => candidate.id === trackId);
    if (!track) throw new Error(`Unknown track "${trackId}"`);
    if (parameters.gain !== undefined) {
      if (!validFinite(parameters.gain, 0)) throw new RangeError('Track gain must be non-negative');
      track.gain = parameters.gain;
      track.gainState.target = parameters.gain;
    }
    if (parameters.pan !== undefined) {
      if (!validFinite(parameters.pan) || parameters.pan < -1 || parameters.pan > 1) {
        throw new RangeError('Track pan must be in range -1..1');
      }
      track.pan = parameters.pan;
      track.panState.target = parameters.pan;
    }
    if (parameters.mute !== undefined) track.mute = parameters.mute;
    if (parameters.solo !== undefined) track.solo = parameters.solo;
    if (parameters.mute !== undefined || parameters.solo !== undefined) this.refreshTrackGateTargets();
  }

  private startAudition(assetId: string, token: number): void {
    if (!this.assets.has(assetId)) {
      this.emit({ type: 'error', code: 'asset-missing', message: `Audition asset "${assetId}" is not synchronized`, assetId });
      return;
    }
    this.audition = { assetId, token, elapsedSeconds: 0 };
  }

  private startMidiAudition(command: WorkletMidiAudition): void {
    const project = this.project;
    if (!project) throw new Error('A project must be synchronized before MIDI audition');
    const track = project.tracks.find((candidate) => candidate.id === command.trackId);
    if (!track || track.kind !== 'midi' || !track.midiProfile) {
      throw new Error(`Unknown MIDI track "${command.trackId}"`);
    }
    if (!Number.isSafeInteger(command.token) || command.token < 0) {
      throw new RangeError('MIDI audition token must be a non-negative safe integer');
    }
    if (!validFinite(command.pitch) || !validFinite(command.velocity) || !validFinite(command.durationSeconds)) {
      throw new RangeError('MIDI audition pitch, velocity, and duration must be finite');
    }
    const profile = command.profile;
    if (!Number.isInteger(profile.channel) || profile.channel < 0 || profile.channel > 15) {
      throw new RangeError('MIDI audition channel must be an integer from 0..15');
    }
    if (profile.instrumentKind === 'drums') {
      if (profile.channel !== 9 || profile.instrumentId !== 'WebAudioFont 128_0_Chaos_sf2_file') {
        throw new RangeError('Drum audition requires MIDI channel 10 and the pinned Chaos instrument');
      }
    } else if (
      profile.channel === 9
      || profile.instrumentId !== 'WebAudio-TinySynth'
      || !validFinite(profile.program)
    ) {
      throw new RangeError('Melodic audition requires a non-drum channel and a TinySynth program');
    }

    // A retrigger crossfades the previous note instead of truncating a sample
    // at an arbitrary phase. Candidate-audio audition remains independent.
    this.releaseMidiAuditions();
    const pitch = clamp(Math.round(command.pitch), 0, 127);
    const velocity = clamp(command.velocity, 0, 1);
    const durationSeconds = clamp(
      command.durationSeconds,
      MIN_MIDI_AUDITION_SECONDS,
      MAX_MIDI_AUDITION_SECONDS,
    );
    const normalizedProfile = profile.instrumentKind === 'drums'
      ? { ...profile }
      : { ...profile, program: clamp(Math.round(profile.program ?? 0), 0, 127) };
    this.midiAuditions.push({
      ...command,
      pitch,
      velocity,
      durationSeconds,
      profile: normalizedProfile,
      elapsedSeconds: 0,
      noiseSeed: tinySynthNoiseSeed(`audition:${command.token}:${command.trackId}`, pitch, 0),
      lastTrackGain: track.gainState.current,
      lastTrackPan: track.panState.current,
    });
  }

  private releaseMidiAuditions(token?: number): void {
    const survivors: MidiAuditionState[] = [];
    for (const audition of this.midiAuditions) {
      if (token !== undefined && audition.token !== token) {
        survivors.push(audition);
        continue;
      }
      if (audition.elapsedSeconds <= 0) {
        this.emit({ type: 'midi-audition-ended', token: audition.token });
        continue;
      }
      if (audition.releaseAtSeconds === undefined) {
        audition.releaseAtSeconds = audition.elapsedSeconds;
        audition.releaseLevel = midiAuditionEnvelope(
          audition.elapsedSeconds,
          this.midiAuditionDuration(audition),
        );
      }
      survivors.push(audition);
    }
    this.midiAuditions = survivors;
  }

  private smooth(parameter: SmoothedParameter): number {
    if (Math.abs(parameter.target - parameter.current) <= 1e-7) parameter.current = parameter.target;
    else parameter.current += (parameter.target - parameter.current) * this.smoothingCoefficient;
    return parameter.current;
  }

  private smoothMixerFrame(): void {
    const project = this.project;
    if (!project) return;
    for (const track of project.tracks) {
      this.smooth(track.gainState);
      this.smooth(track.panState);
    }
    this.smooth(project.masterGainState);
  }

  private setTrackGateTarget(gate: TrackGateEnvelope, target: number): void {
    if (gate.target === target) return;
    gate.target = target;
    if (Math.abs(gate.current - target) <= EPSILON) {
      gate.current = target;
      gate.step = 0;
      gate.remainingFrames = 0;
      return;
    }
    // Restarting from the current sample-domain value makes rapid mute/solo
    // reversals continuous instead of jumping to either endpoint.
    gate.remainingFrames = this.trackGateRampFrames;
    gate.step = (target - gate.current) / gate.remainingFrames;
  }

  private refreshTrackGateTargets(): void {
    const tracks = this.project?.tracks ?? [];
    const anySolo = tracks.some((track) => track.solo && !track.mute);
    for (const track of tracks) {
      this.setTrackGateTarget(track.gateState, track.mute || (anySolo && !track.solo) ? 0 : 1);
    }
  }

  private advanceTrackGatesFrame(): void {
    for (const track of this.project?.tracks ?? []) {
      const gate = track.gateState;
      if (gate.remainingFrames <= 0) continue;
      gate.current += gate.step;
      gate.remainingFrames -= 1;
      if (gate.remainingFrames === 0) {
        gate.current = gate.target;
        gate.step = 0;
      }
    }
  }

  private renderProjectFrame(beat: number): [number, number] {
    const project = this.project!;
    let masterLeft = 0;
    let masterRight = 0;
    for (const track of project.tracks) {
      const gain = track.gainState.current;
      const pan = track.panState.current;
      const gate = track.gateState.current;
      if (gate <= EPSILON && track.gateState.target === 0) continue;
      const source = track.kind === 'audio'
        ? this.renderAudioTrack(track, beat)
        : this.renderMidiTrack(track, beat, project.bpm);
      let panned: [number, number];
      if (track.kind === 'audio' && !source[2]) panned = stereoPan(source[0], source[1], pan);
      else panned = monoPan(source[0], pan);
      const left = panned[0] * gain * gate;
      const right = panned[1] * gain * gate;
      track.peak = Math.max(track.peak, Math.abs(left), Math.abs(right));
      masterLeft += left;
      masterRight += right;
    }
    const masterGain = project.masterGainState.current;
    return [masterLeft * masterGain, masterRight * masterGain];
  }

  /** Third tuple member indicates a mono source. */
  private renderAudioTrack(track: RenderTrack, beat: number): [number, number, boolean] {
    const index = upperBoundStart(track.audioClips, beat) - 1;
    if (index < 0) return [0, 0, true];
    const clip = track.audioClips[index];
    const positionBeat = beat - clip.startBeat;
    if (clip.muted || positionBeat < 0 || positionBeat >= clip.durationBeats) return [0, 0, true];
    const asset = this.assets.get(clip.assetId);
    if (!asset) {
      if (!this.reportedMissingAssets.has(clip.assetId)) {
        this.reportedMissingAssets.add(clip.assetId);
        this.emit({
          type: 'error',
          code: 'asset-missing',
          message: `Audio asset "${clip.assetId}" is not synchronized`,
          assetId: clip.assetId,
        });
      }
      return [0, 0, true];
    }
    const sourceBeat = sourceBeatAtPosition(clip, positionBeat);
    const sourceFrame = secondsAtBeats(sourceBeat, clip.timebase.sourceBpm) * asset.sampleRate;
    const fade = linearEdgeEnvelope(
      secondsAtBeats(positionBeat, this.project!.bpm),
      secondsAtBeats(clip.durationBeats, this.project!.bpm),
      clip.fadeIn,
      clip.fadeOut,
    );
    const gain = clip.gain * fade;
    if (asset.channelData.length === 1) {
      return [sampleLinear(asset.channelData[0], sourceFrame) * gain, 0, true];
    }
    // Match deterministic offline export: the first two channels are the
    // stereo program; additional channels are intentionally not invented into
    // a different downmix law.
    return [
      sampleLinear(asset.channelData[0], sourceFrame) * gain,
      sampleLinear(asset.channelData[1], sourceFrame) * gain,
      false,
    ];
  }

  private renderMidiTrack(track: RenderTrack, beat: number, bpm: number): [number, number, true] {
    let sample = 0;
    const events = track.midiEvents;
    let index = upperBoundStart(events, beat) - 1;
    const earliestPossibleStart = beat - track.maxMidiDurationBeats - EPSILON;
    for (; index >= 0 && events[index].startBeat >= earliestPossibleStart; index -= 1) {
      const event = events[index];
      if (event.clipMuted || beat >= event.clipStartBeat + event.clipDurationBeats - EPSILON) continue;
      const elapsedBeats = beat - event.startBeat;
      if (elapsedBeats < -EPSILON) continue;
      const noteSeconds = secondsAtBeats(event.noteOffsetBeats + Math.max(0, elapsedBeats), bpm);
      const noteDurationSeconds = secondsAtBeats(event.noteDurationBeats, bpm);
      const clipPositionSeconds = secondsAtBeats(beat - event.clipStartBeat, bpm);
      const clipDurationSeconds = secondsAtBeats(event.clipDurationBeats, bpm);
      const clipEnvelope = linearEdgeEnvelope(
        clipPositionSeconds,
        clipDurationSeconds,
        event.clipFadeIn,
        event.clipFadeOut,
      );
      let voice = 0;
      if (event.instrumentKind === 'drums') {
        const drum = getChaosDrumVoice(event.pitch);
        const asset = this.assets.get(drum.assetId);
        if (!asset) {
          if (!this.reportedMissingAssets.has(drum.assetId)) {
            this.reportedMissingAssets.add(drum.assetId);
            this.emit({
              type: 'error',
              code: 'asset-missing',
              message: `WebAudioFont drum asset "${drum.assetId}" is not synchronized`,
              assetId: drum.assetId,
            });
          }
          continue;
        }
        const sourceFrame = noteSeconds * asset.sampleRate * drum.playbackRate;
        voice = sampleAssetMono(asset, sourceFrame)
          * event.velocity * event.velocity
          * WEBAUDIOFONT_CHAOS_DRUM_GAIN;
      } else {
        const releaseTail = tinySynthReleaseTailSeconds(event.midiProgram ?? 0);
        if (noteSeconds > noteDurationSeconds + releaseTail) continue;
        voice = tinySynthSampleAtTime({
          program: event.midiProgram,
          pitch: event.pitch,
          velocity: event.velocity,
          noteSeconds,
          noteDurationSeconds,
          sampleRate: this.sampleRate,
          noiseSeed: tinySynthNoiseSeed(event.noteId, event.pitch, event.startBeat),
        });
      }
      voice *= event.clipGain * clipEnvelope;
      sample += voice;
    }
    return [sample, 0, true];
  }

  private midiAuditionDuration(audition: MidiAuditionState): number {
    if (audition.profile.instrumentKind !== 'drums') return audition.durationSeconds;
    const drum = getChaosDrumVoice(audition.pitch);
    const asset = this.assets.get(drum.assetId);
    if (!asset) return audition.durationSeconds;
    const sourceFrames = Math.min(...asset.channelData.map((channel) => channel.length));
    return Math.min(
      audition.durationSeconds,
      sourceFrames / (asset.sampleRate * drum.playbackRate),
    );
  }

  private renderMidiAuditionsFrame(): [number, number] {
    const project = this.project;
    if (!project) {
      for (const audition of this.midiAuditions) {
        this.emit({ type: 'midi-audition-ended', token: audition.token });
      }
      this.midiAuditions = [];
      return [0, 0];
    }
    let masterLeft = 0;
    let masterRight = 0;
    const survivors: MidiAuditionState[] = [];
    for (const audition of this.midiAuditions) {
      const durationSeconds = this.midiAuditionDuration(audition);
      const releaseElapsed = audition.releaseAtSeconds === undefined
        ? undefined
        : audition.elapsedSeconds - audition.releaseAtSeconds;
      if (
        audition.elapsedSeconds >= durationSeconds
        || (releaseElapsed !== undefined && releaseElapsed >= MIDI_AUDITION_RELEASE_SECONDS)
      ) {
        this.emit({ type: 'midi-audition-ended', token: audition.token });
        continue;
      }

      let voice = 0;
      if (audition.profile.instrumentKind === 'drums') {
        const drum = getChaosDrumVoice(audition.pitch);
        const asset = this.assets.get(drum.assetId);
        if (!asset) {
          if (!this.reportedMissingAssets.has(drum.assetId)) {
            this.reportedMissingAssets.add(drum.assetId);
            this.emit({
              type: 'error',
              code: 'asset-missing',
              message: `WebAudioFont drum asset "${drum.assetId}" is not synchronized`,
              assetId: drum.assetId,
            });
          }
          this.emit({ type: 'midi-audition-ended', token: audition.token });
          continue;
        }
        const sourceFrame = audition.elapsedSeconds * asset.sampleRate * drum.playbackRate;
        voice = sampleAssetMono(asset, sourceFrame)
          * audition.velocity * audition.velocity
          * WEBAUDIOFONT_CHAOS_DRUM_GAIN;
      } else {
        const noteDurationSeconds = Math.max(
          MIN_MIDI_AUDITION_SECONDS * 0.5,
          durationSeconds - MIDI_AUDITION_RELEASE_SECONDS,
        );
        voice = tinySynthSampleAtTime({
          program: audition.profile.program,
          pitch: audition.pitch,
          velocity: audition.velocity,
          noteSeconds: audition.elapsedSeconds,
          noteDurationSeconds,
          sampleRate: this.sampleRate,
          noiseSeed: audition.noiseSeed,
        });
      }

      let envelope = midiAuditionEnvelope(audition.elapsedSeconds, durationSeconds);
      if (releaseElapsed !== undefined) {
        envelope = (audition.releaseLevel ?? envelope)
          * smoothStep(1 - releaseElapsed / MIDI_AUDITION_RELEASE_SECONDS);
      }
      voice *= envelope;
      const track = project.tracks.find((candidate) => candidate.id === audition.trackId);
      if (track) {
        audition.lastTrackGain = track.gainState.current;
        audition.lastTrackPan = track.panState.current;
      }
      const panned = monoPan(voice, audition.lastTrackPan);
      const left = panned[0] * audition.lastTrackGain;
      const right = panned[1] * audition.lastTrackGain;
      if (track) track.peak = Math.max(track.peak, Math.abs(left), Math.abs(right));
      masterLeft += left;
      masterRight += right;
      audition.elapsedSeconds += 1 / this.sampleRate;
      survivors.push(audition);
    }
    this.midiAuditions = survivors;
    const masterGain = project.masterGainState.current;
    return [masterLeft * masterGain, masterRight * masterGain];
  }

  private renderAuditionFrame(): [number, number] {
    const audition = this.audition!;
    const asset = this.assets.get(audition.assetId);
    if (!asset) {
      this.audition = undefined;
      return [0, 0];
    }
    const durationSeconds = Math.min(...asset.channelData.map((channel) => channel.length)) / asset.sampleRate;
    if (audition.elapsedSeconds >= durationSeconds) {
      this.audition = undefined;
      this.emit({ type: 'audition-ended', token: audition.token });
      return [0, 0];
    }
    const sourceFrame = audition.elapsedSeconds * asset.sampleRate;
    const fade = linearEdgeEnvelope(audition.elapsedSeconds, durationSeconds, 0.012, 0.025) * 0.86;
    audition.elapsedSeconds += 1 / this.sampleRate;
    if (asset.channelData.length === 1) {
      const sample = sampleLinear(asset.channelData[0], sourceFrame) * fade;
      return [sample, sample];
    }
    return [
      sampleLinear(asset.channelData[0], sourceFrame) * fade,
      sampleLinear(asset.channelData[1], sourceFrame) * fade,
    ];
  }

  private advanceTransport(): void {
    const project = this.project!;
    const nextBeat = this.positionBeat + project.bpm / (60 * this.sampleRate);
    if (nextBeat < this.transportEndBeat - EPSILON) {
      this.positionBeat = nextBeat;
      return;
    }
    if (this.loopEnabled) {
      const loopLength = project.loop.endBeat - project.loop.startBeat;
      this.positionBeat = project.loop.startBeat + positiveModulo(nextBeat - project.loop.startBeat, loopLength);
      return;
    }
    this.positionBeat = this.transportEndBeat;
    this.setState('idle');
    this.emit({ type: 'ended', positionBeat: this.positionBeat });
  }

  private emitTelemetry(): void {
    const trackPeaks: Record<string, number> = Object.create(null) as Record<string, number>;
    for (const track of this.project?.tracks ?? []) {
      trackPeaks[track.id] = Math.min(1, track.peak);
      track.peak = 0;
    }
    this.emit({
      type: 'telemetry',
      state: this.state,
      positionBeat: this.positionBeat,
      masterPeak: Math.min(1, this.masterPeak),
      trackPeaks,
    });
    this.telemetryFrames %= Math.max(1, Math.round(this.sampleRate / TELEMETRY_HZ));
    this.masterPeak = 0;
  }

  private emitState(): void {
    this.emit({ type: 'state', state: this.state, positionBeat: this.positionBeat });
  }

  private setState(state: WorkletPlaybackState): void {
    if (this.state === state) return;
    this.state = state;
    this.emitState();
  }
}
