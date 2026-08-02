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
import { CartesiaManager, setCaptureWorkletUrl, type CartesiaSession } from '@/audio/cartesia';
import { PcmEncoder } from './pcm-encoder';
import { TranslateHop } from './translate-hop';
import { TranslatedAudioPlayer } from './translated-audio-player';
import type { AudioFrame } from '@/audio/translated-audio-queue';

export interface PipelineCallbacks {
  onSocketOpen(): void;
  onSocketClosed(code: number): void;
  onFrame(raw: string): void;
  onError(reason: string, code: string): void;
  /** Translated speech started or stopped, so the caller can update the UI. */
  onTranslatedAudioActive?(active: boolean): void;
  /**
   * A caption produced IN THIS BROWSER (Enhanced only). The server never sees this text,
   * so it cannot arrive as a `subtitle_*` frame like every other tier's does.
   */
  onLocalSubtitle?(text: string, interim: boolean, original?: string): void;
  /** Mint a Cartesia session (Enhanced only) — injected so the pipeline stays testable. */
  fetchCartesiaSession?: () => Promise<CartesiaSession | null>;
}

export interface PipelineOptions {
  sessionId: string;
  streamId: string;
  wsUrl: string;
  originalVolume: number;
  translatedAudioEnabled: boolean;
  /** Encode PCM16/24k (speech-to-speech tiers) rather than WebM/Opus (Standard). */
  pcm: boolean;
  /**
   * Run the provider IN THIS BROWSER (Cartesia "Enhanced") instead of streaming audio to
   * the server. The socket still carries billing and the translation hop — Cartesia does
   * speech-to-text and text-to-speech but not translation.
   */
  clientDirect: boolean;
  /** The spoken language. Required for Enhanced: Cartesia cannot detect it. */
  sourceLang: string;
  /** The language to translate into. */
  targetLang: string;
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

/** The tab is the only "speaker" an extension session has. */
const TAB_PEER_ID = 'tab';

export class CapturePipeline {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private gain: GainNode | null = null;
  private recorder: MediaRecorder | null = null;
  private pcmEncoder: PcmEncoder | null = null;
  private socket: WebSocket | null = null;
  private player: TranslatedAudioPlayer | null = null;
  private cartesia: CartesiaManager | null = null;
  private hop: TranslateHop | null = null;
  private disposed = false;

  /** User's preferred original-audio level, before ducking is applied. */
  private preferredVolume: number;
  private ducked = false;
  /** Which encoder the server expects. Set from the tier, corrected by `capture_format`. */
  private pcmMode: boolean;

