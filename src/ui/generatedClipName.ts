const wordLimitForDuration = (durationSeconds: number): number => {
  if (durationSeconds <= 2.5) return 2
  if (durationSeconds <= 10) return 3
  return 4
}

const cleanWord = (word: string): string => word
  .replace(/^[^\p{L}\p{N}#&]+|[^\p{L}\p{N}#&-]+$/gu, '')

const titleWord = (word: string): string => word
  .split('-')
  .map((part) => part ? `${part[0].toUpperCase()}${part.slice(1)}` : part)
  .join('-')

/** Uses only the prompt's leading words; it does not infer, rewrite, or classify musical intent. */
export const generatedClipName = (prompt: string, durationSeconds: number): string => {
  const words = prompt
    .trim()
    .split(/\s+/)
    .map(cleanWord)
    .filter(Boolean)
    .slice(0, wordLimitForDuration(durationSeconds))
    .map(titleWord)

  return words.join(' ') || 'Generated Sound'
}
