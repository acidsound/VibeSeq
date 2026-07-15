import { describe, expect, it } from 'vitest';
import { createDemoProject } from './demo';
import { sha256Media, verifyMediaIntegrity } from './audio/hash';
import { createHistoryStore, createSnapshotCommand } from './history';
import {
  base64ToBytes,
  bytesToBase64,
  createProjectCheckpoint,
  createMemoryProjectPersistence,
  createProjectPersistence,
  deserializeProject,
  deserializeProjectCheckpoint,
  PROJECT_SERIALIZATION_FORMAT,
  ProjectImportError,
  ProjectRecoveryPendingError,
  serializeProject,
  serializeProjectCheckpoint,
  validateProject,
} from './persistence';

class TestStorage implements Storage {
  private readonly values = new Map<string, string>();
  private failKey: string | undefined;
  private failRemoveKey: string | undefined;
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) {
    if (this.failRemoveKey === key) {
      this.failRemoveKey = undefined;
      throw new DOMException('Injected remove failure', 'UnknownError');
    }
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    if (this.failKey === key) {
      this.failKey = undefined;
      throw new DOMException('Injected quota failure', 'QuotaExceededError');
    }
    this.values.set(key, value);
  }
  failNextSet(key: string) { this.failKey = key; }
  failNextRemove(key: string) { this.failRemoveKey = key; }
}

