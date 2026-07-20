import { VibeSeqWorkletRenderer } from './workletRenderer';
import { WorkletInputRecorder } from './inputRecording';
import {
  VIBESEQ_AUDIO_PROCESSOR_NAME,
  type WorkletCommand,
} from './workletProtocol';

declare const sampleRate: number;
declare const currentFrame: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: AudioWorkletNodeOptions);
}
declare function registerProcessor(
  name: string,
  processorCtor: new (options?: AudioWorkletNodeOptions) => AudioWorkletProcessor,
): void;

class VibeSeqAudioProcessor extends AudioWorkletProcessor {
  private readonly renderer: VibeSeqWorkletRenderer;
  private readonly inputRecorder: WorkletInputRecorder;

  constructor(options?: AudioWorkletNodeOptions) {
    super(options);
    this.renderer = new VibeSeqWorkletRenderer(sampleRate, (event) => this.port.postMessage(event));
    this.inputRecorder = new WorkletInputRecorder(
      sampleRate,
      (event, transfer = []) => this.port.postMessage(event, transfer),
    );
    this.port.onmessage = (event: MessageEvent<WorkletCommand>) => {
      const command = event.data;
      try {
        if (command.type === 'start-recording') {
          this.inputRecorder.start(
            command.sessionId,
            command.channelCount,
            this.renderer.getPositionBeat(),
            currentFrame,
          );
          return;
        }
        if (command.type === 'stop-recording') {
          this.inputRecorder.stop(command.sessionId, currentFrame);
          return;
        }
        if (command.type === 'cancel-recording') {
          this.inputRecorder.cancel(command.sessionId);
          return;
        }
        if (command.type === 'dispose' && this.inputRecorder.active) {
          this.inputRecorder.cancelActive();
        }
        this.renderer.handleCommand(command);
      } catch (error) {
        this.port.postMessage({
          type: 'error',
          code: 'recording-command',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    };
  }

  process(
    inputs: readonly (readonly Float32Array[])[],
    outputs: readonly (readonly Float32Array[])[],
    _parameters: Record<string, Float32Array>,
  ): boolean {
    const frameCount = outputs[0]?.[0]?.length ?? inputs[0]?.[0]?.length ?? 0;
    this.inputRecorder.append(inputs[0] ?? [], frameCount);
    return this.renderer.process(outputs[0] ?? []);
  }
}

registerProcessor(VIBESEQ_AUDIO_PROCESSOR_NAME, VibeSeqAudioProcessor);
