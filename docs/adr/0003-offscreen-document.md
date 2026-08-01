# ADR 0003 — Offscreen document for the audio pipeline

**Status:** accepted · 2026-08-01

## Context

The capture pipeline needs a `MediaStream`, an `AudioContext`, a `MediaRecorder`, and a
WebSocket, all alive for the whole session — potentially hours.

An MV3 service worker is terminated after ~30 s of inactivity and has no DOM, no
`AudioContext`, and no `navigator.mediaDevices`.

## Decision

Run the entire capture → encode → transport pipeline in a `chrome.offscreen` document with
reason `USER_MEDIA`. The service worker only mints the media stream id and orchestrates.

## Rationale

This is the only supported MV3 mechanism for long-lived media work. The alternatives are
worse: an injected in-page pipeline dies on navigation and pollutes the page; a popup-hosted
pipeline dies when the popup closes.

## Consequences

- One more context to reason about, and messages must carry a session id so a late message
  from a previous session cannot affect the current one.
- The offscreen document owns at most **one** pipeline, which is the structural guarantee
  that a single extension instance cannot run two captures.
- If the service worker is killed, the offscreen document goes with it — acceptable,
  because a killed worker means the session is over anyway.
- Teardown order is fixed (recorder → socket → tracks → context) so nothing can emit after
  disposal.
