/**
 * The capture → encode → transport pipeline. Lives in the offscreen document because an
 * MV3 service worker cannot hold an AudioContext or a long-lived MediaStream.
 *
 * The single most important behaviour here: `chrome.tabCapture` **takes over the tab's
 * audio**. If the captured stream is not routed back to the speakers, the user hears
 * silence and thinks the extension broke the page. So the graph is always:
 *
 *     tab stream ──► MediaStreamSource ──► GainNode ──► destination   (what the user hears)
 *                                     └─► encoder ──► WebSocket       (what we transcribe)
 *
 * That same GainNode is the 0–100 % original-audio control and the ducking mechanism —
 * one node serving three requirements, which is why it is created eagerly and never
 * bypassed.
 *
 * The encoder is swappable at runtime: WebM/Opus by default, PCM16/24k when the server
 * sends `capture_format { pcm: true }`. Reconnection reopens ONLY the socket — the tab
 * capture and audio graph survive, because a `tabCapture` stream id cannot be re-minted
 * without another user gesture.
 */

import { AUDIO } from '@/shared/config';
import { PcmEncoder } from './pcm-encoder';
import { TranslatedAudioPlayer } from './translated-audio-player';
import type { AudioFrame } from '@/audio/translated-audio-queue';

export interface PipelineCallbacks {
  onSocketOpen(): void;
  onSocketClosed(code: number): void;
  onFrame(raw: string): void;
  onError(reason: string, code: string): void;
  /** Translated speech started or stopped, so the caller can update the UI. */
  onTranslatedAudioActive?(active: boolean): void;
}

export interface PipelineOptions {
  sessionId: string;
  streamId: string;
  wsUrl: string;
  originalVolume: number;
  translatedAudioEnabled: boolean;
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

/** How far the original audio is ducked while translated speech is playing. */
export const DUCK_FACTOR = 0.25;

export class CapturePipeline {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private gain: GainNode | null = null;
  private recorder: MediaRecorder | null = null;
  private pcmEncoder: PcmEncoder | null = null;
  private socket: WebSocket | null = null;
  private player: TranslatedAudioPlayer | null = null;
  private disposed = false;

  /** User's preferred original-audio level, before ducking is applied. */
  private preferredVolume: number;
  private ducked = false;

  constructor(
    private readonly options: PipelineOptions,
    private readonly callbacks: PipelineCallbacks,
    private readonly env: PipelineEnv = DEFAULT_ENV,
  ) {
    this.preferredVolume = options.originalVolume;
  }

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
    // The recorder is started by the socket's `open` handler, NOT here — see wireSocket.
    this.openSocket();

    if (this.options.translatedAudioEnabled) await this.enableTranslatedAudio();
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
    this.gain.gain.value = this.preferredVolume;
    source.connect(this.gain);
    this.gain.connect(this.context.destination);
  }

  /** Attach handlers to a socket. Shared by the initial connect and every reconnect. */
  private wireSocket(socket: WebSocket): void {
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    socket.addEventListener('open', () => {
      // The server opens the STT stream on `start`, not on connect.
      socket.send(JSON.stringify({ type: 'start' }));
      this.callbacks.onSocketOpen();
      // Start recording ONLY now. Starting earlier silently discarded the opening
      // chunks — including chunk #1, which is the one carrying the WebM header. The
      // server then fed Deepgram a headerless stream: language detection fell back to
      // its default and transcription produced nothing, with no error anywhere.
      //
      // A FRESH recorder per connection is also what a reconnect needs: the server
      // opens a new Deepgram session, and that session needs its own header.
      this.restartRecorder();
    });
    socket.addEventListener('message', (event) => {
      if (typeof event.data === 'string') this.callbacks.onFrame(event.data);
    });
    socket.addEventListener('close', (event) => {
      // Only report a close for the socket we still consider current — a deliberate
      // close during reconnect must not look like a new failure.
      if (this.socket === socket) this.callbacks.onSocketClosed(event.code);
    });
    socket.addEventListener('error', () => {
      // The close event always follows; classification happens there.
      if (this.socket === socket) {
        this.callbacks.onError('websocket error', 'socket_disconnected');
      }
    });
  }

  private openSocket(): void {
    this.wireSocket(this.env.createSocket(this.options.wsUrl));
  }

  /**
   * Reopen the transport after a recoverable drop, keeping capture alive.
   *
   * The tab stream and audio graph are deliberately untouched: a `tabCapture` stream id
   * cannot be re-minted without another user gesture, so tearing them down would end the
   * session permanently and force the user to click Start again. Buffered translated
   * speech is flushed — it belongs to a moment that has passed.
   */
  reconnect(wsUrl: string): void {
    if (this.disposed) return;

    const old = this.socket;
    this.socket = null;
    old?.close(1000, 'reconnecting');

    this.player?.flush();
    // wireSocket restarts the recorder on `open`, which is exactly what the new
    // Deepgram session on the other end needs — a stream that begins with a header.
    this.wireSocket(this.env.createSocket(wsUrl));
  }

