import { describe, expect, it } from 'vitest';
import { createBlankProject, createDemoProject } from '../demo';
import { createDrumMidiTrackSettings, createMelodicMidiTrackSettings } from '../midi/instrument';
import { CHAOS_DRUM_SAMPLE_NOTES, chaosDrumAssetId } from './midiInstrumentRender';
import { renderProjectToPcm } from './mixdown';
import { VibeSeqWorkletRenderer } from './workletRenderer';
import {
  allProjectAudioAssetIds,
  createWorkletProjectSnapshot,
  type WorkletAssetPayload,
  type WorkletCommand,
  type WorkletEvent,
} from './workletProtocol';

const renderFrames = (
  renderer: VibeSeqWorkletRenderer,
  frameCount: number,
  blockSize = 128,
): [Float32Array, Float32Array] => {
  const left = new Float32Array(frameCount);
  const right = new Float32Array(frameCount);
  for (let offset = 0; offset < frameCount; offset += blockSize) {
    const frames = Math.min(blockSize, frameCount - offset);
    const blockLeft = new Float32Array(frames);
    const blockRight = new Float32Array(frames);
    expect(renderer.process([blockLeft, blockRight])).toBe(true);
    left.set(blockLeft, offset);
    right.set(blockRight, offset);
  }
  return [left, right];
};

const maximumAdjacentDelta = (samples: readonly number[]): number => {
  let maximum = 0;
  for (let index = 1; index < samples.length; index += 1) {
    maximum = Math.max(maximum, Math.abs(samples[index] - samples[index - 1]));
  }
  return maximum;
};

describe('AudioWorklet project protocol', () => {
  it('serializes explicit Audio timing and track-wide MIDI instrument routing', () => {
    const project = createDemoProject({ now: '2026-07-15T00:00:00.000Z' });
    const snapshot = createWorkletProjectSnapshot(project);
    const audio = snapshot.tracks.find((track) => track.kind === 'audio')!;
    const midi = snapshot.tracks.find((track) => track.kind === 'midi')!;

    expect(audio.audioClips[0].timebase).toEqual({ mode: 'fixed-seconds', sourceBpm: 118 });
    expect(midi.midiProfile).toMatchObject({
      channel: 0,
      instrumentKind: 'melodic',
      instrumentId: 'WebAudio-TinySynth',
      program: 80,
    });
    expect(midi.midiEvents[0]).toMatchObject({
      midiChannel: 0,
      instrumentKind: 'melodic',
      instrumentId: 'WebAudio-TinySynth',
      midiProgram: 80,
    });
  });

  it('normalizes a hot-loaded legacy MIDI track before worklet sync', () => {
    const project = createDemoProject({ now: '2026-07-15T00:00:00.000Z' });
    const midi = project.tracks.find((track) => track.kind === 'midi')!;
    delete (midi as unknown as { midi?: typeof midi.midi }).midi;

    expect(createWorkletProjectSnapshot(project).tracks.find((track) => track.id === midi.id)?.midiProfile)
      .toMatchObject({ instrumentKind: 'melodic', instrumentId: 'WebAudio-TinySynth' });
  });

  it('preloads every arranged audio asset regardless of initial mute and solo state', () => {
    const project = createDemoProject({ now: '2026-07-15T00:00:00.000Z' });
    const audioTracks = project.tracks.filter((track) => track.kind === 'audio');
    const midiTrack = project.tracks.find((track) => track.kind === 'midi')!;
    for (const track of audioTracks) track.mute = true;
    midiTrack.solo = true;
    const expected = [...new Set(audioTracks.flatMap((track) => (
      track.clips.flatMap((clip) => clip.kind === 'audio' ? [clip.assetId] : [])
    )))];
    for (const track of audioTracks) for (const clip of track.clips) clip.muted = true;

    expect([...allProjectAudioAssetIds(project)]).toEqual(expected);
  });
});

