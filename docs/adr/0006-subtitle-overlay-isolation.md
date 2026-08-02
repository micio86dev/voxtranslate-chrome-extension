# ADR 0006 — Shadow DOM overlay, injected on gesture

**Status:** accepted · 2026-08-01

## Context

Subtitles must render over arbitrary websites without breaking them, without being broken
by them, and without requesting permission to read every page the user visits.

## Decision

- A **closed Shadow DOM** on a single host element.
- Injected programmatically via `chrome.scripting.executeScript` on the user's Start
  gesture, using `activeTab` — **not** a declarative content script with `<all_urls>`.
- `pointer-events: none` on the host.
- `z-index: 2147483000`, deliberately below the maximum.
- Re-parented into `document.fullscreenElement` on `fullscreenchange`.
- Guarded by a global marker against double injection.

## Rationale

**Closed Shadow DOM** means page CSS cannot reach in and overlay CSS cannot leak out.
Subtitles over video are exactly where a leaked `font-size` or an inherited `text-transform`
ruins the result.

**`activeTab` over `<all_urls>`** is the whole permission story. `<all_urls>` reads as
"this extension can see every page you visit" in the store listing and is the single
biggest install deterrent — and it is unnecessary, because the user always tells us which
tab they want.

**`pointer-events: none`** keeps page controls clickable through the overlay. A subtitle bar
that eats clicks on the play button is a broken page.

**Not `z-index: 2147483647`.** Leaving headroom lets a site's own modal still win, which is
the polite behaviour and avoids covering cookie banners and consent dialogs the user needs
to interact with.

**Fullscreen re-parenting** exists because a `position: fixed` element in `document.body`
disappears when a `<video>` goes fullscreen — precisely when subtitles matter most.

## Consequences

- Pages that forbid injection (`chrome://`, the Web Store) get audio translation but no
  overlay. Handled as a warning, not a session failure.
- Finals replace partials **in place** rather than clearing first, which is what prevents
  the visible flicker between segments.
- **The bundle must be an IIFE.** `executeScript` re-evaluates the file in the SAME
  isolated world, and a page gets injected more than once (SPA navigation, a retry, a
  second session). A plain-script bundle put its top-level bindings in that shared scope,
  so the second injection died with `Identifier 'f' has already been declared` — and the
  in-file re-injection guard was useless, because the failure happens at _evaluation_
  time, before any statement runs. The content script is therefore built separately
  (`vite.content.config.ts`) with `format: 'iife'`; the other entries stay ESM because the
  service worker is `type: module`. Two e2e tests hold the line: one evaluates the shipped
  bundle three times and asserts no page error, the other asserts the file still opens
  with `(function(`.
- No site-specific adapters. The universal path works from captured tab audio, so nothing
  depends on YouTube's DOM.
