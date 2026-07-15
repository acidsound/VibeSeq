import type { Project, ProjectSummary } from '../types';
import {
  createProjectCheckpoint,
  deserializeProjectCheckpoint,
  serializeProjectCheckpoint,
  validateProject,
  validateProjectCheckpoint,
} from './projectSerialization';
import type { ProjectCheckpoint, ProjectSessionSnapshot } from './projectSerialization';

export {
  base64ToBytes,
  bytesToBase64,
  createProjectCheckpoint,
  deserializeProject,
  deserializeProjectCheckpoint,
  ProjectImportError,
  PROJECT_SCHEMA_VERSION,
  PROJECT_SERIALIZATION_FORMAT,
  PROJECT_SERIALIZATION_VERSION,
  serializeProject,
  serializeProjectCheckpoint,
  validateProject,
  validateProjectCheckpoint,
  validateProjectSession,
} from './projectSerialization';
export type {
  ActiveInferenceJobSnapshot,
  GenerationCandidateSnapshot,
  InferenceJobSnapshot,
  ProjectCheckpoint,
  ProjectSessionSnapshot,
} from './projectSerialization';

export type PersistenceBackend = 'indexeddb' | 'localstorage' | 'memory';

export class ProjectRecoveryPendingError extends Error {
  readonly projectId: string;

  constructor(projectId: string) {
    super(`Project ${projectId} has a newer interrupted-save checkpoint`);
    this.name = 'ProjectRecoveryPendingError';
    this.projectId = projectId;
  }
}

export class ProjectCheckpointConflictError extends Error {
  readonly projectId: string;
  readonly revision: number;
  readonly checkpointIds: string[];

  constructor(projectId: string, revision: number, checkpointIds: string[]) {
    super(`Project ${projectId} has conflicting checkpoints at durability revision ${revision}`);
    this.name = 'ProjectCheckpointConflictError';
    this.projectId = projectId;
    this.revision = revision;
    this.checkpointIds = [...checkpointIds];
  }
}

export class ProjectDurabilityError extends Error {
  readonly code: 'quota-exceeded' | 'durable-storage-unavailable';
  readonly attemptedBackends: PersistenceBackend[];

  constructor(code: ProjectDurabilityError['code'], attemptedBackends: PersistenceBackend[]) {
    super(code === 'quota-exceeded'
      ? 'Durable browser storage is full; the current session is not safely saved'
      : 'Durable browser storage is unavailable; the current session is not safely saved');
    this.name = 'ProjectDurabilityError';
    this.code = code;
    this.attemptedBackends = [...attemptedBackends];
  }
}

export interface ProjectPersistence {
  /** Save the project while preserving any already-journaled candidate/job session. */
  save(project: Project): Promise<void>;
  /** Atomically checkpoint the project and pre-placement candidate/job session. */
  saveWorkspace(project: Project, session: ProjectSessionSnapshot): Promise<ProjectCheckpoint>;
  /** Atomically commit an already validated portable checkpoint. */
  importWorkspace(checkpoint: ProjectCheckpoint): Promise<ProjectCheckpoint>;
  load(projectId: string): Promise<Project | undefined>;
  loadWorkspace(projectId: string): Promise<ProjectCheckpoint | undefined>;
  /** Return a complete interrupted-save snapshot without silently applying it. */
  loadRecovery(projectId: string): Promise<ProjectCheckpoint | undefined>;
  /** Enumerate every globally pending recovery, including not-yet-acknowledged project IDs. */
  listRecoveries(): Promise<ProjectCheckpoint[]>;
  /** Promote the interrupted-save snapshot to the acknowledged project. */
  recover(projectId: string): Promise<ProjectCheckpoint | undefined>;
  discardRecovery(projectId: string): Promise<void>;
  list(): Promise<ProjectSummary[]>;
  remove(projectId: string): Promise<void>;
  clear(): Promise<void>;
  getBackend(): PersistenceBackend;
}

export interface PersistenceOptions {
  namespace?: string;
  indexedDB?: IDBFactory | null;
  localStorage?: Storage | null;
}

