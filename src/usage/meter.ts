/**
 * Usage accounting for the side panel.
 *
 * The backend is authoritative for money. It owns the ledger (`users.balance`, a USD
 * `Decimal`) and pushes `balance_update` after each charge. This module never *computes*
 * a charge — it derives display values from the authoritative balances the server sends.
 *
 * Session spend is therefore `openingBalance − currentBalance`, not a client-side
 * rate × time product. If the two ever disagreed, the server would be right, so we
 * simply never produce a second opinion.
 *
 * NOTE ON UNITS: VoxTranslate consumer accounts hold **US dollars**, not credits. The
 * integer "credits" in the codebase belong to the separate B2B organisation pool
 * (`server/src/business/credits.rs`), which must never be mixed with consumer money.
 */

export interface UsageSnapshot {
  /** Authoritative remaining balance, USD. */
  remaining: number;
  /** Spent during the current session, USD. */
  sessionSpent: number;
  /** Seconds of audio streamed in the current session. */
  sessionSeconds: number;
  /** Spent since the user's reset baseline, USD. */
  sinceReset: number;
}

export interface MeterState {
  openingBalance: number | null;
  currentBalance: number | null;
  /** Balance recorded when the user last reset the counter. */
  resetBaselineBalance: number | null;
  startedAt: number | null;
  lastTickAt: number | null;
  sessionSeconds: number;
}

export function initialMeter(resetBaselineBalance: number | null = null): MeterState {
  return {
    openingBalance: null,
    currentBalance: null,
    resetBaselineBalance,
    startedAt: null,
    lastTickAt: null,
    sessionSeconds: 0,
  };
}

/** Called when a session starts, with the balance known at that moment. */
export function beginSession(state: MeterState, balance: number, at: number): MeterState {
  return {
    ...state,
    openingBalance: balance,
    currentBalance: balance,
    // First session ever: the reset baseline starts where the user starts, so
    // "since reset" is never a nonsense number on day one.
    resetBaselineBalance: state.resetBaselineBalance ?? balance,
    startedAt: at,
    lastTickAt: at,
    sessionSeconds: 0,
  };
}

/** Fold an authoritative `balance_update` from the server. */
export function applyBalanceUpdate(state: MeterState, balance: number, at: number): MeterState {
  const elapsed = state.lastTickAt === null ? 0 : Math.max(0, (at - state.lastTickAt) / 1000);
  return {
    ...state,
    // A session that receives an update before `beginSession` (e.g. a reconnect
    // races the account fetch) still gets a sane opening point.
    openingBalance: state.openingBalance ?? balance,
    resetBaselineBalance: state.resetBaselineBalance ?? balance,
    currentBalance: balance,
    lastTickAt: at,
    sessionSeconds: state.sessionSeconds + elapsed,
  };
}

/**
 * Reset the displayed counter.
 *
 * This ONLY moves the baseline the "since reset" figure is measured from. It refunds
 * nothing, deletes no history, and touches no invoice — the backend ledger is untouched.
 */
export function resetCounter(state: MeterState): MeterState {
  return { ...state, resetBaselineBalance: state.currentBalance ?? state.openingBalance };
}

export function snapshot(state: MeterState): UsageSnapshot {
  const remaining = state.currentBalance ?? 0;
  const sessionSpent =
    state.openingBalance === null || state.currentBalance === null
      ? 0
      : Math.max(0, state.openingBalance - state.currentBalance);
  const sinceReset =
    state.resetBaselineBalance === null || state.currentBalance === null
      ? 0
      : Math.max(0, state.resetBaselineBalance - state.currentBalance);

  return {
    remaining,
    sessionSpent,
    sessionSeconds: Math.round(state.sessionSeconds),
    sinceReset,
  };
}

/** Money formatting. USD because that is the only currency the consumer ledger has. */
export function formatUsd(amount: number, locale = 'en-US'): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    // Sub-cent amounts are real here (a 30 s Standard session costs well under $0.01),
    // so showing "$0.00" for actual spend would read as a bug.
    maximumFractionDigits: amount > 0 && amount < 0.01 ? 4 : 2,
  }).format(amount);
}

export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/**
 * Remaining minutes at a tier's advertised rate, or null when it cannot be estimated
 * honestly. We refuse to guess: a wrong "you have 12 minutes left" is worse than no
 * estimate, and `rate_per_minute` is the only rate the server exposes.
 */
export function estimateRemainingMinutes(
  remainingUsd: number,
  ratePerMinute: number,
): number | null {
  if (!Number.isFinite(ratePerMinute) || ratePerMinute <= 0) return null;
  if (!Number.isFinite(remainingUsd) || remainingUsd < 0) return null;
  return Math.floor(remainingUsd / ratePerMinute);
}
