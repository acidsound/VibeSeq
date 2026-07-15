import type {
  AudioClip,
  MidiClip,
  MidiTrack,
  PcmAssetSource,
  PcmAudioAsset,
  Project,
  ProjectSampleRate,
  Track,
} from '../../types';
import { getArrangedMidiNotes, sourceBeatAtClipPosition } from '../clip';
import { getMidiTrackPlaybackProfile } from '../midi/instrument';
import { beatsToSeconds, getProjectEndBeat } from '../time';
import {
  linearEdgeEnvelopeFactor,
} from './midiSynth';
import {
  CHAOS_DRUM_SAMPLE_NOTES,
  getChaosDrumVoice,
  tinySynthNoiseSeed,
  tinySynthReleaseTailSeconds,
  tinySynthSampleAtTime,
  WEBAUDIOFONT_CHAOS_DRUM_GAIN,
} from './midiInstrumentRender';
import { equalPowerPanGains, webAudioStereoPanMatrix } from './panning';
import { audioSourceBeatToSeconds, getAudioClipPlaybackRate } from './timebase';

export interface MixdownOptions {
  sampleRate?: ProjectSampleRate;
  fromBeat?: number;
  toBeat?: number;
  channelCount?: 1 | 2;
  /** Attenuates 4x inter-sample peak estimates above 0.98; it never boosts the mix. */
  protectPeaks?: boolean;
  /** Fail instead of silently exporting a mix with missing audio clips. Defaults to true. */
  strictAssets?: boolean;
  /** Reports completed renderer work. It does not make this synchronous function non-blocking. */
  onRenderProgress?: (progress: MixdownProgress) => void;
}

export interface MixdownProgress {
  phase: 'mixing' | 'analyzing';
  completed: number;
  total: number;
}

export interface PcmMixdown {
  sampleRate: number;
  channelData: Float32Array[];
  durationSeconds: number;
  /** Post-protection sample peak. Kept as the concise compatibility field. */
  peak: number;
  sourceSamplePeak: number;
  sourceInterSamplePeak: number;
  interSamplePeak: number;
  peakProtectionApplied: boolean;
  /** A negative value when protection attenuated the render, otherwise zero. */
  peakAttenuationDb: number;
}

export type WavDither = 'none' | 'tpdf';

export interface WavEncodeOptions {
  bitDepth?: 16 | 24 | 32;
  /** 16-bit PCM defaults to deterministic TPDF; higher depths are never dithered here. */
  dither?: WavDither;
  /** Makes TPDF output reproducible for the same render. */
  ditherSeed?: number;
  /** Reports encoded frames. It does not make this synchronous function non-blocking. */
  onEncodeProgress?: (completedFrames: number, totalFrames: number) => void;
}

export interface ExportWavOptions extends MixdownOptions, WavEncodeOptions {}

export const PEAK_PROTECTION_CEILING = 0.98;
export const DEFAULT_TPDF_DITHER_SEED = 0x5649_4245;
const INTER_SAMPLE_PHASES = [0.25, 0.5, 0.75] as const;

const resolveAsset = async (source: PcmAssetSource, assetId: string): Promise<PcmAudioAsset | undefined> => {
  if (typeof source === 'function') return source(assetId);
  const possibleMap = source as ReadonlyMap<string, PcmAudioAsset>;
  if (typeof possibleMap.get === 'function') return possibleMap.get(assetId);
  return (source as Record<string, PcmAudioAsset>)[assetId];
};

const trackIsAudible = (track: Track, tracks: readonly Track[]): boolean => {
  if (track.mute) return false;
  const anySolo = tracks.some((candidate) => candidate.solo && !candidate.mute);
  return !anySolo || track.solo;
};

const fadeFactor = (clip: AudioClip | MidiClip, positionBeat: number, bpm: number): number => {
  const positionSeconds = beatsToSeconds(positionBeat, bpm);
  const durationSeconds = beatsToSeconds(clip.durationBeats, bpm);
  return linearEdgeEnvelopeFactor(positionSeconds, durationSeconds, clip.fadeIn, clip.fadeOut);
};

