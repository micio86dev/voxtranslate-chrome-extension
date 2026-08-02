# Manual testing checklist

Automated tests cannot cover tab capture, real audio, on-page rendering, or latency. This
checklist is what actually verifies those, and it must be run by a human with Chrome, a
logged-in VoxTranslate account, and a funded balance.

**Why capture cannot be automated** (verified, not assumed): `tabCapture.getMediaStreamId`
requires the `activeTab` grant, which only a real user invocation of the extension action
produces. Chrome refuses otherwise with the exact message _"Extension has not been invoked
for the current page (see activeTab permission)."_ Playwright drives page content, not
browser chrome, so it cannot click the action. Everything downstream of the stream — the
audio graph, encoder settings, backpressure, teardown — IS covered automatically in
`tests/unit/capture-pipeline.test.ts` with injected browser APIs.

**Already covered automatically**, so do not re-test by hand: account sync, side-panel
rendering, tier-filtered language list, preference persistence, usage-counter reset,
logout and token clearing, and the refuse-to-start-without-an-account path
(`tests/e2e/pipeline.spec.ts`).

Record the Chrome version and the build commit with the results.

## Prerequisites

- [ ] Backend deployed with `GET /ws/extension` and `/api/extension/*` (shipped).
- [ ] **`EXTENSION_ORIGINS=chrome-extension://<id>` set on the API.** Until this is set
      every side-panel `fetch` is blocked by CORS and the panel stays on "sign in".
      Pin the id with a manifest `key` first, or it changes on each unpacked load.
- [ ] The web app deployed with `/extension/connect`.
- [ ] Test account with a small positive balance.

## 0. Backend smoke test (do this first — it isolates client bugs from server bugs)

- [ ] `GET /ws/extension?lang=it&token=<jwt>` upgrades rather than 400/401.
- [ ] Omitting `token` is rejected — extension sessions have no guest tier.
- [ ] `lang=auto` is rejected with "target language cannot be auto".
- [ ] Opening a session creates ONE row in `usage_sessions` and finalises it on close.
- [ ] While translating foreign audio, the balance decreases; while the source language
      matches the target, it does **not**.
- [ ] **Billing follows the session, not the socket**: connect without pressing Start and
      confirm the balance does NOT move; press Stop and confirm it stops moving again.
      (The meter is spawned per streaming session for exactly this reason.)
- [ ] After `balance_exhausted`, sending `start` again is refused with
      `insufficient_balance` — it must never open an unmetered session.

### PKCE exchange (cannot be covered in CI — billing is not configured there)

- [ ] `POST /api/extension/code` without an Authorization header is rejected.
- [ ] With a valid session it returns a code; the code is a JWT that expires in 60 s.
- [ ] `POST /api/extension/token` with that code and the matching verifier returns a
      token + profile.
- [ ] The **same** code presented with a DIFFERENT verifier is rejected.
- [ ] A session JWT presented as a `code` is rejected (the `kind` claim guards this).
- [ ] A code older than 60 s is rejected.

## 1. Install and first run

- [ ] `bun run build`, load `dist/` unpacked, no manifest errors in `chrome://extensions`.
- [ ] Clicking the toolbar icon opens the side panel.

> **The toolbar click is not decoration.** Chrome grants `activeTab` — and therefore
> `tabCapture` — only for an action click, context menu item, keyboard shortcut or
> omnibox pick. **Opening or clicking inside the side panel grants nothing.** So the flow
> is always: go to the tab you want translated → click the VoxTranslate icon → press
> Start. Opening the panel from the puzzle-piece menu, or clicking the icon on a
> different tab, leaves capture denied.
>
> The grant is also revoked when the tab navigates to another origin, so after following
> a link to a different site the icon must be clicked again.

- [ ] Logged-out state shows branding, explanation, login button, privacy summary.

## 2. Authentication

