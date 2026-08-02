/**
 * Integration tests: the session pipeline driven end-to-end through the pure modules,
 * with a scripted server replacing the network.
 *
 * These are the tests that catch cross-module bugs the unit tests cannot see — a stale
 * frame updating the meter, a bypass that forgets to restore audio, a reconnect that
 * bills twice. No provider is contacted and no credit is spent.
 */

import { describe, expect, it } from 'vitest';
import { applyDetection, initialLanguageMode, originalAudioGain } from '@/audio/language-mode';
import { TranslatedAudioQueue } from '@/audio/translated-audio-queue';
import { DEFAULT_BACKOFF, isFatalCloseCode, nextBackoff } from '@/websocket/backoff';
import { parseServerMessage } from '@/websocket/validate';
import {
  acceptsEventFrom,
  initialContext,
  transition,
  type SessionContext,
} from '@/state/session-machine';
import {
  applyBalanceUpdate,
  beginSession,
  initialMeter,
  snapshot,
  type MeterState,
} from '@/usage/meter';

/** Minimal harness: a session plus everything the background worker folds per frame. */
class Harness {
  session: SessionContext;
  meter: MeterState;
  languageMode = initialLanguageMode();
  queue: TranslatedAudioQueue;
  played: number[] = [];
  rejectedFrames: string[] = [];

  constructor(
    readonly sessionId: string,
    readonly target: string,
    openingBalance: number,
  ) {
    this.session = initialContext(true);
    this.session = transition(this.session, { type: 'START_REQUESTED' }, sessionId).context;
    this.session = transition(this.session, { type: 'CAPTURE_GRANTED' }).context;
    this.session = transition(this.session, { type: 'SOCKET_OPEN' }).context;
    this.meter = beginSession(initialMeter(), openingBalance, 0);
    this.queue = new TranslatedAudioQueue(sessionId);
  }

  /** Mirrors the background worker's frame handling, including the staleness guard. */
  receive(sessionId: string, raw: string, at: number): void {
    if (!acceptsEventFrom(this.session, sessionId)) {
      this.rejectedFrames.push(raw);
      return;
    }
    const parsed = parseServerMessage(raw);
    if (!parsed.ok) {
      this.rejectedFrames.push(raw);
      return;
    }
    const message = parsed.message;

    if (message.type === 'balance_update' && 'balance' in message) {
      this.meter = applyBalanceUpdate(this.meter, message.balance, at);
    }
    if (message.type === 'language_detected' && 'lang' in message) {
      this.languageMode = applyDetection(
        this.languageMode,
        { lang: message.lang, confidence: message.confidence ?? 1, at },
        this.target,
      );
    }
    if (message.type === 'translated_audio' && 'seq' in message) {
      const result = this.queue.enqueue({
        seq: message.seq,
        pcm16_b64: message.pcm16_b64,
        sessionId,
      });
      this.played.push(...result.ready.map((f) => f.seq));
    }
    if (message.type === 'balance_exhausted') {
      this.session = transition(this.session, { type: 'CREDITS_EXHAUSTED' }).context;
    }
  }

  get gain(): number {
    return originalAudioGain({
      mode: this.languageMode.mode,
      preferredGain: 0,
      translatedAudioActive: false,
      translatedAudioDegraded: false,
    });
  }
}

const frame = (o: Record<string, unknown>) => JSON.stringify(o);

