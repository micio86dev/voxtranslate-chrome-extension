/**
 * The Enhanced translation hop.
 *
 * Cartesia does speech-to-text and text-to-speech but NOT translation, so every finalized
 * source segment is sent over our own WebSocket as `translate_text` and comes back as
 * `translated_text` (spec 0108). Text is the only thing that crosses our server on this
 * tier — the audio stays between the browser and Cartesia.
 *
 * Requests are correlated by `request_id` because replies can overtake each other: a short
 * segment translates faster than a long one sent before it, and matching by arrival order
 * would put the wrong words under the wrong speech.
 */

/** Give up on a segment after this long. A caption that arrives late is worse than none. */
const REQUEST_TIMEOUT_MS = 8_000;

/**
 * Cap on in-flight requests. If the socket stalls, unbounded pending promises would pin
 * every segment of the session in memory and then resolve in a burst nobody can read.
 */
const MAX_PENDING = 24;

interface Pending {
  resolve: (text: string | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class TranslateHop {
  private pending = new Map<string, Pending>();
  private counter = 0;

  constructor(private readonly send: (frame: string) => boolean) {}

  /**
   * Translate one finalized segment. Resolves to null on timeout, on a closed socket, or
   * when too many requests are already in flight — the caller then shows the untranslated
   * source rather than nothing.
   */
  translate(text: string, source: string, target: string): Promise<string | null> {
    if (this.pending.size >= MAX_PENDING) return Promise.resolve(null);

    const requestId = `t${++this.counter}`;
    const frame = JSON.stringify({
      type: 'translate_text',
      request_id: requestId,
      text,
      source,
      target,
    });
    if (!this.send(frame)) return Promise.resolve(null);

    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve(null);
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, timer });
    });
  }

  /**
   * Feed one inbound `translated_text` frame. Returns true when it matched a request —
   * an unmatched reply is not an error (it may have already timed out), just ignored.
   */
  accept(requestId: string, text: string): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.resolve(text);
    return true;
  }

  /** Abandon everything in flight — on stop, on reconnect, on a language change. */
  cancelAll(): void {
    for (const { resolve, timer } of this.pending.values()) {
      clearTimeout(timer);
      resolve(null);
    }
    this.pending.clear();
  }

  get inFlight(): number {
    return this.pending.size;
  }
}
