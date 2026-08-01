import { describe, expect, it } from 'vitest';
import { DEFAULT_BACKOFF, isFatalCloseCode, nextBackoff } from '@/websocket/backoff';

describe('reconnect backoff', () => {
  it('grows exponentially before the cap (max jitter)', () => {
    const max = () => 1;
    expect(nextBackoff(0, 0, DEFAULT_BACKOFF, max)).toMatchObject({ retry: true, delayMs: 500 });
    expect(nextBackoff(1, 0, DEFAULT_BACKOFF, max)).toMatchObject({ delayMs: 1_000 });
    expect(nextBackoff(2, 0, DEFAULT_BACKOFF, max)).toMatchObject({ delayMs: 2_000 });
    expect(nextBackoff(3, 0, DEFAULT_BACKOFF, max)).toMatchObject({ delayMs: 4_000 });
  });

  it('caps the delay', () => {
    const capped = nextBackoff(20, 0, { ...DEFAULT_BACKOFF, maxAttempts: 100 }, () => 1);
    expect(capped).toMatchObject({ retry: true, delayMs: DEFAULT_BACKOFF.maxDelayMs });
  });

  it('applies full jitter so a fleet does not reconnect in lockstep', () => {
    const zero = nextBackoff(3, 0, DEFAULT_BACKOFF, () => 0);
    const half = nextBackoff(3, 0, DEFAULT_BACKOFF, () => 0.5);
    expect(zero).toMatchObject({ delayMs: 0 });
    expect(half).toMatchObject({ delayMs: 2_000 });
  });

  it('gives up after the attempt budget', () => {
    const decision = nextBackoff(DEFAULT_BACKOFF.maxAttempts, 0, DEFAULT_BACKOFF, () => 0.5);
    expect(decision).toEqual({ retry: false, reason: 'attempts-exhausted' });
  });

  it('gives up after the time budget even with attempts left', () => {
    const decision = nextBackoff(1, DEFAULT_BACKOFF.maxTotalMs + 1, DEFAULT_BACKOFF, () => 0.5);
    expect(decision).toEqual({ retry: false, reason: 'time-exhausted' });
  });

  it('reports the next attempt number so the caller can count', () => {
    const first = nextBackoff(0, 0, DEFAULT_BACKOFF, () => 0.5);
    expect(first).toMatchObject({ retry: true, attempt: 1 });
  });
});

describe('fatal close classification', () => {
  it('never retries an auth or billing failure', () => {
    // Retrying these either cannot succeed or risks a duplicate billed session.
    expect(isFatalCloseCode(1006, 'invalid_token')).toBe(true);
    expect(isFatalCloseCode(1006, 'insufficient_balance')).toBe(true);
    expect(isFatalCloseCode(1006, 'banned')).toBe(true);
    expect(isFatalCloseCode(1006, 'unsupported_language')).toBe(true);
  });

  it('treats deliberate closes as fatal', () => {
    expect(isFatalCloseCode(1000)).toBe(true);
    expect(isFatalCloseCode(1001)).toBe(true);
    expect(isFatalCloseCode(1008)).toBe(true);
  });

  it('treats transport faults as retryable', () => {
    expect(isFatalCloseCode(1006)).toBe(false);
    expect(isFatalCloseCode(1011)).toBe(false);
    expect(isFatalCloseCode(1012)).toBe(false);
  });

  it('lets an unknown server code fall through as non-fatal', () => {
    expect(isFatalCloseCode(1006, 'transient_provider_error')).toBe(false);
  });
});
