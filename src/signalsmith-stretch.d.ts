declare module 'signalsmith-stretch' {
  export interface SignalsmithStretchSchedule {
    output?: number
    active?: boolean
    input?: number
    rate?: number
    semitones?: number
    tonalityHz?: number
    formantSemitones?: number
    formantCompensation?: boolean
    formantBaseHz?: number
    loopStart?: number
    loopEnd?: number
  }

  export interface SignalsmithStretchNode extends AudioWorkletNode {
    inputTime: number
    addBuffers(buffers: Float32Array[]): Promise<number>
    dropBuffers(toSeconds?: number): Promise<{ start: number; end: number }>
    schedule(change: SignalsmithStretchSchedule): Promise<SignalsmithStretchSchedule>
    start(when?: number | SignalsmithStretchSchedule, offset?: number, duration?: number, rate?: number, semitones?: number): Promise<unknown>
    stop(when?: number): Promise<unknown>
    latency(): Promise<number>
    configure(options: { blockMs?: number | null; intervalMs?: number; splitComputation?: boolean; preset?: 'default' | 'cheaper' }): Promise<unknown>
    setUpdateInterval(seconds: number, callback?: (inputTime: number) => void): Promise<unknown>
  }

  export interface SignalsmithStretchFactory {
    (
      context: BaseAudioContext,
      options?: AudioWorkletNodeOptions,
    ): Promise<SignalsmithStretchNode>
    /** Same-origin worklet entrypoint, used instead of the default blob URL. */
    moduleUrl?: string
  }

  const SignalsmithStretch: SignalsmithStretchFactory
  export default SignalsmithStretch
}