describe('session flow', () => {
  it('accumulates usage from authoritative balance updates', () => {
    const h = new Harness('s1', 'it', 5.0);
    h.receive('s1', frame({ type: 'balance_update', balance: 4.9 }), 1_000);
    h.receive('s1', frame({ type: 'balance_update', balance: 4.8 }), 2_000);

    const usage = snapshot(h.meter);
    expect(usage.remaining).toBeCloseTo(4.8);
    expect(usage.sessionSpent).toBeCloseTo(0.2);
  });

  it('ignores every frame from a previous session', () => {
    const h = new Harness('s2', 'it', 5.0);
    h.receive('s1', frame({ type: 'balance_update', balance: 0.01 }), 1_000);
    h.receive(
      's1',
      frame({ type: 'translated_audio', speaker_id: 't', lang: 'it', seq: 0, pcm16_b64: 'A' }),
      1_100,
    );

    // Neither the meter nor the audio queue moved.
    expect(snapshot(h.meter).remaining).toBeCloseTo(5.0);
    expect(h.played).toEqual([]);
    expect(h.rejectedFrames).toHaveLength(2);
  });

  it('restores original audio when the source language matches the target', () => {
    const h = new Harness('s1', 'it', 5.0);
    expect(h.gain).toBe(0); // user muted the original while translating

    for (let i = 0; i < 3; i++) {
      h.receive(
        's1',
        frame({ type: 'language_detected', peer_id: 't', lang: 'it', confidence: 0.95 }),
        i * 2_000,
      );
    }

    expect(h.languageMode.mode).toBe('bypassed');
    // The 0 % preference is overridden — the user must not be left in silence.
    expect(h.gain).toBe(1);
  });

  it('resumes translation when the spoken language changes back', () => {
    const h = new Harness('s1', 'it', 5.0);
    for (let i = 0; i < 3; i++) {
      h.receive(
        's1',
        frame({ type: 'language_detected', peer_id: 't', lang: 'it', confidence: 0.95 }),
        i * 2_000,
      );
    }
    expect(h.languageMode.mode).toBe('bypassed');

    h.receive(
      's1',
      frame({ type: 'language_detected', peer_id: 't', lang: 'en', confidence: 0.93 }),
      10_000,
    );
    expect(h.languageMode.mode).toBe('translating');
    expect(h.gain).toBe(0);
  });

  it('plays translated audio in order across an out-of-order burst', () => {
    const h = new Harness('s1', 'it', 5.0);
    const audio = (seq: number) =>
      frame({ type: 'translated_audio', speaker_id: 't', lang: 'it', seq, pcm16_b64: `p${seq}` });

    h.receive('s1', audio(0), 0);
    h.receive('s1', audio(2), 10);
    h.receive('s1', audio(1), 20);
    h.receive('s1', audio(3), 30);

    expect(h.played).toEqual([0, 1, 2, 3]);
  });

  it('tears the session down when credits are exhausted', () => {
    const h = new Harness('s1', 'it', 0.02);
    h.receive('s1', frame({ type: 'balance_update', balance: 0.0 }), 1_000);
    h.receive('s1', frame({ type: 'balance_exhausted' }), 1_100);

    expect(h.session.state).toBe('stopping');
    const done = transition(h.session, { type: 'TEARDOWN_COMPLETE' });
    expect(done.context.state).toBe('stopped');
    expect(done.context.sessionId).toBeNull();
  });

  it('rejects a malformed frame without disturbing session state', () => {
    const h = new Harness('s1', 'it', 5.0);
    h.receive('s1', '{ not json', 100);
    h.receive('s1', frame({ type: 'balance_update', balance: 'lots' }), 200);

    expect(h.rejectedFrames).toHaveLength(2);
    expect(h.session.state).toBe('streaming');
    expect(snapshot(h.meter).remaining).toBeCloseTo(5.0);
  });
});

describe('disconnect and reconnect', () => {
  it('retries a transport fault and stops after the budget', () => {
    let elapsed = 0;
    let attempt = 0;
    const attempts: number[] = [];

    for (;;) {
      const decision = nextBackoff(attempt, elapsed, DEFAULT_BACKOFF, () => 1);
      if (!decision.retry) {
        expect(decision.reason).toBe('attempts-exhausted');
        break;
      }
      attempts.push(decision.delayMs);
      elapsed += decision.delayMs;
      attempt = decision.attempt;
    }

    expect(attempts).toHaveLength(DEFAULT_BACKOFF.maxAttempts);
    // Bounded, not infinite — the user gets an error rather than a silent forever-spin.
    expect(attempts.every((d) => d <= DEFAULT_BACKOFF.maxDelayMs)).toBe(true);
  });

  it('never retries an auth failure, so a dead token cannot loop', () => {
    expect(isFatalCloseCode(1006, 'invalid_token')).toBe(true);

    const ctx = initialContext(true);
    const started = transition(ctx, { type: 'START_REQUESTED' }, 's1').context;
    const captured = transition(started, { type: 'CAPTURE_GRANTED' }).context;
    const closed = transition(captured, { type: 'SOCKET_CLOSED', recoverable: false });

    expect(closed.context.state).toBe('error');
    expect(closed.context.sessionId).toBeNull();
  });

  it('returns to streaming after a successful reconnect', () => {
    const h = new Harness('s1', 'it', 5.0);
    h.session = transition(h.session, { type: 'SOCKET_CLOSED', recoverable: true }).context;
    expect(h.session.state).toBe('reconnecting');

    h.session = transition(h.session, { type: 'RECONNECT_SUCCEEDED' }).context;
    expect(h.session.state).toBe('streaming');
    // The session id survived, so post-reconnect frames are still accepted.
    expect(acceptsEventFrom(h.session, 's1')).toBe(true);
  });
});

