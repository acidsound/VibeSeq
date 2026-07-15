import type { GenerationLengthSnapshot, TimeSignature } from '../types'

export type GenerationLengthChoice = Pick<GenerationLengthSnapshot, 'unit' | 'value'>

export const GENERATION_LENGTH_CHOICES: readonly GenerationLengthChoice[] = [
  { unit: 'seconds', value: 4 },
  { unit: 'seconds', value: 8 },
  { unit: 'seconds', value: 16 },
  { unit: 'seconds', value: 30 },
  { unit: 'bars', value: 1 },
  { unit: 'bars', value: 2 },
  { unit: 'bars', value: 4 },
]

export const generationLengthChoiceId = (choice: GenerationLengthChoice): string =>
  `${choice.unit}:${choice.value}`

export const parseGenerationLengthChoice = (value: string): GenerationLengthChoice => {
  const [unit, rawValue] = value.split(':')
  const numericValue = Number(rawValue)
  if ((unit !== 'seconds' && unit !== 'bars') || !Number.isFinite(numericValue) || numericValue <= 0) {
    throw new RangeError('Generation length must be a positive seconds or bars value')
  }
  return { unit, value: numericValue }
}

export const resolveGenerationLength = (
  choice: GenerationLengthChoice,
  bpm: number,
  timeSignature: TimeSignature,
): GenerationLengthSnapshot => {
  if (!Number.isFinite(bpm) || bpm <= 0) throw new RangeError('Generation length requires a positive BPM')
  if (!Number.isFinite(choice.value) || choice.value <= 0) throw new RangeError('Generation length must be positive')
  const beatsPerBar = (timeSignature.numerator * 4) / timeSignature.denominator
  if (!Number.isFinite(beatsPerBar) || beatsPerBar <= 0) throw new RangeError('Generation length requires a valid time signature')
  const durationSeconds = choice.unit === 'seconds'
    ? choice.value
    : (choice.value * beatsPerBar * 60) / bpm
  return {
    unit: choice.unit,
    value: choice.value,
    durationSeconds,
    bpm,
    timeSignature: { ...timeSignature },
  }
}

export const generationLengthLabel = (length: GenerationLengthSnapshot): string =>
  length.unit === 'bars'
    ? `${length.value} ${length.value === 1 ? 'bar' : 'bars'} · ${length.durationSeconds.toFixed(2)} sec @ ${length.bpm.toFixed(1)} BPM`
    : `${length.value} sec`
