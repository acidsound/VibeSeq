import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { sha256Media } from './audio/hash';
import { createGlobalSoundLibrary, createMemorySoundLibrary, SoundLibraryError } from './soundLibrary';
import type { SoundLibraryItem } from './soundLibrary';

const item = async (overrides: Partial<SoundLibraryItem> = {}): Promise<SoundLibraryItem> => {
  const blob = new Blob([Uint8Array.from([82, 73, 70, 70, 1, 2, 3, 4])], { type: 'audio/wav' });
  return {
    id: 'sound-a',
    name: 'Generated pulse',
    source: 'generated',
    createdAt: '2026-07-15T00:00:00.000Z',
    durationSeconds: 4,
    mimeType: 'audio/wav',
    provider: 'stable-audio-3',
    blob,
    contentHashSha256: await sha256Media(blob),
    ...overrides,
  };
};

describe('project-independent Sound Library', () => {
  beforeEach(async () => {
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase('vibeseq-library-test');
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    });
  });

  it('survives a new library instance and returns newest sounds first', async () => {
    const library = createGlobalSoundLibrary({ indexedDB, databaseName: 'vibeseq-library-test' });
    await library.put(await item());
    await library.put(await item({ id: 'sound-b', name: 'Second sound', createdAt: '2026-07-15T00:00:01.000Z', blob: new Blob([Uint8Array.from([9, 8, 7])]), contentHashSha256: undefined }));

    const reopened = createGlobalSoundLibrary({ indexedDB, databaseName: 'vibeseq-library-test' });
    await expect(reopened.list()).resolves.toMatchObject([
      { id: 'sound-b', name: 'Second sound', integrity: { state: 'available' } },
      { id: 'sound-a', name: 'Generated pulse', integrity: { state: 'available' } },
    ]);
  });

  it('deduplicates identical source bytes by SHA-256 and supports removal', async () => {
    const library = createMemorySoundLibrary();
    const first = await library.put(await item());
    const duplicate = await library.put(await item({ id: 'duplicate', name: 'Renamed duplicate' }));
    expect(duplicate.id).toBe(first.id);
    await expect(library.list()).resolves.toHaveLength(1);
    await library.remove(first.id);
    await expect(library.list()).resolves.toEqual([]);
  });

  it('rejects missing or tampered media instead of creating a fake library row', async () => {
    const library = createMemorySoundLibrary();
    await expect(library.put(await item({ blob: undefined, bytes: undefined }))).rejects.toMatchObject({ code: 'media-missing' });
    await expect(library.put(await item({ contentHashSha256: '0'.repeat(64) }))).rejects.toBeInstanceOf(SoundLibraryError);
  });
});
