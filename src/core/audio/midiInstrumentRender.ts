import { TINY_SYNTH_PROGRAM_0 } from './generated/tinySynthProgram0'
import type { TinySynthQualityZeroVoice, TinySynthWaveform } from './generated/tinySynthProgram0'

export const TINY_SYNTH_QUALITY = 0 as const
export const TINY_SYNTH_MASTER_GAIN = 0.5
export const WEBAUDIOFONT_CHAOS_DRUM_GAIN = 0.72
export const MAX_TINY_SYNTH_RELEASE_SECONDS = 4
export const TINY_SYNTH_RELEASE_TIME_CONSTANTS = 8

export const CHAOS_DRUM_SAMPLE_NOTES = [36, 38, 42, 46] as const
export type ChaosDrumSampleNote = typeof CHAOS_DRUM_SAMPLE_NOTES[number]

export const chaosDrumAssetId = (note: ChaosDrumSampleNote): string =>
  `builtin:webaudiofont:128${note}_0_Chaos_sf2_file`

export interface ChaosDrumVoice {
  assetId: string
  sourcePitch: ChaosDrumSampleNote
  playbackRate: number
}

/**
 * Four samples keep the encoded Chaos kit around 30 KiB (about 42 KiB in its
 * original WebAudioFont JS wrappers). Less common GM notes are intentionally
 * mapped into the nearest core kick/snare/hat voice and pitch-shifted.
 */
export function getChaosDrumVoice(pitch: number): ChaosDrumVoice {
  const note = Math.max(0, Math.min(127, Math.round(pitch)))
  let sourcePitch: ChaosDrumSampleNote
  if (note <= 36) sourcePitch = 36
  else if (note <= 41) sourcePitch = 38
  else if (note === 42 || note === 44) sourcePitch = 42
  else sourcePitch = 46
  const semitoneOffset = Math.max(-7, Math.min(7, note - sourcePitch))
  return {
    assetId: chaosDrumAssetId(sourcePitch),
    sourcePitch,
    playbackRate: 2 ** (semitoneOffset / 12),
  }
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.max(minimum, Math.min(maximum, value))

export const tinySynthVoice = (program = 0): TinySynthQualityZeroVoice =>
  TINY_SYNTH_PROGRAM_0[clamp(Math.round(program), 0, 127)] ?? TINY_SYNTH_PROGRAM_0[0]

export const tinySynthReleaseSeconds = (program = 0): number =>
  clamp(tinySynthVoice(program).r ?? 0.05, 0, MAX_TINY_SYNTH_RELEASE_SECONDS)

const releaseTailSeconds = (releaseSeconds: number): number =>
  releaseSeconds * TINY_SYNTH_RELEASE_TIME_CONSTANTS

/**
 * Finite render/scan boundary for TinySynth's exponential note-off envelope.
 * Both realtime and offline renderers must use this helper so a long-release
 * program cannot outlive the Worklet's backwards event scan.
 */
export const tinySynthReleaseTailSeconds = (program = 0): number =>
  releaseTailSeconds(tinySynthReleaseSeconds(program))

export const tinySynthNoiseSeed = (noteId: string, pitch: number, startBeat: number): number => {
  let seed = (Math.round(startBeat * 960) ^ Math.round(pitch)) >>> 0
  for (let index = 0; index < noteId.length; index += 1) seed = Math.imul(seed ^ noteId.charCodeAt(index), 16_777_619)
  return seed >>> 0
}

const tinySynthEnvelopeBeforeRelease = (
  voice: TinySynthQualityZeroVoice,
  noteSeconds: number,
): number => {
  const time = Math.max(0, noteSeconds)
  const attack = Math.max(0, voice.a ?? 0)
  const hold = Math.max(0, voice.h ?? 0.01)
  const decay = Math.max(0, voice.d ?? 0.01)
  const sustain = Math.max(0, voice.s ?? 0)
  if (attack > 0 && time < attack) return time / attack
  const decayStart = attack + hold
  if (time <= decayStart) return 1
  if (decay === 0) return sustain
  return sustain + (1 - sustain) * Math.exp(-(time - decayStart) / decay)
}

export function tinySynthEnvelope(
  program: number,
  noteSeconds: number,
  noteDurationSeconds: number,
): number {
  const voice = tinySynthVoice(program)
  const duration = Math.max(0, noteDurationSeconds)
  if (noteSeconds <= duration) return tinySynthEnvelopeBeforeRelease(voice, noteSeconds)
  const release = clamp(voice.r ?? 0.05, 0, MAX_TINY_SYNTH_RELEASE_SECONDS)
  if (release === 0) return 0
  const levelAtRelease = tinySynthEnvelopeBeforeRelease(voice, duration)
  const releaseElapsed = noteSeconds - duration
  return releaseElapsed > releaseTailSeconds(release)
    ? 0
    : levelAtRelease * Math.exp(-releaseElapsed / release)
}

const phase01 = (frequency: number, seconds: number): number => {
  const phase = frequency * Math.max(0, seconds)
  return phase - Math.floor(phase)
}

const polyBlep = (phase: number, phaseStep: number): number => {
  if (phaseStep <= 0 || phaseStep >= 1) return 0
  if (phase < phaseStep) {
    const x = phase / phaseStep
    return x + x - x * x - 1
  }
  if (phase > 1 - phaseStep) {
    const x = (phase - 1) / phaseStep
    return x * x + x + x + 1
  }
  return 0
}

const hashNoise = (frame: number, seed: number): number => {
  let value = (frame ^ seed) >>> 0
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d)
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b)
  value = (value ^ (value >>> 16)) >>> 0
  return value / 0x7fff_ffff - 1
}

