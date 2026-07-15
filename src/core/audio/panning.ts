const clampPan = (pan: number): number => Math.max(-1, Math.min(1, pan))

/** Equal-power mono-to-stereo gains used by Web Audio's StereoPannerNode. */
export function equalPowerPanGains(pan: number, outputChannelCount: number): [number, number] {
  if (outputChannelCount === 1) return [1, 0]
  const angle = ((clampPan(pan) + 1) * Math.PI) / 4
  return [Math.cos(angle), Math.sin(angle)]
}

export interface StereoPanMatrix {
  leftFromLeft: number
  leftFromRight: number
  rightFromLeft: number
  rightFromRight: number
}

/**
 * Stereo-to-stereo matrix mandated for Web Audio's StereoPannerNode.
 *
 * Unlike the mono law, center pan is identity. Moving left preserves the left
 * channel and folds the right channel toward it; moving right does the mirror
 * operation. Keeping this matrix in the sample-domain renderer makes exported
 * audio agree with the live StereoPannerNode graph.
 */
export function webAudioStereoPanMatrix(pan: number): StereoPanMatrix {
  const normalizedPan = clampPan(pan)
  if (normalizedPan === 0) {
    return { leftFromLeft: 1, leftFromRight: 0, rightFromLeft: 0, rightFromRight: 1 }
  }
  const x = normalizedPan <= 0 ? normalizedPan + 1 : normalizedPan
  const gainLeft = Math.cos(x * Math.PI / 2)
  const gainRight = Math.sin(x * Math.PI / 2)
  return normalizedPan <= 0
    ? {
        leftFromLeft: 1,
        leftFromRight: gainLeft,
        rightFromLeft: 0,
        rightFromRight: gainRight,
      }
    : {
        leftFromLeft: gainLeft,
        leftFromRight: 0,
        rightFromLeft: gainRight,
        rightFromRight: 1,
      }
}
