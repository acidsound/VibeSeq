import { VibeSeqWorkletRenderer } from './workletRenderer';
import {
  VIBESEQ_AUDIO_PROCESSOR_NAME,
  type WorkletCommand,
} from './workletProtocol';

declare const sampleRate: number;
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

  constructor(options?: AudioWorkletNodeOptions) {
    super(options);
    this.renderer = new VibeSeqWorkletRenderer(sampleRate, (event) => this.port.postMessage(event));
    this.port.onmessage = (event: MessageEvent<WorkletCommand>) => this.renderer.handleCommand(event.data);
  }

  process(
    _inputs: readonly (readonly Float32Array[])[],
    outputs: readonly (readonly Float32Array[])[],
    _parameters: Record<string, Float32Array>,
  ): boolean {
    return this.renderer.process(outputs[0] ?? []);
  }
}

registerProcessor(VIBESEQ_AUDIO_PROCESSOR_NAME, VibeSeqAudioProcessor);
