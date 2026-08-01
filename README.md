# VoxTranslate for Chrome

Real-time translated subtitles for the audio playing in your browser tab — YouTube,
Twitch, Udemy, podcasts, webinars, streaming platforms, anything with sound.

Part of the [VoxTranslate](https://voxtranslate.app) platform. This repository is included
in the main VoxTranslate workspace as a Git submodule.

> **Status: feature-complete, pending a human end-to-end check.** The extension and its
> backend both build, lint, and pass their suites. The backend session mode, the PKCE
> login endpoints and the web-app handoff page are implemented. What has NOT happened is
> a human loading it in Chrome against a live account — tab capture cannot be automated
> (see below), so nobody has yet watched real subtitles appear over a real video.
> [What works today](#what-works-today) is the honest section.

---

## Contents

- [What works today](#what-works-today)
- [Architecture](#architecture)
- [Requirements](#requirements)
- [Install and develop](#install-and-develop)
- [Build and load in Chrome](#build-and-load-in-chrome)
- [Testing](#testing)
- [Authentication flow](#authentication-flow)
- [Audio capture flow](#audio-capture-flow)
- [WebSocket protocol](#websocket-protocol)
- [Usage and billing](#usage-and-billing)
- [Privacy model](#privacy-model)
- [Backend changes required](#backend-changes-required)
- [Chrome Web Store packaging](#chrome-web-store-packaging)
- [Working with the submodule](#working-with-the-submodule)
- [Troubleshooting](#troubleshooting)
- [Known limitations](#known-limitations)

---

## What works today

**Verified on this machine** (`bun run verify` + `bun run test:e2e`):

- Builds to a valid MV3 bundle whose emitted paths match the manifest.
- TypeScript strict mode passes with no `any` and no suppressions.
- ESLint passes with zero warnings.
- **136 unit + integration tests** covering the session state machine, locale
  normalisation, detected-language stability, translated-audio ordering, reconnect
  backoff, usage accounting, PKCE, inbound-frame validation, and the capture pipeline
  (audio graph, encoder settings, backpressure, teardown) with injected browser APIs.
- **10 browser end-to-end tests** against a real unpacked extension and a fake backend:
  session restore from a stored token, account sync, side-panel rendering, tier-filtered
  language list, preference persistence, usage-counter reset, logout, and the
  refuses-to-start-without-an-account path.

**Cannot be automated — verified only by hand** (`docs/manual-testing.md`):

- Tab capture. `chrome.tabCapture.getMediaStreamId` requires the `activeTab` grant, which
  only a real user invocation of the extension action produces. Chrome refuses otherwise
  with _"Extension has not been invoked for the current page (see activeTab permission)."_
  Playwright drives page content, not browser chrome, so it cannot produce that click.
  Requesting `<all_urls>` would make the tests pass and the product worse, so the
  capture-dependent e2e cases are explicitly skipped with that reason in the file.
- Subtitle overlay appearance on real pages, fullscreen, and SPA navigation.
- Live streaming against the real backend, and end-to-end latency.
- Repeated start/stop cleanup observed in Chrome's task manager.

**Not implemented:**

- The backend extension-session mode (see [Backend changes required](#backend-changes-required)).
  Without it the WebSocket connects but nothing is translated.
- The `/api/extension/code` and `/api/extension/token` endpoints, so login cannot complete.
- The Enhanced tier, which is client-direct to Cartesia and needs a second in-browser pipeline.
- Server-side persistence of the usage-counter reset baseline (it is device-local today).

---

## Architecture

```
┌─────────────────────────── Chrome ────────────────────────────┐
│                                                               │
│  Side panel (Vue 3)          view layer only, no logic        │
│        │  chrome.runtime messaging (typed unions)             │
│        ▼                                                      │
│  Service worker (MV3)        state machine, auth, account,    │
│        │                     session arbitration              │
│        ▼                                                      │
│  Offscreen document          tabCapture consumer              │
│    ├── AudioContext ──► GainNode ──► speakers  (what you hear)│
│    ├── MediaRecorder ──► WebM/Opus 32 kbps @ 100 ms           │
│    └── WebSocket ──────► binary audio + JSON frames           │
│                                                               │
│  Content script              Shadow-DOM subtitle overlay      │
└───────────────────────────────────────────────────────────────┘
                              │ wss
                              ▼
              VoxTranslate backend (Axum / Rust)
              Deepgram STT → Groq / OpenAI / Gemini translation
```

**Why an offscreen document?** An MV3 service worker is killed aggressively and cannot
hold an `AudioContext` or a long-lived `MediaStream`. The offscreen document is the only
supported place for a continuous capture pipeline.

**Why the GainNode is not optional.** `chrome.tabCapture` takes over the tab's audio — if
the captured stream is not routed back to the speakers, the user hears silence and assumes
the extension broke the page. That same node is also the 0–100 % original-audio control
and the ducking mechanism: one node, three requirements.

Domain logic (state machine, language stability, audio queue, backoff, usage) is pure and
Chrome-free, which is why it can be unit-tested without a browser. Chrome APIs sit behind
thin adapters.

---

## Requirements

- **Chrome 116+** (`tabCapture.getMediaStreamId` with the offscreen consumer pattern;
  `sidePanel` needs 114+, `offscreen` needs 109+, so 116 is the binding constraint).
- **Bun 1.2+** — the only package manager and script runner used here. Do not use npm,
  pnpm, or Yarn.
- A VoxTranslate account with a positive balance.

Chrome only. Firefox, Safari, and Edge are **not** supported and not claimed — the code is
structured so a browser adapter could be added later, but nothing has been tested there.

---

## Install and develop

```bash
bun install
cp .env.example .env      # point at your backend if not using production
bun run dev               # rebuild on change
```

Available scripts:

| Script               | What it does                                    |
| -------------------- | ----------------------------------------------- |
| `bun run dev`        | watch build into `dist/`                        |
| `bun run build`      | production build                                |
| `bun run typecheck`  | `vue-tsc --noEmit`, strict                      |
| `bun run lint`       | ESLint, zero warnings tolerated                 |
| `bun run format`     | Prettier write                                  |
| `bun run test`       | unit + integration (Vitest)                     |
| `bun run test:e2e`   | Playwright, loads the unpacked extension        |
| `bun run package`    | build + emit the store ZIP into `release/`      |
| `bun run sync:langs` | re-copy the language catalogue from `../server` |
| `bun run verify`     | typecheck + lint + test + build                 |

### Local backend

Set both origins in `.env`:

```
VITE_API_ORIGIN=http://localhost:8080
VITE_APP_ORIGIN=http://localhost:4321
```

The WebSocket origin is derived from `VITE_API_ORIGIN` by swapping `http` → `ws`, so there
is only one thing to configure.

---

## Build and load in Chrome

```bash
bun run build
```

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. **Load unpacked** → select the `dist/` directory.
4. Pin VoxTranslate to the toolbar; clicking it opens the side panel.

> **Extension ID changes on every fresh unpacked load** unless you pin it. The backend
> CORS allow-list and the OAuth redirect registration are keyed to the ID, so for stable
> local development add a `key` field to the manifest (Chrome docs: _Keep a consistent
> extension ID_). Without it you will need to update the allow-list each time.

---

## Testing

```bash
bun run test          # 136 unit + integration tests
bun run test:e2e      # 10 browser tests against a real unpacked extension
bun run verify        # typecheck + lint + test + build
```

The e2e suite builds the extension against a **local fake backend** (`tests/e2e/fixtures/`)
that speaks the real protocol, so it never touches production and never spends credit.

No test contacts a translation provider and no test spends real credit. Integration tests
drive the real modules through a scripted server rather than the network, which is what
catches cross-module bugs — a stale frame updating the meter, a bypass that forgets to
restore audio, a reconnect that would bill twice.

**What tests cannot cover here:** tab capture, real audio, on-page rendering, and latency.
Those are in [`docs/manual-testing.md`](docs/manual-testing.md) as an explicit checklist,
because pretending an automated suite covers them would be dishonest.

---

## Authentication flow

VoxTranslate has no OAuth authorization server — it is an OAuth _client_ to Google. So the
extension does not invent one; it reuses the existing web login behind a one-time,
PKCE-bound handoff code.

```
extension                       voxtranslate.app                  backend
  │ verifier + S256 challenge
  ├─ launchWebAuthFlow ────────►│
  │                             │ existing Google sign-in
  │                             ├─ POST /api/extension/code ────►│  one-time code,
  │                             │◄───────────────────────────────┤  60 s TTL, single use
  │◄─ redirect ?code=…&state=…
  ├─ POST /api/extension/token { code, code_verifier } ─────────►│
  │◄─ { token, user } ───────────────────────────────────────────┤
```

Security properties:

- The token **only ever arrives in a POST response body**. `parseCallbackUrl` actively
  refuses a callback carrying `access_token`, `refresh_token`, or `token` in the query
  string _or_ the fragment, so a backend regression fails loudly rather than silently
  writing a credential into browser history.
- `state` is a single-use nonce compared without an early-exit short-circuit.
- The token is stored in `chrome.storage.session` — in memory, cleared when the browser
  closes, never written to disk.
- An unreadable or near-expiry token is treated as expired and discarded (fail closed).

**Honest limitation:** the issued token is VoxTranslate's existing long-lived session JWT.
There is no refresh token and no server-side revocation _for any VoxTranslate client_, so
logout is local-only. This is documented in [`PRIVACY.md`](PRIVACY.md) rather than
glossed over. See [ADR 0005](docs/adr/0005-authentication.md) for why building a full
authorization server was rejected as out of scope.

---

## Audio capture flow

```
user presses Start (explicit gesture — nothing is captured before this)
   → service worker: tabCapture.getMediaStreamId({ targetTabId })
   → offscreen: getUserMedia({ chromeMediaSource: 'tab', chromeMediaSourceId })
   → AudioContext:  source ─┬─► GainNode ─► destination     (user keeps hearing the tab)
                            └─► MediaRecorder ─► WebSocket   (server transcribes)
```

**Format: WebM/Opus, 32 kbps, mono, 100 ms timeslice.** This is not a free choice — it
mirrors exactly what the backend already ingests (`client/src/scripts/audio-capture.ts`,
spec 0043) so Deepgram is opened with `container=webm` and no server-side codec work is
needed.

When the server sends `capture_format { pcm: true }` — because one captured stream must
feed two providers at once — the encoder switches to **PCM16 @ 24 kHz** via an
AudioWorklet, and back again on request. Only the encoder changes: the capture stream and
the passthrough graph are untouched, so what the user hears never glitches.

### Reconnection

A dropped socket reopens the **transport only**. Capture and the audio graph stay alive,
because a `tabCapture` stream id cannot be re-minted without another user gesture —
tearing it down would force the user to click Start again for a blip of network.

Backoff is exponential with full jitter, bounded by both attempts and elapsed time. Auth,
billing and deliberate closes are never retried (retrying a billing failure risks a
duplicate charged session). While the transport is down the original audio is restored and
the overlay says "Reconnecting…", so the user is never left in silence wondering.

### Translated audio

For tiers that produce speech, the server streams `translated_audio`: PCM16 mono @ 24 kHz,
base64, sequenced. Frames pass through a queue that enforces ordering, drops duplicates
and rejects stale segments, then a `pcm-playback-worklet` drains them gaplessly. The
original audio ducks under the translated voice and returns when it stops.

Both AudioWorklet processors are copied verbatim from the VoxTranslate web client, so both
clients encode and drain audio identically. They are loaded from an extension-origin URL,
never a `blob:` URL — the CSP allows `self` only, and a blob worklet fails silently.

Playback degrades safely: if the worklet cannot be built, or speech stalls, the original
audio is restored, a non-blocking warning appears, and subtitles keep running. Silence is
never an acceptable output.

Only the tab the user explicitly started on is captured. Never the microphone, never
another tab, never a background tab.

---

## WebSocket protocol

Reuses the existing VoxTranslate protocol (`server/src/protocol.rs`) rather than
introducing a parallel one.

**Connect:** `GET /ws?room=&lang=&token=&engine=&client=chrome-extension&source=`

The session JWT travels as a query parameter because browsers cannot set headers on a
WebSocket handshake — this is the established VoxTranslate convention, over TLS, and the
token is a session credential, never a refresh credential.

**Consumed server frames:**

| Frame                               | Used for                                                           |
| ----------------------------------- | ------------------------------------------------------------------ |
| `subtitle_interim`                  | partial subtitles                                                  |
| `subtitle_final`                    | final subtitle + `translations[target]`                            |
| `translated_audio`                  | PCM16 24 kHz base64 + `seq` (queue implemented, playback deferred) |
| `language_detected`                 | bypass stability logic                                             |
| `balance_update`                    | authoritative usage accounting                                     |
| `low_balance` / `balance_exhausted` | warnings and safe teardown                                         |
| `capture_format`                    | switch to PCM when the server asks                                 |
| `error`                             | structured error with a `code` the UI branches on                  |

Every inbound frame is validated at runtime before it is trusted
(`src/websocket/validate.ts`). Unknown message types are ignored, not treated as errors —
the server sends room/WebRTC traffic this client does not care about.

**Sent:** binary audio frames, plus `start` / `stop`.

---

## Usage and billing

The backend is authoritative for money. The extension never computes a charge — it derives
display values from the balances the server pushes, so the two can never disagree.

```
This session      $0.0042   (1:23)
Since reset       $2.16
Remaining         $12.40
```

> **Units:** VoxTranslate consumer accounts hold **US dollars**, not credits. The integer
> "credits" elsewhere in the codebase belong to the separate B2B organisation pool, which
> must never be mixed with consumer money. The UI says dollars because the ledger says
> dollars.

**Reset usage counter** moves only the baseline the "since reset" figure is measured from.
It refunds nothing, deletes no history, and touches no invoice. A confirmation dialog says
exactly that. It is currently device-local — persisting the baseline server-side needs a
column and a migration, which is deferred.

When the balance is exhausted the server stops billing and translating; the extension tears
the pipeline down, restores original audio, keeps the tab usable, and offers the purchase link.

---

## Privacy model

See [`PRIVACY.md`](PRIVACY.md) for the full notice. In short:

- Audio is captured **only** while a session is running, and **only** from the tab you chose.
- Capture starts on your explicit click and stops on Stop, on tab close, or on error.
- The microphone is never accessed. Other tabs are never accessed.
- No browsing history, page content, cookies, or form values are read or transmitted.
- The full page URL is **not** sent. Neither are query parameters, video IDs, or page HTML.
- Tokens, raw audio, and full transcripts are never written to logs.

---

## Backend changes required

The extension cannot function end-to-end until these land. Full analysis in
[`docs/discovery.md`](docs/discovery.md).

| #   | Change                                                                  | Risk     | Status                             |
| --- | ----------------------------------------------------------------------- | -------- | ---------------------------------- |
| 1   | Allow `chrome-extension://<id>` in the CORS allow-list                  | low      | **done** — set `EXTENSION_ORIGINS` |
| 2   | `POST /api/extension/code` + `POST /api/extension/token` (PKCE handoff) | medium   | **done**                           |
| 3   | **Extension session mode** — `GET /ws/extension`                        | **high** | **done** — see below               |
| 4   | Server-side usage-counter reset baseline (column + migration)           | medium   | deferred                           |

### How the session mode works

`server/src/extension.rs` adds `GET /ws/extension`. Rather than change the room model, one
connection joins a **private room as two peers**:

```
source peer    id "<sid>-src"   lang "auto"     owns the Deepgram session
listener peer  id "<sid>"       lang <target>   receives subtitles, is billed
```

Everything else then falls out of behaviour that already existed, with **no change to
`rooms.rs`, `usage.rs` or any engine**: fan-out sees one target language and translates
into it; the meter bills one stream per interval; and when detection resolves the source
language to the listener's, delivery is skipped _and_ the meter skips the tick — the
"already in your language" bypass, unbilled, for free.

No migration was needed. The handoff code is a signed, PKCE-bound JWT with a 60-second
life rather than a stored row, which avoids touching a live billing database. The
trade-off is that a code cannot be revoked inside that minute; it is worthless without
the verifier, which never leaves the extension.

**Required environment:** `EXTENSION_ORIGINS=chrome-extension://<id>` on the API. Until it
is set, the side panel's `fetch` calls are blocked by CORS.

The client side of reconnection, `capture_format` switching and translated-audio playback
is implemented and tested, but none of it can be exercised until #3 exists — the server
never sends those frames to a session it does not recognise.

**Why #3 was hard.** VoxTranslate's model is a room of symmetric peers, each with one
language they both speak and hear in. Translation targets are derived from _other_ peers,
so a single-peer room translates nothing and bills nothing. The two-peer trick above is
what makes an asymmetric tab-audio session fit that model without rewriting it.

## Chrome Web Store packaging

```bash
bun run package     # → release/voxtranslate-chrome-<version>.zip
```

The script refuses to package a build missing any manifest-declared file, because the store
rejects those after upload — much later and much more annoyingly.

Store assets, permission justifications, the data-use disclosure checklist, and the release
checklist live in [`docs/store/`](docs/store/). **Nothing is published automatically.**

---

## Working with the submodule

From the parent VoxTranslate workspace:

```bash
# first clone
git submodule update --init --recursive

# pull the latest extension commit
git submodule update --remote voxtranslate-chrome-extension

# after committing inside the extension, bump the parent pointer
cd voxtranslate-chrome-extension && git push
cd .. && git add voxtranslate-chrome-extension && git commit -m "chore: bump chrome extension"
```

The extension follows the workspace Git Flow: `feature/<name>` off `develop`,
`release/<X.Y.Z>`, merge with `--no-ff`, tag `vX.Y.Z`.

---

## Troubleshooting

| Symptom                                 | Cause and fix                                                                                                       |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Tab goes silent when translating starts | The audio graph failed to build. `tabCapture` takes over the tab audio; check the offscreen document's console.     |
| "Requesting tab audio…" never advances  | `getMediaStreamId` was denied. Reload the tab and retry; capture needs a user gesture in the current tab.           |
| No subtitles but audio is captured      | The page blocks script injection (`chrome://`, the Web Store). Audio translation still works; the overlay does not. |
| Subtitles vanish in fullscreen          | Should not happen — the overlay re-parents into the fullscreen element. File an issue with the site.                |
| Login window opens then nothing         | The backend extension endpoints are not deployed yet. See [Backend changes required](#backend-changes-required).    |
| CORS errors in the side panel           | The extension ID is not on the backend allow-list. Pin the ID with a manifest `key`.                                |

---

## Known limitations

- **Not functional end-to-end** until the backend session mode ships.
- **Translated audio is not implemented.** The ordering queue exists and is tested; playback does not.
- **The Enhanced tier is unsupported.** It is client-direct to Cartesia and needs a second
  in-browser STT + TTS pipeline inside the offscreen document.
- **The usage-counter reset is device-local**, not synced across devices.
- **No server-side logout.** VoxTranslate has no token revocation for any client.
- **Chrome only.** No other browser has been tested, so none is claimed.
- **Language detection runs once per session start, not continuously.** The Standard engine
  probes the first few seconds of audio and then opens a Deepgram stream pinned to that
  language (`engine/standard.rs` calls `set_peer_lang` exactly once). So if a video
  _switches_ language halfway through, the extension will not notice: no contradicting
  `language_detected` event is ever sent, and the client's hysteresis has nothing to act
  on. Stopping and restarting the session re-detects. Continuous re-detection would be a
  backend change, and is not implemented.
- **Language bypass depends on backend detection quality.** The client adds hysteresis
  (3 agreeing detections at ≥0.85 confidence over ≥4 s to enter bypass, 1 to leave), but it
  cannot be better than the signal it is given.

---

## Licence

MIT — see [`LICENSE`](LICENSE).
