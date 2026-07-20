import SignalsmithStretch from 'signalsmith-stretch'
import signalsmithWorkletModuleUrl from 'signalsmith-stretch?worker&url'

SignalsmithStretch.moduleUrl = signalsmithWorkletModuleUrl

export const MIN_AUDIO_PITCH_SEMITONES = -12
export const MAX_AUDIO_PITCH_SEMITONES = 12
export const MIN_AUDIO_STRETCH_RATIO = 0.125
export const MAX_AUDIO_STRETCH_RATIO = 2
export const SIGNALSMITH_STRETCH_VERSION = '1.3.2'

export interface AudioTransformParameters {
  pitchSemitones: number
  /** Output duration divided by immutable-source duration. */
  stretchRatio: number
}

const validateParameters = ({ pitchSemitones, stretchRatio }: AudioTransformParameters): void => {
  if (!Number.isFinite(pitchSemitones)
    || pitchSemitones < MIN_AUDIO_PITCH_SEMITONES
    || pitchSemitones > MAX_AUDIO_PITCH_SEMITONES) {
    throw new RangeError(`Pitch shift must be in range ${MIN_AUDIO_PITCH_SEMITONES}..${MAX_AUDIO_PITCH_SEMITONES} semitones`)
  }
  if (!Number.isFinite(stretchRatio)
    || stretchRatio < MIN_AUDIO_STRETCH_RATIO
    || stretchRatio > MAX_AUDIO_STRETCH_RATIO) {
    throw new RangeError(`Stretch ratio must be in range ${MIN_AUDIO_STRETCH_RATIO}..${MAX_AUDIO_STRETCH_RATIO}`)
  }
}

export const audioTransformIsIdentity = ({ pitchSemitones, stretchRatio }: AudioTransformParameters): boolean =>
  Math.abs(pitchSemitones) < 1e-9 && Math.abs(stretchRatio - 1) < 1e-9

/**
 * Renders one immutable asset derivative with independent pitch and duration.
 * The returned buffer is the exact media later shared by realtime playback and
 * WAV export; Signalsmith is not inserted into either render graph at runtime.
 */
export async function renderAudioTransform(
  input: AudioBuffer,
  parameters: AudioTransformParameters,
): Promise<AudioBuffer> {
  validateParameters(parameters)
  if (input.numberOfChannels < 1 || input.length < 1 || input.sampleRate <= 0) {
    throw new RangeError('Audio transform requires a non-empty decoded source')
  }

  const channelCount = Math.min(2, input.numberOfChannels)
  const outputFrames = Math.max(1, Math.round(input.length * parameters.stretchRatio))
  if (!Number.isSafeInteger(outputFrames) || outputFrames > 0x7fff_ffff) {
    throw new RangeError('Audio transform output exceeds the safe PCM frame limit')
  }

  const context = new OfflineAudioContext(channelCount, outputFrames, input.sampleRate)
  const node = await SignalsmithStretch(context, {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [channelCount],
  })
  try {
    await node.addBuffers(Array.from(
      { length: channelCount },
      (_, channel) => input.getChannelData(channel).slice(),
    ))
    node.connect(context.destination)
    await node.schedule({
      output: 0,
      active: true,
      input: 0,
      rate: 1 / parameters.stretchRatio,
      semitones: parameters.pitchSemitones,
    })
    return await context.startRendering()
  } finally {
    node.disconnect()
  }
}
