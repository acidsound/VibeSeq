import { describe, expect, it } from 'vitest';
import { CompoundCommandError, createHistoryStore, createSnapshotCommand, type HistoryCommand } from './history';

const add = (amount: number): HistoryCommand<number> => ({
  label: `Add ${amount}`,
  async do(value) {
    await Promise.resolve();
    return value + amount;
  },
  undo: (value) => value - amount,
});

describe('history store', () => {
  it('serializes async commands and undoes a compound edit as one step', async () => {
    const history = createHistoryStore(0);
    await Promise.all([history.execute(add(1)), history.execute(add(2))]);
    expect(history.getState()).toBe(3);
    await history.executeCompound('Phrase edit', [add(4), add(8)]);
    expect(history.getState()).toBe(15);
    expect(history.getSnapshot().undoLabel).toBe('Phrase edit');
    await history.undo();
    expect(history.getState()).toBe(3);
    await history.redo();
    expect(history.getState()).toBe(15);
  });

  it('rolls back completed commands when a compound operation fails', async () => {
    const history = createHistoryStore(10);
    const failure: HistoryCommand<number> = {
      label: 'Fail',
      do: () => {
        throw new Error('disk full');
      },
      undo: (value) => value,
    };
    await expect(history.executeCompound('Atomic edit', [add(5), failure])).rejects.toBeInstanceOf(CompoundCommandError);
    expect(history.getState()).toBe(10);
    expect(history.canUndo()).toBe(false);
  });

  it('preserves the actionable error from a rejected single command', async () => {
    const history = createHistoryStore(10);
    const failure = new RangeError('overlap is not allowed');
    const command: HistoryCommand<number> = {
      label: 'Rejected edit',
      do: () => { throw failure; },
      undo: (value) => value,
    };

    await expect(history.execute(command)).rejects.toBe(failure);
    expect(history.getState()).toBe(10);
    expect(history.canUndo()).toBe(false);
  });

  it('coalesces rapid commands with the same merge key into one undo step', async () => {
    const history = createHistoryStore({ gain: 0 });
    await history.execute(createSnapshotCommand<{ gain: number }>('Gain', (state) => ({ ...state, gain: 0.25 }), structuredClone, 'gain:track-1'));
    await history.execute(createSnapshotCommand<{ gain: number }>('Gain', (state) => ({ ...state, gain: 0.75 }), structuredClone, 'gain:track-1'));
    expect(history.getState().gain).toBe(0.75);
    await history.undo();
    expect(history.getState().gain).toBe(0);
    expect(history.canUndo()).toBe(false);
  });

  it('does not let an in-flight update restore the previous project after replacement', async () => {
    const history = createHistoryStore({ id: 'previous', jobs: 0 });
    let finishPreviousUpdate: ((value: { id: string; jobs: number }) => void) | undefined;
    let markPreviousUpdateStarted: (() => void) | undefined;
    const previousUpdateStarted = new Promise<void>((resolve) => { markPreviousUpdateStarted = resolve; });
    const previousUpdate = history.updateState(() => {
      markPreviousUpdateStarted?.();
      return new Promise((resolve) => { finishPreviousUpdate = resolve; });
    });

    await previousUpdateStarted;
    history.replaceState({ id: 'new', jobs: 0 }, { clearHistory: true });
    finishPreviousUpdate?.({ id: 'previous', jobs: 1 });
    await previousUpdate;

    expect(history.getState()).toEqual({ id: 'new', jobs: 0 });
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(false);
  });

  it('reverses and redoes at least 100 ordered edits without state divergence', async () => {
    const history = createHistoryStore<number[]>([]);

    for (let value = 0; value < 100; value += 1) {
      await history.execute({
        label: `Append ${value}`,
        do: (state) => [...state, value],
        undo: (state) => state.slice(0, -1),
      });
    }

    const committed = Array.from({ length: 100 }, (_, index) => index);
    expect(history.getState()).toEqual(committed);

    for (let index = 0; index < 100; index += 1) await history.undo();
    expect(history.getState()).toEqual([]);
    expect(history.canUndo()).toBe(false);

    for (let index = 0; index < 100; index += 1) await history.redo();
    expect(history.getState()).toEqual(committed);
    expect(history.canRedo()).toBe(false);
  });
});