/**
 * Subtitle language selection.
 *
 * Mirrors what the background does per frame. The bug these guard: partials arrive
 * UNTRANSLATED (the server sends the raw transcript in the source language), and
 * rendering them on the main line produced subtitles that flickered between the source
 * and target languages.
 */
interface Rendered {
  main?: string | null;
  secondary?: string | null;
}

function renderFrame(
  raw: string,
  target: string,
  opts: { dual: boolean; bypassed: boolean; tierSpeaks?: boolean },
): Rendered | null {
  const parsed = parseServerMessage(raw);
  if (!parsed.ok) return null;
  const m = parsed.message;

  if (m.type === 'subtitle_interim' && 'text' in m) {
    // Speech-to-speech engines send an already-translated partial (labelled with the
    // source language, and delivered only to listeners of the target); Standard sends
    // the raw transcript to everyone.
    if (opts.tierSpeaks) return { main: m.text };
    return opts.dual ? { secondary: m.text } : null;
  }
  if (m.type === 'subtitle_final' && 'original' in m) {
    const translated = m.translations[target] ?? null;
    if (translated) {
      return { main: translated, secondary: opts.dual ? m.original : null };
    }
    return opts.bypassed
      ? { main: m.original, secondary: null }
      : { main: null, secondary: m.original };
  }
  return null;
}

const interim = (text: string, lang: string) =>
  JSON.stringify({ type: 'subtitle_interim', speaker_id: 't', text, lang });
const final = (original: string, lang: string, translations: Record<string, string>) =>
  JSON.stringify({ type: 'subtitle_final', speaker_id: 't', original, lang, translations });

describe('subtitle language', () => {
  it('never puts an untranslated partial on the main line', () => {
    // This is the reported "mix of Italian and Spanish": every Spanish partial flashed
    // on the main line before the Italian final replaced it.
    const out = renderFrame(interim('hola que tal', 'es'), 'it', { dual: false, bypassed: false });
    expect(out).toBeNull();
  });

  it('shows a partial as the ORIGINAL line when dual language is on', () => {
    const out = renderFrame(interim('hola que tal', 'es'), 'it', { dual: true, bypassed: false });
    expect(out).toEqual({ secondary: 'hola que tal' });
    expect(out).not.toHaveProperty('main');
  });

  it('renders the target translation on the main line', () => {
    const out = renderFrame(final('hola mundo', 'es', { it: 'ciao mondo' }), 'it', {
      dual: false,
      bypassed: false,
    });
    expect(out).toEqual({ main: 'ciao mondo', secondary: null });
  });

  it('keeps the original off the main line when the translation is missing', () => {
    // Happens right after a language change, before the server retargets. Showing the
    // source text as if it were the translation is the mix all over again.
    const out = renderFrame(final('hola mundo', 'es', { en: 'hello world' }), 'it', {
      dual: false,
      bypassed: false,
    });
    expect(out).toEqual({ main: null, secondary: 'hola mundo' });
  });

  it('shows the text plainly in bypass, where no translation is expected', () => {
    const out = renderFrame(final('ciao mondo', 'it', {}), 'it', { dual: false, bypassed: true });
    expect(out).toEqual({ main: 'ciao mondo', secondary: null });
  });

  it('shows both lines when dual language is on', () => {
    const out = renderFrame(final('hola mundo', 'es', { it: 'ciao mondo' }), 'it', {
      dual: true,
      bypassed: false,
    });
    expect(out).toEqual({ main: 'ciao mondo', secondary: 'hola mundo' });
  });
});

describe('partials depend on the engine, not the frame', () => {
  it('puts a speech-tier partial on the MAIN line — it is already translated', () => {
    // Discarding these is why most of the text never appeared on Pro and Premium: the
    // live caption IS the translation there, and only the sparse finals were rendered.
    const out = renderFrame(interim('ciao mondo', 'es'), 'it', {
      dual: false,
      bypassed: false,
      tierSpeaks: true,
    });
    expect(out).toEqual({ main: 'ciao mondo' });
  });

  it('still keeps a Standard partial off the main line', () => {
    const out = renderFrame(interim('hola mundo', 'es'), 'it', {
      dual: false,
      bypassed: false,
      tierSpeaks: false,
    });
    expect(out).toBeNull();
  });

  it('does not put a speech-tier partial on the original line in dual mode', () => {
    // It is the translation, so labelling it "original" would be a lie.
    const out = renderFrame(interim('ciao mondo', 'es'), 'it', {
      dual: true,
      bypassed: false,
      tierSpeaks: true,
    });
    expect(out).toEqual({ main: 'ciao mondo' });
  });
});
