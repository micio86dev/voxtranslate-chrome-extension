/**
 * Structured errors.
 *
 * Two rules, both enforced by the shape of this module:
 *  1. The user never sees a stack trace, a provider name, or an internal URL.
 *  2. Nothing is caught silently — every failure gets a code, and the code is what the
 *     UI branches on and what diagnostics record.
 */

export type ErrorCode =
  | 'unsupported_chrome'
  | 'capture_denied'
  | 'capture_needs_gesture'
  | 'tab_unavailable'
  | 'tab_closed'
  | 'auth_expired'
  | 'auth_failed'
  | 'backend_unavailable'
  | 'socket_disconnected'
  | 'tier_unavailable'
  | 'unsupported_language'
  | 'provider_unavailable'
  | 'insufficient_balance'
  | 'update_required'
  | 'translated_audio_failed'
  | 'already_running'
  | 'unknown';

/** User-facing copy. Deliberately plain; no blame, no jargon, always a next step. */
const MESSAGES: Record<ErrorCode, string> = {
  unsupported_chrome: 'This version of Chrome is too old. Update Chrome and try again.',
  capture_denied: 'VoxTranslate needs permission to capture this tab’s audio.',
  capture_needs_gesture:
    'Click the VoxTranslate icon in the toolbar while on this tab, then press Start. ' +
    'Chrome only lets an extension capture a tab you opened it on.',
  tab_unavailable: 'This tab’s audio can’t be captured. Try a normal web page.',
  tab_closed: 'The tab being translated was closed.',
  auth_expired: 'Your session expired. Please sign in again.',
  auth_failed: 'Sign-in didn’t complete. Please try again.',
  backend_unavailable: 'VoxTranslate is unreachable right now. Try again shortly.',
  socket_disconnected: 'Connection lost. Reconnecting…',
  tier_unavailable: 'That translation tier isn’t available right now.',
  unsupported_language: 'That language isn’t supported by the selected tier.',
  provider_unavailable: 'The translation service is temporarily unavailable.',
  insufficient_balance: 'You’re out of credit. Add more to keep translating.',
  update_required: 'Please update the VoxTranslate extension to continue.',
  translated_audio_failed: 'Translated speech is unavailable — showing subtitles only.',
  already_running: 'A translation session is already running.',
  unknown: 'Something went wrong. Please try again.',
};

export class VoxError extends Error {
  constructor(
    readonly code: ErrorCode,
    /** Internal detail: logged, never rendered. */
    readonly detail?: string,
  ) {
    super(MESSAGES[code]);
    this.name = 'VoxError';
  }

  /** The safe, user-facing message. */
  get userMessage(): string {
    return MESSAGES[this.code];
  }
}

export function userMessageFor(code: ErrorCode | null | undefined): string {
  return MESSAGES[code ?? 'unknown'];
}

/** Map a server `error.code` onto ours, defaulting to `unknown` rather than guessing. */
export function fromServerCode(code: string | undefined): ErrorCode {
  switch (code) {
    case 'invalid_token':
      return 'auth_expired';
    case 'insufficient_balance':
      return 'insufficient_balance';
    case 'banned':
      return 'auth_failed';
    case 'unsupported_language':
      return 'unsupported_language';
    default:
      return 'unknown';
  }
}

/**
 * Redact anything that must never reach a log: tokens, audio, and full page URLs.
 * Used by the diagnostic logger, which is why it is deliberately aggressive.
 */
export function redact(value: string): string {
  return value
    .replace(/(token=)[^&\s]+/gi, '$1[redacted]')
    .replace(/(Bearer\s+)[\w.-]+/gi, '$1[redacted]')
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[jwt]');
}
