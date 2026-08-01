# ADR 0008 — Reconnect the transport only, and reuse the web client's worklets

**Status:** accepted · 2026-08-01

## Context

Three pieces landed together: bounded reconnection, runtime encoder switching for
`capture_format`, and translated-speech playback. Each had an obvious naive shape that
would have been wrong.

## Decisions

### Reconnection reopens the socket, never the capture

A `tabCapture` stream id cannot be re-minted without another user gesture (`activeTab`).
So a reconnect that tore down capture would end the session permanently — the user would
have to click Start again because of a two-second network blip. The pipeline therefore
keeps the stream, the audio graph and the encoder alive and swaps only the WebSocket.

The old socket's `close` event is suppressed once it is no longer the current socket:
otherwise a deliberate close during reconnect looks like a fresh failure and triggers a
second reconnect.

Backoff is bounded by attempts AND elapsed time. Auth, billing and deliberate closes are
never retried — retrying a billing failure risks a duplicate charged session.

### The encoder is swappable; the passthrough graph is not

`capture_format { pcm: true }` switches to PCM16/24k through a separate 24 kHz
AudioContext. Pinning the _passthrough_ context to 24 kHz would have been simpler, but it
would downgrade the audio the user actually hears for the sake of an encoder requirement.
So: two contexts — one at the device rate for what reaches the speakers, one at 24 kHz for
what reaches the wire.

A failed PCM switch restarts Opus rather than leaving the session silently mute.

### Worklets are copied from the web client, not rewritten

`pcm-capture-worklet.js` and `pcm-playback-worklet.js` are taken verbatim from
`client/public/`. Two implementations of the same Float32 ↔ Int16 conversion would drift,
and the drift would surface as noise in one client only.

They are loaded from an extension-origin URL, never `blob:` — the CSP allows `self` only,
and a blob worklet fails **silently**. That exact trap cost the web client a production
incident (spec 0093).

Because nothing imports them, a bundler change could silently drop them, so `bun run
package` refuses to package a bundle missing either file.

## Consequences

- A network blip no longer costs the user their session.
- Ducking, bypass and degradation converge on one rule: the user is never left in silence.
  Entering bypass flushes queued speech rather than playing it over the original.
- None of this can be exercised end-to-end until the backend extension-session mode
  exists — the server does not send these frames to a session it does not recognise.
