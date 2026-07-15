import { describe, expect, it, vi } from 'vitest';
import { createBlankProject } from '../demo';
import { createDrumMidiTrackSettings, createMelodicMidiTrackSettings } from '../midi/instrument';
import { BUILTIN_CHAOS_DRUM_ASSETS } from './builtinMidiAssets';
import {
  AudioWorkletEngineError,
  AudioWorkletPlaybackEngine,
  createPlaybackEngine,
  detectAudioWorkletSupport,
} from './audioWorkletEngine';
import { WebAudioPlaybackEngine } from './playback';
import type { WorkletCommand, WorkletEvent } from './workletProtocol';

class FakePort {
  onmessage: ((event: MessageEvent<WorkletEvent>) => void) | null = null;
  readonly messages: WorkletCommand[] = [];
  readonly transfers: Transferable[][] = [];
  closed = false;
  started = false;

  postMessage(message: WorkletCommand, transfer: Transferable[] = []): void {
    this.messages.push(message);
    this.transfers.push(transfer);
  }

  start(): void { this.started = true; }
  close(): void { this.closed = true; }
  emit(event: WorkletEvent): void { this.onmessage?.({ data: event } as MessageEvent<WorkletEvent>); }
}

class FakeNode {
  readonly port = new FakePort();
  onprocessorerror: ((event: Event) => void) | null = null;
  connected = false;
  disconnected = false;

  connect<T>(destination: T): T {
    this.connected = true;
    return destination;
  }

  disconnect(): void { this.disconnected = true; }
}

class FakeContext {
  state: AudioContextState = 'suspended';
  currentTime = 10;
  readonly destination = {};
  readonly moduleUrls: string[] = [];
  readonly listeners = new Set<() => void>();
  resumeError?: Error;
  readonly audioWorklet: { addModule: (url: string) => Promise<void> };

  constructor() {
    this.audioWorklet = {
      addModule: async (url: string) => { this.moduleUrls.push(url); },
    };
  }

  async resume(): Promise<void> {
    if (this.resumeError) throw this.resumeError;
    this.state = 'running';
    this.emitStateChange();
  }

  async close(): Promise<void> {
    this.state = 'closed';
    this.emitStateChange();
  }

  decodeAudioDataImpl: (bytes: ArrayBuffer) => Promise<AudioBuffer> = async () => { throw new Error('not used'); };

  async decodeAudioData(bytes: ArrayBuffer): Promise<AudioBuffer> { return this.decodeAudioDataImpl(bytes); }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type === 'statechange') this.listeners.add(listener as () => void);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type === 'statechange') this.listeners.delete(listener as () => void);
  }

  emitStateChange(): void { for (const listener of this.listeners) listener(); }
}

const midiProject = () => {
  const project = createBlankProject({ now: '2026-07-15T00:00:00.000Z', bpm: 120 });
  project.tracks = [{
    id: 'midi-track',
    name: 'MIDI',
    kind: 'midi',
    color: '#5dd6d1',
    gain: 1,
    pan: 0,
    mute: false,
    solo: false,
    midi: createMelodicMidiTrackSettings(),
    clips: [{
      id: 'midi-clip',
      name: 'MIDI',
      kind: 'midi',
      startBeat: 0,
      durationBeats: 2,
      offsetBeats: 0,
      gain: 1,
      fadeIn: 0,
      fadeOut: 0,
      notes: [{ id: 'note', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 1 }],
      provenance: { source: 'user', createdAt: project.createdAt },
    }],
  }];
  project.loop = { enabled: false, startBeat: 0, endBeat: 2 };
  return project;
};

const drumProject = () => {
  const project = midiProject();
  const track = project.tracks[0];
  if (track.kind !== 'midi' || track.clips[0].kind !== 'midi') throw new Error('Expected MIDI fixture');
  track.midi = createDrumMidiTrackSettings();
  track.clips[0].notes[0].pitch = 36;
  return project;
};

const fakeAudioBuffer = (source = Float32Array.of(0.1, 0.05, 0)): AudioBuffer => ({
  numberOfChannels: 1,
  sampleRate: 44_100,
  duration: source.length / 44_100,
  getChannelData: () => source,
} as unknown as AudioBuffer);

