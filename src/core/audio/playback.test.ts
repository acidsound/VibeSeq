import { afterEach, describe, expect, it } from 'vitest';
import type { Project } from '../../types';
import { createDemoProject } from '../demo';
import { midiPeriodicWaveCoefficients, midiPitchFrequency } from './midiSynth';
import { buildPlaybackPlan, WebAudioPlaybackEngine } from './playback';
import { rescaleFixedSecondsAudioClipGeometry } from './timebase';

const createParityProject = (): Project => ({
  schemaVersion: 5,
  id: 'project-parity',
  name: 'Parity fixture',
  bpm: 60,
  sampleRate: 44_100,
  timeSignature: { numerator: 4, denominator: 4 },
  arrangement: { overlapPolicy: 'prevent' },
  tracks: [{
    id: 'track-midi',
    name: 'MIDI',
    kind: 'midi',
    midi: { channel: 0, instrument: { kind: 'melodic', playbackId: 'WebAudio-TinySynth', program: 0 } },
    color: '#5dd6d1',
    gain: 0.8,
    pan: 0.25,
    mute: false,
    solo: false,
    clips: [{
      id: 'clip-midi',
      name: 'MIDI clip',
      kind: 'midi',
      startBeat: 0,
      durationBeats: 2,
      offsetBeats: 0,
      gain: 0.75,
      fadeIn: 0.5,
      fadeOut: 0.5,
      notes: [{ id: 'note-a4', pitch: 69, startBeat: 0, durationBeats: 2, velocity: 0.7 }],
      provenance: { source: 'user', createdAt: '2026-07-15T00:00:00.000Z' },
    }],
  }],
  loop: { enabled: false, startBeat: 0, endBeat: 2 },
  assets: [],
  jobs: [],
  masterGain: 0.9,
  createdAt: '2026-07-15T00:00:00.000Z',
  updatedAt: '2026-07-15T00:00:00.000Z',
});

class FakeAudioParam {
  readonly events: Array<{ kind: 'cancel' | 'set' | 'linear'; value?: number; at: number }> = [];

  cancelScheduledValues(at: number): void { this.events.push({ kind: 'cancel', at }); }
  setValueAtTime(value: number, at: number): void { this.events.push({ kind: 'set', value, at }); }
  linearRampToValueAtTime(value: number, at: number): void { this.events.push({ kind: 'linear', value, at }); }
}

class FakeAudioNode {
  connect<T>(destination: T): T { return destination; }
  disconnect(): void { /* no-op test graph */ }
}

class FakeGainNode extends FakeAudioNode { readonly gain = new FakeAudioParam(); }
class FakePannerNode extends FakeAudioNode { readonly pan = new FakeAudioParam(); }
class FakeAnalyserNode extends FakeAudioNode {
  fftSize = 0;
  smoothingTimeConstant = 0;
  getFloatTimeDomainData(data: Float32Array): void { data.fill(0); }
}

class FakeOscillatorNode extends FakeAudioNode {
  readonly frequency = new FakeAudioParam();
  wave?: unknown;
  startAt?: number;
  stopAt?: number;

  setPeriodicWave(wave: unknown): void { this.wave = wave; }
  start(at: number): void { this.startAt = at; }
  stop(at?: number): void { this.stopAt = at; }
  addEventListener(): void { /* source never ends during this synchronous test */ }
}

class FakeBufferSourceNode extends FakeAudioNode {
  buffer: AudioBuffer | null = null;
  readonly playbackRate = new FakeAudioParam();
  startCall?: { when: number; offset: number; duration: number };
  stopAt?: number;

  start(when = 0, offset = 0, duration = 0): void { this.startCall = { when, offset, duration }; }
  stop(at?: number): void { this.stopAt = at; }
  addEventListener(): void { /* source never ends during this synchronous test */ }
}

class FakeAudioContext {
  currentTime = 10;
  readonly sampleRate = 44_100;
  readonly state = 'running';
  readonly destination = new FakeAudioNode();
  readonly gains: FakeGainNode[] = [];
  readonly oscillators: FakeOscillatorNode[] = [];
  readonly bufferSources: FakeBufferSourceNode[] = [];
  readonly waves: Array<{ real: Float32Array; imag: Float32Array; options: PeriodicWaveConstraints }> = [];