const sampleLinear = (channel: Float32Array, position: number): number => {
  if (position < 0 || position >= channel.length) return 0;
  const lower = Math.floor(position);
  const upper = Math.min(channel.length - 1, lower + 1);
  const fraction = position - lower;
  return channel[lower] * (1 - fraction) + channel[upper] * fraction;
};

const sampleAssetMono = (asset: PcmAudioAsset, position: number): number => {
  if (asset.channelData.length === 1) return sampleLinear(asset.channelData[0], position);
  return (sampleLinear(asset.channelData[0], position) + sampleLinear(asset.channelData[1], position)) * 0.5;
};

const samplePeak = (channelData: readonly Float32Array[]): number => {
  let peak = 0;
  for (const channel of channelData) {
    for (const sample of channel) {
      if (!Number.isFinite(sample)) throw new Error('Cannot export non-finite PCM samples');
      peak = Math.max(peak, Math.abs(sample));
    }
  }
  return peak;
};

/**
 * Deterministic 4x cubic inter-sample estimate used for peak-risk protection.
 * It catches overshoots between PCM samples but is not presented as a certified BS.1770 meter.
 */
export function estimateInterSamplePeak(channelData: readonly Float32Array[]): number {
  let peak = samplePeak(channelData);
  for (const channel of channelData) {
    for (let frame = 0; frame + 1 < channel.length; frame += 1) {
      const p0 = channel[Math.max(0, frame - 1)];
      const p1 = channel[frame];
      const p2 = channel[frame + 1];
      const p3 = channel[Math.min(channel.length - 1, frame + 2)];
      for (const fraction of INTER_SAMPLE_PHASES) {
        const squared = fraction * fraction;
        const cubed = squared * fraction;
        const interpolated = 0.5 * (
          2 * p1
          + (-p0 + p2) * fraction
          + (2 * p0 - 5 * p1 + 4 * p2 - p3) * squared
          + (-p0 + 3 * p1 - 3 * p2 + p3) * cubed
        );
        peak = Math.max(peak, Math.abs(interpolated));
      }
    }
  }
  return peak;
}

const mixAudioClip = (
  output: Float32Array[],
  project: Project,
  track: Track,
  clip: AudioClip,
  asset: PcmAudioAsset,
  fromBeat: number,
  toBeat: number,
  sampleRate: number,
): void => {
  if (clip.muted || asset.channelData.length === 0 || asset.sampleRate <= 0) return;
  const overlapStart = Math.max(fromBeat, clip.startBeat);
  const overlapEnd = Math.min(toBeat, clip.startBeat + clip.durationBeats);
  if (overlapEnd <= overlapStart) return;
  const firstFrame = Math.max(0, Math.floor(beatsToSeconds(overlapStart - fromBeat, project.bpm) * sampleRate));
  const lastFrame = Math.min(output[0].length, Math.ceil(beatsToSeconds(overlapEnd - fromBeat, project.bpm) * sampleRate));
  const secondsPerOutputFrame = 1 / sampleRate;
  const beatsPerSecond = project.bpm / 60;
  const [leftPan, rightPan] = equalPowerPanGains(track.pan, output.length);
  const stereoPan = webAudioStereoPanMatrix(track.pan);
  // Validate the explicit timebase even though source-position conversion below
  // already embeds the same rate through the source/project BPM ratio.
  getAudioClipPlaybackRate(clip, project.bpm);
  const baseGain = project.masterGain * track.gain * clip.gain;
  for (let frame = firstFrame; frame < lastFrame; frame += 1) {
    const absoluteBeat = fromBeat + frame * secondsPerOutputFrame * beatsPerSecond;
    const clipPosition = absoluteBeat - clip.startBeat;
    const sourceSeconds = audioSourceBeatToSeconds(
      clip,
      sourceBeatAtClipPosition(clip, clipPosition),
    );
    const sourceFrame = sourceSeconds * asset.sampleRate;
    const gain = baseGain * fadeFactor(clip, clipPosition, project.bpm);
    if (output.length === 1) {
      let mono = 0;
      for (const channel of asset.channelData) mono += sampleLinear(channel, sourceFrame);
      output[0][frame] += (mono / asset.channelData.length) * gain;
    } else if (asset.channelData.length === 1) {
      const mono = sampleLinear(asset.channelData[0], sourceFrame) * gain;
      output[0][frame] += mono * leftPan;
      output[1][frame] += mono * rightPan;
    } else {
      const sourceLeft = sampleLinear(asset.channelData[0], sourceFrame);
      const sourceRight = sampleLinear(asset.channelData[1], sourceFrame);
      output[0][frame] += (
        sourceLeft * stereoPan.leftFromLeft
        + sourceRight * stereoPan.leftFromRight
      ) * gain;
      output[1][frame] += (
        sourceLeft * stereoPan.rightFromLeft
        + sourceRight * stereoPan.rightFromRight
      ) * gain;
    }
  }
};

