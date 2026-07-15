import type { AudioClip } from '../../types'
import { getClipSourceSlices } from '../clip'
import { beatsToSeconds } from '../time'
import { audioSourceBeatToSeconds, getAudioClipPlaybackRate } from './timebase'

export interface PcmSegment {
  sampleRate: number
  channelData: Float32Array[]
  durationSeconds: number
}

type ClipSourceMapping = Pick<AudioClip, 'durationBeats' | 'offsetBeats' | 'sourceLoop' | 'timebase'>

const validatePcmSource = (
  channelData: readonly Float32Array[],
  sampleRate: number,
): number => {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new RangeError('sampleRate must be positive')
  if (channelData.length === 0) throw new RangeError('At least one source channel is required')
  return Math.min(...channelData.map((channel) => channel.length))
}

const sampleLinear = (channel: Float32Array, position: number): number => {
  if (position < 0 || position >= channel.length) return 0
  const lower = Math.floor(position)
  const upper = Math.min(channel.length - 1, lower + 1)
  const fraction = position - lower
  return channel[lower] * (1 - fraction) + channel[upper] * fraction
}

/**
 * Extracts an exact source interval and downmixes it to mono for transcription.
 * MuScriptor analyzes mono audio internally, so this avoids uploading unrelated
 * material while preserving every source channel in the selected interval.
 */
export function extractMonoPcmSegment(
  channelData: readonly Float32Array[],
  sampleRate: number,
  startSeconds: number,
  durationSeconds: number,
): PcmSegment {
  const availableFrames = validatePcmSource(channelData, sampleRate)
  if (!Number.isFinite(startSeconds) || startSeconds < 0) throw new RangeError('startSeconds must be non-negative')
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new RangeError('durationSeconds must be positive')

  const firstFrame = Math.min(availableFrames, Math.floor(startSeconds * sampleRate))
  const requestedEnd = firstFrame + Math.ceil(durationSeconds * sampleRate)
  const lastFrame = Math.min(availableFrames, requestedEnd)
  if (lastFrame <= firstFrame) throw new RangeError('The selected interval is outside the source audio')

  const mono = new Float32Array(lastFrame - firstFrame)
  for (let channelIndex = 0; channelIndex < channelData.length; channelIndex += 1) {
    const channel = channelData[channelIndex]
    for (let frame = firstFrame; frame < lastFrame; frame += 1) {
      mono[frame - firstFrame] += channel[frame] / channelData.length
    }
  }
  return {
    sampleRate,
    channelData: [mono],
    durationSeconds: mono.length / sampleRate,
  }
}

/**
 * Renders the source mapping heard across one arrangement clip into immutable
 * mono PCM for transcription. Unlike a linear crop, this follows clip trim
 * offsets and concatenates every complete or partial source-loop slice.
 *
 * The output covers the full arrangement interval, rounded up to complete PCM
 * frames. Source positions after encoded media are rendered as silence, matching
 * realtime playback and CPU mixdown when a non-destructive region is lengthened.
 */
export function extractMonoPcmClipSegment(
  channelData: readonly Float32Array[],
  sampleRate: number,
  clip: ClipSourceMapping,
  bpm: number,
): PcmSegment {
  validatePcmSource(channelData, sampleRate)
  if (!Number.isFinite(bpm) || bpm <= 0) throw new RangeError('bpm must be positive')
  if (!Number.isFinite(clip.durationBeats) || clip.durationBeats <= 0) {
    throw new RangeError('Clip duration must be positive')
  }

  const requestedFrames = beatsToSeconds(clip.durationBeats, bpm) * sampleRate
  const frameCount = Math.ceil(requestedFrames)
  if (!Number.isSafeInteger(frameCount) || frameCount <= 0 || frameCount > 0x7fff_ffff) {
    throw new RangeError('Clip duration exceeds the safe PCM frame limit')
  }

  const mono = new Float32Array(frameCount)
  const slices = getClipSourceSlices(clip)
  const playbackRate = getAudioClipPlaybackRate(clip, bpm)
  const frameEpsilon = 1e-7
  for (const slice of slices) {
    const placementStartFrame = beatsToSeconds(slice.placementStartBeat, bpm) * sampleRate
    const placementEndFrame = beatsToSeconds(
      slice.placementStartBeat + slice.durationBeats,
      bpm,
    ) * sampleRate
    const firstOutputFrame = Math.max(0, Math.ceil(placementStartFrame - frameEpsilon))
    const lastOutputFrame = Math.min(frameCount, Math.ceil(placementEndFrame - frameEpsilon))
    const sourceStartFrame = audioSourceBeatToSeconds(clip, slice.sourceStartBeat) * sampleRate

    for (let outputFrame = firstOutputFrame; outputFrame < lastOutputFrame; outputFrame += 1) {
      const sourceFrame = sourceStartFrame + (outputFrame - placementStartFrame) * playbackRate
      if (sourceFrame < -frameEpsilon) {
        throw new RangeError('The clip source mapping is outside the source audio')
      }
      const boundedSourceFrame = Math.max(0, sourceFrame)
      let sample = 0
      for (const channel of channelData) sample += sampleLinear(channel, boundedSourceFrame)
      mono[outputFrame] = sample / channelData.length
    }
  }

  return {
    sampleRate,
    channelData: [mono],
    durationSeconds: mono.length / sampleRate,
  }
}
