import type { ProjectLoop } from '../../types';
import type { WorkletEvent, WorkletRecordingResult, WorkletRecordingStart } from './workletProtocol';

export const RECORDING_CHUNK_FRAMES = 16_384;
export const MAX_RECORDING_CHANNELS = 2;

type RecordingEmitter = (event: WorkletEvent, transfer?: Transferable[]) => void;

/**
 * Realtime-safe fixed-buffer PCM collector used inside the AudioWorklet. The
 * control thread receives bounded chunks, while the absolute frame count stays
 * independent from a looping transport position.
 */
export class WorkletInputRecorder {
  private session?: WorkletRecordingStart;
  private buffers: Float32Array[] = [];
  private writeFrame = 0;
  private totalFrames = 0;

  constructor(
    private readonly sampleRate: number,
    private readonly emit: RecordingEmitter,
  ) {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw new RangeError('Recording sample rate must be positive');
    }
  }

  get active(): boolean { return Boolean(this.session); }

  start(sessionId: string, channelCount: number, startPositionBeat: number, startFrame: number): void {
    if (this.session) throw new Error('An input recording is already active');
    if (!sessionId) throw new Error('Recording session id is required');
    const normalizedChannels = Math.max(1, Math.min(MAX_RECORDING_CHANNELS, Math.round(channelCount)));
    this.session = {
      sessionId,
      startPositionBeat,
      startFrame,
      sampleRate: this.sampleRate,
      channelCount: normalizedChannels,
    };
    this.buffers = Array.from({ length: normalizedChannels }, () => new Float32Array(RECORDING_CHUNK_FRAMES));
    this.writeFrame = 0;
    this.totalFrames = 0;
    this.emit({ type: 'recording-started', ...this.session });
  }

  append(input: readonly Float32Array[], frameCount: number): void {
    const session = this.session;
    if (!session || frameCount <= 0) return;
    let sourceFrame = 0;
    while (sourceFrame < frameCount) {
      const writable = Math.min(RECORDING_CHUNK_FRAMES - this.writeFrame, frameCount - sourceFrame);
      for (let channel = 0; channel < session.channelCount; channel += 1) {
        const source = input[channel] ?? input[0];
        if (source) {
          this.buffers[channel].set(source.subarray(sourceFrame, sourceFrame + writable), this.writeFrame);
        } else {
          this.buffers[channel].fill(0, this.writeFrame, this.writeFrame + writable);
        }
      }
      this.writeFrame += writable;
      this.totalFrames += writable;
      sourceFrame += writable;
      if (this.writeFrame === RECORDING_CHUNK_FRAMES) this.flush();
    }
  }

  stop(sessionId: string, endFrame: number): void {
    const session = this.requireSession(sessionId);
    this.flush();
    this.emit({
      type: 'recording-complete',
      sessionId: session.sessionId,
      endFrame,
      frameCount: this.totalFrames,
    });
    this.reset();
  }

  cancel(sessionId: string): void {
    const session = this.requireSession(sessionId);
    this.emit({ type: 'recording-cancelled', sessionId: session.sessionId });
    this.reset();
  }

  cancelActive(): void {
    if (!this.session) return;
    this.emit({ type: 'recording-cancelled', sessionId: this.session.sessionId });
    this.reset();
  }

  private requireSession(sessionId: string): WorkletRecordingStart {
    if (!this.session || this.session.sessionId !== sessionId) {
      throw new Error(`Unknown recording session "${sessionId}"`);
    }
    return this.session;
  }

  private flush(): void {
    const session = this.session;
    if (!session || this.writeFrame === 0) return;
    const channelData = this.buffers.map((buffer) => buffer.slice(0, this.writeFrame));
    this.emit(
      { type: 'recording-chunk', sessionId: session.sessionId, frameCount: this.writeFrame, channelData },
      channelData.map((channel) => channel.buffer),
    );
    this.buffers = Array.from({ length: session.channelCount }, () => new Float32Array(RECORDING_CHUNK_FRAMES));
    this.writeFrame = 0;
  }

  private reset(): void {
    this.session = undefined;
    this.buffers = [];
    this.writeFrame = 0;
    this.totalFrames = 0;
  }
}