const waveformSample = (
  waveform: TinySynthWaveform,
  frequency: number,
  seconds: number,
  sampleRate: number,
  noiseSeed: number,
): number => {
  const phase = phase01(frequency, seconds)
  const radians = phase * Math.PI * 2
  const step = clamp(frequency / sampleRate, 0, 0.999)
  if (waveform === 'sine') return Math.sin(radians)
  if (waveform === 'triangle') return (2 / Math.PI) * Math.asin(Math.sin(radians))
  if (waveform === 'sawtooth') return 2 * phase - 1 - polyBlep(phase, step)
  if (waveform === 'square') {
    return (phase < 0.5 ? 1 : -1) + polyBlep(phase, step) - polyBlep((phase + 0.5) % 1, step)
  }
  if (waveform === 'w9999') {
    return Math.sin(radians) * 0.7 + Math.sin(radians * 2) * 0.2 + Math.sin(radians * 3) * 0.1
  }
  const frame = Math.max(0, Math.floor(seconds * sampleRate))
  const white = hashNoise(frame, noiseSeed)
  if (waveform === 'n0') return white
  return white * (phase < 0.5 ? 1 : -1)
}

export function tinySynthSampleAtTime(options: {
  program?: number
  pitch: number
  velocity: number
  noteSeconds: number
  noteDurationSeconds: number
  sampleRate: number
  noiseSeed?: number
}): number {
  const program = clamp(Math.round(options.program ?? 0), 0, 127)
  const voice = tinySynthVoice(program)
  const noteFrequency = 440 * 2 ** ((clamp(Math.round(options.pitch), 0, 127) - 69) / 12)
  const baseFrequency = noteFrequency * (voice.t ?? 1) + (voice.f ?? 0)
  const pitchTarget = baseFrequency * (voice.p ?? 1)
  const pitchTime = Math.max(1e-6, voice.q ?? 1)
  const frequency = pitchTarget + (baseFrequency - pitchTarget) * Math.exp(-Math.max(0, options.noteSeconds) / pitchTime)
  if (!Number.isFinite(frequency) || frequency <= 0 || frequency >= options.sampleRate / 2) return 0
  const keyGain = voice.k
    ? 2 ** (((clamp(Math.round(options.pitch), 0, 127) - 60) / 12) * voice.k)
    : 1
  const normalizedVelocity = clamp(options.velocity, 0, 1)
  const velocityGain = (127 * 127 / 16_384) * normalizedVelocity * normalizedVelocity
  return waveformSample(
    voice.w,
    frequency,
    options.noteSeconds,
    options.sampleRate,
    options.noiseSeed ?? (program * 131 + Math.round(options.pitch)),
  ) * (voice.v ?? 0.5)
    * keyGain
    * velocityGain
    * tinySynthEnvelope(program, options.noteSeconds, options.noteDurationSeconds)
    * TINY_SYNTH_MASTER_GAIN
}
