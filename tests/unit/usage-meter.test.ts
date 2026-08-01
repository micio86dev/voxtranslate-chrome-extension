import { describe, expect, it } from 'vitest';
import {
  applyBalanceUpdate,
  beginSession,
  estimateRemainingMinutes,
  formatDuration,
  formatUsd,
  initialMeter,
  resetCounter,
  snapshot,
} from '@/usage/meter';

describe('usage meter', () => {
  it('derives session spend from authoritative balances, not a local rate', () => {
    let m = beginSession(initialMeter(), 5.0, 0);
    m = applyBalanceUpdate(m, 4.75, 5_000);
    m = applyBalanceUpdate(m, 4.5, 10_000);

    const s = snapshot(m);
    expect(s.remaining).toBeCloseTo(4.5);
    expect(s.sessionSpent).toBeCloseTo(0.5);
    expect(s.sessionSeconds).toBe(10);
  });

  it('tracks "since reset" separately from the session', () => {
    let m = beginSession(initialMeter(10.0), 10.0, 0);
    m = applyBalanceUpdate(m, 9.0, 1_000);

    // Reset moves only the baseline; the account balance is untouched.
    m = resetCounter(m);
    expect(snapshot(m).sinceReset).toBe(0);
    expect(snapshot(m).remaining).toBeCloseTo(9.0);

    m = applyBalanceUpdate(m, 8.5, 2_000);
    const s = snapshot(m);
    expect(s.sinceReset).toBeCloseTo(0.5);
    // The session total still counts from the session's own opening balance.
    expect(s.sessionSpent).toBeCloseTo(1.5);
  });

  it('reset never changes the remaining balance', () => {
    let m = beginSession(initialMeter(), 3.0, 0);
    m = applyBalanceUpdate(m, 2.0, 1_000);
    const before = snapshot(m).remaining;
    m = resetCounter(m);
    expect(snapshot(m).remaining).toBe(before);
  });

  it('never reports negative spend if the balance goes up mid-session', () => {
    // A top-up during a session is legitimate; it must not render as negative usage.
    let m = beginSession(initialMeter(), 1.0, 0);
    m = applyBalanceUpdate(m, 11.0, 1_000);
    expect(snapshot(m).sessionSpent).toBe(0);
    expect(snapshot(m).sinceReset).toBe(0);
  });

  it('survives a balance update that arrives before the session opens', () => {
    // Reconnect racing the account fetch — must not produce a nonsense opening balance.
    const m = applyBalanceUpdate(initialMeter(), 7.5, 1_000);
    const s = snapshot(m);
    expect(s.remaining).toBeCloseTo(7.5);
    expect(s.sessionSpent).toBe(0);
  });

  it('reports zeroes before any balance is known', () => {
    const s = snapshot(initialMeter());
    expect(s).toMatchObject({ remaining: 0, sessionSpent: 0, sinceReset: 0, sessionSeconds: 0 });
  });
});

describe('formatting', () => {
  it('shows sub-cent spend with extra precision instead of $0.00', () => {
    // A short Standard session genuinely costs less than a cent; rounding it to zero
    // would read as a bug to the user.
    expect(formatUsd(0.0042)).toBe('$0.0042');
    expect(formatUsd(2.5)).toBe('$2.50');
    expect(formatUsd(0)).toBe('$0.00');
  });

  it('formats durations with and without hours', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(3_725)).toBe('1:02:05');
  });
});

describe('remaining-time estimate', () => {
  it('estimates whole minutes at the tier rate', () => {
    expect(estimateRemainingMinutes(1.0, 0.01)).toBe(100);
    expect(estimateRemainingMinutes(0.005, 0.01)).toBe(0);
  });

  it('refuses to guess when the rate is unusable', () => {
    // Better no estimate than a wrong one.
    expect(estimateRemainingMinutes(1.0, 0)).toBeNull();
    expect(estimateRemainingMinutes(1.0, -1)).toBeNull();
    expect(estimateRemainingMinutes(-1, 0.01)).toBeNull();
    expect(estimateRemainingMinutes(1.0, Number.NaN)).toBeNull();
  });
});
