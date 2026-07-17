import { beatsPerBar } from '../core'
import type { TimeSignature } from '../types'

export const SNAP_GRID_OPTIONS = [
  { value: 'bar', label: 'Bar' },
  { value: '1/2', label: '1/2' },
  { value: '1/4', label: '1/4' },
  { value: '1/8', label: '1/8' },
  { value: '1/16', label: '1/16' },
  { value: 'free', label: 'Free' },
] as const

export type SnapGrid = (typeof SNAP_GRID_OPTIONS)[number]['value']

export const snapGridLabel = (grid: SnapGrid): string =>
  SNAP_GRID_OPTIONS.find((option) => option.value === grid)?.label ?? 'Free'

/** Resolves the selected musical grid into quarter-note beats. Null means free placement. */
export const snapGridDivision = (grid: SnapGrid, timeSignature: TimeSignature): number | null => {
  if (grid === 'free') return null
  if (grid === 'bar') return beatsPerBar(timeSignature)
  const denominator = Number(grid.slice(2))
  return 4 / denominator
}
