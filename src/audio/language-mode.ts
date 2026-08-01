/**
 * Detected-language stability, and the audio-mode decision that follows from it.
 *
 * The backend already stops translating AND stops billing when the spoken language
 * equals the listener's language (`server/src/usage.rs` billable_streams → None,
 * `rooms.rs` skips same-language delivery). So this module does not decide billing —
 * it decides what the *user hears*, and it exists to stop the UI flapping.
 *
 * Why hysteresis is asymmetric: entering bypass on a bad detection is much worse than
 * leaving it on a bad detection. A wrong bypass leaves the user staring at content they
 * cannot understand; a wrong translate costs a fraction of a cent. So entering bypass
 * demands sustained agreement, and leaving it is fast.
 */

export type AudioMode =
  /** Spoken language differs from the target: translate, duck the original. */
  | 'translating'
  /** Spoken language already matches the target: no translation, original audible. */
  | 'bypassed';

export interface StabilityConfig {
  /** Minimum per-event confidence to count toward a mode change. */
  minConfidence: number;
  /** Consecutive agreeing detections required to ENTER bypass. */
  enterBypassStreak: number;
  /** Minimum elapsed time (ms) across that streak, so a burst can't trigger it. */
  enterBypassMinDurationMs: number;
  /** Consecutive agreeing detections required to LEAVE bypass. */
  leaveBypassStreak: number;
}

export const DEFAULT_STABILITY: StabilityConfig = {
  minConfidence: 0.85,
  enterBypassStreak: 3,
  enterBypassMinDurationMs: 4_000,
  leaveBypassStreak: 1,
};

export interface DetectionEvent {
  lang: string;
  /** Absent on a manual override; treated as fully confident. */
  confidence?: number;
  /** Monotonic timestamp in ms. Injected so tests need no clock. */
  at: number;
}

export interface LanguageModeState {
  mode: AudioMode;
  /** The language currently believed to be spoken, or null before first detection. */
  detected: string | null;
  /** Consecutive detections agreeing with the pending change. */
  streak: number;
  /** Timestamp of the first detection in the current streak. */
  streakStartedAt: number | null;
  /** What the streak is building toward, or null when it agrees with `mode`. */
  pending: AudioMode | null;
}

export function initialLanguageMode(): LanguageModeState {
  return { mode: 'translating', detected: null, streak: 0, streakStartedAt: null, pending: null };
}

/**
 * Fold one detection event into the mode state.
 *
 * `targetLanguage` is the language the user wants to understand. Low-confidence events
 * do not reset an in-progress streak — they are simply not evidence either way, which
 * keeps a single noisy frame from undoing four seconds of agreement.
 */
export function applyDetection(
  state: LanguageModeState,
  event: DetectionEvent,
  targetLanguage: string,
  config: StabilityConfig = DEFAULT_STABILITY,
): LanguageModeState {
  const confidence = event.confidence ?? 1;
  if (confidence < config.minConfidence) return state;

  const matchesTarget = event.lang === targetLanguage;
  const wanted: AudioMode = matchesTarget ? 'bypassed' : 'translating';
  const detected = event.lang;

  // Already in the wanted mode: clear any pending streak toward the other one.
  if (wanted === state.mode) {
    return { ...state, detected, streak: 0, streakStartedAt: null, pending: null };
  }

  // Continue or start a streak toward `wanted`.
  const continuing = state.pending === wanted;
  const streak = continuing ? state.streak + 1 : 1;
  const streakStartedAt = continuing ? (state.streakStartedAt ?? event.at) : event.at;

  const requiredStreak =
    wanted === 'bypassed' ? config.enterBypassStreak : config.leaveBypassStreak;
  const requiredDuration = wanted === 'bypassed' ? config.enterBypassMinDurationMs : 0;
  const elapsed = event.at - streakStartedAt;

  if (streak >= requiredStreak && elapsed >= requiredDuration) {
    return { mode: wanted, detected, streak: 0, streakStartedAt: null, pending: null };
  }

  return { mode: state.mode, detected, streak, streakStartedAt, pending: wanted };
}

/**
 * The gain to apply to the tab's ORIGINAL audio, 0..1.
 *
 * The important rule: in bypass the original becomes audible **even if the user set the
 * slider to 0 %**. Silence is never a correct output — a user who muted the original did
 * so to hear the translation, and in bypass there is no translation to hear.
 */
export function originalAudioGain(input: {
  mode: AudioMode;
  /** User's 0..1 preference for original-audio volume while translating. */
  preferredGain: number;
  /** True when translated speech is currently playing (duck under it). */
  translatedAudioActive: boolean;
  /** True when translated audio was requested but is failing/unavailable. */
  translatedAudioDegraded: boolean;
}): number {
  const preferred = Math.min(1, Math.max(0, input.preferredGain));

  // Nothing to translate → the user must hear the source, whatever the slider says.
  if (input.mode === 'bypassed') return Math.max(preferred, 1);

  // Translation is supposed to be audible but isn't — restore the original rather than
  // leaving the user in silence.
  if (input.translatedAudioDegraded) return Math.max(preferred, 0.8);

  // Normal translating state: honour the user's preference, ducking under active speech.
  return input.translatedAudioActive ? preferred : Math.max(preferred, preferred);
}
