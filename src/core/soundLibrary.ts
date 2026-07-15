import type { GenerationLengthSnapshot, MediaIntegrity, WaveformPeakLevel } from '../types';
import { sha256Media, verifyMediaIntegrity } from './audio/hash';

export type SoundLibrarySource = 'generated' | 'imported';

/** Project-independent, immutable source media available to every local project. */
export interface SoundLibraryItem {
  id: string;
  name: string;
  source: SoundLibrarySource;
  createdAt: string;
  durationSeconds: number;
  mimeType: string;
  sampleRate?: number;
  channelCount?: number;
  prompt?: string;
  seed?: number;
  generationLength?: GenerationLengthSnapshot;
  provider?: string;
  device?: string;
  model?: string;
  modelId?: string;
  modelRevision?: string;
  codeRevision?: string;
  runtime?: string;
  route?: string;
  sourcePeak?: number | null;
  outputPeak?: number | null;
  peakProtectionApplied?: boolean;
  peakAttenuationDb?: number;
  waveform?: WaveformPeakLevel;
  blob?: Blob;
  bytes?: ArrayBuffer;
  contentHashSha256?: string;
  integrity?: MediaIntegrity;
}

export interface SoundLibrary {
  put(item: SoundLibraryItem): Promise<SoundLibraryItem>;
  get(id: string): Promise<SoundLibraryItem | undefined>;
  list(): Promise<SoundLibraryItem[]>;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
}

export class SoundLibraryError extends Error {
  readonly code: 'unavailable' | 'invalid-item' | 'media-missing' | 'media-corrupt';

  constructor(code: SoundLibraryError['code'], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SoundLibraryError';
    this.code = code;
  }
}

export interface SoundLibraryOptions {
  indexedDB?: IDBFactory | null;
  databaseName?: string;
}

const copyItem = (item: SoundLibraryItem): SoundLibraryItem => structuredClone(item);

const prepareItem = async (item: SoundLibraryItem): Promise<SoundLibraryItem> => {
  if (!item.id.trim() || !item.name.trim() || !Number.isFinite(item.durationSeconds) || item.durationSeconds <= 0) {
    throw new SoundLibraryError('invalid-item', 'Library sound requires an ID, name, and positive duration');
  }
  if (!item.blob && !item.bytes) {
    throw new SoundLibraryError('media-missing', 'Library sound requires local encoded audio bytes');
  }
  const prepared = copyItem(item);
  prepared.contentHashSha256 ??= await sha256Media(prepared.blob ?? prepared.bytes!);
  const integrity = await verifyMediaIntegrity(prepared);
  prepared.integrity = integrity;
  if (integrity.state === 'missing') throw new SoundLibraryError('media-missing', integrity.message ?? 'Library media is missing');
  if (integrity.state !== 'available') throw new SoundLibraryError('media-corrupt', integrity.message ?? 'Library media failed integrity verification');
  return prepared;
};

const requestResult = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error('Sound Library request failed'));
});

const transactionDone = (transaction: IDBTransaction): Promise<void> => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onerror = () => reject(transaction.error ?? new Error('Sound Library transaction failed'));
  transaction.onabort = () => reject(transaction.error ?? new Error('Sound Library transaction aborted'));
});

export function createGlobalSoundLibrary(options: SoundLibraryOptions = {}): SoundLibrary {
  const factory = options.indexedDB === undefined ? globalThis.indexedDB : options.indexedDB ?? undefined;
  const databaseName = options.databaseName ?? 'vibeseq-sound-library';
  let databasePromise: Promise<IDBDatabase> | undefined;
  const database = (): Promise<IDBDatabase> => {
    if (!factory) return Promise.reject(new SoundLibraryError('unavailable', 'IndexedDB is unavailable; the global Sound Library cannot be saved'));
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      const request = factory.open(databaseName, 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore('sounds', { keyPath: 'id' });
        store.createIndex('contentHashSha256', 'contentHashSha256', { unique: true });
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
      request.onerror = () => reject(new SoundLibraryError('unavailable', 'The global Sound Library could not be opened', { cause: request.error }));
      request.onblocked = () => reject(new SoundLibraryError('unavailable', 'The global Sound Library upgrade is blocked by another VibeSeq tab'));
    });
    return databasePromise;
  };

  return {
    async put(item) {
      const prepared = await prepareItem(item);
      const db = await database();
      const transaction = db.transaction('sounds', 'readwrite');
      const store = transaction.objectStore('sounds');
      const existing = await requestResult<SoundLibraryItem | undefined>(
        store.index('contentHashSha256').get(prepared.contentHashSha256!),
      );
      const stored = existing
        ? { ...prepared, id: existing.id, createdAt: existing.createdAt }
        : prepared;
      store.put(copyItem(stored));
      await transactionDone(transaction);
      return copyItem(stored);
    },
    async get(id) {
      const db = await database();
      const transaction = db.transaction('sounds', 'readonly');
      const item = await requestResult<SoundLibraryItem | undefined>(transaction.objectStore('sounds').get(id));
      await transactionDone(transaction);
      return item ? copyItem(item) : undefined;
    },
    async list() {
      const db = await database();
      const transaction = db.transaction('sounds', 'readonly');
      const items = await requestResult<SoundLibraryItem[]>(transaction.objectStore('sounds').getAll());
      await transactionDone(transaction);
      return items.map(copyItem).sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
    },
    async remove(id) {
      const db = await database();
      const transaction = db.transaction('sounds', 'readwrite');
      transaction.objectStore('sounds').delete(id);
      await transactionDone(transaction);
    },
    async clear() {
      const db = await database();
      const transaction = db.transaction('sounds', 'readwrite');
      transaction.objectStore('sounds').clear();
      await transactionDone(transaction);
    },
  };
}

export function createMemorySoundLibrary(): SoundLibrary {
  const items = new Map<string, SoundLibraryItem>();
  return {
    async put(item) {
      const prepared = await prepareItem(item);
      const duplicate = [...items.values()].find((entry) => entry.contentHashSha256 === prepared.contentHashSha256);
      const stored = duplicate ? { ...prepared, id: duplicate.id, createdAt: duplicate.createdAt } : prepared;
      items.set(stored.id, copyItem(stored));
      return copyItem(stored);
    },
    async get(id) {
      const item = items.get(id);
      return item ? copyItem(item) : undefined;
    },
    async list() {
      return [...items.values()].map(copyItem).sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
    },
    async remove(id) { items.delete(id); },
    async clear() { items.clear(); },
  };
}
