/**
 * The capture → encode → transport pipeline. Lives in the offscreen document because an
 * MV3 service worker cannot hold an AudioContext or a long-lived MediaStream.
 *
 * The single most important behaviour here: `chrome.tabCapture` **takes over the tab's
 * audio**. If the captured stream is not routed back to the speakers, the user hears
 * silence and thinks the extension broke the page. So the graph is always:
 *
 *     tab stream ──► MediaStreamSource ──► GainNode ──► destination   (what the user hears)
 *                                     └─► MediaRecorder ──► WebSocket (what we transcribe)
 *
 * That same GainNode is the 0–100 % original-audio control and the ducking mechanism —
 * one node serving three requirements, which is why it is created eagerly and never
 * bypassed.
 */

import { AUDIO } from '@/shared/config';

export interface PipelineCallbacks {
  onSocketOpen(): void;
  onSocketClosed(code: number): void;
  onFrame(raw: string): void;
  onError(reason: string, code: string): void;
}

export interface PipelineOptions {
  sessionId: string;
  streamId: string;
  wsUrl: string;
  originalVolume: number;
}

/**
 * Browser APIs the pipeline touches, injected so the whole class is testable without a
 * real tab, a real microphone, or a real socket. `activeTab` makes tab capture
 * impossible to automate in a test browser (Chrome: "Extension has not been invoked for
 * the current page"), so injecting the environment is the only way to cover this file at
 * all — and the seam costs nothing in production, where the defaults are used.
 */
export interface PipelineEnv {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  createAudioContext(): AudioContext;
  createRecorder(stream: MediaStream, options: MediaRecorderOptions): MediaRecorder;
  createSocket(url: string): WebSocket;
  isTypeSupported(mime: string): boolean;
}

const DEFAULT_ENV: PipelineEnv = {
  getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
  createAudioContext: () => new AudioContext(),
  createRecorder: (stream, options) => new MediaRecorder(stream, options),
  createSocket: (url) => new WebSocket(url),
  isTypeSupported: (mime) => MediaRecorder.isTypeSupported(mime),
};

/** Stop sending when the socket has this much unsent data — stale audio is worthless. */
export const BACKPRESSURE_BYTES = 1_000_000;

/**
 * `WebSocket.OPEN`, as a literal. Reading it off the global couples the pipeline to a
 * global that does not exist in every environment (it is absent under happy-dom), for
 * no benefit — the value is fixed by the WHATWG spec.
 */
const WS_OPEN = 1;

export class CapturePipeline {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private gain: GainNode | null = null;
  private recorder: MediaRecorder | null = null;
  private socket: WebSocket | null = null;
  private disposed = false;

  constructor(
    private readonly options: PipelineOptions,
    private readonly callbacks: PipelineCallbacks,
    private readonly env: PipelineEnv = DEFAULT_ENV,
  ) {}

  private pickMimeType(): string {
    return this.env.isTypeSupported(AUDIO.mimeType) ? AUDIO.mimeType : AUDIO.fallbackMimeType;
  }

  async start(): Promise<void> {
    try {
      await this.openStream();
    } catch (cause) {
      this.callbacks.onError(String(cause), 'capture_denied');
      await this.dispose();
      return;
    }

    this.buildAudioGraph();
    this.openSocket();
    this.startRecorder();
  }

  /**
   * Consume the media stream id minted by the service worker.
   *
   * The `chromeMediaSource: 'tab'` constraint is the documented MV3 path: the worker
   * calls `tabCapture.getMediaStreamId`, and only this document may consume the id.
   */
  private async openStream(): Promise<void> {
    this.stream = await this.env.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: this.options.streamId,
        },
      },
      video: false,
    } as MediaStreamConstraints);

    // If the tab closes or navigates away, the track ends. Treat that as session end
    // rather than letting the pipeline sit on a dead stream.
    for (const track of this.stream.getAudioTracks()) {
      track.addEventListener('ended', () => {
        if (!this.disposed) this.callbacks.onError('tab audio ended', 'tab_closed');
      });
    }
  }

  /** Re-route captured audio to the speakers so the tab does not go silent. */
  private buildAudioGraph(): void {
    if (!this.stream) return;
    this.context = this.env.createAudioContext();
    const source = this.context.createMediaStreamSource(this.stream);
    this.gain = this.context.createGain();
    this.gain.gain.value = this.options.originalVolume;
    source.connect(this.gain);
    this.gain.connect(this.context.destination);
  }

  private openSocket(): void {
    const socket = this.env.createSocket(this.options.wsUrl);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    socket.addEventListener('open', () => {
      // The server opens the STT stream on `start`, not on connect.
      socket.send(JSON.stringify({ type: 'start' }));
      this.callbacks.onSocketOpen();
    });
    socket.addEventListener('message', (event) => {
      if (typeof event.data === 'string') this.callbacks.onFrame(event.data);
    });
    socket.addEventListener('close', (event) => {
      this.callbacks.onSocketClosed(event.code);
    });
    socket.addEventListener('error', () => {
      // The close event always follows; classification happens there.
      this.callbacks.onError('websocket error', 'socket_disconnected');
    });
  }

  private startRecorder(): void {
    if (!this.stream) return;
    const recorder = this.env.createRecorder(this.stream, {
      mimeType: this.pickMimeType(),
      audioBitsPerSecond: AUDIO.bitsPerSecond,
    });
    this.recorder = recorder;

    recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size === 0) return;
      const socket = this.socket;
      if (!socket || socket.readyState !== WS_OPEN) return;
      // Drop rather than buffer when the socket backs up: stale audio is worthless
      // for live subtitles, and an unbounded queue is how extensions leak memory.
      if (socket.bufferedAmount > BACKPRESSURE_BYTES) return;
      void event.data.arrayBuffer().then((buffer) => {
        if (socket.readyState === WS_OPEN) socket.send(buffer);
      });
    });

    recorder.start(AUDIO.timesliceMs);
  }

  setOriginalVolume(volume: number): void {
    if (!this.gain || !this.context) return;
    const clamped = Math.min(1, Math.max(0, volume));
    // Ramp instead of stepping — an instant gain change is an audible click.
    this.gain.gain.setTargetAtTime(clamped, this.context.currentTime, 0.05);
  }

  /**
   * Release every resource. Idempotent, and ordered so nothing can emit after teardown:
   * recorder → socket → tracks → audio context.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    if (this.recorder && this.recorder.state !== 'inactive') {
      try {
        this.recorder.stop();
      } catch {
        // Already stopped by a track ending; nothing to do.
      }
    }
    this.recorder = null;

    if (this.socket) {
      const socket = this.socket;
      this.socket = null;
      if (socket.readyState === WS_OPEN) {
        try {
          socket.send(JSON.stringify({ type: 'stop' }));
        } catch {
          // Socket died first — the close below is what matters.
        }
      }
      socket.close(1000, 'session ended');
    }

    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;

    if (this.context && this.context.state !== 'closed') await this.context.close();
    this.context = null;
    this.gain = null;
  }
}