interface PersistenceAdapter {
  commit(checkpoint: ProjectCheckpoint): Promise<void>;
  loadWorkspace(projectId: string): Promise<ProjectCheckpoint | undefined>;
  loadRecovery(projectId: string): Promise<ProjectCheckpoint | undefined>;
  listRecoveries(): Promise<ProjectCheckpoint[]>;
  recover(projectId: string): Promise<ProjectCheckpoint | undefined>;
  discardRecovery(projectId: string): Promise<void>;
  list(): Promise<ProjectSummary[]>;
  remove(projectId: string): Promise<void>;
  clear(): Promise<void>;
}

const summarize = (project: Project): ProjectSummary => ({
  id: project.id,
  name: project.name,
  bpm: project.bpm,
  trackCount: project.tracks.length,
  updatedAt: project.updatedAt,
});

const copyCheckpoint = (checkpoint: ProjectCheckpoint): ProjectCheckpoint =>
  validateProjectCheckpoint(structuredClone(checkpoint));

const isSameCheckpoint = (
  primary: ProjectCheckpoint | undefined,
  recovery: ProjectCheckpoint | undefined,
): boolean => Boolean(primary && recovery && primary.checkpointId === recovery.checkpointId);

function createMemoryAdapter(): PersistenceAdapter {
  const projects = new Map<string, ProjectCheckpoint>();
  const recovery = new Map<string, ProjectCheckpoint>();
  return {
    async commit(checkpoint) {
      const pending = copyCheckpoint(checkpoint);
      recovery.set(checkpoint.project.id, pending);
      projects.set(checkpoint.project.id, copyCheckpoint(pending));
      recovery.delete(checkpoint.project.id);
    },
    async loadWorkspace(projectId) {
      const checkpoint = projects.get(projectId);
      return checkpoint ? copyCheckpoint(checkpoint) : undefined;
    },
    async loadRecovery(projectId) {
      const pending = recovery.get(projectId);
      if (!pending || isSameCheckpoint(projects.get(projectId), pending)) return undefined;
      return copyCheckpoint(pending);
    },
    async listRecoveries() {
      return [...recovery.values()].map(copyCheckpoint);
    },
    async recover(projectId) {
      const pending = recovery.get(projectId);
      if (!pending) return undefined;
      projects.set(projectId, copyCheckpoint(pending));
      recovery.delete(projectId);
      return copyCheckpoint(pending);
    },
    async discardRecovery(projectId) {
      recovery.delete(projectId);
    },
    async list() {
      return [...projects.values()]
        .map((checkpoint) => summarize(checkpoint.project))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async remove(projectId) {
      projects.delete(projectId);
      recovery.delete(projectId);
    },
    async clear() {
      projects.clear();
      recovery.clear();
    },
  };
}

function createLocalStorageAdapter(storage: Storage, namespace: string): PersistenceAdapter {
  const projectPrefix = `${namespace}:project:`;
  const recoveryPrefix = `${namespace}:recovery:`;
  const projectKey = (id: string) => `${projectPrefix}${id}`;
  const recoveryKey = (id: string) => `${recoveryPrefix}${id}`;
  const keysWithPrefix = (prefix: string): string[] => {
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(prefix)) keys.push(key);
    }
    return keys;
  };
  const loadAt = (key: string): ProjectCheckpoint | undefined => {
    const value = storage.getItem(key);
    return value ? deserializeProjectCheckpoint(value) : undefined;
  };

  return {
    async commit(checkpoint) {
      const serialized = await serializeProjectCheckpoint(checkpoint);
      const id = checkpoint.project.id;
      // Phase one is intentionally separate: a crash leaves a complete recovery.
      storage.setItem(recoveryKey(id), serialized);
      storage.setItem(projectKey(id), serialized);
      storage.removeItem(recoveryKey(id));
    },
    async loadWorkspace(projectId) {
      return loadAt(projectKey(projectId));
    },
    async loadRecovery(projectId) {
      const pending = loadAt(recoveryKey(projectId));
      if (!pending) return undefined;
      try {
        return isSameCheckpoint(loadAt(projectKey(projectId)), pending) ? undefined : pending;
      } catch {
        return pending;
      }
    },
    async listRecoveries() {
      const checkpoints: ProjectCheckpoint[] = [];
      for (const key of keysWithPrefix(recoveryPrefix)) {
        try {
          const checkpoint = loadAt(key);
          if (checkpoint) checkpoints.push(checkpoint);
        } catch {
          // A corrupt recovery record must not hide healthy recovery choices.
        }
      }
      return checkpoints;
    },
    async recover(projectId) {
      const serialized = storage.getItem(recoveryKey(projectId));
      if (!serialized) return undefined;
      const pending = deserializeProjectCheckpoint(serialized);
      storage.setItem(projectKey(projectId), serialized);
      storage.removeItem(recoveryKey(projectId));
      return pending;
    },
    async discardRecovery(projectId) {
      storage.removeItem(recoveryKey(projectId));
    },
    async list() {
      const summaries: ProjectSummary[] = [];
      for (const key of keysWithPrefix(projectPrefix)) {
        try {
          const checkpoint = loadAt(key);
          if (checkpoint) summaries.push(summarize(checkpoint.project));
        } catch {
          // One corrupt project must not hide or prevent deletion of the others.
        }
      }
      return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async remove(projectId) {
      storage.removeItem(projectKey(projectId));
      storage.removeItem(recoveryKey(projectId));
    },
    async clear() {
      for (const key of [...keysWithPrefix(projectPrefix), ...keysWithPrefix(recoveryPrefix)]) {
        storage.removeItem(key);
      }
    },
  };
}

