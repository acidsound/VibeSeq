export interface AuditionPreviewRequest {
  readonly candidateId: string
  readonly epoch: number
  readonly signal: AbortSignal
}

/**
 * Owns the single candidate-preview request allowed to prepare or play.
 * Starting a replacement aborts the previous media fetch and invalidates every
 * continuation that cannot observe AbortSignal (hashing and audio decoding).
 */
export class AuditionPreviewGate {
  private epoch = 0
  private controller?: AbortController
  private candidateId: string | null = null

  get activeCandidateId(): string | null {
    return this.candidateId
  }

  begin(candidateId: string): AuditionPreviewRequest {
    this.controller?.abort()
    const controller = new AbortController()
    this.controller = controller
    this.candidateId = candidateId
    return { candidateId, epoch: ++this.epoch, signal: controller.signal }
  }

  isCurrent(request: AuditionPreviewRequest): boolean {
    return request.epoch === this.epoch
      && request.candidateId === this.candidateId
      && !request.signal.aborted
  }

  finish(request: AuditionPreviewRequest): boolean {
    if (!this.isCurrent(request)) return false
    this.controller = undefined
    this.candidateId = null
    return true
  }

  cancel(): string | null {
    const cancelledId = this.candidateId
    this.epoch += 1
    this.controller?.abort()
    this.controller = undefined
    this.candidateId = null
    return cancelledId
  }
}

export const isAbortError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