const audioProject = () => {
  const project = createBlankProject({ now: '2026-07-15T00:00:00.000Z', bpm: 120 });
  project.tracks = [{
    id: 'audio-track',
    name: 'Audio',
    kind: 'audio',
    color: '#f6a84b',
    gain: 1,
    pan: 0,
    mute: false,
    solo: false,
    clips: [{
      id: 'audio-clip',
      name: 'Audio',
      kind: 'audio',
      assetId: 'asset',
      startBeat: 0,
      durationBeats: 2,
      offsetBeats: 0,
      timebase: { mode: 'fixed-seconds', sourceBpm: 120 },
      gain: 1,
      fadeIn: 0,
      fadeOut: 0,
      provenance: { source: 'user', createdAt: project.createdAt },
    }],
  }];
  return project;
};

const nodeHarness = () => {
  const nodes: FakeNode[] = [];
  const factory = () => {
    const node = new FakeNode();
    nodes.push(node);
    return node as unknown as AudioWorkletNode;
  };
  return { nodes, factory };
};

describe('AudioWorklet host engine', () => {
  it('makes unsupported capability and compatibility selection explicit', () => {
    const support = detectAudioWorkletSupport({
      isSecureContext: false,
    } as never);
    expect(support).toMatchObject({ supported: false, code: 'insecure-context' });

    expect(createPlaybackEngine(midiProject())).toBeInstanceOf(AudioWorkletPlaybackEngine);
    expect(createPlaybackEngine(midiProject(), { backend: 'web-audio-compatibility' }))
      .toBeInstanceOf(WebAudioPlaybackEngine);
  });

  it('resumes once, keeps playback alive across project and mixer sync, and consumes telemetry', async () => {
    const context = new FakeContext();
    const harness = nodeHarness();
    const positions: number[] = [];
    const states: string[] = [];
    const meters: number[] = [];
    const engine = new AudioWorkletPlaybackEngine(midiProject(), {
      context: context as unknown as AudioContext,
      nodeFactory: harness.factory,
      processorModuleUrl: '/audio-worklet.js',
      onPosition: (beat) => positions.push(beat),
      onStateChange: (state) => states.push(state),
      onMeter: (meter) => meters.push(meter.master),
    });

    await engine.play({ fromBeat: 0, toBeat: 2 });
    const node = harness.nodes[0];
    expect(context.state).toBe('running');
    expect(context.moduleUrls).toEqual(['/audio-worklet.js']);
    expect(node.connected).toBe(true);
    expect(node.port.started).toBe(true);
    expect(node.port.messages.map((message) => message.type)).toEqual(['sync-project', 'play']);

    engine.setMasterGain(0.7);
    engine.setTrackParameters('midi-track', { gain: 0.8, pan: -0.25, mute: false, solo: true });
    const changed = midiProject();
    changed.tracks[0].gain = 0.6;
    const beforeProjectSync = node.port.messages.length;
    engine.setProject(changed);
    expect(node.port.messages.slice(beforeProjectSync).map((message) => message.type)).toEqual([
      'set-master-gain',
      'set-track-parameters',
    ]);
    expect(node.port.messages.filter((message) => message.type === 'sync-project')).toHaveLength(1);
    expect(engine.getState()).toBe('playing');

    const structurallyChanged = midiProject();
    const midiTrack = structurallyChanged.tracks[0];
    if (midiTrack.kind !== 'midi' || midiTrack.clips[0].kind !== 'midi') throw new Error('Expected MIDI fixture');
    midiTrack.clips[0].notes[0].pitch = 67;
    engine.setProject(structurallyChanged);
    expect(node.port.messages.at(-1)?.type).toBe('sync-project');
    expect(engine.getState()).toBe('playing');

    node.port.emit({
      type: 'telemetry',
      state: 'playing',
      positionBeat: 0.75,
      masterPeak: 0.42,
      trackPeaks: { 'midi-track': 0.3 },
    });
    expect(positions.at(-1)).toBe(0.75);
    expect(meters.at(-1)).toBe(0.42);
    expect(states).toContain('playing');
    await engine.dispose();
  });

  it('keeps decoded candidate PCM ephemeral and unregisters it after natural audition end', async () => {
    const context = new FakeContext();
    context.decodeAudioDataImpl = async () => fakeAudioBuffer(Float32Array.of(0.1, 0.2, 0));
    const harness = nodeHarness();
    const ended = vi.fn();
    const engine = new AudioWorkletPlaybackEngine(undefined, {
      context: context as unknown as AudioContext,
      nodeFactory: harness.factory,
      processorModuleUrl: '/audio-worklet.js',
    });

    await engine.audition('candidate-a', new ArrayBuffer(8), ended);
    const node = harness.nodes[0];
    const sync = node.port.messages.find((message) => message.type === 'sync-asset');
    const start = node.port.messages.find((message) => message.type === 'audition');
    expect(sync).toMatchObject({ type: 'sync-asset' });
    expect(start).toMatchObject({ type: 'audition' });
    if (sync?.type !== 'sync-asset' || start?.type !== 'audition') throw new Error('Expected audition commands');
    expect(sync.asset.id).toBe(start.assetId);
    expect(sync.asset.id).not.toBe('candidate-a');

    node.port.emit({ type: 'audition-ended', token: start.token });
    expect(ended).toHaveBeenCalledOnce();
    expect(node.port.messages.at(-1)).toEqual({ type: 'remove-asset', assetId: sync.asset.id });
    await expect(engine.audition('candidate-a')).rejects.toMatchObject({ code: 'asset-missing' });
    await engine.dispose();
  });

  it('unregisters a replaced or stopped ephemeral audition without touching project buffers', async () => {
    const context = new FakeContext();
    context.decodeAudioDataImpl = async () => fakeAudioBuffer();
    const harness = nodeHarness();
    const engine = new AudioWorkletPlaybackEngine(undefined, {
      context: context as unknown as AudioContext,
      nodeFactory: harness.factory,
      processorModuleUrl: '/audio-worklet.js',
    });
    engine.registerAudioBuffer('project-asset', fakeAudioBuffer());
    expect(engine.hasAudioBuffer('project-asset')).toBe(true);

    await engine.audition('candidate-a', new ArrayBuffer(4));
    const firstStart = harness.nodes[0].port.messages.find((message) => message.type === 'audition');
    if (firstStart?.type !== 'audition') throw new Error('Expected first audition');
    await engine.audition('candidate-b', new ArrayBuffer(4));
    expect(harness.nodes[0].port.messages).toContainEqual({ type: 'stop-audition', token: firstStart.token });
    expect(harness.nodes[0].port.messages).toContainEqual({ type: 'remove-asset', assetId: firstStart.assetId });

    const starts = harness.nodes[0].port.messages.filter((message) => message.type === 'audition');
    const secondStart = starts.at(-1);
    if (secondStart?.type !== 'audition') throw new Error('Expected replacement audition');
    engine.stopAudition();
    expect(harness.nodes[0].port.messages.at(-2)).toEqual({ type: 'stop-audition', token: secondStart.token });
    expect(harness.nodes[0].port.messages.at(-1)).toEqual({ type: 'remove-asset', assetId: secondStart.assetId });
    expect(harness.nodes[0].port.messages).not.toContainEqual({ type: 'remove-asset', assetId: 'project-asset' });
    engine.unregisterAudioBuffer('project-asset');
    expect(engine.hasAudioBuffer('project-asset')).toBe(false);
    await engine.dispose();
  });

  it('does not synchronize or start candidate PCM when stop wins the decode race', async () => {
    const context = new FakeContext();
    let finishDecode: ((buffer: AudioBuffer) => void) | undefined;
    context.decodeAudioDataImpl = () => new Promise<AudioBuffer>((resolve) => { finishDecode = resolve; });
    const harness = nodeHarness();
    const engine = new AudioWorkletPlaybackEngine(undefined, {
      context: context as unknown as AudioContext,
      nodeFactory: harness.factory,
      processorModuleUrl: '/audio-worklet.js',
    });

    const pending = engine.audition('candidate-a', new ArrayBuffer(4));
    await vi.waitFor(() => expect(finishDecode).toBeTypeOf('function'));
    engine.stopAudition();
    finishDecode!(fakeAudioBuffer());
    await pending;
    expect(harness.nodes[0].port.messages.some((message) => message.type === 'sync-asset')).toBe(false);
    expect(harness.nodes[0].port.messages.some((message) => message.type === 'audition')).toBe(false);
    await engine.dispose();
  });

  it('decodes and synchronizes every pinned Chaos drum sample before starting playback', async () => {
    const context = new FakeContext();
    const harness = nodeHarness();
    const loaded: string[] = [];
    const engine = new AudioWorkletPlaybackEngine(drumProject(), {
      context: context as unknown as AudioContext,
      nodeFactory: harness.factory,
      processorModuleUrl: '/audio-worklet.js',
      builtinMidiAssetLoader: async (_context, source) => {
        loaded.push(source.id);
        return fakeAudioBuffer();
      },
    });

    await engine.play({ fromBeat: 0, toBeat: 2 });
    expect(loaded).toEqual(BUILTIN_CHAOS_DRUM_ASSETS.map((source) => source.id));
    expect(harness.nodes[0].port.messages.map((message) => message.type)).toEqual([
      'sync-project',
      'sync-asset',
      'sync-asset',
      'sync-asset',
      'sync-asset',
      'play',
    ]);
    expect(harness.nodes[0].port.messages
      .filter((message) => message.type === 'sync-asset')
      .map((message) => message.asset.id))
      .toEqual(BUILTIN_CHAOS_DRUM_ASSETS.map((source) => source.id));
    await engine.dispose();
  });

  it('posts a clamped MIDI audition with the project track playback-profile snapshot', async () => {
    const context = new FakeContext();
    const harness = nodeHarness();
    const project = midiProject();
    const track = project.tracks[0];
    if (track.kind !== 'midi') throw new Error('Expected MIDI fixture');
    track.midi = createMelodicMidiTrackSettings(2, 40);
    const engine = new AudioWorkletPlaybackEngine(project, {
      context: context as unknown as AudioContext,
      nodeFactory: harness.factory,
      processorModuleUrl: '/audio-worklet.js',
    });

    await engine.auditionMidiNote('midi-track', 129.7, 2, 0.001);
    expect(context.state).toBe('running');
    expect(harness.nodes[0].port.messages.map((message) => message.type)).toEqual([
      'sync-project',
      'audition-midi-note',
    ]);
    expect(harness.nodes[0].port.messages.at(-1)).toEqual({
      type: 'audition-midi-note',
      audition: {
        token: 1,
        trackId: 'midi-track',
        pitch: 127,
        velocity: 1,
        durationSeconds: 0.03,
        profile: {
          channel: 2,
          instrumentKind: 'melodic',
          instrumentId: 'WebAudio-TinySynth',
          program: 40,
        },
      },
    });

    engine.stopMidiNoteAudition();
    expect(harness.nodes[0].port.messages.at(-1)).toEqual({ type: 'stop-midi-note-audition' });
    await engine.dispose();
  });

  it('does not post a stale note when stop wins the initialization race', async () => {
    const context = new FakeContext();
    let finishModuleLoad!: () => void;
    context.audioWorklet.addModule = () => new Promise<void>((resolve) => {
      finishModuleLoad = resolve;
    });
    const harness = nodeHarness();
    const engine = new AudioWorkletPlaybackEngine(midiProject(), {
      context: context as unknown as AudioContext,
      nodeFactory: harness.factory,
      processorModuleUrl: '/audio-worklet.js',
    });

    const pending = engine.auditionMidiNote('midi-track', 60);
    engine.stopMidiNoteAudition();
    finishModuleLoad();
    await pending;
    expect(harness.nodes[0].port.messages.map((message) => message.type)).toEqual(['sync-project']);
    await engine.dispose();
  });

  it('loads pinned Chaos PCM before posting a drum-note audition', async () => {
    const context = new FakeContext();
    const harness = nodeHarness();
    const loaded: string[] = [];
    const engine = new AudioWorkletPlaybackEngine(drumProject(), {
      context: context as unknown as AudioContext,
      nodeFactory: harness.factory,
      processorModuleUrl: '/audio-worklet.js',
      builtinMidiAssetLoader: async (_context, source) => {
        loaded.push(source.id);
        return fakeAudioBuffer();
      },
    });

    await engine.auditionMidiNote('midi-track', 36);
    expect(loaded).toEqual(BUILTIN_CHAOS_DRUM_ASSETS.map((source) => source.id));
    expect(harness.nodes[0].port.messages.at(-1)).toMatchObject({
      type: 'audition-midi-note',
      audition: {
        pitch: 36,
        profile: {
          channel: 9,
          instrumentKind: 'drums',
          instrumentId: 'WebAudioFont 128_0_Chaos_sf2_file',
        },
      },
    });
    expect(harness.nodes[0].port.messages
      .filter((message) => message.type === 'sync-asset')).toHaveLength(BUILTIN_CHAOS_DRUM_ASSETS.length);
    await engine.dispose();
  });

  it('fails explicitly when a required built-in drum sample cannot be loaded', async () => {
    const context = new FakeContext();
    const harness = nodeHarness();
    const engine = new AudioWorkletPlaybackEngine(drumProject(), {
      context: context as unknown as AudioContext,
      nodeFactory: harness.factory,
      processorModuleUrl: '/audio-worklet.js',
      builtinMidiAssetLoader: async () => { throw new Error('fixture 404'); },
    });

    await expect(engine.play({ fromBeat: 0, toBeat: 2 })).rejects.toMatchObject({
      code: 'asset-load-failed',
    });
    expect(harness.nodes[0].port.messages.some((message) => message.type === 'play')).toBe(false);
    expect(engine.getState()).toBe('idle');
    await engine.dispose();
  });

  it('reports processor crashes and explicitly re-enters without reloading the module', async () => {
    const context = new FakeContext();
    const harness = nodeHarness();
    const errors: AudioWorkletEngineError[] = [];
    const engine = new AudioWorkletPlaybackEngine(midiProject(), {
      context: context as unknown as AudioContext,
      nodeFactory: harness.factory,
      processorModuleUrl: '/audio-worklet.js',
      onError: (error) => errors.push(error),
    });
    await engine.play({ fromBeat: 0, toBeat: 2 });
    harness.nodes[0].onprocessorerror?.(new Event('processorerror'));
    expect(engine.getState()).toBe('paused');
    expect(errors.at(-1)?.code).toBe('processor-crashed');

    await engine.play({ toBeat: 2 });
    expect(harness.nodes).toHaveLength(2);
    expect(context.moduleUrls).toEqual(['/audio-worklet.js']);
    expect(harness.nodes[0].disconnected).toBe(true);
    expect(harness.nodes[1].port.messages.map((message) => message.type)).toEqual(['sync-project', 'play']);
    await engine.dispose();
  });

  it('recreates an owned closed context, resynchronizes PCM, and never hides a missing asset', async () => {
    const contexts: FakeContext[] = [];
    const harness = nodeHarness();
    const createContext = () => {
      const context = new FakeContext();
      contexts.push(context);
      return context as unknown as AudioContext;
    };
    const engine = new AudioWorkletPlaybackEngine(audioProject(), {
      contextFactory: createContext,
      nodeFactory: harness.factory,
      processorModuleUrl: '/audio-worklet.js',
    });

    await expect(engine.play({ fromBeat: 0, toBeat: 2 })).rejects.toMatchObject({ code: 'asset-missing' });
    const source = Float32Array.of(0.1, 0.2, 0.3, 0.4);
    engine.registerAudioBuffer('asset', {
      numberOfChannels: 1,
      sampleRate: 4,
      duration: 1,
      getChannelData: () => source,
    } as unknown as AudioBuffer);
    await engine.play({ fromBeat: 0, toBeat: 2 });
    expect(harness.nodes[0].port.messages.map((message) => message.type)).toContain('sync-asset');
    const firstTransfer = harness.nodes[0].port.transfers.find((transfer) => transfer.length > 0);
    expect(firstTransfer).toHaveLength(1);

    await contexts[0].close();
    await engine.play({ fromBeat: 0, toBeat: 2 });
    expect(contexts).toHaveLength(2);
    expect(harness.nodes).toHaveLength(2);
    expect(harness.nodes[1].port.messages.map((message) => message.type)).toEqual([
      'sync-project',
      'sync-asset',
      'play',
    ]);
    expect(source).toEqual(Float32Array.of(0.1, 0.2, 0.3, 0.4));
    await engine.dispose();
  });

  it('resumes a suspended context and reconstructs an owned closed context on visibility re-entry', async () => {
    const contexts: FakeContext[] = [];
    const harness = nodeHarness();
    const engine = new AudioWorkletPlaybackEngine(midiProject(), {
      contextFactory: () => {
        const context = new FakeContext();
        contexts.push(context);
        return context as unknown as AudioContext;
      },
      nodeFactory: harness.factory,
      processorModuleUrl: '/audio-worklet.js',
    });

    await engine.play({ fromBeat: 0, toBeat: 2 });
    contexts[0].state = 'suspended';
    contexts[0].emitStateChange();
    await engine.reenter();
    expect(contexts[0].state).toBe('running');
    expect(harness.nodes[0].port.messages.map((message) => message.type)).toEqual([
      'sync-project',
      'play',
    ]);

    await contexts[0].close();
    expect(engine.getState()).toBe('paused');
    await engine.reenter();
    expect(contexts).toHaveLength(2);
    expect(harness.nodes).toHaveLength(2);
    expect(harness.nodes[1].port.messages.map((message) => message.type)).toEqual([
      'sync-project',
      'play',
    ]);
    expect(engine.getState()).toBe('playing');
    await engine.dispose();
  });

  it('surfaces resume rejection instead of silently switching engines', async () => {
    const context = new FakeContext();
    context.resumeError = new Error('gesture required');
    const harness = nodeHarness();
    const engine = new AudioWorkletPlaybackEngine(midiProject(), {
      context: context as unknown as AudioContext,
      nodeFactory: harness.factory,
      processorModuleUrl: '/audio-worklet.js',
    });

    await expect(engine.play({ fromBeat: 0, toBeat: 2 })).rejects.toMatchObject({
      code: 'context-resume-failed',
    });
    expect(engine.getState()).toBe('idle');
    await engine.dispose();
  });
});
