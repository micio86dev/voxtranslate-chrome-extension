# Privacy Notice — VoxTranslate for Chrome

Last updated: 2026-08-01

This notice describes what the VoxTranslate Chrome extension does with your data. It
supplements the [VoxTranslate Privacy Policy](https://voxtranslate.app/privacy), which
governs your VoxTranslate account.

---

## What audio is captured

Only the audio playing in the **single browser tab you explicitly choose**.

The extension does **not** access:

- your microphone,
- any other tab,
- any background tab,
- system audio outside the chosen tab.

## When capture starts

Capture starts **only** when you press "Start translating this tab". Opening the side
panel, installing the extension, or browsing does not capture anything.

Chrome shows its own recording indicator on the tab while capture is active, and the side
panel shows an active-session badge.

## When capture stops

Capture stops immediately when any of these happens:

- you press "Stop",
- the captured tab is closed,
- the tab's audio track ends (navigation away, media removed),
- your balance is exhausted,
- the connection fails and reconnection is abandoned,
- you log out.

On stop, the media tracks, audio context, recorder, WebSocket, and on-page subtitle overlay
are all released.

## What is sent to VoxTranslate

While a session is running:

| Sent                                        | Why                                |
| ------------------------------------------- | ---------------------------------- |
| Encoded tab audio (WebM/Opus, 32 kbps mono) | speech recognition and translation |
| Your target language                        | to know what to translate into     |
| Your chosen translation tier                | routing and pricing                |
| Your session token                          | authentication and billing         |

**Not sent**, deliberately:

- the page URL, or any part of it,
- query parameters, video IDs, or page titles beyond what you see in the panel,
- page HTML or any page content,
- cookies, local storage, or form values,
- browsing history,
- microphone audio,
- any network traffic other than our own.

The extension requests **no** broad host permissions. It has access to VoxTranslate's own
origins, plus whichever single tab you activate it on via Chrome's `activeTab` permission.

## What is stored, and where

| Data                                                         | Location                                                                       | Lifetime                                  |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------ | ----------------------------------------- |
| Session token                                                | `chrome.storage.session` (in memory)                                           | cleared when Chrome closes or you log out |
| Cached profile (name, email, balance)                        | `chrome.storage.local`                                                         | until logout                              |
| Your preferences (language, tier, volume, subtitle settings) | `chrome.storage.local`, plus your VoxTranslate account for the target language | until changed                             |

The session token is deliberately kept in memory-only storage rather than on disk.

## What VoxTranslate retains

Audio and transcript retention is governed by the
[VoxTranslate Privacy Policy](https://voxtranslate.app/privacy) and is the same as for the
web application — this extension introduces no separate retention.

Usage is recorded in your existing VoxTranslate billing ledger: session duration and cost.
There is no second, extension-specific ledger.

## Deleting your data

Account data, including usage history, is deleted through your VoxTranslate account
(`DELETE /api/user`, exposed in the web app). Removing the extension deletes its local
storage but does not delete your account.

## Logging

The extension never logs:

- access tokens or any credential,
- raw or encoded audio,
- full transcripts,
- payment details,
- page URLs.

Diagnostic messages are redacted before being written (`src/shared/errors.ts`).

## An honest limitation

VoxTranslate does not currently support server-side session revocation — for this
extension or for the web application. Logging out clears the token from your device, but
the token remains technically valid on the server until it expires. We are stating this
rather than implying stronger guarantees than exist.

## Contact

Questions about this notice: <https://voxtranslate.app/contact>