- [ ] "Log in with VoxTranslate" opens the auth window.
- [ ] Completing login returns to the panel showing name, email, and balance.
- [ ] The redirect URL contains **no** token (check `chrome://extensions` service-worker log).
- [ ] Closing the auth window mid-flow returns to a clean logged-out state, no error spam.
- [ ] Logout clears the panel back to logged-out.
- [ ] After logout, `chrome.storage.session` holds no token.

## 3. Capture and playback — the critical one

On a YouTube video in a foreign language:

- [ ] With the panel open but WITHOUT clicking the icon on this tab, press Start: it must
      refuse with "Click the VoxTranslate icon…", not a bare permission error.
- [ ] Click the icon on this tab, then press Start. Chrome shows its recording indicator.
- [ ] **The tab audio is still audible** (this is the failure mode that matters most —
      capture takes over the audio, and if the graph is wrong the tab goes silent).
- [ ] Panel shows "Translating".
- [ ] Dragging original-audio volume to 0 % silences the original.
- [ ] Dragging it back to 100 % restores it, with no click or pop.
- [ ] Press Stop. Audio returns to normal, overlay disappears, panel returns to ready.

## 4. Subtitles

- [ ] Partial subtitles appear and update smoothly.
- [ ] Finals replace partials **without flicker**.
- [ ] Text is readable over both bright and dark video.
- [ ] Page controls (play, seek, volume) remain clickable through the overlay.
- [ ] Going fullscreen keeps subtitles visible.
- [ ] Leaving fullscreen keeps subtitles visible.
- [ ] Navigating within a SPA (YouTube next video) does not produce two overlays.
- [ ] The page console shows NO `Identifier '…' has already been declared` after a second
      start on the same tab. (The content script is an IIFE precisely so re-injection is
      safe; this is the symptom if that ever regresses.)
- [ ] Stopping removes the overlay immediately and completely.

## 5. Language bypass

- [ ] Play content already in your target language.
- [ ] After a few seconds the panel shows "Already in your language".
- [ ] **Original audio becomes audible even with the volume slider at 0 %.**
- [ ] No credit is consumed while bypassed (watch the session figure).
- [ ] Switching to foreign-language content resumes translation automatically.
- [ ] A single foreign word does not flip the mode.

## 6. Usage and billing

- [ ] Session cost increases while translating.
- [ ] "Since reset" and "Remaining" update.
- [ ] Reset counter shows the confirmation dialog with the "no refund" wording.
- [ ] After reset, "since reset" is zero and **remaining is unchanged**.
- [ ] Billing history in the web app is unchanged by the reset.
- [ ] "Buy more credit" opens voxtranslate.app and the purchase modal appears
      (`/?buy=1&source=chrome-extension`). There is no `/billing` page — a link there 404s.
- [ ] Returning to the panel after a purchase shows the new balance.

## 7. Low and exhausted balance

With an almost-empty account:

- [ ] Low-balance warning appears once, not repeatedly.
- [ ] On exhaustion: translation stops, original audio is restored, the tab stays usable,
      the purchase action is shown, and the session closes cleanly.

## 8. Failure handling

- [ ] Close the captured tab mid-session → session stops, no zombie pipeline.
- [ ] Navigate the captured tab away → session stops cleanly.
- [ ] Kill network mid-session → "Reconnecting…", then a clear error after the budget.
      It must **not** retry forever.
- [ ] Start on a `chrome://` page → clear error, no crash.
- [ ] Start on a silent tab → no crash.

## 9. Resource cleanup — run this last, it catches the leaks

- [ ] Start and stop **10 times in a row**.
- [ ] `chrome://extensions` → service worker → no growing listener count.
- [ ] Only **one** offscreen document exists (`chrome://inspect`).
- [ ] No orphaned overlay elements in the page DOM.
- [ ] Memory in Chrome's Task Manager returns to roughly baseline after stopping.
- [ ] No `MediaStream` still active (Chrome's recording indicator is off).