const mixMidiClip = (
  output: Float32Array[],
  project: Project,
  track: Track,
  clip: MidiClip,
  fromBeat: number,
  toBeat: number,
  sampleRate: number,
  instrumentAssets: ReadonlyMap<string, PcmAudioAsset>,
): void => {
  if (clip.muted || track.kind !== 'midi') return;
  const profile = getMidiTrackPlaybackProfile(track as MidiTrack);
  const [leftPan, rightPan] = equalPowerPanGains(track.pan, output.length);
  // Expand from the authored instance onset instead of clipping expansion to
  // the export range. This preserves oscillator phase/noise identity and keeps
  // note-off or one-shot tails audible when a loop/export begins inside them.
  for (const instance of getArrangedMidiNotes(clip)) {
    const { note } = instance;
    const noteDurationSeconds = beatsToSeconds(note.durationBeats, project.bpm);
    const drum = profile.instrumentKind === 'drums' ? getChaosDrumVoice(note.pitch) : undefined;
    const drumAsset = drum ? instrumentAssets.get(drum.assetId) : undefined;
    const releaseSeconds = drumAsset
      ? Math.min(...drumAsset.channelData.map((channel) => channel.length)) / drumAsset.sampleRate / drum!.playbackRate
      : tinySynthReleaseTailSeconds(profile.program ?? 0);
    const instanceEnd = Math.min(
      clip.startBeat + clip.durationBeats,
      instance.startBeat + instance.durationBeats + (releaseSeconds * project.bpm) / 60,
    );
    if (instance.startBeat >= toBeat || instanceEnd <= fromBeat) continue;
    const firstFrame = Math.max(0, Math.floor(beatsToSeconds(instance.startBeat - fromBeat, project.bpm) * sampleRate));
    const lastFrame = Math.min(output[0].length, Math.ceil(beatsToSeconds(instanceEnd - fromBeat, project.bpm) * sampleRate));
    const instanceNoteOffsetSeconds = beatsToSeconds(instance.noteOffsetBeats, project.bpm);
    const baseGain = project.masterGain * track.gain * clip.gain;
    for (let frame = firstFrame; frame < lastFrame; frame += 1) {
      const absoluteSeconds = frame / sampleRate + beatsToSeconds(fromBeat, project.bpm);
      const noteSeconds = instanceNoteOffsetSeconds
        + absoluteSeconds
        - beatsToSeconds(instance.startBeat, project.bpm);
      const absoluteBeat = fromBeat + (frame / sampleRate) * (project.bpm / 60);
      const clipGain = fadeFactor(clip, absoluteBeat - clip.startBeat, project.bpm);
      const sample = drum && drumAsset
        ? sampleAssetMono(drumAsset, noteSeconds * drumAsset.sampleRate * drum.playbackRate)
          * note.velocity * note.velocity * WEBAUDIOFONT_CHAOS_DRUM_GAIN * baseGain * clipGain
        : tinySynthSampleAtTime({
            program: profile.program,
            pitch: note.pitch,
            velocity: note.velocity,
            noteSeconds,
            noteDurationSeconds,
            sampleRate,
            noiseSeed: tinySynthNoiseSeed(note.id, note.pitch, instance.startBeat),
          }) * baseGain * clipGain;
      output[0][frame] += sample * leftPan;
      if (output.length > 1) output[1][frame] += sample * rightPan;
    }
  }
};