export const combineRecordingChunks = (
  start: WorkletRecordingStart,
  chunks: readonly Float32Array[][],
  endFrame: number,
  frameCount: number,
): WorkletRecordingResult => {
  if (!Number.isInteger(frameCount) || frameCount < 0) throw new RangeError('Recording frame count is invalid');
  const channelData = Array.from({ length: start.channelCount }, () => new Float32Array(frameCount));
  let writeFrame = 0;
  for (const chunk of chunks) {
    const chunkFrames = chunk[0]?.length ?? 0;
    if (chunk.length !== start.channelCount || chunk.some((channel) => channel.length !== chunkFrames)) {
      throw new Error('Recording chunk channel layout changed');
    }
    if (writeFrame + chunkFrames > frameCount) throw new Error('Recording chunks exceed the declared frame count');
    for (let channel = 0; channel < start.channelCount; channel += 1) {
      channelData[channel].set(chunk[channel], writeFrame);
    }
    writeFrame += chunkFrames;
  }
  if (writeFrame !== frameCount) throw new Error('Recording chunks do not match the declared frame count');
  return { ...start, endFrame, frameCount, channelData };
};

export interface RecordedClipGeometry {
  offsetBeats: number;
  durationBeats: number;
  compensationFrames: number;
}

export interface UnfoldedLoopRecordingPlan {
  /** Input takes are always linear media; project-cycle playback never becomes a clip source loop. */
  sourceLoop: undefined;
  passCount: number;
  unfoldsProjectLoop: boolean;
}

export const planUnfoldedLoopRecording = (
  startBeat: number,
  rawDurationBeats: number,
  loop: ProjectLoop,
): UnfoldedLoopRecordingPlan => {
  if (!Number.isFinite(startBeat) || startBeat < 0 || !Number.isFinite(rawDurationBeats) || rawDurationBeats <= 0) {
    throw new RangeError('Loop recording placement needs a valid start and positive duration');
  }
  if (!loop.enabled) return { sourceLoop: undefined, passCount: 1, unfoldsProjectLoop: false };
  const loopLength = loop.endBeat - loop.startBeat;
  if (!Number.isFinite(loopLength) || loopLength <= 0) throw new RangeError('Loop recording needs a valid project loop');
  const elapsedFromLoopStart = Math.max(0, startBeat - loop.startBeat) + rawDurationBeats;
  const passCount = Math.max(1, Math.ceil(elapsedFromLoopStart / loopLength - 1e-9));
  return { sourceLoop: undefined, passCount, unfoldsProjectLoop: passCount > 1 };
};

/** Keeps the raw take immutable and skips the measured round-trip delay in clip source coordinates. */
export const recordedClipGeometry = (
  frameCount: number,
  sampleRate: number,
  bpm: number,
  compensationMs: number,
): RecordedClipGeometry => {
  if (!Number.isInteger(frameCount) || frameCount <= 0) throw new RangeError('A recording needs at least one frame');
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new RangeError('Recording sample rate must be positive');
  if (!Number.isFinite(bpm) || bpm <= 0) throw new RangeError('Recording BPM must be positive');
  if (!Number.isFinite(compensationMs) || compensationMs < 0) throw new RangeError('Recording compensation must be non-negative');
  const requestedFrames = Math.round((compensationMs / 1_000) * sampleRate);
  const compensationFrames = Math.min(frameCount - 1, requestedFrames);
  const beatsPerFrame = bpm / (60 * sampleRate);
  return {
    offsetBeats: compensationFrames * beatsPerFrame,
    durationBeats: (frameCount - compensationFrames) * beatsPerFrame,
    compensationFrames,
  };
};
