/**
 * Playback of server-generated translated speech.
 *
 * The server sends PCM16 mono @ 24 kHz, base64, sequenced (`server/src/protocol.rs`
 * TranslatedAudio). Ordering, de-duplication and stale rejection are handled by the
 * shared `TranslatedAudioQueue`; this module owns only the audio graph.
 *
 * It reuses `pcm-playback-worklet.js` — the same processor the VoxTranslate web client
 * ships — rather than a second implementation, so both clients drain audio identically.
 * The worklet is loaded from an extension-origin URL, never a `blob:` URL: the CSP
 * allows `self` only, and a blob worklet fails silently (the same trap spec 0093 hit in
 * production on the web client).
 */

import { TranslatedAudioQueue, type AudioFrame } from '@/audio/translated-audio-queue';

/** The server's fixed output format. Not negotiable — it is what the wire carries. */
export const TRANSLATED_SAMPLE_RATE = 24_000;

const PLAYBACK_WORKLET = 'pcm-playback-worklet.js';
const PROCESSOR_NAME = 'pcm-playback-processor';

/** Silence for this long with nothing queued counts as "no longer speaking". */
const IDLE_AFTER_MS = 400;

/**
 * Drop the buffer once playback is this far behind the audio we have queued.
 *
 * The worklet's FIFO is unbounded. On a continuous source — a video, rather than the
 * bursty turn-taking of a call — the network can deliver slightly faster than the audio
 * clock drains, and the backlog grows monotonically: first latency, then artefacts, then
 * a rising wash of noise as the buffer churns. Resyncing loses a moment of speech;
 * drifting loses the rest of the session.
 */
const MAX_BACKLOG_SECONDS = 1.5;

export interface PlayerCallbacks {
  /** Fires when translated speech starts or stops, so the caller can duck the original. */
  onActiveChange(active: boolean): void;
  /** Playback could not be set up or has failed; the caller must restore original audio. */
  onDegraded(reason: string): void;
}

/** Decode base64 PCM16 → Float32 in [-1, 1], the format the worklet drains. */
export function decodePcm16(base64: string): Float32Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  // A truncated frame would misalign every subsequent sample, so drop the odd byte
  // rather than reinterpreting the stream.
  const sampleCount = Math.floor(bytes.length / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, sampleCount * 2);
  const out = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    // Little-endian, matching what the server writes.
    out[i] = view.getInt16(i * 2, true) / 0x8000;
  }
  return out;
}

export class TranslatedAudioPlayer {
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private gain: GainNode | null = null;
  private queue: TranslatedAudioQueue;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private active = false;
  private disposed = false;
  /** Seconds of audio handed to the worklet, and where playback had reached by then. */
  private queuedSeconds = 0;
  private queueStartedAt: number | null = null;

  constructor(
    sessionId: string,
    private readonly callbacks: PlayerCallbacks,
    private readonly resolveWorkletUrl: (path: string) => string = (p) => chrome.runtime.getURL(p),
  ) {
    this.queue = new TranslatedAudioQueue(sessionId);
  }

  /**
   * Build the playback graph. Kept separate from the constructor because it is async
   * and may fail — and a failure here must degrade to original audio, not throw into
   * the capture pipeline.
   */
  async init(): Promise<boolean> {
    try {
      // A context pinned to the stream's rate avoids resampling the translated voice.
      this.context = new AudioContext({ sampleRate: TRANSLATED_SAMPLE_RATE });
      await this.context.audioWorklet.addModule(this.resolveWorkletUrl(PLAYBACK_WORKLET));
      if (this.disposed) return false;

      // Explicit topology. A default node has one INPUT and infers its output channel
      // count from it, which for a source-only processor is neither what we want nor
      // stable across engines — the worklet writes a single mono channel.
      this.node = new AudioWorkletNode(this.context, PROCESSOR_NAME, {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      this.gain = this.context.createGain();
      this.gain.gain.value = 1;
      this.node.connect(this.gain).connect(this.context.destination);
      // Same trap as the capture context: a suspended graph plays nothing, silently.
      if (this.context.state === 'suspended') {
        await this.context.resume();
      }
      return true;
    } catch (cause) {
      this.callbacks.onDegraded(String(cause));
      await this.dispose();
      return false;
    }
  }

  /**
   * Accept one frame. Ordering and stale rejection happen in the queue, so a late or
   * duplicated segment is dropped here rather than played over current speech.
   */
  enqueue(frame: AudioFrame): void {
    if (this.disposed || !this.node) return;

    const result = this.queue.enqueue(frame);
    if (result.ready.length === 0) return;

    for (const ready of result.ready) {
      let samples: Float32Array;
      try {
        samples = decodePcm16(ready.pcm16_b64);
      } catch (cause) {
        // A single malformed frame must not kill the stream.
        console.warn('[voxtranslate] undecodable audio frame dropped', String(cause));
        continue;
      }
      if (samples.length === 0) continue;

      // Track the backlog: how much audio we have handed over versus how much wall time
      // has passed since playback began.
      const now = this.context?.currentTime ?? 0;
      if (this.queueStartedAt === null) {
        this.queueStartedAt = now;
        this.queuedSeconds = 0;
      }
      this.queuedSeconds += samples.length / TRANSLATED_SAMPLE_RATE;
      const played = now - this.queueStartedAt;

      if (this.queuedSeconds - played > MAX_BACKLOG_SECONDS) {
        // We are falling behind and will never catch up on our own. Resync rather than
        // let the delay — and the artefacts that come with it — keep growing.
        console.warn('[voxtranslate] translated audio fell behind; resyncing');
        this.node.port.postMessage('flush');
        this.queueStartedAt = now;
        this.queuedSeconds = samples.length / TRANSLATED_SAMPLE_RATE;
      }

      this.node.port.postMessage(samples);
    }

    this.markActive();
  }

  /** Translated speech is playing: tell the caller so it can duck the original. */
  private markActive(): void {
    if (!this.active) {
      this.active = true;
      this.callbacks.onActiveChange(true);
    }
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.active = false;
      this.idleTimer = null;
      this.callbacks.onActiveChange(false);
    }, IDLE_AFTER_MS);
  }

  /**
   * Drop everything pending and go silent immediately.
   *
   * Used on stop, on reconnect, and when the language bypass engages — in all three
   * cases the buffered speech belongs to a moment that has passed, and playing it over
   * what comes next is worse than a gap.
   */
  flush(): void {
    this.queue.cancel();
    this.node?.port.postMessage('flush');
    this.queueStartedAt = null;
    this.queuedSeconds = 0;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.active) {
      this.active = false;
      this.callbacks.onActiveChange(false);
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;

    if (this.node) {
      this.node.port.onmessage = null;
      this.node.disconnect();
      this.node = null;
    }
    this.gain?.disconnect();
    this.gain = null;

    if (this.context && this.context.state !== 'closed') {
      await this.context.close().catch(() => undefined);
    }
    this.context = null;

    if (this.active) {
      this.active = false;
      this.callbacks.onActiveChange(false);
    }
  }
}