describe('local project persistence', () => {
  it('round-trips arbitrary binary bytes', () => {
    const bytes = Uint8Array.from([0, 1, 2, 127, 128, 254, 255]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it('preserves blobs and array buffers through the localStorage codec', async () => {
    const project = createDemoProject({ now: '2026-07-15T00:00:00.000Z', sampleRate: 48_000 });
    project.assets[0].bytes = Uint8Array.from([4, 8, 15, 16, 23, 42]).buffer;
    project.assets[0].blob = new Blob(['audio'], { type: 'audio/wav' });
    const restored = deserializeProject(await serializeProject(project));
    expect([...new Uint8Array(restored.assets[0].bytes!)]).toEqual([4, 8, 15, 16, 23, 42]);
    expect(await restored.assets[0].blob?.text()).toBe('audio');
    expect(restored.sampleRate).toBe(48_000);
    expect(restored.schemaVersion).toBe(4);
    expect(restored.tracks[0].clips[0]).toMatchObject({
      timebase: { mode: 'fixed-seconds', sourceBpm: 118 },
    });
    expect(restored.tracks[2]).toMatchObject({
      kind: 'midi',
      midi: {
        channel: 0,
        instrument: { kind: 'melodic', playbackId: 'WebAudio-TinySynth', program: 80 },
      },
    });
  });

  it('migrates schema v1 projects without a sample rate to 44.1 kHz', () => {
    const current = createDemoProject({ now: '2026-07-15T00:00:00.000Z', sampleRate: 48_000 });
    const legacy = JSON.parse(JSON.stringify(current)) as Record<string, unknown>;
    legacy.schemaVersion = 1;
    delete legacy.sampleRate;
    delete legacy.arrangement;

    const restored = deserializeProject(JSON.stringify(legacy));
    expect(restored.schemaVersion).toBe(4);
    expect(restored.sampleRate).toBe(44_100);
    expect(restored.arrangement.overlapPolicy).toBe('prevent');
    expect(() => validateProject({ ...legacy, sampleRate: 96_000 })).toThrow(/44100 or 48000/);
  });

  it('migrates schema v2 clips without source loops and round-trips schema v4 loop phase', async () => {
    const current = createDemoProject({ now: '2026-07-15T00:00:00.000Z' });
    const v2 = JSON.parse(JSON.stringify(current)) as Record<string, unknown>;
    v2.schemaVersion = 2;
    delete v2.arrangement;
    const migrated = validateProject(v2);
    expect(migrated.schemaVersion).toBe(4);
    expect(migrated.arrangement.overlapPolicy).toBe('prevent');
    expect(migrated.tracks[0].clips[0].sourceLoop).toBeUndefined();

    current.tracks[0].clips[0].sourceLoop = {
      cycleStartBeat: 2,
      cycleLengthBeats: 4,
      phaseBeats: 1.5,
    };
    current.tracks[0].clips[0].durationBeats = 13.25;
    const restored = deserializeProject(await serializeProject(current));
    expect(restored.schemaVersion).toBe(4);
    expect(restored.arrangement.overlapPolicy).toBe('prevent');
    expect(restored.tracks[0].clips[0]).toMatchObject({
      durationBeats: 13.25,
      sourceLoop: { cycleStartBeat: 2, cycleLengthBeats: 4, phaseBeats: 1.5 },
      timebase: { mode: 'fixed-seconds', sourceBpm: 118 },
    });
  });

  it('migrates schema v3 Audio clips to an explicit timebase without guessing every source is a loop', () => {
    type LegacyClip = {
      timebase?: unknown;
      provenance: { metadata?: Record<string, string | number | boolean | null> };
    };
    type LegacyProject = {
      schemaVersion: number;
      tracks: Array<{ clips: LegacyClip[] }>;
    };
    const legacy = JSON.parse(JSON.stringify(
      createDemoProject({ now: '2026-07-15T00:00:00.000Z' }),
    )) as LegacyProject;
    legacy.schemaVersion = 3;
    const generatedLoop = legacy.tracks[0].clips[0];
    delete generatedLoop.timebase;
    generatedLoop.provenance.metadata = {
      generationLengthUnit: 'bars',
      generationLengthBpm: 120,
    };
    const fixedMedia = legacy.tracks[1].clips[0];
    delete fixedMedia.timebase;

    const migrated = validateProject(legacy);
    expect(migrated.schemaVersion).toBe(4);
    expect(migrated.tracks[0].clips[0]).toMatchObject({
      timebase: { mode: 'tempo-follow-repitch', sourceBpm: 120 },
    });
    expect(migrated.tracks[1].clips[0]).toMatchObject({
      timebase: { mode: 'fixed-seconds', sourceBpm: 118 },
    });
  });

  it('requires valid schema v4 Audio timing and rejects an unreconciled fixed-seconds BPM', () => {
    type MutableAudioClip = { timebase?: { mode: string; sourceBpm: number } };
    type MutableProject = { tracks: Array<{ clips: MutableAudioClip[] }> };
    const raw = JSON.parse(JSON.stringify(
      createDemoProject({ now: '2026-07-15T00:00:00.000Z' }),
    )) as MutableProject;
    const audioClip = raw.tracks[0].clips[0];

    delete audioClip.timebase;
    expect(() => validateProject(raw)).toThrow(/explicit Audio timebase/);

    audioClip.timebase = { mode: 'unknown-mode', sourceBpm: 118 };
    expect(() => validateProject(raw)).toThrow(/unsupported value/);

    audioClip.timebase = { mode: 'fixed-seconds', sourceBpm: 120 };
    expect(() => validateProject(raw)).toThrow(/rescaled to the project BPM/);
  });

  it('migrates legacy note channels to explicit MIDI track routing and instruments', () => {
    type LegacyTrack = {
      kind: string;
      midi?: unknown;
      clips: Array<{ kind: string; notes?: Array<{ channel?: number }> }>;
    };
    const legacy = JSON.parse(JSON.stringify(
      createDemoProject({ now: '2026-07-15T00:00:00.000Z' }),
    )) as { tracks: LegacyTrack[] };
    const drumTrack = legacy.tracks[2];
    delete drumTrack.midi;
    for (const note of drumTrack.clips[0].notes ?? []) note.channel = 9;
    const melodicTrack = legacy.tracks[3];
    delete melodicTrack.midi;
    for (const note of melodicTrack.clips[0].notes ?? []) note.channel = 4;

    const migrated = validateProject(legacy);
    expect(migrated.tracks[2]).toMatchObject({
      midi: {
        channel: 9,
        instrument: { kind: 'drums', playbackId: 'WebAudioFont 128_0_Chaos_sf2_file' },
      },
    });
    expect(migrated.tracks[3]).toMatchObject({
      midi: {
        channel: 4,
        instrument: { kind: 'melodic', playbackId: 'WebAudio-TinySynth', program: 0 },
      },
    });
  });

  it('rejects invalid explicit MIDI channels, programs, and playback profiles', () => {
    const project = createDemoProject({ now: '2026-07-15T00:00:00.000Z' });
    const track = project.tracks[2];
    if (track.kind !== 'midi') throw new Error('Expected demo MIDI track');

    track.midi = {
      channel: 0,
      instrument: { kind: 'drums', playbackId: 'WebAudioFont 128_0_Chaos_sf2_file' },
    };
    expect(() => validateProject(project)).toThrow(/drum tracks must use MIDI wire channel 10/);

    track.midi = {
      channel: 9,
      instrument: { kind: 'melodic', playbackId: 'WebAudio-TinySynth', program: 0 },
    };
    expect(() => validateProject(project)).toThrow(/reserved for drum tracks/);

    track.midi = {
      channel: 0,
      instrument: { kind: 'melodic', playbackId: 'WebAudio-TinySynth', program: 128 },
    };
    expect(() => validateProject(project)).toThrow(/program.*0\.\.127/);
  });

  it('round-trips an immutable MuScriptor submission snapshot while accepting legacy jobs', async () => {
    const project = createDemoProject({ now: '2026-07-15T00:00:00.000Z' });
    project.jobs.push({
      id: 'midi-extraction-snapshotted',
      kind: 'midi-extraction',
      state: 'running',
      computeTarget: 'local-gpu',
      progress: 0.5,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      input: {
        assetId: 'asset-audio-1',
        trackId: 'track-audio-1',
        clipId: 'clip-audio-1',
        durationSeconds: 4,
        midiExtraction: {
          sourceAssetId: 'asset-audio-1',
          sourceTrackId: 'track-audio-1',
          sourceClipId: 'clip-audio-1',
          sourceClipName: 'Submitted source',
          startBeat: 6,
          durationBeats: 8,
          offsetBeats: 2,
          sourceLoop: { cycleStartBeat: 1, cycleLengthBeats: 4, phaseBeats: 1.5 },
          timebase: { mode: 'tempo-follow-repitch', sourceBpm: 120 },
          bpm: 120,
        },
      },
    });
    project.jobs.push({
      id: 'midi-extraction-legacy',
      kind: 'midi-extraction',
      state: 'running',
      computeTarget: 'local-cpu',
      progress: 0.25,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      input: { assetId: 'asset-audio-1', trackId: 'track-audio-1', clipId: 'clip-audio-1' },
    });

    const restored = deserializeProject(await serializeProject(project));
    expect(restored.jobs[0].input.midiExtraction).toEqual(project.jobs[0].input.midiExtraction);
    expect(restored.jobs[1].input.midiExtraction).toBeUndefined();

    const legacyDocument = JSON.parse(await serializeProject(project)) as {
      project: { jobs: Array<{ input: { midiExtraction?: { timebase?: unknown } } }> };
    };
    delete legacyDocument.project.jobs[0].input.midiExtraction?.timebase;
    expect(deserializeProject(JSON.stringify(legacyDocument)).jobs[0].input.midiExtraction?.timebase)
      .toEqual({ mode: 'fixed-seconds', sourceBpm: 120 });

    project.jobs[0].input.midiExtraction!.timebase = { mode: 'fixed-seconds', sourceBpm: 118 };
    expect(() => validateProject(project)).toThrow(/rescaled to the submitted BPM/);
    project.jobs[0].input.midiExtraction!.timebase = { mode: 'tempo-follow-repitch', sourceBpm: 120 };
    project.jobs[0].input.midiExtraction!.bpm = 0;
    expect(() => validateProject(project)).toThrow(/midiExtraction\.bpm.*tempo/);
  });

  it('rejects source-loop cycles below the 1/64-beat safety floor and unnormalized phases', () => {
    const project = createDemoProject({ now: '2026-07-15T00:00:00.000Z' });
    project.tracks[0].clips[0].sourceLoop = {
      cycleStartBeat: 0,
      cycleLengthBeats: 0,
      phaseBeats: 0,
    };
    expect(() => validateProject(project)).toThrow(/1\/64 beat/);
    project.tracks[0].clips[0].sourceLoop = {
      cycleStartBeat: 0,
      cycleLengthBeats: (1 / 64) - Number.EPSILON,
      phaseBeats: 0,
    };
    expect(() => validateProject(project)).toThrow(/1\/64 beat/);
    project.tracks[0].clips[0].sourceLoop = {
      cycleStartBeat: 0,
      cycleLengthBeats: 1 / 64,
      phaseBeats: 0,
    };
    expect(validateProject(project).tracks[0].clips[0].sourceLoop?.cycleLengthBeats).toBe(1 / 64);
    project.tracks[0].clips[0].sourceLoop = {
      cycleStartBeat: 0,
      cycleLengthBeats: 4,
      phaseBeats: 4,
    };
    expect(() => validateProject(project)).toThrow(/phase in range/);
  });

  it('rejects invalid clip geometry before it reaches the arrangement', () => {
    const project = createDemoProject({ now: '2026-07-15T00:00:00.000Z' });
    const clip = project.tracks[0].clips[0];
    clip.startBeat = -0.25;
    expect(() => validateProject(project)).toThrow(/startBeat.*non-negative arrangement beat/);

    clip.startBeat = 0;
    clip.offsetBeats = -0.25;
    expect(() => validateProject(project)).toThrow(/offsetBeats.*non-negative source beat/);

    clip.offsetBeats = 0;
    for (const duration of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      clip.durationBeats = duration;
      expect(() => validateProject(project)).toThrow(/durationBeats/);
    }
  });

  it('rejects same-track overlaps under the fixed prevent policy but accepts adjacent clips', () => {
    const project = createDemoProject({ now: '2026-07-15T00:00:00.000Z' });
    const track = project.tracks[0];
    const first = track.clips[0];
    first.startBeat = 2;
    first.durationBeats = 4;
    const adjacent = structuredClone(first);
    adjacent.id = 'adjacent-clip';
    adjacent.startBeat = 6;
    track.clips.push(adjacent);
    expect(validateProject(project).tracks[0].clips).toHaveLength(2);

    adjacent.startBeat = 5.999;
    expect(() => validateProject(project)).toThrow(/overlap policy prevents.*overlapping/);
  });

  it('keeps schema v1 and v2 assets without hashes readable but never claims verification', () => {
    for (const schemaVersion of [1, 2]) {
      const project = createDemoProject({ now: '2026-07-15T00:00:00.000Z' });
      project.assets[0].bytes = Uint8Array.from([8, 6, 7, 5, 3, 0, 9]).buffer;
      const legacy = structuredClone(project) as unknown as {
        schemaVersion: number;
        assets: Array<Record<string, unknown>>;
      };
      legacy.schemaVersion = schemaVersion;
      delete legacy.assets[0].contentHashSha256;
      delete legacy.assets[0].integrity;

      const restored = validateProject(legacy);
      expect(restored.assets[0].contentHashSha256).toBeUndefined();
      expect(restored.assets[0].integrity).toMatchObject({ state: 'unverified' });
      expect(restored.assets[1].integrity).toMatchObject({ state: 'missing' });
    }
  });

  it('round-trips immutable hashes with source bytes and candidate blobs through a checkpoint', async () => {
    const project = createDemoProject({ now: '2026-07-15T00:00:00.000Z' });
    const sourceBytes = Uint8Array.from([82, 73, 70, 70, 9, 8, 7]).buffer;
    const sourceHash = await sha256Media(sourceBytes);
    project.assets[0].bytes = sourceBytes;
    project.assets[0].contentHashSha256 = sourceHash;
    const candidateBlob = new Blob([Uint8Array.from([87, 65, 86, 69, 1, 2, 3])], { type: 'audio/wav' });
    const candidateHash = await sha256Media(candidateBlob);

    const checkpoint = createProjectCheckpoint(project, {
      candidates: [{
        id: 'candidate-hashed',
        name: 'Hashed candidate',
        prompt: 'durable content identity',
        duration: 4,
        provider: 'stable-audio-3',
        device: 'mps',
        mimeType: 'audio/wav',
        blob: candidateBlob,
        contentHashSha256: candidateHash,
      }],
    });
    const restored = deserializeProjectCheckpoint(await serializeProjectCheckpoint(checkpoint));
    const restoredAsset = restored.project.assets[0];
    const restoredCandidate = restored.session.candidates[0];

    expect(restoredAsset.contentHashSha256).toBe(sourceHash);
    expect([...new Uint8Array(restoredAsset.bytes!)]).toEqual([...new Uint8Array(sourceBytes)]);
    expect(restoredCandidate.contentHashSha256).toBe(candidateHash);
    expect([...new Uint8Array(await restoredCandidate.blob!.arrayBuffer())]).toEqual([87, 65, 86, 69, 1, 2, 3]);
    expect(restoredAsset.integrity?.state).toBe('unverified');
    expect(restoredCandidate.integrity?.state).toBe('unverified');
    await expect(verifyMediaIntegrity(restoredAsset)).resolves.toEqual({
      state: 'available',
      expectedHashSha256: sourceHash,
      actualHashSha256: sourceHash,
    });
    await expect(verifyMediaIntegrity(restoredCandidate)).resolves.toEqual({
      state: 'available',
      expectedHashSha256: candidateHash,
      actualHashSha256: candidateHash,
    });
  });

  it('keeps source media bytes unchanged through arrangement edit, undo, and redo', async () => {
    const project = createDemoProject({ now: '2026-07-15T00:00:00.000Z' });
    const immutableBytes = Uint8Array.from([10, 20, 30, 40, 50]).buffer;
    const sourceHash = await sha256Media(immutableBytes);
    project.assets[0].bytes = immutableBytes;
    project.assets[0].contentHashSha256 = sourceHash;
    const history = createHistoryStore(project);

    await history.execute(createSnapshotCommand('Arrange source clip', (state) => {
      const draft = structuredClone(state);
      const clip = draft.tracks[0].clips[0];
      clip.startBeat = 6;
      clip.durationBeats = 12;
      clip.offsetBeats = 2;
      clip.gain = 0.5;
      clip.fadeIn = 1;
      clip.fadeOut = 1.5;
      return draft;
    }));

    const assertSourceIdentity = async () => {
      const asset = history.getState().assets[0];
      expect([...new Uint8Array(asset.bytes!)]).toEqual([10, 20, 30, 40, 50]);
      expect(asset.contentHashSha256).toBe(sourceHash);
      await expect(verifyMediaIntegrity(asset)).resolves.toMatchObject({
        state: 'available',
        expectedHashSha256: sourceHash,
        actualHashSha256: sourceHash,
      });
    };

    expect(history.getState().tracks[0].clips[0]).toMatchObject({
      startBeat: 6,
      durationBeats: 12,
      offsetBeats: 2,
    });
    await assertSourceIdentity();
    await history.undo();
    await assertSourceIdentity();
    await history.redo();
    await assertSourceIdentity();
    expect([...new Uint8Array(immutableBytes)]).toEqual([10, 20, 30, 40, 50]);
  });

  it('imports the released raw schema without mutating the input', () => {
    const project = createDemoProject({ now: '2026-07-15T00:00:00.000Z' });
    const raw = JSON.parse(JSON.stringify(project)) as Record<string, unknown>;
    const before = JSON.stringify(raw);
    const restored = deserializeProject(JSON.stringify(raw));
    expect(restored.id).toBe(project.id);
    expect(restored.jobs).toEqual([]);
    expect(JSON.stringify(raw)).toBe(before);
  });

  it('migrates the previous raw binary envelope and isolates a corrupt asset', async () => {
    const project = createDemoProject({ now: '2026-07-15T00:00:00.000Z' });
    const legacy = JSON.parse(JSON.stringify(project)) as {
      assets: Array<Record<string, unknown>>;
    };
    legacy.assets[0].blob = {
      __vibeseqBinary: true,
      mimeType: 'audio/wav',
      base64: bytesToBase64(Uint8Array.from([82, 73, 70, 70])),
    };
    legacy.assets[1].blob = {
      __vibeseqBinary: true,
      mimeType: 'audio/wav',
      base64: 'not-valid-base64!',
    };
    const restored = deserializeProject(JSON.stringify(legacy));
    expect(restored.assets[0].blob?.size).toBe(4);
    expect([...new Uint8Array(await restored.assets[0].blob!.arrayBuffer())]).toEqual([82, 73, 70, 70]);
    expect(restored.assets[1].blob).toBeUndefined();
    expect(restored.assets[1].integrity?.state).toBe('corrupt');
  });

  it('rejects future versions and invalid nested state with typed errors', () => {
    expect(() => deserializeProjectCheckpoint(JSON.stringify({
      format: PROJECT_SERIALIZATION_FORMAT,
      serializationVersion: 999,
    }))).toThrowError(ProjectImportError);

    const project = createDemoProject({ now: '2026-07-15T00:00:00.000Z' });
    project.jobs.push({
      id: 'job-invalid',
      kind: 'stable-audio-generation',
      state: 'running',
      computeTarget: 'local-cpu',
      progress: 2,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      input: { prompt: 'invalid progress fixture' },
    });
    expect(() => validateProject(project)).toThrow(/progress 0\.\.1/);

    project.jobs[0].progress = 0.5;
    project.jobs[0].input.seed = 1.5;
    expect(() => validateProject(project)).toThrow(/input\.seed.*integer in range/);

    project.jobs.length = 0;
    expect(() => createProjectCheckpoint(project, {
      candidates: [{
        id: 'invalid-seed-candidate',
        name: 'Invalid seed',
        prompt: 'must not import',
        duration: 1,
        seed: 2 ** 32,
        provider: 'stable-audio-3',
        device: 'cpu',
      }],
    })).toThrow(/candidates\[0\]\.seed.*integer in range/);
  });

  it('stores immutable copies in the memory fallback', async () => {
    const persistence = createMemoryProjectPersistence();
    const project = createDemoProject({ now: '2026-07-15T00:00:00.000Z' });
    await persistence.save(project);
    project.name = 'Mutated outside storage';
    expect((await persistence.load(project.id))?.name).toBe('Neon Afterglow');
    expect(await persistence.list()).toHaveLength(1);
    await persistence.remove(project.id);
    expect(await persistence.load(project.id)).toBeUndefined();
  });

  it('uses localStorage when IndexedDB is unavailable', async () => {
    const storage = new TestStorage();
    const persistence = createProjectPersistence({ indexedDB: null, localStorage: storage, namespace: 'test' });
    const project = createDemoProject({ now: '2026-07-15T00:00:00.000Z' });
    await persistence.save(project);
    expect(persistence.getBackend()).toBe('localstorage');
    expect((await persistence.load(project.id))?.id).toBe(project.id);
    await persistence.clear();
    expect(storage.length).toBe(0);
  });

  it('does not report project deletion until every available backend confirms removal', async () => {
    const storage = new TestStorage();
    const namespace = 'delete-confirmation';
    const persistence = createProjectPersistence({ indexedDB: null, localStorage: storage, namespace });
    const project = createDemoProject({ now: '2026-07-15T00:00:00.000Z' });
    await persistence.save(project);

    storage.failNextRemove(`${namespace}:project:${project.id}`);
    await expect(persistence.remove(project.id)).rejects.toThrow(/could not be confirmed/);
    await expect(persistence.load(project.id)).resolves.toMatchObject({ id: project.id });

    await persistence.remove(project.id);
    await expect(persistence.load(project.id)).resolves.toBeUndefined();
  });

  it('keeps healthy projects listable and corrupt records removable', async () => {
    const storage = new TestStorage();
    storage.setItem('isolation:project:damaged-project', '{not valid json');
    const persistence = createProjectPersistence({
      indexedDB: null,
      localStorage: storage,
      namespace: 'isolation',
    });
    const project = createDemoProject({ now: '2026-07-15T00:00:00.000Z' });
    await persistence.save(project);
    expect((await persistence.list()).map((entry) => entry.id)).toEqual([project.id]);
    await persistence.remove('damaged-project');
    expect(storage.getItem('isolation:project:damaged-project')).toBeNull();
  });

  it('round-trips candidates, candidate bytes, project jobs, and an active job', async () => {
    const storage = new TestStorage();
    const first = createProjectPersistence({ indexedDB: null, localStorage: storage, namespace: 'session' });
    const project = createDemoProject({ now: '2026-07-15T00:00:00.000Z' });
    project.jobs.push({
      id: 'job-generation-1',
      kind: 'stable-audio-generation',
      state: 'completed',
      computeTarget: 'local-gpu',
      progress: 1,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      input: {
        prompt: 'durable candidate',
        durationSeconds: 4,
        seed: 42,
        generationLength: {
          unit: 'bars',
          value: 2,
          durationSeconds: 4,
          bpm: 120,
          timeSignature: { numerator: 4, denominator: 4 },
        },
      },
      output: { assetId: 'candidate-asset-1' },
    });
    await first.saveWorkspace(project, {
      candidates: [{
        id: 'candidate-1',
        name: 'Durable variation',
        prompt: 'durable candidate',
        duration: 4,
        seed: 42,
        generationLength: {
          unit: 'bars',
          value: 2,
          durationSeconds: 4,
          bpm: 120,
          timeSignature: { numerator: 4, denominator: 4 },
        },
        provider: 'stable-audio-3',
        device: 'mps',
        assetId: 'candidate-asset-1',
        assetUrl: '/api/assets/candidate-asset-1',
        mimeType: 'audio/wav',
        bytes: Uint8Array.from([1, 3, 3, 7]).buffer,
        jobId: 'job-generation-1',
      }],
      activeJob: {
        label: 'Extracting MIDI structure',
        job: {
          id: 'inference-job-2',
          kind: 'transcribe',
          status: 'running',
          progress: 0.4,
        },
      },
    });

    const reopened = createProjectPersistence({ indexedDB: null, localStorage: storage, namespace: 'session' });
    const checkpoint = await reopened.loadWorkspace(project.id);
    expect(checkpoint?.project.jobs[0].output?.assetId).toBe('candidate-asset-1');
    expect(checkpoint?.project.jobs[0].input.seed).toBe(42);
    expect(checkpoint?.project.jobs[0].input.generationLength).toMatchObject({ unit: 'bars', value: 2, durationSeconds: 4 });
    expect(checkpoint?.session.candidates[0].seed).toBe(42);
    expect(checkpoint?.session.candidates[0].generationLength).toMatchObject({ unit: 'bars', value: 2, durationSeconds: 4 });
    expect([...new Uint8Array(checkpoint?.session.candidates[0].bytes ?? new ArrayBuffer(0))]).toEqual([1, 3, 3, 7]);
    expect(checkpoint?.session.activeJob?.job).toMatchObject({
      id: 'inference-job-2',
      status: 'running',
      progress: 0.4,
    });

    project.name = 'Session-preserving autosave';
    await reopened.save(project);
    expect((await reopened.loadWorkspace(project.id))?.session.candidates).toHaveLength(1);
  });

  it('offers and promotes a complete recovery after an interrupted primary write', async () => {
    const storage = new TestStorage();
    const namespace = 'crash';
    const project = createDemoProject({ now: '2026-07-15T00:00:00.000Z' });
    const first = createProjectPersistence({ indexedDB: null, localStorage: storage, namespace });
    await first.save(project);

    project.name = 'Newer unacknowledged edit';
    project.updatedAt = '2026-07-15T00:00:01.000Z';
    storage.failNextSet(`${namespace}:project:${project.id}`);
    await expect(first.saveWorkspace(project, {
      candidates: [{
        id: 'recovery-candidate',
        name: 'Unplaced recovery audio',
        prompt: 'recovery fixture',
        duration: 2,
        provider: 'stable-audio-3',
        device: 'cpu',
        bytes: Uint8Array.from([9, 8, 7]).buffer,
      }],
    })).rejects.toBeInstanceOf(ProjectRecoveryPendingError);
    expect(first.getBackend()).toBe('localstorage');

    const afterCrash = createProjectPersistence({ indexedDB: null, localStorage: storage, namespace });
    expect((await afterCrash.load(project.id))?.name).toBe('Neon Afterglow');
    expect((await afterCrash.loadRecovery(project.id))?.project.name).toBe('Newer unacknowledged edit');
    expect((await afterCrash.loadRecovery(project.id))?.session.candidates[0].id).toBe('recovery-candidate');
    await expect(afterCrash.save(project)).rejects.toBeInstanceOf(ProjectRecoveryPendingError);
    expect((await afterCrash.recover(project.id))?.project.name).toBe('Newer unacknowledged edit');
    expect((await afterCrash.load(project.id))?.name).toBe('Newer unacknowledged edit');
    expect(await afterCrash.loadRecovery(project.id)).toBeUndefined();
  });

  it('can explicitly discard recovery without changing the acknowledged project', async () => {
    const storage = new TestStorage();
    const namespace = 'discard';
    const project = createDemoProject({ now: '2026-07-15T00:00:00.000Z' });
    const first = createProjectPersistence({ indexedDB: null, localStorage: storage, namespace });
    await first.save(project);
    project.name = 'Discard this interrupted edit';
    project.updatedAt = '2026-07-15T00:00:01.000Z';
    storage.failNextSet(`${namespace}:project:${project.id}`);
    await expect(first.save(project)).rejects.toBeInstanceOf(ProjectRecoveryPendingError);

    const afterCrash = createProjectPersistence({ indexedDB: null, localStorage: storage, namespace });
    await afterCrash.discardRecovery(project.id);
    expect(await afterCrash.loadRecovery(project.id)).toBeUndefined();
    expect((await afterCrash.load(project.id))?.name).toBe('Neon Afterglow');

    project.name = 'Save after explicit discard';
    await afterCrash.save(project);
    expect((await afterCrash.load(project.id))?.name).toBe('Save after explicit discard');
  });

  it('serializes explicit checkpoints without losing their recovery identity', async () => {
    const project = createDemoProject({ now: '2026-07-15T00:00:00.000Z' });
    const checkpoint = createProjectCheckpoint(project, { candidates: [] }, {
      checkpointId: 'checkpoint-stable-id',
      savedAt: '2026-07-15T00:00:02.000Z',
    });
    const restored = deserializeProjectCheckpoint(await serializeProjectCheckpoint(checkpoint));
    expect(restored.checkpointId).toBe('checkpoint-stable-id');
    expect(restored.revision).toBe(checkpoint.revision);
    expect(restored.savedAt).toBe('2026-07-15T00:00:02.000Z');

    const legacyEnvelope = JSON.parse(await serializeProjectCheckpoint(checkpoint)) as Record<string, unknown>;
    delete legacyEnvelope.revision;
    const migrated = deserializeProjectCheckpoint(JSON.stringify(legacyEnvelope));
    expect(migrated.revision).toBe(Date.parse('2026-07-15T00:00:02.000Z') * 1_000);
  });

  it('atomically imports an explicit project/session checkpoint without regenerating its identity', async () => {
    const persistence = createMemoryProjectPersistence();
    const project = createDemoProject({ now: '2026-07-15T00:00:00.000Z' });
    project.name = 'Imported Colab workspace';
    const checkpoint = createProjectCheckpoint(project, {
      candidates: [{
        id: 'imported-candidate',
        name: 'Imported candidate',
        prompt: 'portable state',
        duration: 2,
        provider: 'stable-audio-3',
        device: 'cuda',
        bytes: Uint8Array.from([1, 2, 3]).buffer,
      }],
      activeJob: {
        label: 'Imported job',
        job: { id: 'imported-job', kind: 'generate', status: 'running', progress: 0.25 },
      },
    }, { checkpointId: 'imported-checkpoint', savedAt: '2026-07-15T00:00:03.000Z' });

    const imported = await persistence.importWorkspace(checkpoint);
    checkpoint.project.name = 'Mutated after import';
    checkpoint.session.candidates[0].name = 'Mutated candidate';
    const restored = await persistence.loadWorkspace(project.id);

    expect(imported.checkpointId).toBe('imported-checkpoint');
    expect(restored?.checkpointId).toBe('imported-checkpoint');
    expect(restored?.savedAt).toBe('2026-07-15T00:00:03.000Z');
    expect(restored?.project.name).toBe('Imported Colab workspace');
    expect(restored?.session.candidates[0].name).toBe('Imported candidate');
    expect(restored?.session.activeJob?.job.id).toBe('imported-job');
  });
});