/** Deterministic CPU renderer used both by browser export and unit tests. */
export async function renderProjectToPcm(
  project: Project,
  assets: PcmAssetSource,
  options: MixdownOptions = {},
): Promise<PcmMixdown> {
  const sampleRate = options.sampleRate ?? project.sampleRate;
  if (sampleRate !== 44_100 && sampleRate !== 48_000) {
    throw new RangeError('Project sample rate must be 44100 or 48000 Hz');
  }
  const fromBeat = Math.max(0, options.fromBeat ?? 0);
  const toBeat = Math.max(fromBeat, options.toBeat ?? getProjectEndBeat(project.tracks));
  const channelCount = options.channelCount ?? 2;
  const durationSeconds = beatsToSeconds(toBeat - fromBeat, project.bpm);
  const frameCount = Math.max(1, Math.round(durationSeconds * sampleRate));
  const channelData = Array.from({ length: channelCount }, () => new Float32Array(frameCount));

  const instrumentAssets = new Map<string, PcmAudioAsset>();
  const needsChaosDrums = project.tracks.some((track) => (
    track.kind === 'midi' && getMidiTrackPlaybackProfile(track).instrumentKind === 'drums'
  ));
  if (needsChaosDrums) {
    for (const note of CHAOS_DRUM_SAMPLE_NOTES) {
      const assetId = getChaosDrumVoice(note).assetId;
      const asset = await resolveAsset(assets, assetId);
      if (!asset && (options.strictAssets ?? true)) {
        throw new Error(`Missing decoded WebAudioFont drum asset "${assetId}"`);
      }
      if (asset) instrumentAssets.set(assetId, asset);
    }
  }

  const trackCount = project.tracks.length;
  options.onRenderProgress?.({ phase: 'mixing', completed: 0, total: trackCount });
  for (let trackIndex = 0; trackIndex < trackCount; trackIndex += 1) {
    const track = project.tracks[trackIndex];
    if (trackIsAudible(track, project.tracks)) {
      for (const clip of track.clips) {
        if (clip.kind === 'audio') {
          if (clip.muted || clip.startBeat >= toBeat || clip.startBeat + clip.durationBeats <= fromBeat) continue;
          const asset = await resolveAsset(assets, clip.assetId);
          if (asset) mixAudioClip(channelData, project, track, clip, asset, fromBeat, toBeat, sampleRate);
          else if (options.strictAssets ?? true) {
            throw new Error(`Missing decoded PCM data for audio asset "${clip.assetId}"`);
          }
        } else {
          mixMidiClip(channelData, project, track, clip, fromBeat, toBeat, sampleRate, instrumentAssets);
        }
      }
    }
    options.onRenderProgress?.({ phase: 'mixing', completed: trackIndex + 1, total: trackCount });
  }

  options.onRenderProgress?.({ phase: 'analyzing', completed: 0, total: 2 });
  const sourceSamplePeak = samplePeak(channelData);
  options.onRenderProgress?.({ phase: 'analyzing', completed: 1, total: 2 });
  const sourceInterSamplePeak = estimateInterSamplePeak(channelData);
  let scale = 1;
  if (options.protectPeaks && sourceInterSamplePeak > PEAK_PROTECTION_CEILING) {
    scale = PEAK_PROTECTION_CEILING / sourceInterSamplePeak;
    for (const channel of channelData) {
      for (let index = 0; index < channel.length; index += 1) channel[index] *= scale;
    }
  }
  options.onRenderProgress?.({ phase: 'analyzing', completed: 2, total: 2 });
  return {
    sampleRate,
    channelData,
    durationSeconds,
    peak: sourceSamplePeak * scale,
    sourceSamplePeak,
    sourceInterSamplePeak,
    interSamplePeak: sourceInterSamplePeak * scale,
    peakProtectionApplied: scale < 1,
    peakAttenuationDb: scale < 1 ? 20 * Math.log10(scale) : 0,
  };
}

