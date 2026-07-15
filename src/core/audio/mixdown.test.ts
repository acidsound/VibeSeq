import { describe, expect, it } from 'vitest';
import { createBlankProject, createDemoProject } from '../demo';
import {
  equalPowerPanGains,
  linearEdgeEnvelopeFactor,
} from './midiSynth';
import { tinySynthNoiseSeed, tinySynthSampleAtTime } from './midiInstrumentRender';
import { buildPlaybackPlan } from './playback';
import { encodeWav, estimateInterSamplePeak, renderProjectToPcm } from './mixdown';
import { webAudioStereoPanMatrix } from './panning';

const readInt24Le = (view: DataView, offset: number): number => {
  const value = view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16);
  return value & 0x80_0000 ? value - 0x100_0000 : value;
};

describe('offline mixdown', () => {
  it('matches StereoPannerNode stereo-input output at 44.1 and 48 kHz', async () => {
    for (const sampleRate of [44_100, 48_000] as const) {
      for (const pan of [-1, -0.5, 0, 0.5, 1]) {
        const project = createBlankProject({ now: '2026-07-15T00:00:00.000Z', bpm: 60, sampleRate })
        project.masterGain = 1
        project.tracks = [{
          id: 'stereo-pan-track',
          name: 'Stereo pan fixture',
          kind: 'audio',
          color: '#f6a84b',
          gain: 1,
          pan,
          mute: false,
          solo: false,
          clips: [{
            id: 'stereo-pan-clip',
            name: 'Stereo pan fixture',
            kind: 'audio',
            assetId: 'stereo-pan-asset',
            startBeat: 0,
            durationBeats: 4 / sampleRate,
            offsetBeats: 0,
            timebase: { mode: 'fixed-seconds', sourceBpm: 60 },
            gain: 1,
            fadeIn: 0,
            fadeOut: 0,
            provenance: { source: 'user', createdAt: project.createdAt },
          }],
        }]
        const rendered = await renderProjectToPcm(project, new Map([['stereo-pan-asset', {
          id: 'stereo-pan-asset',
          sampleRate,
          channelData: [Float32Array.of(0.5, -0.25, 0.75, -0.125), Float32Array.of(0.25, 0.5, -0.125, -0.75)],
        }]]), {
          sampleRate,
          fromBeat: 0,
          toBeat: 4 / sampleRate,
          protectPeaks: false,
        })
        const matrix = webAudioStereoPanMatrix(pan)
        expect(rendered.channelData[0][0]).toBeCloseTo(0.5 * matrix.leftFromLeft + 0.25 * matrix.leftFromRight, 7)
        expect(rendered.channelData[1][0]).toBeCloseTo(0.5 * matrix.rightFromLeft + 0.25 * matrix.rightFromRight, 7)
      }
    }
  })

  it('renders MIDI on the CPU and writes a valid PCM WAV', async () => {
    const project = createDemoProject({ now: '2026-07-15T00:00:00.000Z' });
    project.tracks = project.tracks.filter((track) => track.kind === 'midi');
    const rendered = await renderProjectToPcm(project, new Map(), {
      sampleRate: 44_100,
      fromBeat: 0,
      toBeat: 2,
    });
    expect(rendered.channelData[0].some((sample) => sample !== 0)).toBe(true);
    const wav = encodeWav(rendered.channelData, rendered.sampleRate, { bitDepth: 16 });
    const bytes = new Uint8Array(wav);
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...bytes.slice(8, 12))).toBe('WAVE');
    expect(wav.byteLength).toBe(44 + rendered.channelData[0].length * 2 * 2);
  });

  it('renders muted regions as silence in the full-mix export', async () => {
    const project = createDemoProject({ now: '2026-07-15T00:00:00.000Z' });
    project.tracks = project.tracks.filter((track) => track.kind === 'midi');
    for (const track of project.tracks) {
      for (const clip of track.clips) clip.muted = true;
    }
    const rendered = await renderProjectToPcm(project, new Map(), {
      sampleRate: 44_100,
      fromBeat: 0,
      toBeat: 2,
      protectPeaks: false,
    });

    expect(rendered.peak).toBe(0);
    expect(rendered.channelData.every((channel) => channel.every((sample) => sample === 0))).toBe(true);
  });

  it('does not silently omit an audio asset from a production export', async () => {
    const project = createDemoProject({ now: '2026-07-15T00:00:00.000Z' });
    await expect(
      renderProjectToPcm(project, new Map(), { sampleRate: 44_100, fromBeat: 0, toBeat: 1 }),
    ).rejects.toThrow('asset-dream-drift');
  });

  it('mixes decoded audio clips as well as synthesized MIDI', async () => {
    const project = createDemoProject({ now: '2026-07-15T00:00:00.000Z' });
    project.tracks = project.tracks.filter((track) => track.id === 'track-atmosphere');
    const source = Float32Array.from({ length: 44_100 }, (_, frame) => Math.sin((2 * Math.PI * 220 * frame) / 44_100));
    const rendered = await renderProjectToPcm(
      project,
      new Map([['asset-dream-drift', { id: 'asset-dream-drift', sampleRate: 44_100, channelData: [source] }]]),
      { sampleRate: 44_100, fromBeat: 0, toBeat: 1 },
    );
    expect(rendered.peak).toBeGreaterThan(0.1);
    expect(rendered.channelData[0][0]).toBe(0);
    expect(rendered.channelData[1].some((sample) => sample !== 0)).toBe(true);
  });

  it('renders repeated audio source cycles with the same mapping as the live plan', async () => {
    const project = createBlankProject({ now: '2026-07-15T00:00:00.000Z', bpm: 60 });
    project.masterGain = 1;
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
    const source = Float32Array.of(0.2, 0.4, 0.6, 0.8, 0.2);
    const rendered = await renderProjectToPcm(project, new Map([['audio-loop-asset', {
      id: 'audio-loop-asset',
      sampleRate: 4,
      channelData: [source],
    }]]), {
      sampleRate: 44_100,
      fromBeat: 0,
      toBeat: 2.5,
      channelCount: 1,
      protectPeaks: false,
    });
    const liveEvents = buildPlaybackPlan(project, { fromBeat: 0, toBeat: 2.5 }).events
      .filter((event) => event.kind === 'audio');
    expect(liveEvents.map((event) => [event.whenSeconds, event.durationSeconds, event.offsetSeconds])).toEqual([
      [0, 1, 0],
      [1, 1, 0],
      [2, 0.5, 0],
    ]);
    expect(rendered.channelData[0][0]).toBeCloseTo(0.2, 6);
    expect(rendered.channelData[0][44_100]).toBeCloseTo(rendered.channelData[0][0], 6);
    expect(rendered.channelData[0][88_200]).toBeCloseTo(rendered.channelData[0][0], 6);
    expect(rendered.channelData[0]).toHaveLength(Math.round(2.5 * 44_100));
  });

  it('renders tempo-follow Audio across 60/120/240 BPM at both production sample rates', async () => {
    for (const sampleRate of [44_100, 48_000] as const) {
      for (const bpm of [60, 120, 240]) {
        const project = createBlankProject({
          now: '2026-07-15T00:00:00.000Z',
          bpm,
          sampleRate,
        });
        project.masterGain = 1;
        project.tracks = [{
          id: 'tempo-follow-track',
          name: 'Tempo follow',
          kind: 'audio',
          color: '#f6a84b',
          gain: 1,
          pan: 0,
          mute: false,
          solo: false,
          clips: [{
            id: 'tempo-follow-clip',
            name: '120 BPM source',
            kind: 'audio',
            assetId: 'tempo-follow-asset',
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

        const rendered = await renderProjectToPcm(project, new Map([['tempo-follow-asset', {
          id: 'tempo-follow-asset',
          sampleRate,
          channelData: [source],
        }]]), {
          sampleRate,
          fromBeat: 0,
          toBeat: 8,
          channelCount: 1,
          protectPeaks: false,
        });

        const expectedDurationSeconds = (8 * 60) / bpm;
        const output = rendered.channelData[0];
        expect(output).toHaveLength(Math.round(expectedDurationSeconds * sampleRate));
        expect(rendered.durationSeconds).toBe(expectedDurationSeconds);
        for (const progress of [0, 0.25, 0.75, 0.999]) {
          const outputFrame = Math.min(output.length - 1, Math.floor(output.length * progress));
          const sourceFrame = outputFrame * (bpm / 120);
          const expected = 0.1 + (sourceFrame / (sourceFrames - 1)) * 0.4;
          expect(output[outputFrame]).toBeCloseTo(expected, 5);
        }
        expect(output.at(-1)).toBeGreaterThan(0.49);
      }
    }
  });

  it('renders repeated MIDI deterministically, including a partial last note', async () => {
    const project = createBlankProject({ now: '2026-07-15T00:00:00.000Z', bpm: 60 });
    project.masterGain = 1;
    project.tracks = [{
      id: 'midi-loop-track',
      name: 'MIDI loop',
      kind: 'midi',
      midi: { channel: 0, instrument: { kind: 'melodic', playbackId: 'WebAudio-TinySynth', program: 0 } },
      color: '#5dd6d1',
      gain: 1,
      pan: 0,
      mute: false,
      solo: false,
      clips: [{
        id: 'midi-loop-clip',
        name: 'MIDI loop',
        kind: 'midi',
        startBeat: 0,
        durationBeats: 2.5,
        offsetBeats: 0,
        sourceLoop: { cycleStartBeat: 0, cycleLengthBeats: 1, phaseBeats: 0 },
        gain: 1,
        fadeIn: 0,
        fadeOut: 0,
        notes: [{ id: 'pulse', pitch: 60, startBeat: 0.25, durationBeats: 0.5, velocity: 1 }],
        provenance: { source: 'user', createdAt: project.createdAt },
      }],
    }];
    const first = await renderProjectToPcm(project, new Map(), {
      fromBeat: 0,
      toBeat: 2.5,
      channelCount: 1,
      protectPeaks: false,
    });
    const second = await renderProjectToPcm(project, new Map(), {
      fromBeat: 0,
      toBeat: 2.5,
      channelCount: 1,
      protectPeaks: false,
    });
    expect(second.channelData[0]).toEqual(first.channelData[0]);
    const onsetFrame = Math.round(0.25 * first.sampleRate);
    const repeatFrame = Math.round(1.25 * first.sampleRate);
    for (const offset of [1, 17, 211, 1_337]) {
      expect(first.channelData[0][repeatFrame + offset]).toBeCloseTo(first.channelData[0][onsetFrame + offset], 5);
    }
    expect(first.channelData[0].slice(Math.round(2.25 * first.sampleRate)).some((sample) => sample !== 0)).toBe(true);
  });

  it('matches the shared TinySynth instrument contract after a mid-note seek', async () => {
    const project = createDemoProject({ now: '2026-07-15T00:00:00.000Z' });
    project.bpm = 60;
    project.masterGain = 0.9;
    project.tracks = project.tracks.filter((track) => track.id === 'track-lead-midi');
    const track = project.tracks[0];
    track.gain = 0.8;
    track.pan = 0.25;
    const clip = track.clips[0];
    if (clip.kind !== 'midi') throw new Error('Expected MIDI test fixture');
    clip.startBeat = 0;
    clip.durationBeats = 2;
    clip.offsetBeats = 0;
    clip.gain = 0.75;
    clip.fadeIn = 0.5;
    clip.fadeOut = 0.5;
    clip.notes = [{ id: 'note-parity', pitch: 61, startBeat: 0, durationBeats: 2, velocity: 0.7 }];

    const sampleRate = 44_100;
    const fromBeat = 0.123;
    const toBeat = 1.777;
    const rendered = await renderProjectToPcm(project, new Map(), {
      sampleRate,
      fromBeat,
      toBeat,
      protectPeaks: false,
    });
    if (track.kind !== 'midi' || clip.kind !== 'midi') throw new Error('Expected routed MIDI test fixture');
    const program = track.midi.instrument.kind === 'melodic' ? track.midi.instrument.program : 0;
    const [leftPan, rightPan] = equalPowerPanGains(track.pan, 2);

    for (const frame of [0, 777, 4_321, rendered.channelData[0].length - 1]) {
      const absoluteBeat = fromBeat + frame / sampleRate;
      const noteSeconds = absoluteBeat;
      const clipEnvelope = linearEdgeEnvelopeFactor(absoluteBeat, clip.durationBeats, clip.fadeIn, clip.fadeOut);
      const mono = tinySynthSampleAtTime({
        program,
        pitch: 61,
        velocity: 0.7,
        noteSeconds,
        noteDurationSeconds: 2,
        sampleRate,
        noiseSeed: tinySynthNoiseSeed('note-parity', 61, 0),
      }) * project.masterGain * track.gain * clip.gain * clipEnvelope;
      expect(rendered.channelData[0][frame]).toBeCloseTo(mono * leftPan, 5);
      expect(rendered.channelData[1][frame]).toBeCloseTo(mono * rightPan, 5);
    }
  });

  it('uses the explicit project or selected sample rate with an exact rounded frame count', async () => {
    const project = createDemoProject({ now: '2026-07-15T00:00:00.000Z', sampleRate: 48_000 });
    project.tracks = [];
    project.bpm = 123;
    const durationSeconds = (7 * 60) / project.bpm;

    const projectRate = await renderProjectToPcm(project, new Map(), { fromBeat: 0, toBeat: 7 });
    expect(projectRate.sampleRate).toBe(48_000);
    expect(projectRate.channelData[0]).toHaveLength(Math.round(durationSeconds * 48_000));

    const selectedRate = await renderProjectToPcm(project, new Map(), {
      sampleRate: 44_100,
      fromBeat: 0,
      toBeat: 7,
    });
    expect(selectedRate.sampleRate).toBe(44_100);
    expect(selectedRate.channelData[0]).toHaveLength(Math.round(durationSeconds * 44_100));
  });

  it('detects cubic inter-sample overshoot instead of calling it a certified true peak', () => {
    const estimated = estimateInterSamplePeak([Float32Array.of(0, 1, 1, 0)]);
    expect(estimated).toBeGreaterThan(1);
    expect(estimated).toBeCloseTo(1.125, 6);
  });

  it('discloses 4x inter-sample peak protection and its exact attenuation', async () => {
    const project = createBlankProject({ now: '2026-07-15T00:00:00.000Z' });
    project.bpm = 60;
    project.masterGain = 1;
    project.tracks = [{
      id: 'peak-track',
      name: 'Peak fixture',
      kind: 'audio',
      color: '#f6a84b',
      gain: 1,
      pan: 0,
      mute: false,
      solo: false,
      clips: [{
        id: 'peak-clip',
        name: 'Peak fixture',
        kind: 'audio',
        assetId: 'peak-asset',
        startBeat: 0,
        durationBeats: 4 / 44_100,
        offsetBeats: 0,
        timebase: { mode: 'fixed-seconds', sourceBpm: 60 },
        gain: 1,
        fadeIn: 0,
        fadeOut: 0,
        provenance: { source: 'user', createdAt: project.createdAt },
      }],
    }];
    const assets = new Map([['peak-asset', {
      id: 'peak-asset',
      sampleRate: 44_100,
      channelData: [Float32Array.of(0, 1, 1, 0)],
    }]]);

    const rendered = await renderProjectToPcm(project, assets, {
      fromBeat: 0,
      toBeat: 4 / 44_100,
      channelCount: 1,
      protectPeaks: true,
    });
    expect(rendered.sourceSamplePeak).toBe(1);
    expect(rendered.sourceInterSamplePeak).toBeCloseTo(1.125, 6);
    expect(rendered.peakProtectionApplied).toBe(true);
    expect(rendered.interSamplePeak).toBeCloseTo(0.98, 6);
    expect(rendered.peakAttenuationDb).toBeCloseTo(20 * Math.log10(0.98 / 1.125), 6);
  });
});

describe('WAV encoding', () => {
  it('writes exact 48 kHz stereo 16-bit PCM headers and frame count', () => {
    const frames = 48_000;
    const wav = encodeWav([new Float32Array(frames), new Float32Array(frames)], 48_000, { bitDepth: 16 });
    const view = new DataView(wav);
    expect(String.fromCharCode(...new Uint8Array(wav, 0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...new Uint8Array(wav, 8, 4))).toBe('WAVE');
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(24, true)).toBe(48_000);
    expect(view.getUint32(28, true)).toBe(192_000);
    expect(view.getUint16(32, true)).toBe(4);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(frames * 2 * 2);
    expect(wav.byteLength).toBe(44 + frames * 2 * 2);
  });

  it('applies deterministic named TPDF dither to 16-bit PCM', () => {
    const silence = new Float32Array(1_024);
    const first = new Uint8Array(encodeWav([silence], 44_100, { bitDepth: 16 }));
    const second = new Uint8Array(encodeWav([silence], 44_100, { bitDepth: 16 }));
    const anotherSeed = new Uint8Array(encodeWav([silence], 44_100, { bitDepth: 16, ditherSeed: 123 }));
    expect(first).toEqual(second);
    expect(first.subarray(44).some((byte) => byte !== 0)).toBe(true);
    expect(anotherSeed).not.toEqual(first);
  });

  it('preserves 24-bit PCM quantization and 32-bit float samples without dither', () => {
    const source = Float32Array.of(-1, -0.5, 0, 0.5, 1);
    const pcm24 = encodeWav([source], 44_100, { bitDepth: 24 });
    const pcm24View = new DataView(pcm24);
    expect(pcm24View.getUint16(20, true)).toBe(1);
    expect(pcm24View.getUint16(34, true)).toBe(24);
    expect(source.map((_, index) => readInt24Le(pcm24View, 44 + index * 3))).toEqual(
      Float32Array.of(-8_388_608, -4_194_304, 0, 4_194_304, 8_388_607),
    );

    const float32 = encodeWav([source], 48_000, { bitDepth: 32 });
    const float32View = new DataView(float32);
    expect(float32View.getUint16(20, true)).toBe(3);
    expect(float32View.getUint16(34, true)).toBe(32);
    expect(source.map((_, index) => float32View.getFloat32(44 + index * 4, true))).toEqual(source);
    expect(() => encodeWav([source], 44_100, { bitDepth: 24, dither: 'tpdf' })).toThrow(/only supported for 16-bit/);
  });
});
