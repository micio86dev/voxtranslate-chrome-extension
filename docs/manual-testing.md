# Manual testing checklist

Automated tests cannot cover tab capture, real audio, on-page rendering, or latency. This
checklist is what actually verifies those, and it must be run by a human with Chrome, a
logged-in VoxTranslate account, and a funded balance.

Record the Chrome version and the build commit with the results.

## Prerequisites

- [ ] Backend deployed with the extension session mode and `/api/extension/*` endpoints.
- [ ] Extension ID on the backend CORS allow-list.
- [ ] Test account with a small positive balance.

## 1. Install and first run

- [ ] `bun run build`, load `dist/` unpacked, no manifest errors in `chrome://extensions`.
- [ ] Clicking the toolbar icon opens the side panel.
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

- [ ] Press Start. Chrome shows its recording indicator on the tab.
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
- [ ] "Buy more credit" opens voxtranslate.app with `?source=chrome-extension`.
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
