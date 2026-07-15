export const MIN_GENERATION_SEED = 0
export const MAX_GENERATION_SEED = 0xffff_ffff

/**
 * Parse the exact integer syntax shown in the seed field. Decimal and
 * exponential forms are deliberately rejected so the visible value remains
 * an unambiguous, reproducible Stable Audio input.
 */
export function parseGenerationSeedDraft(value: string): number | null {
  const trimmed = value.trim()
  if (!/^[+-]?\d+$/.test(trimmed)) return null
  const parsed = Number(trimmed)
  if (!Number.isSafeInteger(parsed)) return null
  return Math.max(MIN_GENERATION_SEED, Math.min(MAX_GENERATION_SEED, parsed))
}

export function randomGenerationSeed(
  fillRandomValues: (target: Uint32Array<ArrayBuffer>) => void = (target) => {
    globalThis.crypto.getRandomValues(target)
  },
): number {
  const values = new Uint32Array(new ArrayBuffer(Uint32Array.BYTES_PER_ELEMENT))
  fillRandomValues(values)
  return values[0]
}
