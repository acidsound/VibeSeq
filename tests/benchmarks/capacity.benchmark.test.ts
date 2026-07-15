import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { runInNewContext } from 'node:vm';
import { setFlagsFromString } from 'node:v8';
import { describe, expect, it } from 'vitest';
import {
  CAPACITY_REFERENCE_TARGET,
  createCapacityReferenceFixture,
} from '../../src/core/capacityReference';
import { exportWavBuffer } from '../../src/core/audio/mixdown';
import { buildPlaybackPlan, WebAudioPlaybackEngine } from '../../src/core/audio/playback';
import { exportMidi, importMidi } from '../../src/core/midi/smf';
import {
  createProjectCheckpoint,
  deserializeProjectCheckpoint,
  serializeProjectCheckpoint,
} from '../../src/core/projectSerialization';

interface Measurement {
  elapsedMs: number;
  rssBeforeBytes: number;
  rssAfterBytes: number;
  heapUsedBeforeBytes: number;
  heapUsedAfterBytes: number;
  arrayBuffersBeforeBytes: number;
  arrayBuffersAfterBytes: number;
}

const enabled = process.env.VIBESEQ_CAPACITY_BENCHMARK === '1';

class CountingAudioParam {
  cancelScheduledValues(): void { /* count nodes, not parameter events */ }
  setValueAtTime(): void { /* count nodes, not parameter events */ }
  linearRampToValueAtTime(): void { /* count nodes, not parameter events */ }
}

class CountingAudioNode {
  connect<T>(destination: T): T { return destination; }
  disconnect(): void { /* no-op counting graph */ }
}

class CountingScheduledNode extends CountingAudioNode {
  start(): void { /* no-op counting graph */ }
  stop(): void { /* no-op counting graph */ }
  addEventListener(): void { /* no-op counting graph */ }
}

class CountingOscillatorNode extends CountingScheduledNode {
  readonly frequency = new CountingAudioParam();
  setPeriodicWave(): void { /* no-op counting graph */ }
}

class CountingBufferSourceNode extends CountingScheduledNode {
  buffer: AudioBuffer | null = null;
}

class CountingGainNode extends CountingAudioNode { readonly gain = new CountingAudioParam(); }
class CountingPannerNode extends CountingAudioNode { readonly pan = new CountingAudioParam(); }
class CountingAnalyserNode extends CountingAudioNode {
  fftSize = 0;
  smoothingTimeConstant = 0;
  getFloatTimeDomainData(data: Float32Array): void { data.fill(0); }
}

class CountingAudioContext {
  currentTime = 0;
  readonly sampleRate = 44_100;
  readonly state = 'running';
  readonly destination = new CountingAudioNode();
  oscillatorCount = 0;
  bufferSourceCount = 0;

  createGain(): CountingGainNode { return new CountingGainNode(); }
  createAnalyser(): CountingAnalyserNode { return new CountingAnalyserNode(); }
  createStereoPanner(): CountingPannerNode { return new CountingPannerNode(); }
  createOscillator(): CountingOscillatorNode {
    this.oscillatorCount += 1;
    return new CountingOscillatorNode();
  }
  createBufferSource(): CountingBufferSourceNode {
    this.bufferSourceCount += 1;
    return new CountingBufferSourceNode();
  }
  createPeriodicWave(): PeriodicWave { return {} as PeriodicWave; }
}

const measure = async <T>(run: () => T | Promise<T>): Promise<{ value: T; measurement: Measurement }> => {
  const before = process.memoryUsage();
  const startedAt = performance.now();
  const value = await run();
  const elapsedMs = performance.now() - startedAt;
  const after = process.memoryUsage();
  return {
    value,
    measurement: {
      elapsedMs,
      rssBeforeBytes: before.rss,
      rssAfterBytes: after.rss,
      heapUsedBeforeBytes: before.heapUsed,
      heapUsedAfterBytes: after.heapUsed,
      arrayBuffersBeforeBytes: before.arrayBuffers,
      arrayBuffersAfterBytes: after.arrayBuffers,
    },
  };
};

