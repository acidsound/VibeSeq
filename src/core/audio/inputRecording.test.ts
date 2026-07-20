import { describe, expect, it, vi } from 'vitest';
import {
  combineRecordingChunks,
  planUnfoldedLoopRecording,
  recordedClipGeometry,
  RECORDING_CHUNK_FRAMES,
  WorkletInputRecorder,
} from './inputRecording';
import type { WorkletEvent } from './workletProtocol';

describe('Worklet input recording', () => {
  it('keeps absolute frames continuous and flushes bounded transferable PCM chunks', () => {
    const events: WorkletEvent[] = [];
    const transfers: Transferable[][] = [];
    const recorder = new WorkletInputRecorder(48_000, (event, transfer = []) => {
      events.push(event);
      transfers.push(transfer);
    });
    recorder.start('take-1', 2, 3.5, 1_000);
    const first = Float32Array.from({ length: RECORDING_CHUNK_FRAMES }, (_, index) => index / RECORDING_CHUNK_FRAMES);
    recorder.append([first], first.length);
    recorder.append([Float32Array.of(0.25, 0.5)], 2);
    recorder.stop('take-1', 1_000 + first.length + 2);

    expect(events[0]).toMatchObject({
      type: 'recording-started',
      sessionId: 'take-1',
      startPositionBeat: 3.5,
      startFrame: 1_000,
      channelCount: 2,
    });
    const chunks = events.filter((event) => event.type === 'recording-chunk');
    expect(chunks).toHaveLength(2);
    expect(transfers.filter((transfer) => transfer.length > 0).map((transfer) => transfer.length)).toEqual([2, 2]);
    expect(events.at(-1)).toEqual({
      type: 'recording-complete',
      sessionId: 'take-1',
      endFrame: 1_000 + first.length + 2,
      frameCount: first.length + 2,
    });
    if (chunks[0]?.type !== 'recording-chunk' || chunks[1]?.type !== 'recording-chunk') throw new Error('Expected chunks');
    expect(chunks[0].channelData[1]).toEqual(chunks[0].channelData[0]);

    const result = combineRecordingChunks(
      events[0] as Extract<WorkletEvent, { type: 'recording-started' }>,
      chunks.map((chunk) => chunk.type === 'recording-chunk' ? chunk.channelData : []),
      1_000 + first.length + 2,
      first.length + 2,
    );
    expect(result.channelData[0].at(-2)).toBe(0.25);
    expect(result.channelData[0].at(-1)).toBe(0.5);
  });

  it('rejects mismatched sessions instead of mixing takes', () => {
    const recorder = new WorkletInputRecorder(44_100, vi.fn());
    recorder.start('take-1', 1, 0, 0);
    expect(() => recorder.stop('take-2', 128)).toThrow(/unknown recording session/i);
  });
});

describe('recorded clip latency geometry', () => {
  it('preserves the raw take and skips round-trip latency through source offset', () => {
    const geometry = recordedClipGeometry(48_000, 48_000, 120, 25);
    expect(geometry.compensationFrames).toBe(1_200);
    expect(geometry.offsetBeats).toBeCloseTo(0.05);
    expect(geometry.durationBeats).toBeCloseTo(1.95);
  });

  it('keeps at least one audible frame for an over-large manual compensation', () => {
    const geometry = recordedClipGeometry(10, 1_000, 120, 500);
    expect(geometry.compensationFrames).toBe(9);
    expect(geometry.offsetBeats).toBeCloseTo(0.018);
    expect(geometry.durationBeats).toBeCloseTo(0.002);
  });

  it('keeps every project-loop pass as one linear editable take', () => {
    expect(planUnfoldedLoopRecording(2, 10, { enabled: true, startBeat: 0, endBeat: 4 })).toEqual({
      sourceLoop: undefined,
      passCount: 3,
      unfoldsProjectLoop: true,
    });
    expect(planUnfoldedLoopRecording(0, 4, { enabled: true, startBeat: 0, endBeat: 4 })).toEqual({
      sourceLoop: undefined,
      passCount: 1,
      unfoldsProjectLoop: false,
    });
  });
});
