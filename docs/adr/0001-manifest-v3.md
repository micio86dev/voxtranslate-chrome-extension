# ADR 0001 — Manifest V3

**Status:** accepted · 2026-08-01

## Context

Chrome extensions can target Manifest V2 or V3. MV2 is being removed from the Chrome Web
Store and disabled in Chrome; MV3 replaces the persistent background page with an
event-driven service worker.

## Decision

Target Manifest V3, minimum Chrome 116.

The version floor is set by `tabCapture.getMediaStreamId` combined with the offscreen
document consumer pattern. `sidePanel` needs 114+ and `offscreen` needs 109+, so 116 is the
binding constraint, not an arbitrary round number.

## Consequences

- No persistent background page. The service worker is killed aggressively, so nothing
  important may live only in a closure — see ADR 0003.
- No remote code. Everything is bundled at build time; CSP is `script-src 'self'`.
- Publishing to the Web Store remains possible; MV2 would not have been.
- Migration cost later is avoided entirely.