  createGain(): FakeGainNode {
    const node = new FakeGainNode();
    this.gains.push(node);
    return node;
  }
  createAnalyser(): FakeAnalyserNode { return new FakeAnalyserNode(); }
  createStereoPanner(): FakePannerNode { return new FakePannerNode(); }
  createOscillator(): FakeOscillatorNode {
    const node = new FakeOscillatorNode();
    this.oscillators.push(node);
    return node;
  }
  createBufferSource(): FakeBufferSourceNode {
    const node = new FakeBufferSourceNode();
    this.bufferSources.push(node);
    return node;
  }
  createPeriodicWave(real: Float32Array, imag: Float32Array, options: PeriodicWaveConstraints): PeriodicWave {
    const wave = { real, imag, options };
    this.waves.push(wave);
    return wave as unknown as PeriodicWave;
  }
}

const engines: WebAudioPlaybackEngine[] = [];

const createTempoFollowAudioProject = (bpm: number): Project => {
  const project = createParityProject();
  project.bpm = bpm;
  project.loop.endBeat = 8;
  project.tracks = [{
    id: 'track-tempo-follow',
    name: 'Tempo follow',
    kind: 'audio',
    color: '#f6a84b',
    gain: 1,
    pan: 0,
    mute: false,
    solo: false,
    clips: [{
      id: 'clip-tempo-follow',
      name: '120 BPM source',
      kind: 'audio',
      assetId: 'asset-tempo-follow',
      startBeat: 0,
      durationBeats: 8,
      offsetBeats: 0,
      timebase: { mode: 'tempo-follow-repitch', sourceBpm: 120 },
      gain: 1,
      fadeIn: 0,
      fadeOut: 0,
      provenance: { source: 'user', createdAt: project.createdAt },
    }],
  }];
  project.assets = [{
    id: 'asset-tempo-follow',
    name: '120 BPM source',
    mimeType: 'audio/wav',
    durationSeconds: 4,
    createdAt: project.createdAt,
    provenance: { source: 'user', createdAt: project.createdAt },
  }];
  project.masterGain = 1;
  return project;
};

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.dispose()));
});

