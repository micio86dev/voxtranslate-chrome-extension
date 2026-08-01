# ADR 0009 — A two-peer private room, not a new session type

**Status:** accepted · 2026-08-01

## Context

VoxTranslate's model is a room of **symmetric peers**. Each peer has exactly one `lang` —
the language it both speaks and receives in. Translation targets are derived from the
_other_ peers (`rooms::get_room_languages` excludes self), and `usage::billable_streams`
returns `None` when no target differs from the speaker.

Consequence: **a room with one peer transcribes nothing, translates nothing, and bills
nothing.**

A tab-audio session is asymmetric — one foreign audio SOURCE and one LISTENER — so it does
not fit. Three options were on the table:

1. A synthetic two-peer room built by the **client** (two WebSocket connections).
2. A new single-peer session type: source/target split, a new `MeterScope`, changes to
   `rooms.rs`, `usage.rs`, and the engine trait's assumptions.
3. A two-peer private room built by the **server**, inside one connection.

## Decision

Option 3. `server/src/extension.rs` adds `GET /ws/extension`; one connection joins a
`Private` room as two peers:

```
source peer    id "<sid>-src"   lang "auto"     owns the Deepgram session
listener peer  id "<sid>"       lang <target>   receives subtitles, is billed
```

## Rationale

The decisive property: **every behaviour we need already exists** and falls out for free.

- Fan-out sees exactly one target language and translates into it.
- The meter, scoped to the source peer, bills one stream per interval.
- When detection resolves the source language to the listener's, delivery is skipped
  **and** the meter skips the tick — the "already in your language" bypass, unbilled.
  That is not new code; it is `rooms.rs:145` and `usage.rs:69` doing what they always did.

So `rooms.rs`, `usage.rs` and every engine are untouched. The blast radius of a bug is one
new file and one new route — nothing that a live call or webinar goes through.

Option 1 was rejected because it doubles the connections, injects fake peers into the
metrics and lobby from an untrusted client, and makes the bypass path arrive via a
confusing route. Option 2 was rejected because it rewrites the billing and fan-out core to
express something the existing model can already say.

## Consequences

- The room counts two peers in `active_peers`. It is `Private`, so it is never listed or
  joinable, but operational gauges will read slightly high while extension sessions run.
- The source peer holds an outbound channel it never meaningfully uses; it is drained so a
  full channel cannot block a room broadcast.
- Client-direct engines (Cartesia "Enhanced") are forced back to the default — they never
  run on the server path and would otherwise produce silence.
- The listener's `set_lang` changes the _target_ mid-session; `auto` is rejected there,
  because an `auto` listener is skipped by fan-out and the session would go quiet.
- No migration. The PKCE handoff code is a signed, 60-second JWT rather than a stored row,
  so nothing was altered on a live billing database. A code cannot be revoked inside that
  minute — acceptable, since it is useless without the verifier.

## Bugs this design still let in (found on review, before deploy)

Reusing the room model made the _shape_ right, but three billing-adjacent mistakes still
had to be caught by reading the code again:

1. **The two joins were chained with `and_then`.** A failure on the second left the
   listener peer in the room with nothing driving or ending it. Practically unreachable —
   a new room holding one peer against a cap of four — but correctness should not depend
   on that staying true.
2. **A session could be restarted after credits were exhausted.** The meter task exits for
   good on exhaustion, and the loop went on accepting `start`, so a client that simply
   sent it again got a fully working, _unmetered_ session. The extension tears down on
   `balance_exhausted`, but the server must never depend on a well-behaved client for
   billing.
3. **The meter ran for the whole connection, not the streaming session.** It was spawned
   at connect, so it charged from the moment the side panel opened a socket — before Start
   and after Stop, until the tab closed. `billable_streams` only asks whether a target
   language differs from the source; it cannot tell whether audio is flowing. The room
   path had this right all along (`lib::spawn_meter` runs only once a session opens), and
   the fix was to match it.

The pattern in all three: _reusing a mechanism is not the same as reusing its lifecycle._