  constructor(
    private readonly options: PipelineOptions,
    private readonly callbacks: PipelineCallbacks,
    private readonly env: PipelineEnv = DEFAULT_ENV,
  ) {
    this.preferredVolume = options.originalVolume;
    this.pcmMode = options.pcm;
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
    // The encoder is started by the socket's `open` handler, NOT here — see wireSocket.
    // On a client-direct tier no encoder ever starts: no audio goes to our server.
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
    // A suspended passthrough graph means the captured tab goes SILENT for the user.
    if (this.context.state === 'suspended') {
      void this.context.resume();
    }
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
      if (this.options.clientDirect) {
        // Nothing to encode: the browser talks to the provider directly. The socket
        // carries billing and the translation hop only.
        void this.startClientDirect();
      } else {
        // A FRESH encoder per connection is also what a reconnect needs: the server opens
        // a new upstream session, and a WebM one needs its own header.
        void this.restartEncoder();
      }
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
  private async restartEncoder(): Promise<void> {
    if (this.recorder && this.recorder.state !== 'inactive') {
      try {
        this.recorder.stop();
      } catch {
        // Already stopped (e.g. the track ended); starting a new one is still correct.
      }
    }
    this.recorder = null;
    await this.pcmEncoder?.dispose();
    this.pcmEncoder = null;

    if (this.pcmMode) {
      await this.startPcmEncoder();
    } else {
      this.startRecorder();
    }
  }

  /** Open the PCM16/24k path; falls back to Opus rather than leaving the session mute. */
  private async startPcmEncoder(): Promise<void> {
    if (!this.stream) return;
    const encoder = new PcmEncoder(this.stream, {
      onChunk: (buffer) => this.sendAudio(buffer),
      onError: (reason) => this.callbacks.onError(reason, 'provider_unavailable'),
    });
    const ok = await encoder.start();
    if (ok) {
      this.pcmEncoder = encoder;
    } else {
      this.pcmMode = false;
      this.startRecorder();
    }
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
    this.pcmMode = pcm;
    await this.restartEncoder();
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

  /**
   * Start the in-browser Cartesia pipeline.
   *
   * The tab is modelled as a single "peer" whose language the user chose — Cartesia has
   * no auto-detect, which is why Enhanced asks for the spoken language up front.
   */
  private async startClientDirect(): Promise<void> {
    if (this.disposed || !this.stream || this.cartesia) return;

    console.info('[voxtranslate] enhanced: starting in-browser pipeline', {
      source: this.options.sourceLang,
      target: this.options.targetLang,
      speech: this.options.translatedAudioEnabled,
    });

    const fetchSession = this.callbacks.fetchCartesiaSession;
    if (!fetchSession) {
      this.callbacks.onError('no Cartesia session provider', 'provider_unavailable');
      return;
    }
    if (!CartesiaManager.supported) {
      this.callbacks.onError('browser cannot run the Cartesia pipeline', 'provider_unavailable');
      return;
    }
    // Fail loudly HERE rather than let the manager sit inert: a session it cannot mint
    // looks identical to a session that simply never produces anything.
    const probe = await fetchSession().catch(() => null);
    if (!probe) {
      this.callbacks.onError('could not mint a Cartesia session', 'provider_unavailable');
      return;
    }
    console.info('[voxtranslate] enhanced: session minted, stt=', probe.sttEndpoint);

    // The worklet ships with the extension, so it is served from the extension origin —
    // never a blob: URL, which the CSP blocks and which fails silently.
    setCaptureWorkletUrl(chrome.runtime.getURL('pcm-capture-worklet.js'));

    // Count consecutive failed translations. cartesia.ts falls back to the SOURCE text
    // when a translation does not arrive, which looks exactly like "the output language
    // is the input language" — a silent, very confusing failure. Say it out loud.
    let translateFailures = 0;
    this.hop = new TranslateHop((frame) => {
      const socket = this.socket;
      if (!socket || socket.readyState !== WS_OPEN) {
        console.warn('[voxtranslate] enhanced: cannot translate, socket not open');
        return false;
      }
      socket.send(frame);
      return true;
    });

    if (!this.player && this.options.translatedAudioEnabled) {
      await this.enableTranslatedAudio();
    }

    const manager = new CartesiaManager({
      fetchSession,
      translate: async (text, source, target) => {
        const result = (await this.hop?.translate(text, source, target)) ?? null;
        if (result === null) {
          translateFailures += 1;
          if (translateFailures === 3) {
            this.callbacks.onError(
              'the translation service did not answer — showing the original text',
              'provider_unavailable',
            );
          }
        } else {
          translateFailures = 0;
        }
        return result;
      },
      onSubtitle: (_speakerId, text, interim, original) => {
        if (!interim) console.debug('[voxtranslate] enhanced: final caption');
        this.callbacks.onLocalSubtitle?.(text, interim, original);
      },
      onError: (_speakerId, status, message) => {
        console.warn('[voxtranslate] enhanced pipeline gave up:', status, message);
        this.callbacks.onError(`${status}: ${message}`, 'provider_unavailable');
      },
      playAudio: (_speakerId, seq, pcm16Base64) => {
        this.player?.enqueue({ seq, pcm16_b64: pcm16Base64, sessionId: this.options.sessionId });
      },
      ttsEnabled: () => this.options.translatedAudioEnabled,
    });

    manager.setPeerStream(TAB_PEER_ID, this.stream);
    manager.setPeerLang(TAB_PEER_ID, this.options.sourceLang);
    manager.activate(this.options.targetLang);
    this.cartesia = manager;
    console.info('[voxtranslate] enhanced: pipeline activated');
  }

  /** Route one `translated_text` reply back to whoever asked for it (Enhanced only). */
  acceptTranslation(requestId: string, text: string): boolean {
    return this.hop?.accept(requestId, text) ?? false;
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
    // Enhanced translates in-browser, so the change is applied locally; the server is
    // told anyway because it still meters and fans out for every other tier.
    this.cartesia?.setMyLang(lang);
    this.hop?.cancelAll(); // in-flight segments are for the previous language
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

    this.cartesia?.deactivate();
    this.cartesia = null;
    this.hop?.cancelAll();
    this.hop = null;

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