describe('playback planning', () => {
  it.each([
    { bpm: 60, durationSeconds: 8, playbackRate: 0.5 },
    { bpm: 120, durationSeconds: 4, playbackRate: 1 },
    { bpm: 240, durationSeconds: 2, playbackRate: 2 },
  ])('plans a 120 BPM source honestly at $bpm project BPM', ({ bpm, durationSeconds, playbackRate }) => {
    const event = buildPlaybackPlan(createTempoFollowAudioProject(bpm), {
      fromBeat: 0,
      toBeat: 8,
    }).events[0];

    expect(event?.kind).toBe('audio');
    if (event?.kind !== 'audio') return;
    expect(event.durationSeconds).toBe(durationSeconds);
    expect(event.sourceDurationSeconds).toBe(4);
    expect(event.offsetSeconds).toBe(0);
    expect(event.playbackRate).toBe(playbackRate);
  });

  it.each([
    { bpm: 60, playbackRate: 0.5 },
    { bpm: 120, playbackRate: 1 },
    { bpm: 240, playbackRate: 2 },
  ])('schedules source-time duration and WebAudio rate at $bpm project BPM', async ({ bpm, playbackRate }) => {
    const project = createTempoFollowAudioProject(bpm);
    const context = new FakeAudioContext();
    const engine = new WebAudioPlaybackEngine(project, {
      context: context as unknown as AudioContext,
      startLatencySeconds: 0,
    });
    engines.push(engine);
    engine.registerAudioBuffer('asset-tempo-follow', { duration: 4 } as AudioBuffer);

    await engine.play({ fromBeat: 0, toBeat: 8 });

    expect(context.bufferSources).toHaveLength(1);
    expect(context.bufferSources[0].playbackRate.events).toContainEqual({
      kind: 'set',
      value: playbackRate,
      at: 10,
    });
    expect(context.bufferSources[0].startCall).toEqual({ when: 10, offset: 0, duration: 4 });
  });

  it('expands repeated audio and MIDI source cycles with a partial final iteration', () => {
    const project = createParityProject();
    project.tracks = [
      {
        id: 'track-audio-loop',
        name: 'Audio loop',
        kind: 'audio',
        color: '#f6a84b',
        gain: 1,
        pan: 0,
        mute: false,
        solo: false,
        clips: [{
          id: 'clip-audio-loop',
          name: 'Audio loop',
          kind: 'audio',
          assetId: 'asset-loop',
          startBeat: 0,
          durationBeats: 2.5,
          offsetBeats: 0,
          timebase: { mode: 'fixed-seconds', sourceBpm: 60 },
          sourceLoop: { cycleStartBeat: 0, cycleLengthBeats: 1, phaseBeats: 0 },
          gain: 1,
          fadeIn: 0.5,
          fadeOut: 0.5,
          provenance: { source: 'user', createdAt: project.createdAt },
        }],
      },
      {
        id: 'track-midi-loop',
        name: 'MIDI loop',
        kind: 'midi',
        midi: { channel: 0, instrument: { kind: 'melodic', playbackId: 'WebAudio-TinySynth', program: 0 } },
        color: '#5dd6d1',
        gain: 1,
        pan: 0,
        mute: false,
        solo: false,
        clips: [{
          id: 'clip-midi-loop',
          name: 'MIDI loop',
          kind: 'midi',
          startBeat: 0,
          durationBeats: 2.5,
          offsetBeats: 0,
          sourceLoop: { cycleStartBeat: 0, cycleLengthBeats: 1, phaseBeats: 0 },
          gain: 1,
          fadeIn: 0,
          fadeOut: 0,
          notes: [{ id: 'loop-note', pitch: 60, startBeat: 0.25, durationBeats: 0.5, velocity: 1 }],
          provenance: { source: 'user', createdAt: project.createdAt },
        }],
      },
    ];
    project.assets = [{
      id: 'asset-loop',
      name: 'Loop asset',
      mimeType: 'audio/wav',
      durationSeconds: 1,
      createdAt: project.createdAt,
      provenance: { source: 'user', createdAt: project.createdAt },
    }];
    project.masterGain = 1;

    const plan = buildPlaybackPlan(project, { fromBeat: 0, toBeat: 2.5 });
    const audio = plan.events.filter((event) => event.kind === 'audio');
    const midi = plan.events.filter((event) => event.kind === 'midi');
    expect(audio.map((event) => [event.whenSeconds, event.durationSeconds, event.offsetSeconds])).toEqual([
      [0, 1, 0],
      [1, 1, 0],
      [2, 0.5, 0],
    ]);
    expect(midi.map((event) => [event.whenSeconds, event.durationSeconds])).toEqual([
      [0.25, 0.5],
      [1.25, 0.5],
      [2.25, 0.25],
    ]);

    // Fade policy: only outer placement edges fade; internal source repeats do not retrigger.
    expect(audio[0].gainEnvelope[0].gain).toBe(0);
    expect(audio[0].gainEnvelope.at(-1)?.gain).toBe(1);
    expect(audio[1].gainEnvelope[0].gain).toBe(1);
    expect(audio[1].gainEnvelope.at(-1)?.gain).toBe(1);
    expect(audio[2].gainEnvelope[0].gain).toBe(1);
    expect(audio[2].gainEnvelope.at(-1)?.gain).toBe(0);
  });

  it('schedules every audio source-loop slice through WebAudio with exact offsets and durations', async () => {
    const project = createParityProject();
    project.tracks = [{
      id: 'audio-loop-track',
      name: 'Audio loop',
      kind: 'audio',
      color: '#f6a84b',
      gain: 1,
      pan: 0,
      mute: false,
      solo: false,
      clips: [{
        id: 'audio-loop-clip',
        name: 'Audio loop',
        kind: 'audio',
        assetId: 'audio-loop-asset',
        startBeat: 0,
        durationBeats: 2.5,
        offsetBeats: 0,
        timebase: { mode: 'fixed-seconds', sourceBpm: 60 },
        sourceLoop: { cycleStartBeat: 0, cycleLengthBeats: 1, phaseBeats: 0 },
        gain: 1,
        fadeIn: 0,
        fadeOut: 0,
        provenance: { source: 'user', createdAt: project.createdAt },
      }],
    }];
    project.assets = [{
      id: 'audio-loop-asset',
      name: 'Audio loop source',
      mimeType: 'audio/wav',
      durationSeconds: 1,
      createdAt: project.createdAt,
      provenance: { source: 'user', createdAt: project.createdAt },
    }];
    project.masterGain = 1;
    const context = new FakeAudioContext();
    const engine = new WebAudioPlaybackEngine(project, {
      context: context as unknown as AudioContext,
      startLatencySeconds: 0,
    });
    engines.push(engine);
    engine.registerAudioBuffer('audio-loop-asset', { duration: 1 } as AudioBuffer);
    await engine.play({ fromBeat: 0, toBeat: 2.5 });
    expect(context.bufferSources.map((source) => source.startCall)).toEqual([
      { when: 10, offset: 0, duration: 1 },
    ]);
    context.currentTime = 10.85;
    (engine as unknown as { tick: () => void }).tick();
    context.currentTime = 11.85;
    (engine as unknown as { tick: () => void }).tick();
    expect(context.bufferSources.map((source) => source.startCall)).toEqual([
      { when: 10, offset: 0, duration: 1 },
      { when: 11, offset: 0, duration: 1 },
      { when: 12, offset: 0, duration: 0.5 },
    ]);
  });

  it('trims audio offsets and MIDI notes when playback starts in the middle', () => {
    const project = createDemoProject({ now: '2026-07-15T00:00:00.000Z' });
    const plan = buildPlaybackPlan(project, { fromBeat: 9, toBeat: 10 });
    const atmosphere = plan.events.find((event) => event.kind === 'audio' && event.trackId === 'track-atmosphere');
    expect(atmosphere?.whenSeconds).toBe(0);
    expect(atmosphere?.kind === 'audio' ? atmosphere.offsetSeconds : 0).toBeCloseTo((9 * 60) / 118);
    expect(plan.events.some((event) => event.kind === 'midi')).toBe(true);
  });

  it('applies solo and mute before generating events', () => {
    const project = createDemoProject({ now: '2026-07-15T00:00:00.000Z' });
    project.tracks[2].solo = true;
    const plan = buildPlaybackPlan(project, { fromBeat: 8, toBeat: 12 });
    expect(new Set(plan.events.map((event) => event.trackId))).toEqual(new Set(['track-lead-midi']));
  });

  it('excludes a muted region while leaving sibling regions playable', () => {
    const project = createParityProject();
    const source = project.tracks[0].clips[0];
    source.muted = true;
    const sibling = structuredClone(source);
    sibling.id = 'clip-midi-sibling';
    sibling.startBeat = 2;
    sibling.muted = false;
    project.tracks[0].clips.push(sibling);

    const plan = buildPlaybackPlan(project, { fromBeat: 0, toBeat: 4 });
    expect(plan.events.some((event) => event.clipId === source.id)).toBe(false);
    expect(plan.events.some((event) => event.clipId === sibling.id)).toBe(true);
  });

  it('never plans an audio source whose project media is missing or corrupt', () => {
    const project = createDemoProject({ now: '2026-07-15T00:00:00.000Z' });
    const asset = project.assets.find((candidate) => candidate.id === 'asset-dream-drift')!;

    asset.integrity = { state: 'corrupt', message: 'test mismatch' };
    expect(buildPlaybackPlan(project).events.some((event) =>
      event.kind === 'audio' && event.assetId === asset.id)).toBe(false);

    asset.integrity = { state: 'missing', message: 'test missing bytes' };
    expect(buildPlaybackPlan(project).events.some((event) =>
      event.kind === 'audio' && event.assetId === asset.id)).toBe(false);

    project.assets = project.assets.filter((candidate) => candidate.id !== asset.id);
    expect(buildPlaybackPlan(project).events.some((event) =>
      event.kind === 'audio' && event.assetId === asset.id)).toBe(false);
  });

  it('plans audio fades in seconds while the timeline remains beat-based', () => {
    const project = createDemoProject({ now: '2026-07-15T00:00:00.000Z' });
    const previousBpm = project.bpm;
    project.bpm = 120;
    project.tracks = project.tracks.filter((track) => track.id === 'track-atmosphere');
    project.tracks[0].clips = project.tracks[0].clips.map((clip) =>
      clip.kind === 'audio'
        ? rescaleFixedSecondsAudioClipGeometry(clip, previousBpm, project.bpm)
        : clip);
    const plan = buildPlaybackPlan(project, { fromBeat: 0, toBeat: 2 });
    const event = plan.events.find((candidate) => candidate.kind === 'audio');
    expect(event?.kind).toBe('audio');
    if (event?.kind !== 'audio') return;
    expect(event.gainEnvelope[0].atSeconds).toBe(0);
    expect(event.gainEnvelope[0].gain).toBe(0);
    expect(event.gainEnvelope.some((point) => Math.abs(point.atSeconds - 0.5) < 1e-6)).toBe(true);
  });

  it('preserves original phase, envelope progress, clip fades, and gain when starting mid-note', () => {
    const project = createParityProject();
    const plan = buildPlaybackPlan(project, { fromBeat: 0.25, toBeat: 1.75 });
    const event = plan.events[0];
    expect(event?.kind).toBe('midi');
    if (event?.kind !== 'midi') return;

    expect(event).toMatchObject({
      midiChannel: 0,
      instrumentKind: 'melodic',
      instrumentId: 'WebAudio-TinySynth',
      midiProgram: 0,
    });
    expect(event.noteOffsetSeconds).toBe(0.25);
    expect(event.noteDurationSeconds).toBe(2);
    expect(event.durationSeconds).toBe(1.5);
    expect(event.voiceGainEnvelope[0].gain).toBeCloseTo(0.9 * 0.8 * 0.75 * 0.7 * 0.18, 12);
    expect(event.clipGainEnvelope[0].gain).toBe(0.5);
    expect(event.clipGainEnvelope.at(-1)?.gain).toBe(0.5);
  });

  it('schedules the shared harmonic wave and ends at the authored note edge without a hidden tail', async () => {
    const project = createParityProject();
    const context = new FakeAudioContext();
    const engine = new WebAudioPlaybackEngine(project, {
      context: context as unknown as AudioContext,
      startLatencySeconds: 0,
    });
    engines.push(engine);
    await engine.play({ fromBeat: 0.25, toBeat: 2 });

    const oscillator = context.oscillators[0];
    const event = buildPlaybackPlan(project, { fromBeat: 0.25, toBeat: 2 }).events[0];
    expect(event?.kind).toBe('midi');
    if (event?.kind !== 'midi') return;
    const expectedStart = context.currentTime;
    expect(oscillator.startAt).toBe(expectedStart);
    expect(oscillator.stopAt).toBe(expectedStart + event.durationSeconds);
    expect(context.waves[0].options.disableNormalization).toBe(true);

    const expectedWave = midiPeriodicWaveCoefficients(
      2 * Math.PI * midiPitchFrequency(event.pitch) * event.noteOffsetSeconds,
      midiPitchFrequency(event.pitch),
      context.sampleRate,
    );
    expect([...context.waves[0].real]).toEqual([...expectedWave.real]);
    expect([...context.waves[0].imag]).toEqual([...expectedWave.imag]);

    const voiceGain = context.gains[1];
    const clipGain = context.gains[2];
    expect(voiceGain.gain.events.at(-1)).toMatchObject({ kind: 'linear', value: 0, at: oscillator.stopAt });
    expect(clipGain.gain.events[1]).toMatchObject({ kind: 'set', value: 0.5, at: expectedStart });
  });

  it('starts from the engine seek position when fromBeat is omitted', async () => {
    const project = createParityProject();
    const context = new FakeAudioContext();
    const positions: number[] = [];
    const engine = new WebAudioPlaybackEngine(project, {
      context: context as unknown as AudioContext,
      startLatencySeconds: 0,
      onPosition: (beat) => positions.push(beat),
    });
    engines.push(engine);
    engine.seek(0.75);
    await engine.play({ toBeat: 2 });
    expect(positions.at(-1)).toBe(0.75);
    expect(engine.getPositionBeat()).toBeCloseTo(0.75, 12);
  });

  it('keeps long-project WebAudio node creation inside the schedule-ahead window', async () => {
    const project = createParityProject();
    const track = project.tracks[0];
    const clip = track.clips[0];
    if (clip.kind !== 'midi') throw new Error('Expected MIDI capacity fixture');
    clip.durationBeats = 256;
    clip.notes = Array.from({ length: 256 }, (_, index) => ({
      id: `bounded-note-${index}`,
      pitch: 48 + (index % 24),
      startBeat: index,
      durationBeats: 0.25,
      velocity: 0.7,
    }));
    project.loop.endBeat = 256;
    const context = new FakeAudioContext();
    const engine = new WebAudioPlaybackEngine(project, {
      context: context as unknown as AudioContext,
      startLatencySeconds: 0,
      scheduleAheadSeconds: 0.2,
    });
    engines.push(engine);

    await engine.play({ fromBeat: 0, toBeat: 256 });
    expect(context.oscillators).toHaveLength(1);
    expect(context.oscillators[0].startAt).toBe(10);

    context.currentTime = 10.85;
    (engine as unknown as { tick: () => void }).tick();
    expect(context.oscillators).toHaveLength(2);
    expect(context.oscillators[1].startAt).toBe(11);
  });

  it('catches up a late MIDI event instead of replaying its missed attack', async () => {
    const project = createParityProject();
    const clip = project.tracks[0].clips[0];
    if (clip.kind !== 'midi') throw new Error('Expected MIDI stall fixture');
    clip.durationBeats = 3;
    clip.notes = [
      { id: 'initial', pitch: 60, startBeat: 0, durationBeats: 0.25, velocity: 1 },
      { id: 'late', pitch: 69, startBeat: 1, durationBeats: 1, velocity: 1 },
    ];
    const context = new FakeAudioContext();
    const engine = new WebAudioPlaybackEngine(project, {
      context: context as unknown as AudioContext,
      startLatencySeconds: 0,
      scheduleAheadSeconds: 0.2,
    });
    engines.push(engine);

    await engine.play({ fromBeat: 0, toBeat: 3 });
    context.currentTime = 11.4;
    (engine as unknown as { tick: () => void }).tick();

    const lateOscillator = context.oscillators[1];
    expect(lateOscillator.startAt).toBe(11.4);
    expect(lateOscillator.stopAt).toBe(12);
    const caughtUpBy = context.currentTime - 11;
    const expectedWave = midiPeriodicWaveCoefficients(
      2 * Math.PI * midiPitchFrequency(69) * caughtUpBy,
      midiPitchFrequency(69),
      context.sampleRate,
    );
    expect([...context.waves[1].real]).toEqual([...expectedWave.real]);
    expect([...context.waves[1].imag]).toEqual([...expectedWave.imag]);
  });

  it('skips expired audio after a stall and advances the surviving source offset', async () => {
    const project = createParityProject();
    project.tracks = [{
      id: 'audio-stall-track',
      name: 'Audio stall',
      kind: 'audio',
      color: '#f6a84b',
      gain: 1,
      pan: 0,
      mute: false,
      solo: false,
      clips: [{
        id: 'audio-stall-clip',
        name: 'Audio stall loop',
        kind: 'audio',
        assetId: 'audio-stall-asset',
        startBeat: 0,
        durationBeats: 2.5,
        offsetBeats: 0,
        timebase: { mode: 'fixed-seconds', sourceBpm: 60 },
        sourceLoop: { cycleStartBeat: 0, cycleLengthBeats: 1, phaseBeats: 0 },
        gain: 1,
        fadeIn: 0,
        fadeOut: 0,
        provenance: { source: 'user', createdAt: project.createdAt },
      }],
    }];
    project.assets = [{
      id: 'audio-stall-asset',
      name: 'Audio stall source',
      mimeType: 'audio/wav',
      durationSeconds: 1,
      createdAt: project.createdAt,
      provenance: { source: 'user', createdAt: project.createdAt },
    }];
    const context = new FakeAudioContext();
    const engine = new WebAudioPlaybackEngine(project, {
      context: context as unknown as AudioContext,
      startLatencySeconds: 0,
      scheduleAheadSeconds: 0.2,
    });
    engines.push(engine);
    engine.registerAudioBuffer('audio-stall-asset', { duration: 1 } as AudioBuffer);

    await engine.play({ fromBeat: 0, toBeat: 2.5 });
    context.currentTime = 12.2;
    (engine as unknown as { tick: () => void }).tick();

    expect(context.bufferSources).toHaveLength(2);
    expect(context.bufferSources[1].startCall).toEqual({
      when: 12.2,
      offset: expect.closeTo(0.2, 12),
      duration: expect.closeTo(0.3, 12),
    });
  });

  it('schedules repeating plans incrementally across loop boundaries', async () => {
    const project = createParityProject();
    const track = project.tracks[0];
    const clip = track.clips[0];
    if (clip.kind !== 'midi') throw new Error('Expected MIDI loop fixture');
    clip.notes = [
      { id: 'loop-a', pitch: 60, startBeat: 0, durationBeats: 0.25, velocity: 0.7 },
      { id: 'loop-b', pitch: 64, startBeat: 1, durationBeats: 0.25, velocity: 0.7 },
    ];
    project.loop = { enabled: true, startBeat: 0, endBeat: 2 };
    const context = new FakeAudioContext();
    const engine = new WebAudioPlaybackEngine(project, {
      context: context as unknown as AudioContext,
      startLatencySeconds: 0,
      scheduleAheadSeconds: 0.2,
    });
    engines.push(engine);

    await engine.play({ fromBeat: 0, loop: true });
    expect(context.oscillators.map((oscillator) => oscillator.startAt)).toEqual([10]);
    context.currentTime = 10.85;
    (engine as unknown as { tick: () => void }).tick();
    context.currentTime = 11.85;
    (engine as unknown as { tick: () => void }).tick();
    expect(context.oscillators.map((oscillator) => oscillator.startAt)).toEqual([10, 11, 12]);
  });
});
