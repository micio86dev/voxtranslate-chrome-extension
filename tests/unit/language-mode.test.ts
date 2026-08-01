import { describe, expect, it } from 'vitest';
import {
  applyDetection,
  initialLanguageMode,
  originalAudioGain,
  type LanguageModeState,
} from '@/audio/language-mode';

/** Feed a run of identical detections spaced `stepMs` apart. */
function feed(
  state: LanguageModeState,
  lang: string,
  target: string,
  count: number,
  opts: { confidence?: number; stepMs?: number; startAt?: number } = {},
): LanguageModeState {
  const { confidence = 0.95, stepMs = 2_000, startAt = 0 } = opts;
  let current = state;
  for (let i = 0; i < count; i++) {
    current = applyDetection(current, { lang, confidence, at: startAt + i * stepMs }, target);
  }
  return current;
}

describe('detected-language stability', () => {
  it('starts in translating mode', () => {
    expect(initialLanguageMode().mode).toBe('translating');
  });

  it('does not bypass on a single matching detection', () => {
    const after = applyDetection(
      initialLanguageMode(),
      { lang: 'it', confidence: 0.99, at: 0 },
      'it',
    );
    expect(after.mode).toBe('translating');
    expect(after.pending).toBe('bypassed');
  });

  it('bypasses only after a sustained agreeing streak', () => {
    // 3 detections spread over 4 s meets both the streak and the duration floor.
    const after = feed(initialLanguageMode(), 'it', 'it', 3, { stepMs: 2_000 });
    expect(after.mode).toBe('bypassed');
  });

  it('refuses to bypass when the streak is too fast, even if long enough', () => {
    // 3 detections inside 200 ms: enough events, not enough elapsed time.
    const after = feed(initialLanguageMode(), 'it', 'it', 3, { stepMs: 100 });
    expect(after.mode).toBe('translating');
  });

  it('ignores low-confidence detections without breaking an in-progress streak', () => {
    let state = feed(initialLanguageMode(), 'it', 'it', 2, { stepMs: 2_000 });
    expect(state.streak).toBe(2);

    // A noisy low-confidence foreign word must not reset the streak.
    state = applyDetection(state, { lang: 'en', confidence: 0.2, at: 4_500 }, 'it');
    expect(state.streak).toBe(2);
    expect(state.pending).toBe('bypassed');

    state = applyDetection(state, { lang: 'it', confidence: 0.95, at: 5_000 }, 'it');
    expect(state.mode).toBe('bypassed');
  });

  it('leaves bypass immediately when the language changes back', () => {
    const bypassed = feed(initialLanguageMode(), 'it', 'it', 3, { stepMs: 2_000 });
    expect(bypassed.mode).toBe('bypassed');

    // Asymmetric on purpose: one confident foreign detection resumes translation.
    const resumed = applyDetection(bypassed, { lang: 'en', confidence: 0.9, at: 10_000 }, 'it');
    expect(resumed.mode).toBe('translating');
  });

  it('treats a manual detection with no confidence as fully confident', () => {
    const after = feed(initialLanguageMode(), 'it', 'it', 3, {
      stepMs: 2_000,
      confidence: undefined as unknown as number,
    });
    expect(after.mode).toBe('bypassed');
  });

  it('clears a pending streak when detections agree with the current mode again', () => {
    let state = feed(initialLanguageMode(), 'it', 'it', 2, { stepMs: 2_000 });
    expect(state.pending).toBe('bypassed');

    state = applyDetection(state, { lang: 'en', confidence: 0.95, at: 5_000 }, 'it');
    expect(state.pending).toBeNull();
    expect(state.streak).toBe(0);
    expect(state.mode).toBe('translating');
  });
});

describe('original audio gain', () => {
  it('forces the original audible in bypass even when the user muted it', () => {
    // This is the rule that stops the user hearing silence when nothing is translated.
    const gain = originalAudioGain({
      mode: 'bypassed',
      preferredGain: 0,
      translatedAudioActive: false,
      translatedAudioDegraded: false,
    });
    expect(gain).toBe(1);
  });

  it('honours the user preference while translating', () => {
    const gain = originalAudioGain({
      mode: 'translating',
      preferredGain: 0.2,
      translatedAudioActive: true,
      translatedAudioDegraded: false,
    });
    expect(gain).toBeCloseTo(0.2);
  });

  it('raises the original when translated audio is degraded', () => {
    const gain = originalAudioGain({
      mode: 'translating',
      preferredGain: 0,
      translatedAudioActive: false,
      translatedAudioDegraded: true,
    });
    expect(gain).toBeGreaterThanOrEqual(0.8);
  });

  it('clamps out-of-range preferences', () => {
    const high = originalAudioGain({
      mode: 'translating',
      preferredGain: 5,
      translatedAudioActive: false,
      translatedAudioDegraded: false,
    });
    const low = originalAudioGain({
      mode: 'translating',
      preferredGain: -3,
      translatedAudioActive: false,
      translatedAudioDegraded: false,
    });
    expect(high).toBe(1);
    expect(low).toBe(0);
  });
});