const measureMainThreadStall = async <T>(
  run: () => Promise<T>,
): Promise<{ value: T; measurement: Measurement; maxTimerStallMs: number }> => {
  const intervalMs = 10;
  let expectedAt = performance.now() + intervalMs;
  let maxTimerStallMs = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxTimerStallMs = Math.max(maxTimerStallMs, now - expectedAt);
    expectedAt = now + intervalMs;
  }, intervalMs);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, intervalMs * 2));
  const result = await measure(run);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, intervalMs * 2));
  clearInterval(timer);
  return { ...result, maxTimerStallMs };
};

const sha256 = (value: string | ArrayBuffer | Uint8Array): string => {
  const hash = createHash('sha256');
  if (typeof value === 'string') hash.update(value);
  else if (value instanceof ArrayBuffer) hash.update(new Uint8Array(value));
  else hash.update(value);
  return hash.digest('hex');
};

const garbageCollector = (): (() => void) | undefined => {
  const exposed = (globalThis as typeof globalThis & { gc?: () => void }).gc;
  if (exposed) return exposed;
  try {
    setFlagsFromString('--expose_gc');
    const collect = runInNewContext('gc') as unknown;
    return typeof collect === 'function' ? collect as () => void : undefined;
  } catch {
    return undefined;
  }
};