const requestResult = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });

const transactionDone = (transaction: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });

const checkpointFromIndexedValue = (value: unknown): ProjectCheckpoint => {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid IndexedDB project record');
  }
  const source = value as Record<string, unknown>;
  if (source.checkpoint !== undefined) return validateProjectCheckpoint(source.checkpoint);
  if (typeof source.serialized === 'string') return deserializeProjectCheckpoint(source.serialized);
  const project = validateProject(source);
  return createProjectCheckpoint(project, { candidates: [] }, {
    checkpointId: `legacy-${project.id}-${project.updatedAt}`,
    savedAt: project.updatedAt,
  });
};

function createIndexedDBAdapter(factory: IDBFactory, namespace: string): PersistenceAdapter {
  let databasePromise: Promise<IDBDatabase> | undefined;
  const database = (): Promise<IDBDatabase> => {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      const request = factory.open(`${namespace}-projects`, 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('recovery')) db.createObjectStore('recovery', { keyPath: 'id' });
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
      request.onerror = () => reject(request.error ?? new Error('Could not open IndexedDB'));
      request.onblocked = () => reject(new Error('IndexedDB upgrade is blocked by another VibeSeq tab'));
    });
    return databasePromise;
  };

  const loadStore = async (storeName: 'projects' | 'recovery', projectId: string) => {
    const db = await database();
    const transaction = db.transaction(storeName, 'readonly');
    const value = await requestResult(transaction.objectStore(storeName).get(projectId));
    await transactionDone(transaction);
    return value === undefined ? undefined : checkpointFromIndexedValue(value);
  };

  return {
    async commit(checkpoint) {
      const db = await database();
      const pending = copyCheckpoint(checkpoint);
      const journalTransaction = db.transaction('recovery', 'readwrite');
      journalTransaction.objectStore('recovery').put({ id: checkpoint.project.id, checkpoint: pending });
      await transactionDone(journalTransaction);

      const commitTransaction = db.transaction(['projects', 'recovery'], 'readwrite');
      commitTransaction.objectStore('projects').put({ id: checkpoint.project.id, checkpoint: pending });
      commitTransaction.objectStore('recovery').delete(checkpoint.project.id);
      await transactionDone(commitTransaction);
    },
    async loadWorkspace(projectId) {
      return loadStore('projects', projectId);
    },
    async loadRecovery(projectId) {
      const pending = await loadStore('recovery', projectId);
      if (!pending) return undefined;
      const primary = await loadStore('projects', projectId);
      return isSameCheckpoint(primary, pending) ? undefined : pending;
    },
    async listRecoveries() {
      const db = await database();
      const transaction = db.transaction('recovery', 'readonly');
      const values = await requestResult(transaction.objectStore('recovery').getAll());
      await transactionDone(transaction);
      const checkpoints: ProjectCheckpoint[] = [];
      for (const value of values) {
        try {
          checkpoints.push(checkpointFromIndexedValue(value));
        } catch {
          // Keep valid recovery records available when one record is damaged.
        }
      }
      return checkpoints;
    },
    async recover(projectId) {
      const db = await database();
      const transaction = db.transaction(['projects', 'recovery'], 'readwrite');
      const recoveryStore = transaction.objectStore('recovery');
      const value = await requestResult(recoveryStore.get(projectId));
      if (value === undefined) {
        await transactionDone(transaction);
        return undefined;
      }
      const pending = checkpointFromIndexedValue(value);
      transaction.objectStore('projects').put({ id: projectId, checkpoint: pending });
      recoveryStore.delete(projectId);
      await transactionDone(transaction);
      return pending;
    },
    async discardRecovery(projectId) {
      const db = await database();
      const transaction = db.transaction('recovery', 'readwrite');
      transaction.objectStore('recovery').delete(projectId);
      await transactionDone(transaction);
    },
    async list() {
      const db = await database();
      const transaction = db.transaction('projects', 'readonly');
      const values = await requestResult(transaction.objectStore('projects').getAll());
      await transactionDone(transaction);
      const summaries: ProjectSummary[] = [];
      for (const value of values) {
        try {
          summaries.push(summarize(checkpointFromIndexedValue(value).project));
        } catch {
          // Keep other projects available when one record is damaged.
        }
      }
      return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async remove(projectId) {
      const db = await database();
      const transaction = db.transaction(['projects', 'recovery'], 'readwrite');
      transaction.objectStore('projects').delete(projectId);
      transaction.objectStore('recovery').delete(projectId);
      await transactionDone(transaction);
    },
    async clear() {
      const db = await database();
      const transaction = db.transaction(['projects', 'recovery'], 'readwrite');
      transaction.objectStore('projects').clear();
      transaction.objectStore('recovery').clear();
      await transactionDone(transaction);
    },
  };
}

