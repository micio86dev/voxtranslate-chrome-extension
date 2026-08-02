/**
 * PCM16 @ 24 kHz capture, for when the server asks for it.
 *
 * The default path is WebM/Opus via MediaRecorder (spec 0043). The server switches a
 * session to raw PCM with a `capture_format { pcm: true }` frame when one captured
 * stream must feed two providers at once — Deepgram plus OpenAI/Gemini — because those
 * premium engines take PCM16/24k and Opus cannot be handed to both.
 *
 * Reuses `pcm-capture-worklet.js`, the same processor the VoxTranslate web client ships,
 * so both clients produce byte-identical frames. An AudioContext pinned to 24 kHz makes
 * the browser do the resampling; the worklet does Float32 → Int16 off the main thread
 * and posts ~100 ms chunks.
 *
 * The worklet is loaded from an extension-origin URL, never `blob:` — the CSP allows
 * `self` only, and a blob worklet fails silently.
 */

export const PCM_SAMPLE_RATE = 24_000;

const CAPTURE_WORKLET = 'pcm-capture-worklet.js';
const PROCESSOR_NAME = 'pcm-capture-processor';

export interface PcmEncoderCallbacks {
  onChunk(buffer: ArrayBuffer): void;
  onError(reason: string): void;
}

export class PcmEncoder {
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private sink: GainNode | null = null;
  private disposed = false;

  constructor(
    private readonly stream: MediaStream,
    private readonly callbacks: PcmEncoderCallbacks,
    private readonly resolveWorkletUrl: (path: string) => string = (p) => chrome.runtime.getURL(p),
  ) {}

  async start(): Promise<boolean> {
    try {
      const track = this.stream.getAudioTracks()[0];
      if (!track) {
        this.callbacks.onError('no audio track to encode');
        return false;
      }

      // A dedicated 24 kHz context. Deliberately separate from the passthrough context
      // that feeds the user's speakers — pinning THAT one to 24 kHz would downgrade the
      // audio the user actually hears, for no reason.
      this.context = new AudioContext({ sampleRate: PCM_SAMPLE_RATE });
      await this.context.audioWorklet.addModule(this.resolveWorkletUrl(CAPTURE_WORKLET));
      if (this.disposed) return false;

      // Re-read the track: it may have ended while we awaited the module.
      const live = this.stream.getAudioTracks()[0];
      if (!live) {
        this.callbacks.onError('audio track ended during setup');
        return false;
      }

      this.source = this.context.createMediaStreamSource(new MediaStream([live]));
      this.node = new AudioWorkletNode(this.context, PROCESSOR_NAME);
      this.node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        if (!this.disposed) this.callbacks.onChunk(event.data);
      };

      // A worklet node only runs when the graph pulls it, so it must reach a
      // destination — routed through a silent gain so this path is never audible.
      this.sink = this.context.createGain();
      this.sink.gain.value = 0;
      this.source.connect(this.node).connect(this.sink).connect(this.context.destination);

      // An AudioContext can be created `suspended`, and a suspended graph never pulls the
      // worklet — which means not one PCM sample is ever produced and the session goes
      // quiet with no error at all. Cheap to ask, expensive to miss.
      if (this.context.state === 'suspended') {
        await this.context.resume();
      }
      return true;
    } catch (cause) {
      this.callbacks.onError(String(cause));
      await this.dispose();
      return false;
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    if (this.node) {
      this.node.port.onmessage = null;
      this.node.disconnect();
      this.node = null;
    }
    this.source?.disconnect();
    this.source = null;
    this.sink?.disconnect();
    this.sink = null;

    if (this.context && this.context.state !== 'closed') {
      await this.context.close().catch(() => undefined);
    }
    this.context = null;
  }
}