  /**
   * Stop any running recorder and start a new one.
   *
   * New — not resumed — on purpose: only a fresh MediaRecorder emits a header-bearing
   * first chunk, and every Deepgram session on the other end needs that header to decode
   * the stream at all.
   */
  private restartRecorder(): void {
    if (this.recorder && this.recorder.state !== 'inactive') {
      try {
        this.recorder.stop();
      } catch {
        // Already stopped (e.g. the track ended); starting a new one is still correct.
      }
    }
    this.recorder = null;
    this.startRecorder();
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
      void event.data.arrayBuffer().then((buffer) => this.sendAudio(buffer));
    });

    recorder.start(AUDIO.timesliceMs);
  }

  /** One place decides whether an encoded chunk may go on the wire. */
  private sendAudio(buffer: ArrayBuffer): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WS_OPEN) return;
    // Drop rather than buffer when the socket backs up: stale audio is worthless for
    // live subtitles, and an unbounded queue is how extensions leak memory.
    if (socket.bufferedAmount > BACKPRESSURE_BYTES) return;
    socket.send(buffer);
  }

  /**
   * Switch the encoder to raw PCM16/24k, or back to WebM/Opus.
   *
   * Driven by the server's `capture_format` frame, sent when one captured stream must
   * feed two providers at once. Only the encoder changes — the capture stream and the
   * passthrough graph are untouched, so what the user hears never glitches.
   */
  async setPcmMode(pcm: boolean): Promise<void> {
    if (this.disposed || !this.stream) return;
    if (pcm === (this.pcmEncoder !== null)) return;

    if (pcm) {
      if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
      this.recorder = null;

      const encoder = new PcmEncoder(this.stream, {
        onChunk: (buffer) => this.sendAudio(buffer),
        onError: (reason) => this.callbacks.onError(reason, 'provider_unavailable'),
      });
      const ok = await encoder.start();
      this.pcmEncoder = ok ? encoder : null;
      // A failed PCM switch must not leave the session mute: fall back to Opus.
      if (!ok) this.startRecorder();
      return;
    }

    await this.pcmEncoder?.dispose();
    this.pcmEncoder = null;
    this.startRecorder();
  }

  /** Build the translated-speech graph. Failure degrades to subtitles, never to silence. */
  async enableTranslatedAudio(): Promise<void> {
    if (this.disposed || this.player) return;

    const player = new TranslatedAudioPlayer(this.options.sessionId, {
      onActiveChange: (active) => {
        this.ducked = active;
        this.applyGain();
        this.callbacks.onTranslatedAudioActive?.(active);
      },
      onDegraded: (reason) => {
        // Never leave the user in silence: restore the original and say so.
        this.ducked = false;
        this.applyGain();
        this.callbacks.onError(reason, 'translated_audio_failed');
      },
    });

    const ok = await player.init();
    this.player = ok ? player : null;
  }

  async disableTranslatedAudio(): Promise<void> {
    const player = this.player;
    this.player = null;
    this.ducked = false;
    this.applyGain();
    await player?.dispose();
  }

  /** Feed one validated translated-audio frame to the player. */
  playTranslatedAudio(frame: AudioFrame): void {
    this.player?.enqueue(frame);
  }

  /** Drop pending speech — on stop, on reconnect, and when the language bypass engages. */
  flushTranslatedAudio(): void {
    this.player?.flush();
  }

  /**
   * Tell the server this listener now wants a different language.
   *
   * Without this the room's target set never changes, the server keeps translating into
   * the old language, and the client's lookup for the new one comes back empty — which
   * renders as the untranslated original.
   */
  setTargetLanguage(lang: string): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WS_OPEN) return;
    socket.send(JSON.stringify({ type: 'set_lang', lang }));
  }

  setOriginalVolume(volume: number): void {
    this.preferredVolume = Math.min(1, Math.max(0, volume));
    this.applyGain();
  }

  private applyGain(): void {
    if (!this.gain || !this.context) return;
    const target = this.ducked ? this.preferredVolume * DUCK_FACTOR : this.preferredVolume;
    // Ramp instead of stepping — an instant gain change is an audible click.
    this.gain.gain.setTargetAtTime(target, this.context.currentTime, 0.05);
  }

  /**
   * Release every resource. Idempotent, and ordered so nothing can emit after teardown:
   * encoders → player → socket → tracks → audio context.
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

    await this.pcmEncoder?.dispose();
    this.pcmEncoder = null;

    await this.player?.dispose();
    this.player = null;

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