describe.skipIf(!enabled)('production capacity benchmark', () => {
  it('measures the deterministic supported reference through serialization and offline exports', async () => {
    const fixtureBuild = await measure(createCapacityReferenceFixture);
    const { project, pcmAssets, summary } = fixtureBuild.value;

    const checkpointBuild = await measure(() => createProjectCheckpoint(project, { candidates: [] }, {
      checkpointId: 'capacity-reference-checkpoint',
      savedAt: '2026-07-15T00:00:00.000Z',
    }));
    const serialized = await measure(() => serializeProjectCheckpoint(checkpointBuild.value));
    const deserialized = await measure(() => deserializeProjectCheckpoint(serialized.value));
    const reserialized = await measure(() => serializeProjectCheckpoint(deserialized.value));
    const exactSerializationRoundTrip = reserialized.value === serialized.value;
    const expectedSourceHashes = checkpointBuild.value.project.assets.map((asset) => asset.contentHashSha256);
    const collectGarbage = garbageCollector();
    collectGarbage?.();
    const reloadMemoryBefore = process.memoryUsage();
    const coreReloadCycles = await measure(async () => {
      let current = serialized.value;
      let exactCanonicalBytes = true;
      let exactSourceHashes = true;
      for (let cycle = 0; cycle < 100; cycle += 1) {
        const checkpoint = deserializeProjectCheckpoint(current);
        exactSourceHashes = exactSourceHashes
          && checkpoint.project.assets.every((asset, index) => asset.contentHashSha256 === expectedSourceHashes[index]);
        current = await serializeProjectCheckpoint(checkpoint);
        exactCanonicalBytes = exactCanonicalBytes && current === serialized.value;
        if ((cycle + 1) % 10 === 0) collectGarbage?.();
      }
      return { exactCanonicalBytes, exactSourceHashes, finalSha256: sha256(current) };
    });
    collectGarbage?.();
    const reloadMemoryAfter = process.memoryUsage();

    const playbackPlan = await measure(() => buildPlaybackPlan(project, {
      fromBeat: 0,
      toBeat: CAPACITY_REFERENCE_TARGET.durationBeats,
    }));
    const playbackEventCounts = playbackPlan.value.events.reduce((counts, event) => {
      counts[event.kind] += 1;
      return counts;
    }, { audio: 0, midi: 0 });
    const countingContext = new CountingAudioContext();
    const playbackEngine = new WebAudioPlaybackEngine(project, {
      context: countingContext as unknown as AudioContext,
      startLatencySeconds: 0,
      scheduleAheadSeconds: 0.2,
    });
    for (const asset of project.assets) {
      playbackEngine.registerAudioBuffer(asset.id, { duration: asset.durationSeconds } as AudioBuffer);
    }
    const boundedSchedule = await measure(async () => {
      await playbackEngine.play({ fromBeat: 0, toBeat: CAPACITY_REFERENCE_TARGET.durationBeats });
      return {
        oscillatorCount: countingContext.oscillatorCount,
        bufferSourceCount: countingContext.bufferSourceCount,
      };
    });
    await playbackEngine.dispose();

    const midiFirst = await measure(() => exportMidi(project, {
      fromBeat: 0,
      toBeat: CAPACITY_REFERENCE_TARGET.durationBeats,
      ppq: 480,
    }));
    const midiSecond = await measure(() => exportMidi(project, {
      fromBeat: 0,
      toBeat: CAPACITY_REFERENCE_TARGET.durationBeats,
      ppq: 480,
    }));
    const midiImport = await measure(() => importMidi(midiFirst.value, {
      now: '2026-07-15T00:00:00.000Z',
    }));
    const importedMidiNoteCount = midiImport.value.tracks.reduce((total, track) => total + track.clips.reduce(
      (trackTotal, clip) => trackTotal + (clip.kind === 'midi' ? clip.notes.length : 0),
      0,
    ), 0);
    const exactMidiRepeat = Buffer.from(midiFirst.value).equals(Buffer.from(midiSecond.value));

    const wav = await measureMainThreadStall(() => exportWavBuffer(project, pcmAssets, {
      sampleRate: 44_100,
      fromBeat: 0,
      toBeat: CAPACITY_REFERENCE_TARGET.durationBeats,
      channelCount: 2,
      bitDepth: 24,
      dither: 'none',
      protectPeaks: true,
    }));
    const wavView = new DataView(wav.value);
    const expectedWavBytes = 44 + CAPACITY_REFERENCE_TARGET.durationSeconds * 44_100 * 2 * 3;
    const wavHeaderValid = String.fromCharCode(...new Uint8Array(wav.value, 0, 4)) === 'RIFF'
      && String.fromCharCode(...new Uint8Array(wav.value, 8, 4)) === 'WAVE'
      && wavView.getUint16(22, true) === 2
      && wavView.getUint32(24, true) === 44_100
      && wavView.getUint16(34, true) === 24
      && wav.value.byteLength === expectedWavBytes;

    const evidencePath = process.env.VIBESEQ_CAPACITY_EVIDENCE_FILE
      ?? 'artifacts/qa/2026-07-15-capacity/capacity-benchmark.json';
    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      evidenceScope: 'Node core benchmark; not browser FPS, physical-device, audio-underrun, or UI-responsiveness proof.',
      runtime: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpuModel: cpus()[0]?.model ?? 'unknown',
        logicalCpuCount: cpus().length,
        totalMemoryBytes: totalmem(),
      },
      target: CAPACITY_REFERENCE_TARGET,
      realized: summary,
      checks: {
        supportedReferenceShape: {
          status: summary.unsupportedFeatures.length === 0 ? 'PASS' : 'PARTIAL',
          reasons: summary.unsupportedFeatures,
        },
        serializationRoundTrip: {
          status: exactSerializationRoundTrip ? 'PASS' : 'FAIL',
          exactBytes: exactSerializationRoundTrip,
          serializedBytes: Buffer.byteLength(serialized.value),
          sha256: sha256(serialized.value),
        },
        coreReloadEndurance: {
          status: coreReloadCycles.value.exactCanonicalBytes && coreReloadCycles.value.exactSourceHashes
            ? 'PASS' : 'FAIL',
          cycles: 100,
          exactCanonicalBytes: coreReloadCycles.value.exactCanonicalBytes,
          exactSourceHashes: coreReloadCycles.value.exactSourceHashes,
          finalSha256: coreReloadCycles.value.finalSha256,
          rssGrowthRatioAfterGcOpportunity: (reloadMemoryAfter.rss - reloadMemoryBefore.rss) / reloadMemoryBefore.rss,
          heapGrowthRatioAfterGcOpportunity: (reloadMemoryAfter.heapUsed - reloadMemoryBefore.heapUsed) / reloadMemoryBefore.heapUsed,
          gcExposed: collectGarbage !== undefined,
          memoryAssessment: collectGarbage === undefined ? 'NOT_MEASURED' : 'DIAGNOSTIC_ONLY',
          note: 'Core codec canonical-state endurance only. Forced Node GC makes heap growth diagnostic; retained process RSS is not browser live-object growth. This does not replace 100 real IndexedDB/browser save-close-open cycles.',
        },
        playbackPlan: {
          status: playbackEventCounts.midi === CAPACITY_REFERENCE_TARGET.midiNoteCount ? 'PASS' : 'FAIL',
          eventCount: playbackPlan.value.events.length,
          eventCounts: playbackEventCounts,
          note: 'The complete deterministic plan remains materialized as data; WebAudio node creation is measured separately below.',
        },
        boundedWebAudioSchedule: {
          status: boundedSchedule.value.oscillatorCount < playbackEventCounts.midi
            && boundedSchedule.value.bufferSourceCount < playbackEventCounts.audio ? 'PASS' : 'FAIL',
          scheduleAheadSeconds: 0.2,
          scheduledOscillatorCount: boundedSchedule.value.oscillatorCount,
          scheduledBufferSourceCount: boundedSchedule.value.bufferSourceCount,
          totalPlanEventCount: playbackPlan.value.events.length,
          note: 'Fake AudioContext proves bounded initial node creation; real browser node lifetime and underrun behavior remain unverified.',
        },
        midiExport: {
          status: exactMidiRepeat && importedMidiNoteCount === CAPACITY_REFERENCE_TARGET.midiNoteCount ? 'PASS' : 'FAIL',
          byteLength: midiFirst.value.byteLength,
          sha256: sha256(midiFirst.value),
          exactRepeatedExport: exactMidiRepeat,
          importedTrackCount: midiImport.value.tracks.length,
          importedNoteCount: importedMidiNoteCount,
        },
        wavExport: {
          status: wavHeaderValid ? 'PASS' : 'FAIL',
          byteLength: wav.value.byteLength,
          sha256: sha256(wav.value),
          sampleRate: wavView.getUint32(24, true),
          channelCount: wavView.getUint16(22, true),
          bitDepth: wavView.getUint16(34, true),
          durationSeconds: CAPACITY_REFERENCE_TARGET.durationSeconds,
          maxTimerStallMs: wav.maxTimerStallMs,
          note: 'A large timer stall means this synchronous core path cannot establish the UI-remains-responsive export requirement.',
        },
        productionCapacityGate: {
          status: 'PARTIAL',
          missing: [
            'automation on eight tracks',
            'warm IndexedDB-to-interactive browser open timing',
            'desktop/mobile timeline FPS and gesture stalls',
            '60-minute playback/edit underrun soak',
            '50 generate/cancel and 50 extract/commit/undo memory cycles',
            '100 browser save/reload cycles with source-hash comparison',
          ],
        },
      },
      measurementsMs: {
        fixtureBuild: fixtureBuild.measurement,
        checkpointBuild: checkpointBuild.measurement,
        serialize: serialized.measurement,
        deserialize: deserialized.measurement,
        reserialize: reserialized.measurement,
        coreReloadCycles100: coreReloadCycles.measurement,
        playbackPlan: playbackPlan.measurement,
        boundedWebAudioSchedule: boundedSchedule.measurement,
        midiExportFirst: midiFirst.measurement,
        midiExportSecond: midiSecond.measurement,
        midiImport: midiImport.measurement,
        wavExport: wav.measurement,
      },
    };
    const absoluteEvidencePath = resolve(evidencePath);
    await mkdir(dirname(absoluteEvidencePath), { recursive: true });
    await writeFile(absoluteEvidencePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.info(`CAPACITY_BENCHMARK ${JSON.stringify({
      evidencePath,
      serializationMs: serialized.measurement.elapsedMs,
      deserializeMs: deserialized.measurement.elapsedMs,
      coreReloadCycles100Ms: coreReloadCycles.measurement.elapsedMs,
      playbackPlanMs: playbackPlan.measurement.elapsedMs,
      midiExportMs: midiFirst.measurement.elapsedMs,
      wavExportMs: wav.measurement.elapsedMs,
      wavTimerStallMs: wav.maxTimerStallMs,
    })}`);

    expect(summary).toMatchObject({
      durationSeconds: CAPACITY_REFERENCE_TARGET.durationSeconds,
      trackCount: CAPACITY_REFERENCE_TARGET.trackCount,
      clipCount: CAPACITY_REFERENCE_TARGET.clipCount,
      midiNoteCount: CAPACITY_REFERENCE_TARGET.midiNoteCount,
    });
    expect(exactSerializationRoundTrip).toBe(true);
    expect(coreReloadCycles.value).toMatchObject({ exactCanonicalBytes: true, exactSourceHashes: true });
    expect(playbackEventCounts.midi).toBe(CAPACITY_REFERENCE_TARGET.midiNoteCount);
    expect(exactMidiRepeat).toBe(true);
    expect(importedMidiNoteCount).toBe(CAPACITY_REFERENCE_TARGET.midiNoteCount);
    expect(wavHeaderValid).toBe(true);
  }, 180_000);
});