const createPersistence = (
  candidates: Array<{ backend: PersistenceBackend; adapter: PersistenceAdapter }>,
  options: { acceptMemoryDurability?: boolean } = {},
): ProjectPersistence => {
  let activeIndex = 0;

  type LocatedCheckpoint = {
    index: number;
    checkpoint: ProjectCheckpoint;
  };

  type GlobalProjectState = {
    primaries: LocatedCheckpoint[];
    recoveries: LocatedCheckpoint[];
    primarySuccesses: number;
    recoverySuccesses: number;
    lastError?: unknown;
  };

  const selectNewest = (
    projectId: string,
    records: LocatedCheckpoint[],
  ): LocatedCheckpoint | undefined => {
    if (records.length === 0) return undefined;
    const newestRevision = Math.max(...records.map(({ checkpoint }) => checkpoint.revision));
    const newest = records.filter(({ checkpoint }) => checkpoint.revision === newestRevision);
    const checkpointIds = [...new Set(newest.map(({ checkpoint }) => checkpoint.checkpointId))];
    if (checkpointIds.length > 1) {
      throw new ProjectCheckpointConflictError(projectId, newestRevision, checkpointIds);
    }
    return newest.sort((left, right) => left.index - right.index)[0];
  };

  const readGlobalState = async (projectId: string): Promise<GlobalProjectState> => {
    const state: GlobalProjectState = {
      primaries: [],
      recoveries: [],
      primarySuccesses: 0,
      recoverySuccesses: 0,
    };
    for (let index = 0; index < candidates.length; index += 1) {
      try {
        const primary = await candidates[index].adapter.loadWorkspace(projectId);
        state.primarySuccesses += 1;
        if (primary) state.primaries.push({ index, checkpoint: primary });
      } catch (error) {
        state.lastError = error;
      }
      try {
        const recovery = await candidates[index].adapter.loadRecovery(projectId);
        state.recoverySuccesses += 1;
        if (recovery) state.recoveries.push({ index, checkpoint: recovery });
      } catch (error) {
        state.lastError = error;
      }
    }
    return state;
  };

  const resolveGlobalState = (projectId: string, state: GlobalProjectState) => {
    const primary = selectNewest(projectId, state.primaries);
    const recovery = selectNewest(projectId, state.recoveries);
    if (
      primary
      && recovery
      && primary.checkpoint.revision === recovery.checkpoint.revision
      && primary.checkpoint.checkpointId !== recovery.checkpoint.checkpointId
    ) {
      throw new ProjectCheckpointConflictError(projectId, primary.checkpoint.revision, [
        primary.checkpoint.checkpointId,
        recovery.checkpoint.checkpointId,
      ]);
    }
    const pendingRecovery = recovery && (
      !primary || recovery.checkpoint.revision > primary.checkpoint.revision
    ) ? recovery : undefined;
    const maximumRevision = Math.max(
      0,
      ...state.primaries.map(({ checkpoint }) => checkpoint.revision),
      ...state.recoveries.map(({ checkpoint }) => checkpoint.revision),
    );
    return { primary, pendingRecovery, maximumRevision };
  };

  const isQuotaError = (error: unknown): boolean => {
    let current = error;
    const visited = new Set<unknown>();
    while (current && typeof current === 'object' && !visited.has(current)) {
      visited.add(current);
      if ((current as { name?: unknown }).name === 'QuotaExceededError') return true;
      current = (current as { cause?: unknown }).cause;
    }
    return false;
  };

  const runCommit = async (checkpoint: ProjectCheckpoint): Promise<void> => {
    let lastError: unknown;
    const attemptedBackends: PersistenceBackend[] = [];
    let quotaExceeded = false;
    // Retry the preferred durable backend on every explicit checkpoint. A
    // prior fallback must not permanently strand newer state elsewhere.
    for (let index = 0; index < candidates.length; index += 1) {
      attemptedBackends.push(candidates[index].backend);
      try {
        await candidates[index].adapter.commit(checkpoint);
        activeIndex = index;
        if (candidates[index].backend === 'memory' && !options.acceptMemoryDurability) {
          throw new ProjectDurabilityError(
            quotaExceeded ? 'quota-exceeded' : 'durable-storage-unavailable',
            attemptedBackends,
          );
        }
        return;
      } catch (error) {
        if (error instanceof ProjectDurabilityError) throw error;
        lastError = error;
        quotaExceeded ||= isQuotaError(error);
        try {
          const primary = await candidates[index].adapter.loadWorkspace(checkpoint.project.id);
          if (primary?.checkpointId === checkpoint.checkpointId) {
            await candidates[index].adapter.discardRecovery(checkpoint.project.id).catch(() => undefined);
            activeIndex = index;
            if (candidates[index].backend === 'memory' && !options.acceptMemoryDurability) {
              throw new ProjectDurabilityError(
                quotaExceeded ? 'quota-exceeded' : 'durable-storage-unavailable',
                attemptedBackends,
              );
            }
            return;
          }
        } catch (confirmationError) {
          if (confirmationError instanceof ProjectDurabilityError) throw confirmationError;
          // A damaged or unavailable primary may still have a valid recovery.
        }
        try {
          const recovery = await candidates[index].adapter.loadRecovery(checkpoint.project.id);
          if (recovery && recovery.revision >= checkpoint.revision) {
            throw new ProjectRecoveryPendingError(checkpoint.project.id);
          }
        } catch (recoveryError) {
          if (recoveryError instanceof ProjectRecoveryPendingError) throw recoveryError;
        }
      }
    }
    if (lastError) throw lastError;
    throw new ProjectDurabilityError(
      quotaExceeded ? 'quota-exceeded' : 'durable-storage-unavailable',
      attemptedBackends,
    );
  };

  const loadWorkspace = async (projectId: string): Promise<ProjectCheckpoint | undefined> => {
    const state = await readGlobalState(projectId);
    if (state.primarySuccesses === 0) {
      throw state.lastError ?? new Error('No project persistence backend is available');
    }
    const { primary } = resolveGlobalState(projectId, state);
    if (!primary) return undefined;
    activeIndex = primary.index;
    return copyCheckpoint(primary.checkpoint);
  };

  const loadRecovery = async (projectId: string): Promise<ProjectCheckpoint | undefined> => {
    const state = await readGlobalState(projectId);
    if (state.recoverySuccesses === 0) {
      throw state.lastError ?? new Error('No project persistence backend is available');
    }
    const { pendingRecovery } = resolveGlobalState(projectId, state);
    if (!pendingRecovery) return undefined;
    return copyCheckpoint(pendingRecovery.checkpoint);
  };

  const listRecoveries = async (): Promise<ProjectCheckpoint[]> => {
    const projectIds = new Set<string>();
    let successes = 0;
    let lastError: unknown;
    for (let index = 0; index < candidates.length; index += 1) {
      try {
        const recoveries = await candidates[index].adapter.listRecoveries();
        successes += 1;
        for (const recovery of recoveries) projectIds.add(recovery.project.id);
      } catch (error) {
        lastError = error;
      }
    }
    if (successes === 0) {
      throw lastError ?? new Error('No project persistence backend is available');
    }

    const pending: ProjectCheckpoint[] = [];
    for (const projectId of projectIds) {
      const state = await readGlobalState(projectId);
      const { pendingRecovery } = resolveGlobalState(projectId, state);
      if (pendingRecovery) pending.push(copyCheckpoint(pendingRecovery.checkpoint));
    }
    return pending.sort((left, right) => (
      right.revision - left.revision
      || right.savedAt.localeCompare(left.savedAt)
      || left.project.id.localeCompare(right.project.id)
      || left.checkpointId.localeCompare(right.checkpointId)
    ));
  };

  const list = async (): Promise<ProjectSummary[]> => {
    const projectIds = new Set<string>();
    let successes = 0;
    let lastError: unknown;
    for (let index = 0; index < candidates.length; index += 1) {
      try {
        const summaries = await candidates[index].adapter.list();
        successes += 1;
        for (const summary of summaries) projectIds.add(summary.id);
      } catch (error) {
        lastError = error;
      }
    }
    if (successes === 0) {
      throw lastError ?? new Error('No project persistence backend is available');
    }
    const summaries: ProjectSummary[] = [];
    for (const projectId of projectIds) {
      const checkpoint = await loadWorkspace(projectId);
      if (checkpoint) summaries.push(summarize(checkpoint.project));
    }
    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  };

  const acrossAll = async (
    operation: 'discardRecovery' | 'remove' | 'clear',
    projectId?: string,
  ): Promise<void> => {
    let firstSuccessfulIndex: number | undefined;
    let lastError: unknown;
    let failureCount = 0;
    for (let index = 0; index < candidates.length; index += 1) {
      try {
        if (operation === 'clear') await candidates[index].adapter.clear();
        else if (operation === 'remove') await candidates[index].adapter.remove(projectId!);
        else await candidates[index].adapter.discardRecovery(projectId!);
        firstSuccessfulIndex ??= index;
      } catch (error) {
        lastError = error;
        failureCount += 1;
      }
    }
    if (firstSuccessfulIndex === undefined) {
      throw lastError ?? new Error('No project persistence backend is available');
    }
    activeIndex = firstSuccessfulIndex;
    if (operation === 'remove' && failureCount > 0) {
      throw new Error(
        `Project removal could not be confirmed on ${failureCount} persistence backend${failureCount === 1 ? '' : 's'}`,
        { cause: lastError },
      );
    }
  };

  const saveWorkspace = async (
    project: Project,
    session: ProjectSessionSnapshot,
  ): Promise<ProjectCheckpoint> => {
    const state = await readGlobalState(project.id);
    const { pendingRecovery, maximumRevision } = resolveGlobalState(project.id, state);
    if (pendingRecovery) throw new ProjectRecoveryPendingError(project.id);
    const checkpoint = createProjectCheckpoint(project, session, {
      minimumRevision: maximumRevision + 1,
    });
    await runCommit(checkpoint);
    return copyCheckpoint(checkpoint);
  };

  const importWorkspace = async (checkpoint: ProjectCheckpoint): Promise<ProjectCheckpoint> => {
    const source = copyCheckpoint(checkpoint);
    const state = await readGlobalState(source.project.id);
    const { pendingRecovery, maximumRevision } = resolveGlobalState(source.project.id, state);
    if (pendingRecovery) throw new ProjectRecoveryPendingError(source.project.id);
    const imported = createProjectCheckpoint(source.project, source.session, {
      checkpointId: source.checkpointId,
      savedAt: source.savedAt,
      minimumRevision: maximumRevision + 1,
    });
    await runCommit(imported);
    return copyCheckpoint(imported);
  };

  return {
    async save(project) {
      const session = (await loadWorkspace(project.id))?.session ?? { candidates: [] };
      await saveWorkspace(project, session);
    },
    saveWorkspace,
    importWorkspace,
    async load(projectId) {
      return (await loadWorkspace(projectId))?.project;
    },
    loadWorkspace,
    loadRecovery,
    listRecoveries,
    async recover(projectId) {
      const state = await readGlobalState(projectId);
      if (state.recoverySuccesses === 0) {
        throw state.lastError ?? new Error('No project persistence backend is available');
      }
      const { pendingRecovery } = resolveGlobalState(projectId, state);
      if (!pendingRecovery) return undefined;
      const recovered = await candidates[pendingRecovery.index].adapter.recover(projectId);
      if (!recovered) return undefined;
      activeIndex = pendingRecovery.index;
      for (let index = 0; index < candidates.length; index += 1) {
        if (index !== pendingRecovery.index) {
          await candidates[index].adapter.discardRecovery(projectId).catch(() => undefined);
        }
      }
      return recovered;
    },
    discardRecovery: (projectId) => acrossAll('discardRecovery', projectId),
    list,
    remove: (projectId) => acrossAll('remove', projectId),
    clear: () => acrossAll('clear'),
    getBackend: () => candidates[activeIndex].backend,
  };
};

