# ADR 0007 — The backend is the only source of truth for money

**Status:** accepted · 2026-08-01

## Context

The UI must show session spend, spend since a reset baseline, and remaining balance. It
could compute these from a local rate × elapsed time, or derive them from server-pushed
balances.

Discovery (`docs/discovery.md` §3) also found that the brief's commercial model does not
exist: consumer accounts hold a **USD `Decimal` balance**, not credits. There is no consumer
plan, no `allowed_tiers`, no currency field. Integer credits belong to the separate B2B
organisation pool, whose own module comment says the two "never mix".

## Decision

1. Never compute a charge client-side. Session spend is `openingBalance − currentBalance`,
   derived entirely from authoritative `balance_update` frames.
2. Display **US dollars**, because that is what the ledger holds. Do not invent credits,
   EUR, plans, or per-plan tier gating.
3. Offer every tier the backend offers, because the backend gates none of them for consumers.
4. "Reset usage counter" moves only a display baseline — no refund, no ledger write, no
   history change — and the confirmation dialog says exactly that.

## Rationale

If the client computed a second opinion on cost, the two would eventually disagree, and the
user would be right to trust neither. Deriving from the authoritative balance makes
disagreement structurally impossible.

Inventing a credits/EUR/plans layer would mean a second commercial model living in a
browser extension — precisely what the brief itself forbids ("never create a second
independent credit ledger", "do not hard-code commercial rules that already exist").

## Consequences

- Sub-cent amounts are formatted with extra precision, because a 30-second Standard session
  genuinely costs less than a cent and rendering `$0.00` for real spend reads as a bug.
- The "remaining minutes" estimate returns **null** rather than guessing when the rate is
  unusable. A wrong estimate is worse than none.
- The reset baseline is currently device-local; syncing it needs a column and a migration,
  which is deferred and documented.
- If VoxTranslate later introduces consumer plans or credits, the extension picks them up
  from `/api/engines` and `/api/user/me` with no commercial logic to rewrite.