const writeAscii = (view: DataView, offset: number, value: string): void => {
  for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
};

const createDeterministicRandom = (seed: number): (() => number) => {
  let state = (Math.trunc(seed) >>> 0) || DEFAULT_TPDF_DITHER_SEED;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
};

export function encodeWav(
  channelData: readonly Float32Array[],
  sampleRate: number,
  options: WavEncodeOptions = {},
): ArrayBuffer {
  if (channelData.length < 1 || channelData.length > 2) throw new RangeError('WAV export supports mono or stereo');
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new RangeError('sampleRate must be positive');
  const frameCount = channelData[0].length;
  if (channelData.some((channel) => channel.length !== frameCount)) throw new Error('WAV channels must have equal lengths');
  const bitDepth = options.bitDepth ?? 24;
  const dither = options.dither ?? (bitDepth === 16 ? 'tpdf' : 'none');
  if (dither !== 'none' && dither !== 'tpdf') throw new RangeError(`Unsupported WAV dither mode: ${String(dither)}`);
  if (bitDepth !== 16 && dither !== 'none') throw new RangeError('TPDF dither is only supported for 16-bit PCM');
  const random = createDeterministicRandom(options.ditherSeed ?? DEFAULT_TPDF_DITHER_SEED);
  const bytesPerSample = bitDepth / 8;
  const dataSize = frameCount * channelData.length * bytesPerSample;
  const output = new ArrayBuffer(44 + dataSize);
  const view = new DataView(output);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, bitDepth === 32 ? 3 : 1, true);
  view.setUint16(22, channelData.length, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channelData.length * bytesPerSample, true);
  view.setUint16(32, channelData.length * bytesPerSample, true);
  view.setUint16(34, bitDepth, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);
  let offset = 44;
  const progressInterval = Math.max(1, Math.floor(frameCount / 100));
  options.onEncodeProgress?.(0, frameCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    for (const channel of channelData) {
      const sample = Math.max(-1, Math.min(1, channel[frame] || 0));
      if (bitDepth === 16) {
        const scaled = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        const ditherLsb = dither === 'tpdf' ? random() - random() : 0;
        const quantized = Math.max(-0x8000, Math.min(0x7fff, Math.round(scaled + ditherLsb)));
        view.setInt16(offset, quantized, true);
        offset += 2;
      } else if (bitDepth === 24) {
        const value = Math.round(sample < 0 ? sample * 0x800000 : sample * 0x7fffff);
        view.setUint8(offset, value & 255);
        view.setUint8(offset + 1, (value >>> 8) & 255);
        view.setUint8(offset + 2, (value >>> 16) & 255);
        offset += 3;
      } else {
        view.setFloat32(offset, sample, true);
        offset += 4;
      }
    }
    if ((frame + 1) % progressInterval === 0 || frame + 1 === frameCount) {
      options.onEncodeProgress?.(frame + 1, frameCount);
    }
  }
  return output;
}

export async function exportWavBuffer(
  project: Project,
  assets: PcmAssetSource,
  options: ExportWavOptions = {},
): Promise<ArrayBuffer> {
  const rendered = await renderProjectToPcm(project, assets, options);
  return encodeWav(rendered.channelData, rendered.sampleRate, options);
}

export async function exportWav(
  project: Project,
  assets: PcmAssetSource,
  options: ExportWavOptions = {},
): Promise<Blob> {
  return new Blob([await exportWavBuffer(project, assets, options)], { type: 'audio/wav' });
}

export function audioBufferToPcmAsset(id: string, buffer: AudioBuffer): PcmAudioAsset {
  return {
    id,
    sampleRate: buffer.sampleRate,
    channelData: Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel).slice()),
  };
}
