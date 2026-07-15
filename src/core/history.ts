export type MaybePromise<T> = T | Promise<T>;

export interface HistoryCommand<T> {
  label: string;
  /** Consecutive commands with this key are grouped into one undo step. */
  mergeKey?: string;
  do(state: T): MaybePromise<T>;
  undo(state: T): MaybePromise<T>;
}

export type Command<T> = HistoryCommand<T>;

export interface HistorySnapshot<T> {
  state: T;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel?: string;
  redoLabel?: string;
  pending: boolean;
}

export type HistoryListener<T> = (snapshot: HistorySnapshot<T>) => void;

export interface HistoryStore<T> {
  getState(): T;
  getSnapshot(): HistorySnapshot<T>;
  execute(command: HistoryCommand<T>): Promise<T>;
  executeCompound(label: string, commands: readonly HistoryCommand<T>[]): Promise<T>;
  undo(): Promise<T>;
  redo(): Promise<T>;
  /** Serializes a state update without adding an undo entry. */
  updateState(update: (state: T) => MaybePromise<T>): Promise<T>;
  canUndo(): boolean;
  canRedo(): boolean;
  replaceState(state: T, options?: { clearHistory?: boolean }): void;
  clear(): void;
  subscribe(listener: HistoryListener<T>): () => void;
}

interface HistoryEntry<T> {
  label: string;
  commands: readonly HistoryCommand<T>[];
  mergeKey?: string;
  committedAt: number;
}

export class CompoundCommandError extends Error {
  readonly originalError: unknown;
  readonly rollbackError?: unknown;

  constructor(label: string, originalError: unknown, rollbackError?: unknown) {
    const reason = originalError instanceof Error ? `: ${originalError.message}` : '';
    super(`Compound command "${label}" failed${rollbackError ? ' and rollback was incomplete' : ''}${reason}`, {
      cause: originalError,
    });
    this.name = 'CompoundCommandError';
    this.originalError = originalError;
    this.rollbackError = rollbackError;
  }
}

export function createHistoryStore<T>(initialState: T, maxEntries = 200): HistoryStore<T> {
  let state = initialState;
  let undoStack: HistoryEntry<T>[] = [];
  let redoStack: HistoryEntry<T>[] = [];
  let queue: Promise<void> = Promise.resolve();
  let pendingCount = 0;
  // `replaceState` is a project-boundary operation. Async edits that started
  // against the previous state must never commit after that boundary.
  let stateEpoch = 0;
  const listeners = new Set<HistoryListener<T>>();

  const snapshot = (): HistorySnapshot<T> => ({
    state,
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    undoLabel: undoStack.at(-1)?.label,
    redoLabel: redoStack.at(-1)?.label,
    pending: pendingCount > 0,
  });

  const notify = (): void => {
    const next = snapshot();
    for (const listener of listeners) {
      try {
        listener(next);
      } catch {
        // A view listener must never break editing history.
      }
    }
  };

  const enqueue = <R>(operation: () => Promise<R>): Promise<R> => {
    pendingCount += 1;
    notify();
    const task = queue.then(operation, operation);
    queue = task.then(
      () => {
        pendingCount -= 1;
        notify();
      },
      () => {
        pendingCount -= 1;
        notify();
      },
    );
    return task;
  };

  const runForward = async (commands: readonly HistoryCommand<T>[], label: string): Promise<T> => {
    let nextState = state;
    const completed: HistoryCommand<T>[] = [];
    try {
      for (const command of commands) {
        nextState = await command.do(nextState);
        completed.push(command);
      }
      return nextState;
    } catch (originalError) {
      let rollbackError: unknown;
      for (let index = completed.length - 1; index >= 0; index -= 1) {
        try {
          nextState = await completed[index].undo(nextState);
        } catch (error) {
          rollbackError = error;
          break;
        }
      }
      if (commands.length === 1 && completed.length === 0) throw originalError;
      throw new CompoundCommandError(label, originalError, rollbackError);
    }
  };

  const executeEntry = (entry: HistoryEntry<T>): Promise<T> => {
    const operationEpoch = stateEpoch;
    return enqueue(async () => {
      if (operationEpoch !== stateEpoch) return state;
      const nextState = await runForward(entry.commands, entry.label);
      if (operationEpoch !== stateEpoch) return state;
      state = nextState;
      const previous = undoStack.at(-1);
      if (
        entry.mergeKey
        && previous?.mergeKey === entry.mergeKey
        && entry.committedAt - previous.committedAt <= 750
      ) {
        undoStack[undoStack.length - 1] = {
          ...entry,
          commands: [...previous.commands, ...entry.commands],
        };
      } else {
        undoStack.push(entry);
      }
      if (undoStack.length > maxEntries) undoStack = undoStack.slice(-maxEntries);
      redoStack = [];
      notify();
      return state;
    });
  };

  return {
    getState: () => state,
    getSnapshot: snapshot,
    execute: (command) => executeEntry({ label: command.label, commands: [command], mergeKey: command.mergeKey, committedAt: Date.now() }),
    executeCompound: (label, commands) => {
      if (commands.length === 0) return Promise.resolve(state);
      return executeEntry({ label, commands: [...commands], committedAt: Date.now() });
    },
    undo: () => {
      const operationEpoch = stateEpoch;
      return enqueue(async () => {
        if (operationEpoch !== stateEpoch) return state;
        const entry = undoStack.at(-1);
        if (!entry) return state;
        let nextState = state;
        for (let index = entry.commands.length - 1; index >= 0; index -= 1) {
          nextState = await entry.commands[index].undo(nextState);
        }
        if (operationEpoch !== stateEpoch) return state;
        state = nextState;
        undoStack.pop();
        redoStack.push(entry);
        notify();
        return state;
      });
    },
    redo: () => {
      const operationEpoch = stateEpoch;
      return enqueue(async () => {
        if (operationEpoch !== stateEpoch) return state;
        const entry = redoStack.at(-1);
        if (!entry) return state;
        const nextState = await runForward(entry.commands, entry.label);
        if (operationEpoch !== stateEpoch) return state;
        state = nextState;
        redoStack.pop();
        undoStack.push(entry);
        notify();
        return state;
      });
    },
    updateState: (update) => {
      const operationEpoch = stateEpoch;
      return enqueue(async () => {
        if (operationEpoch !== stateEpoch) return state;
        const nextState = await update(state);
        if (operationEpoch !== stateEpoch) return state;
        state = nextState;
        notify();
        return state;
      });
    },
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    replaceState: (nextState, options) => {
      stateEpoch += 1;
      state = nextState;
      if (options?.clearHistory ?? true) {
        undoStack = [];
        redoStack = [];
      }
      notify();
    },
    clear: () => {
      stateEpoch += 1;
      undoStack = [];
      redoStack = [];
      notify();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function createSnapshotCommand<T>(
  label: string,
  apply: (state: T) => MaybePromise<T>,
  clone: (state: T) => T = (state) => structuredClone(state),
  mergeKey?: string,
  rebaseUndo?: (historicalState: T, currentState: T) => T,
): HistoryCommand<T> {
  let before: T | undefined;
  return {
    label,
    mergeKey,
    async do(state) {
      before = clone(state);
      return apply(state);
    },
    undo(state) {
      if (before === undefined) throw new Error(`Command "${label}" has not been executed`);
      const historicalState = clone(before);
      return rebaseUndo ? rebaseUndo(historicalState, state) : historicalState;
    },
  };
}

export function createValueCommand<T>(label: string, before: T, after: T): HistoryCommand<T> {
  return {
    label,
    do: () => after,
    undo: () => before,
  };
}
