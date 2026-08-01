/**
 * Ordering buffer for `translated_audio` frames.
 *
 * The server sends PCM16 @ 24 kHz mono, base64, tagged with a monotonic `seq` per
 * speaker stream (`server/src/protocol.rs` TranslatedAudio). Frames can arrive out of
 * order or duplicated, and after a reconnect the tail of the previous stream may still
 * be in flight.
 *
 * The rule that matters most: **never play stale speech over later, unrelated content.**
 * A late frame is dropped, not played — a user hearing a sentence from thirty seconds ago
 * over the current one is worse than a small gap.
 */

export interface AudioFrame {
  seq: number;
  /** Base64 PCM16. Decoding is the caller's job — this module stays allocation-light. */
  pcm16_b64: string;
  /** Session this frame belongs to; frames from other sessions are rejected outright. */
  sessionId: string;
}

export interface QueueConfig {
  /** Max frames held while waiting for a gap to fill. Bounds memory on a lossy link. */
  maxBuffered: number;
  /**
   * How many frames we wait for a missing `seq` before giving up and skipping ahead.
   * Waiting forever on a dropped frame would stall playback permanently.
   */
  maxGapWait: number;
}

export const DEFAULT_QUEUE_CONFIG: QueueConfig = { maxBuffered: 64, maxGapWait: 8 };

export interface EnqueueResult {
  /** Frames ready to play now, in order. */
  ready: AudioFrame[];
  /** Why a frame was rejected, for diagnostics. Empty when accepted. */
  dropped: 'stale' | 'duplicate' | 'wrong-session' | 'overflow' | null;
}

/**
 * A single speaker stream's ordering buffer.
 *
 * Deliberately not an EventEmitter: it returns what is playable and lets the caller own
 * playback timing, which keeps it fully unit-testable with no audio context.
 */
export class TranslatedAudioQueue {
  private buffered = new Map<number, AudioFrame>();
  /** seq of the last frame released for playback; -1 before anything has played. */
  private lastReleased = -1;
  private waitedFor = 0;

  constructor(
    private readonly sessionId: string,
    private readonly config: QueueConfig = DEFAULT_QUEUE_CONFIG,
  ) {}

  get bufferedCount(): number {
    return this.buffered.size;
  }

  get lastPlayedSeq(): number {
    return this.lastReleased;
  }

  enqueue(frame: AudioFrame): EnqueueResult {
    if (frame.sessionId !== this.sessionId) {
      return { ready: [], dropped: 'wrong-session' };
    }
    if (frame.seq <= this.lastReleased) {
      // Already played (or superseded) — this is the stale-segment rejection.
      return { ready: [], dropped: 'stale' };
    }
    if (this.buffered.has(frame.seq)) {
      return { ready: [], dropped: 'duplicate' };
    }
    if (this.buffered.size >= this.config.maxBuffered) {
      // Buffer full: the stream is further ahead than we can reassemble. Drop the
      // oldest held frame rather than the new one — newer speech is more relevant.
      const oldest = Math.min(...this.buffered.keys());
      this.buffered.delete(oldest);
      this.buffered.set(frame.seq, frame);
      return { ready: this.drain(), dropped: 'overflow' };
    }

    this.buffered.set(frame.seq, frame);
    return { ready: this.drain(), dropped: null };
  }

  /** Release every contiguous frame from `lastReleased + 1` onward. */
  private drain(): AudioFrame[] {
    const ready: AudioFrame[] = [];
    for (;;) {
      const next = this.buffered.get(this.lastReleased + 1);
      if (next) {
        this.buffered.delete(next.seq);
        this.lastReleased = next.seq;
        ready.push(next);
        this.waitedFor = 0;
        continue;
      }
      if (this.buffered.size === 0) break;

      // A gap. Wait a bounded number of arrivals, then skip to the lowest buffered
      // seq so one lost frame cannot stall the stream forever.
      this.waitedFor += 1;
      if (this.waitedFor < this.config.maxGapWait) break;

      const lowest = Math.min(...this.buffered.keys());
      this.lastReleased = lowest - 1;
      this.waitedFor = 0;
    }
    return ready;
  }

  /** Drop everything pending — used on stop, reconnect, and mode change to bypass. */
  cancel(): void {
    this.buffered.clear();
    this.waitedFor = 0;
  }
}
