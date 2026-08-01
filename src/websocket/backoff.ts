/**
 * Bounded reconnect backoff.
 *
 * Deliberately bounded, not infinite: a silently reconnecting extension is one that
 * keeps a tab captured and a user confused about why nothing is happening. When the
 * budget is spent we surface an error and release the pipeline.
 *
 * Jitter is full-jitter (random in `[0, capped]`) rather than a fixed ±10 % band,
 * because the failure mode we care about is many clients reconnecting after a backend
 * restart, and full jitter spreads that herd best.
 */

export interface BackoffConfig {
  baseMs: number;
  maxDelayMs: number;
  /** Give up after this many attempts. */
  maxAttempts: number;
  /** Or after this much total elapsed time, whichever comes first. */
  maxTotalMs: number;
}

export const DEFAULT_BACKOFF: BackoffConfig = {
  baseMs: 500,
  maxDelayMs: 15_000,
  maxAttempts: 8,
  maxTotalMs: 90_000,
};

export type BackoffDecision =
  | { retry: true; delayMs: number; attempt: number }
  | { retry: false; reason: 'attempts-exhausted' | 'time-exhausted' };

/**
 * Decide whether to retry, and after how long.
 *
 * `random` is injected so tests are deterministic — a backoff you cannot test is a
 * backoff you find out about during an incident.
 */
export function nextBackoff(
  attempt: number,
  elapsedMs: number,
  config: BackoffConfig = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): BackoffDecision {
  if (attempt >= config.maxAttempts) return { retry: false, reason: 'attempts-exhausted' };
  if (elapsedMs >= config.maxTotalMs) return { retry: false, reason: 'time-exhausted' };

  const exponential = config.baseMs * 2 ** attempt;
  const capped = Math.min(exponential, config.maxDelayMs);
  const delayMs = Math.round(random() * capped);

  return { retry: true, delayMs, attempt: attempt + 1 };
}

/**
 * Errors that must NOT be retried. Reconnecting after any of these either cannot
 * succeed or actively harms the user (double billing, a zombie session).
 */
export function isFatalCloseCode(code: number, serverErrorCode?: string): boolean {
  if (serverErrorCode) {
    return ['invalid_token', 'banned', 'insufficient_balance', 'unsupported_language'].includes(
      serverErrorCode,
    );
  }
  // 1000 normal, 1001 going away — both are deliberate closes, not transport faults.
  return code === 1000 || code === 1001 || code === 1008 || code === 4401 || code === 4403;
}
