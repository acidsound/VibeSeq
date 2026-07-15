export type WorkspaceSaveState = 'saving' | 'saved' | 'failed'

export interface WorkspaceSaveCoordinatorOptions<Snapshot, Result> {
  delayMs?: number
  readLatest: () => Snapshot
  save: (snapshot: Snapshot) => Promise<Result>
  onStateChange?: (state: WorkspaceSaveState, error?: unknown) => void
}

export interface WorkspaceSaveCoordinator<Result> {
  schedule(): void
  flush(): Promise<Result>
  cancelPending(): void
  dispose(): void
}

/**
 * One ordered save lane shared by debounced edits and explicit durability
 * barriers. `flush()` cancels the timer, snapshots the latest state, and
 * resolves only after that snapshot has been committed.
 */
export function createWorkspaceSaveCoordinator<Snapshot, Result>(
  options: WorkspaceSaveCoordinatorOptions<Snapshot, Result>,
): WorkspaceSaveCoordinator<Result> {
  const delayMs = options.delayMs ?? 450
  let timer: ReturnType<typeof setTimeout> | undefined
  let queue: Promise<void> = Promise.resolve()
  let version = 0
  let disposed = false

  const cancelPending = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }

  const enqueue = (requestedVersion: number): Promise<Result> => {
    const snapshot = options.readLatest()
    const operation = queue.catch(() => undefined).then(() => options.save(snapshot))
    queue = operation.then(() => undefined, () => undefined)
    operation.then(
      () => {
        if (!disposed && requestedVersion === version) options.onStateChange?.('saved')
      },
      (error: unknown) => {
        if (!disposed && requestedVersion === version) options.onStateChange?.('failed', error)
      },
    )
    return operation
  }

  return {
    schedule() {
      if (disposed) return
      cancelPending()
      const requestedVersion = ++version
      options.onStateChange?.('saving')
      timer = setTimeout(() => {
        timer = undefined
        void enqueue(requestedVersion).catch(() => undefined)
      }, delayMs)
    },
    flush() {
      if (disposed) return Promise.reject(new Error('Workspace save coordinator is disposed'))
      cancelPending()
      const requestedVersion = ++version
      options.onStateChange?.('saving')
      return enqueue(requestedVersion)
    },
    cancelPending,
    dispose() {
      disposed = true
      version += 1
      cancelPending()
    },
  }
}