describe('AudioWorklet render kernel', () => {
  it('renders a newly placed audio asset without restarting active playback', () => {
    const sampleRate = 44_100;
    const project = createBlankProject({ now: '2026-07-17T00:00:00.000Z', bpm: 60, sampleRate });
    project.loop = { enabled: true, startBeat: 0, endBeat: 2 };
    project.tracks = [{
      id: 'audio-track',
      name: 'Audio',
      kind: 'audio',
      color: '#f6a84b',
      gain: 1,
      pan: 0,
      mute: false,
      solo: false,
      clips: [],
    }];
    const renderer = new VibeSeqWorkletRenderer(sampleRate, () => undefined);
    renderer.handleCommand({ type: 'sync-project', project: createWorkletProjectSnapshot(project) });
    renderer.handleCommand({ type: 'play', fromBeat: 0, toBeat: 2, loop: true });

    expect(renderFrames(renderer, 128)[0].every((sample) => sample === 0)).toBe(true);

    renderer.handleCommand({
      type: 'sync-asset',
      asset: {
        id: 'hot-asset',
        sampleRate,
        channelData: [new Float32Array(sampleRate * 2).fill(0.5)],
      },
    });
    project.tracks[0].clips.push({
      id: 'hot-clip',
      name: 'Hot placed audio',
      kind: 'audio',
      assetId: 'hot-asset',
      startBeat: 0,
      durationBeats: 2,
      offsetBeats: 0,
      timebase: { mode: 'fixed-seconds', sourceBpm: 60 },
      gain: 1,
      fadeIn: 0,
      fadeOut: 0,
      provenance: { source: 'user', createdAt: project.createdAt },
    });
    renderer.handleCommand({ type: 'sync-project', project: createWorkletProjectSnapshot(project) });

    expect(renderFrames(renderer, 128)[0].some((sample) => Math.abs(sample) > 1e-6)).toBe(true);
  });

  it('auditions the selected TinySynth pitch/program through track and master mixer gain', () => {
    const sampleRate = 8_000;
    const project = createBlankProject({ now: '2026-07-15T00:00:00.000Z', bpm: 120 });
    project.masterGain = 0.5;
    project.tracks = [{
      id: 'preview-track',
      name: 'Preview',
      kind: 'midi',
      color: '#5dd6d1',
      gain: 0.4,
      pan: -1,
      mute: true,
      solo: false,
      midi: createMelodicMidiTrackSettings(2, 40),
      clips: [],
    }];
    const snapshot = createWorkletProjectSnapshot(project);
    const renderPreview = (pitch: number, program: number) => {
      const events: WorkletEvent[] = [];
      const renderer = new VibeSeqWorkletRenderer(sampleRate, (event) => events.push(event));
      renderer.handleCommand({ type: 'sync-project', project: snapshot });
      renderer.handleCommand({
        type: 'audition-midi-note',
        audition: {
          token: 7,
          trackId: 'preview-track',
          pitch,
          velocity: 0.9,
          durationSeconds: 0.12,
          profile: {
            channel: 2,
            instrumentKind: 'melodic',
            instrumentId: 'WebAudio-TinySynth',
            program,
          },
        },
      });
      const output = renderFrames(renderer, Math.ceil(sampleRate * 0.15));
      return { events, output };
    };

    const electricBass = renderPreview(52, 33);
    const violin = renderPreview(67, 40);
    expect(electricBass.output[0].some((sample) => Math.abs(sample) > 1e-6)).toBe(true);
    expect(electricBass.output[1].every((sample) => Math.abs(sample) < 1e-8)).toBe(true);
    expect([...electricBass.output[0], ...electricBass.output[1]].every(Number.isFinite)).toBe(true);
    expect(electricBass.output[0]).not.toEqual(violin.output[0]);
    expect(electricBass.events.filter((event) => event.type === 'midi-audition-ended'))
      .toEqual([{ type: 'midi-audition-ended', token: 7 }]);
    expect(electricBass.output[0].slice(Math.ceil(sampleRate * 0.125)).every((sample) => sample === 0))
      .toBe(true);
  });

  it('auditions the mapped pinned Chaos drum asset with bounded finite output', () => {
    const sampleRate = 4_000;
    const project = createBlankProject({ now: '2026-07-15T00:00:00.000Z', bpm: 120 });
    project.tracks = [{
      id: 'drum-preview',
      name: 'Drums',
      kind: 'midi',
      color: '#5dd6d1',
      gain: 1,
      pan: 0,
      mute: false,
      solo: false,
      midi: createDrumMidiTrackSettings(),
      clips: [],
    }];
    const events: WorkletEvent[] = [];
    const renderer = new VibeSeqWorkletRenderer(sampleRate, (event) => events.push(event));
    renderer.handleCommand({ type: 'sync-project', project: createWorkletProjectSnapshot(project) });
    renderer.handleCommand({
      type: 'sync-asset',
      asset: {
        id: chaosDrumAssetId(38),
        sampleRate,
        channelData: [Float32Array.from({ length: 320 }, (_, frame) => Math.exp(-frame / 80))],
      },
    });
    renderer.handleCommand({
      type: 'audition-midi-note',
      audition: {
        token: 9,
        trackId: 'drum-preview',
        pitch: 38,
        velocity: 0.75,
        durationSeconds: 2,
        profile: {
          channel: 9,
          instrumentKind: 'drums',
          instrumentId: 'WebAudioFont 128_0_Chaos_sf2_file',
        },
      },
    });

    const output = renderFrames(renderer, 500);
    expect(output[0].some((sample) => Math.abs(sample) > 1e-5)).toBe(true);
    expect([...output[0], ...output[1]].every(Number.isFinite)).toBe(true);
    expect(output[0].slice(330).every((sample) => sample === 0)).toBe(true);
    expect(events).toContainEqual({ type: 'midi-audition-ended', token: 9 });
    expect(events.some((event) => event.type === 'error')).toBe(false);
  });

  it('releases MIDI preview without stopping an independent candidate-audio audition', () => {
    const sampleRate = 2_000;
    const project = createBlankProject({ now: '2026-07-15T00:00:00.000Z', bpm: 120 });
    project.tracks = [{
      id: 'preview-track',
      name: 'Preview',
      kind: 'midi',
      color: '#5dd6d1',
      gain: 1,
      pan: 0,
      mute: false,
      solo: false,
      midi: createMelodicMidiTrackSettings(0, 0),
      clips: [],
    }];
    const events: WorkletEvent[] = [];
    const renderer = new VibeSeqWorkletRenderer(sampleRate, (event) => events.push(event));
    renderer.handleCommand({ type: 'sync-project', project: createWorkletProjectSnapshot(project) });
    renderer.handleCommand({
      type: 'sync-asset',
      asset: { id: 'candidate', sampleRate, channelData: [new Float32Array(sampleRate).fill(0.2)] },
    });
    renderer.handleCommand({ type: 'audition', assetId: 'candidate', token: 3 });
    renderer.handleCommand({
      type: 'audition-midi-note',
      audition: {
        token: 11,
        trackId: 'preview-track',
        pitch: 60,
        velocity: 0.8,
        durationSeconds: 1,
        profile: {
          channel: 0,
          instrumentKind: 'melodic',
          instrumentId: 'WebAudio-TinySynth',
          program: 0,
        },
      },
    });
    renderFrames(renderer, 80);
    renderer.handleCommand({ type: 'stop-midi-note-audition' });
    const release = renderFrames(renderer, 100);

    expect([...release[0], ...release[1]].every(Number.isFinite)).toBe(true);
    expect(events.filter((event) => event.type === 'midi-audition-ended'))
      .toEqual([{ type: 'midi-audition-ended', token: 11 }]);
    const candidateOnly = renderFrames(renderer, 40)[0];
    expect(candidateOnly.every((sample) => sample > 0.1)).toBe(true);
    renderer.handleCommand({ type: 'stop-audition' });
    expect(renderFrames(renderer, 20)[0].every((sample) => sample === 0)).toBe(true);
  });

  it('matches deterministic offline Audio and MIDI sample-domain rendering', async () => {
    const sampleRate = 44_100;
    const project = createBlankProject({ now: '2026-07-15T00:00:00.000Z', bpm: 120, sampleRate });
    project.masterGain = 0.75;
    project.tracks = [
      {
        id: 'audio-track',
        name: 'Audio',
        kind: 'audio',
        color: '#f6a84b',
        gain: 0.8,
        pan: -0.2,
        mute: false,
        solo: false,
        clips: [{
          id: 'audio-clip',
          name: 'Audio',
          kind: 'audio',
          assetId: 'audio-asset',
          startBeat: 0,
          durationBeats: 0.5,
          offsetBeats: 0,
          timebase: { mode: 'fixed-seconds', sourceBpm: 120 },
          gain: 0.9,
          fadeIn: 0.02,
          fadeOut: 0.03,
          provenance: { source: 'user', createdAt: project.createdAt },
        }],
      },
      {
        id: 'midi-track',
        name: 'MIDI',
        kind: 'midi',
        color: '#5dd6d1',
        gain: 0.7,
        pan: 0.3,
        mute: false,
        solo: false,
        midi: createMelodicMidiTrackSettings(2, 40),
        clips: [{
          id: 'midi-clip',
          name: 'MIDI',
          kind: 'midi',
          startBeat: 0,
          durationBeats: 0.5,
          offsetBeats: 0,
          gain: 0.85,
          fadeIn: 0.01,
          fadeOut: 0.02,
          notes: [{ id: 'note', pitch: 64, startBeat: 0.05, durationBeats: 0.35, velocity: 0.72 }],
          provenance: { source: 'user', createdAt: project.createdAt },
        }],
      },
    ];
    const frameCount = Math.round(((0.5 * 60) / project.bpm) * sampleRate);
    const source = Float32Array.from(
      { length: frameCount + 2 },
      (_, frame) => Math.sin((2 * Math.PI * 180 * frame) / sampleRate) * 0.4,
    );
    const asset: WorkletAssetPayload = { id: 'audio-asset', sampleRate, channelData: [source] };
    const events: WorkletEvent[] = [];
    const renderer = new VibeSeqWorkletRenderer(sampleRate, (event) => events.push(event));
    renderer.handleCommand({ type: 'sync-project', project: createWorkletProjectSnapshot(project) });
    renderer.handleCommand({ type: 'sync-asset', asset });
    renderer.handleCommand({ type: 'play', fromBeat: 0, toBeat: 0.5, loop: false });

    const realtime = renderFrames(renderer, frameCount);
    const offline = await renderProjectToPcm(project, new Map([['audio-asset', asset]]), {
      sampleRate,
      fromBeat: 0,
      toBeat: 0.5,
      protectPeaks: false,
    });

    for (const frame of [0, 1, 97, 1_111, Math.floor(frameCount / 2), frameCount - 32]) {
      expect(realtime[0][frame]).toBeCloseTo(offline.channelData[0][frame], 5);
      expect(realtime[1][frame]).toBeCloseTo(offline.channelData[1][frame], 5);
    }
    expect(events.some((event) => event.type === 'ended')).toBe(true);
  });

  it('keeps realtime/offline parity when rendering begins inside a TinySynth release tail', async () => {
    const sampleRate = 44_100;
    const project = createBlankProject({ now: '2026-07-15T00:00:00.000Z', bpm: 60, sampleRate });
    project.masterGain = 1;
    project.tracks = [{
      id: 'tail-track',
      name: 'Tail',
      kind: 'midi',
      color: '#5dd6d1',
      gain: 1,
      pan: -1,
      mute: false,
      solo: false,
      midi: createMelodicMidiTrackSettings(0, 8),
      clips: [{
        id: 'tail-clip',
        name: 'Tail',
        kind: 'midi',
        startBeat: 0,
        durationBeats: 1,
        offsetBeats: 0,
        gain: 1,
        fadeIn: 0,
        fadeOut: 0,
        notes: [{ id: 'release-note', pitch: 60, startBeat: 0, durationBeats: 0.1, velocity: 0.8 }],
        provenance: { source: 'user', createdAt: project.createdAt },
      }],
    }];
    const fromBeat = 0.15;
    const toBeat = 0.25;
    const frameCount = Math.round((toBeat - fromBeat) * sampleRate);
    const renderer = new VibeSeqWorkletRenderer(sampleRate);
    renderer.handleCommand({ type: 'sync-project', project: createWorkletProjectSnapshot(project) });
    renderer.handleCommand({ type: 'play', fromBeat, toBeat, loop: false });
    const realtime = renderFrames(renderer, frameCount);
    const offline = await renderProjectToPcm(project, new Map(), {
      sampleRate,
      fromBeat,
      toBeat,
      protectPeaks: false,
    });

    expect(offline.channelData[0].some((sample) => Math.abs(sample) > 1e-5)).toBe(true);
    for (const frame of [0, 17, 101, 997, frameCount - 1]) {
      expect(realtime[0][frame]).toBeCloseTo(offline.channelData[0][frame], 5);
      expect(realtime[1][frame]).toBeCloseTo(offline.channelData[1][frame], 5);
    }
  });

  it('keeps a long TinySynth release audible past four seconds in realtime and offline render', async () => {
    const sampleRate = 44_100;
    const project = createBlankProject({ now: '2026-07-15T00:00:00.000Z', bpm: 60, sampleRate });
    project.masterGain = 1;
    project.tracks = [{
      id: 'long-tail-track',
      name: 'Long tail',
      kind: 'midi',
      color: '#5dd6d1',
      gain: 1,
      pan: -1,
      mute: false,
      solo: false,
      midi: createMelodicMidiTrackSettings(0, 14),
      clips: [{
        id: 'long-tail-clip',
        name: 'Long tail',
        kind: 'midi',
        startBeat: 0,
        durationBeats: 9,
        offsetBeats: 0,
        gain: 1,
        fadeIn: 0,
        fadeOut: 0,
        notes: [{ id: 'long-release-note', pitch: 60, startBeat: 0, durationBeats: 0.1, velocity: 0.8 }],
        provenance: { source: 'user', createdAt: project.createdAt },
      }],
    }];
    const fromBeat = 5;
    const toBeat = 5.02;
    const frameCount = Math.round((toBeat - fromBeat) * sampleRate);
    const renderer = new VibeSeqWorkletRenderer(sampleRate);
    renderer.handleCommand({ type: 'sync-project', project: createWorkletProjectSnapshot(project) });
    renderer.handleCommand({ type: 'play', fromBeat, toBeat, loop: false });
    const realtime = renderFrames(renderer, frameCount);
    const offline = await renderProjectToPcm(project, new Map(), {
      sampleRate,
      fromBeat,
      toBeat,
      protectPeaks: false,
    });

    expect(realtime[0].some((sample) => Math.abs(sample) > 1e-5)).toBe(true);
    for (const frame of [0, 17, 101, 509, frameCount - 1]) {
      expect(realtime[0][frame]).toBeCloseTo(offline.channelData[0][frame], 5);
      expect(realtime[1][frame]).toBeCloseTo(offline.channelData[1][frame], 5);
    }
  });

  it('matches offline rendering for the compact WebAudioFont Chaos drum samples', async () => {
    const sampleRate = 44_100;
    const project = createBlankProject({ now: '2026-07-15T00:00:00.000Z', bpm: 120, sampleRate });
    project.masterGain = 0.8;
    project.tracks = [{
      id: 'drum-track',
      name: 'Drums',
      kind: 'midi',
      midi: createDrumMidiTrackSettings(),
      color: '#5dd6d1',
      gain: 0.75,
      pan: -0.15,
      mute: false,
      solo: false,
      clips: [{
        id: 'drum-clip',
        name: 'Drums',
        kind: 'midi',
        startBeat: 0,
        durationBeats: 0.5,
        offsetBeats: 0,
        gain: 0.9,
        fadeIn: 0.005,
        fadeOut: 0.015,
        notes: [
          { id: 'kick', pitch: 36, startBeat: 0.02, durationBeats: 0.08, velocity: 0.9 },
          { id: 'hat', pitch: 42, startBeat: 0.25, durationBeats: 0.04, velocity: 0.7 },
        ],
        provenance: { source: 'user', createdAt: project.createdAt },
      }],
    }];
    const instrumentAssets = new Map<string, WorkletAssetPayload>();
    for (const note of CHAOS_DRUM_SAMPLE_NOTES) {
      const source = Float32Array.from({ length: sampleRate / 4 }, (_, frame) => (
        Math.sin((2 * Math.PI * (70 + note) * frame) / sampleRate) * Math.exp(-frame / 1_800)
      ));
      instrumentAssets.set(chaosDrumAssetId(note), {
        id: chaosDrumAssetId(note),
        sampleRate,
        channelData: [source],
      });
    }
    const renderer = new VibeSeqWorkletRenderer(sampleRate);
    renderer.handleCommand({ type: 'sync-project', project: createWorkletProjectSnapshot(project) });
    for (const asset of instrumentAssets.values()) renderer.handleCommand({ type: 'sync-asset', asset });
    renderer.handleCommand({ type: 'play', fromBeat: 0, toBeat: 0.5, loop: false });
    const frameCount = Math.round(0.25 * sampleRate);
    const realtime = renderFrames(renderer, frameCount);
    const offline = await renderProjectToPcm(project, instrumentAssets, {
      sampleRate,
      fromBeat: 0,
      toBeat: 0.5,
      protectPeaks: false,
    });

    expect(realtime[0].some((sample) => Math.abs(sample) > 1e-5)).toBe(true);
    for (const frame of [0, 901, 2_111, 5_700, frameCount - 64]) {
      expect(realtime[0][frame]).toBeCloseTo(offline.channelData[0][frame], 5);
      expect(realtime[1][frame]).toBeCloseTo(offline.channelData[1][frame], 5);
    }
  });

  it('preserves 120 BPM source consumption across 60/120/240 BPM at 44.1/48 kHz', () => {
    for (const sampleRate of [44_100, 48_000] as const) {
      for (const bpm of [60, 120, 240]) {
        const project = createBlankProject({ now: '2026-07-15T00:00:00.000Z', bpm, sampleRate });
        project.masterGain = 1;
        project.tracks = [{
          id: 'follow-track',
          name: 'Follow',
          kind: 'audio',
          color: '#f6a84b',
          gain: 1,
          pan: -1,
          mute: false,
          solo: false,
          clips: [{
            id: 'follow-clip',
            name: 'Follow',
            kind: 'audio',
            assetId: 'follow-asset',
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
        const sourceFrames = sampleRate * 4;
        const source = Float32Array.from(
          { length: sourceFrames },
          (_, frame) => 0.1 + (frame / (sourceFrames - 1)) * 0.4,
        );
        const renderer = new VibeSeqWorkletRenderer(sampleRate);
        renderer.handleCommand({ type: 'sync-project', project: createWorkletProjectSnapshot(project) });
        renderer.handleCommand({
          type: 'sync-asset',
          asset: { id: 'follow-asset', sampleRate, channelData: [source] },
        });
        renderer.handleCommand({ type: 'play', fromBeat: 0, toBeat: 8, loop: false });

        const outputFrames = Math.round(((8 * 60) / bpm) * sampleRate);
        const [left] = renderFrames(renderer, outputFrames);
        expect(left[0]).toBeCloseTo(0.1, 6);
        expect(left.at(-1)).toBeGreaterThan(0.48);
        expect(renderer.getPositionBeat()).toBeCloseTo(8, 7);
      }
    }
  });

  it('applies mixer commands and seek/loop without stopping or rebuilding transport', () => {
    const project = createBlankProject({ now: '2026-07-15T00:00:00.000Z', bpm: 60 });
    project.masterGain = 1;
    project.loop = { enabled: true, startBeat: 0.2, endBeat: 0.4 };
    project.tracks = [{
      id: 'track',
      name: 'Track',
      kind: 'audio',
      color: '#fff',
      gain: 1,
      pan: -1,
      mute: false,
      solo: false,
      clips: [{
        id: 'clip',
        name: 'Clip',
        kind: 'audio',
        assetId: 'asset',
        startBeat: 0,
        durationBeats: 2,
        offsetBeats: 0,
        timebase: { mode: 'fixed-seconds', sourceBpm: 60 },
        gain: 1,
        fadeIn: 0,
        fadeOut: 0,
        provenance: { source: 'user', createdAt: project.createdAt },
      }],
    }];
    const renderer = new VibeSeqWorkletRenderer(1_000);
    const commands: WorkletCommand[] = [
      { type: 'sync-project', project: createWorkletProjectSnapshot(project) },
      { type: 'sync-asset', asset: { id: 'asset', sampleRate: 1_000, channelData: [new Float32Array(2_000).fill(1)] } },
      { type: 'play', fromBeat: 0, toBeat: 0.4, loop: true },
    ];
    commands.forEach((command) => renderer.handleCommand(command));
    renderFrames(renderer, 300);
    expect(renderer.getPositionBeat()).toBeCloseTo(0.3, 6);

    renderer.handleCommand({ type: 'seek', positionBeat: 0.35 });
    const audible = renderFrames(renderer, 10)[0];
    expect(audible.every((sample) => sample > 0.99)).toBe(true);
    expect(renderer.getPositionBeat()).toBeCloseTo(0.36, 6);

    renderer.handleCommand({ type: 'set-track-parameters', trackId: 'track', parameters: { mute: true } });
    const muteRamp = renderFrames(renderer, 10)[0];
    expect(muteRamp[0]).toBeGreaterThan(muteRamp.at(-1)!);
    expect(muteRamp.slice(5).every((sample) => sample === 0)).toBe(true);
    expect(renderer.getState()).toBe('playing');

    renderer.handleCommand({ type: 'set-track-parameters', trackId: 'track', parameters: { mute: false } });
    renderer.handleCommand({ type: 'set-master-gain', gain: 0 });
    const faded = renderFrames(renderer, 50)[0];
    expect(faded[0]).toBeGreaterThan(faded.at(-1)!);
    expect(faded.at(-1)).toBeLessThan(0.01);
    expect(renderer.getState()).toBe('playing');
  });

  it('uses a finite 5 ms live track gate for mute/solo while offline export applies final state from frame zero', async () => {
    const sampleRate = 48_000;
    const project = createBlankProject({ now: '2026-07-15T00:00:00.000Z', bpm: 60, sampleRate });
    project.masterGain = 1;
    project.tracks = [
      {
        id: 'quiet-track',
        name: 'Quiet',
        kind: 'audio',
        color: '#fff',
        gain: 1,
        pan: -1,
        mute: false,
        solo: false,
        clips: [{
          id: 'quiet-clip',
          name: 'Quiet',
          kind: 'audio',
          assetId: 'quiet-asset',
          startBeat: 0,
          durationBeats: 1,
          offsetBeats: 0,
          timebase: { mode: 'fixed-seconds', sourceBpm: 60 },
          gain: 1,
          fadeIn: 0,
          fadeOut: 0,
          provenance: { source: 'user', createdAt: project.createdAt },
        }],
      },
      {
        id: 'loud-track',
        name: 'Loud',
        kind: 'audio',
        color: '#fff',
        gain: 1,
        pan: -1,
        mute: false,
        solo: false,
        clips: [{
          id: 'loud-clip',
          name: 'Loud',
          kind: 'audio',
          assetId: 'loud-asset',
          startBeat: 0,
          durationBeats: 1,
          offsetBeats: 0,
          timebase: { mode: 'fixed-seconds', sourceBpm: 60 },
          gain: 1,
          fadeIn: 0,
          fadeOut: 0,
          provenance: { source: 'user', createdAt: project.createdAt },
        }],
      },
    ];
    const assets = new Map<string, WorkletAssetPayload>([
      ['quiet-asset', { id: 'quiet-asset', sampleRate, channelData: [new Float32Array(sampleRate).fill(0.25)] }],
      ['loud-asset', { id: 'loud-asset', sampleRate, channelData: [new Float32Array(sampleRate).fill(0.75)] }],
    ]);
    const renderer = new VibeSeqWorkletRenderer(sampleRate);
    renderer.handleCommand({ type: 'sync-project', project: createWorkletProjectSnapshot(project) });
    for (const asset of assets.values()) renderer.handleCommand({ type: 'sync-asset', asset });
    renderer.handleCommand({ type: 'play', fromBeat: 0, toBeat: 1, loop: false });
    const steady = renderFrames(renderer, 64)[0];
    expect(steady.at(-1)).toBeCloseTo(1, 7);

    renderer.handleCommand({ type: 'set-track-parameters', trackId: 'quiet-track', parameters: { mute: true } });
    const liveMuteStart = renderFrames(renderer, 96)[0];
    expect(liveMuteStart[0]).toBeGreaterThan(0.99);
    expect(liveMuteStart.at(-1)).toBeCloseTo(0.9, 6);
    expect(maximumAdjacentDelta([steady.at(-1)!, ...liveMuteStart])).toBeLessThan(0.0011);

    // Reverse before the first ramp completes. The new ramp starts at the
    // current gate value, so no endpoint jump is introduced.
    renderer.handleCommand({ type: 'set-track-parameters', trackId: 'quiet-track', parameters: { mute: false } });
    const rapidReverse = renderFrames(renderer, 240)[0];
    expect(Math.abs(rapidReverse[0] - liveMuteStart.at(-1)!)).toBeLessThan(0.001);
    expect(rapidReverse.at(-1)).toBeCloseTo(1, 6);

    renderer.handleCommand({ type: 'set-track-parameters', trackId: 'loud-track', parameters: { solo: true } });
    const soloRamp = renderFrames(renderer, 240)[0];
    expect(soloRamp[0]).toBeGreaterThan(0.99);
    expect(soloRamp.at(-1)).toBeCloseTo(0.75, 6);
    expect(maximumAdjacentDelta([rapidReverse.at(-1)!, ...soloRamp])).toBeLessThan(0.0011);

    // Offline export has no live control transition to smooth. It intentionally
    // renders the persisted final mute/solo decision exactly from frame zero.
    project.tracks[0].mute = true;
    const offline = await renderProjectToPcm(project, assets, {
      sampleRate,
      fromBeat: 0,
      toBeat: 0.005,
      protectPeaks: false,
    });
    expect(offline.channelData[0].every((sample) => Math.abs(sample - 0.75) < 1e-7)).toBe(true);
  });
});