export function createMemoryProjectPersistence(): ProjectPersistence {
  return createPersistence(
    [{ backend: 'memory', adapter: createMemoryAdapter() }],
    { acceptMemoryDurability: true },
  );
}

/** IndexedDB first, then localStorage, with an in-memory last resort. */
export function createProjectPersistence(options: PersistenceOptions = {}): ProjectPersistence {
  const namespace = options.namespace ?? 'vibeseq';
  const globalObject = globalThis as typeof globalThis & {
    indexedDB?: IDBFactory;
    localStorage?: Storage;
  };
  const idbFactory = options.indexedDB === undefined
    ? globalObject.indexedDB
    : options.indexedDB ?? undefined;
  let localStorage: Storage | undefined;
  try {
    localStorage = options.localStorage === undefined
      ? globalObject.localStorage
      : options.localStorage ?? undefined;
  } catch {
    localStorage = undefined;
  }

  const candidates: Array<{ backend: PersistenceBackend; adapter: PersistenceAdapter }> = [];
  if (idbFactory) candidates.push({ backend: 'indexeddb', adapter: createIndexedDBAdapter(idbFactory, namespace) });
  if (localStorage) candidates.push({ backend: 'localstorage', adapter: createLocalStorageAdapter(localStorage, namespace) });
  candidates.push({ backend: 'memory', adapter: createMemoryAdapter() });
  return createPersistence(candidates);
}
