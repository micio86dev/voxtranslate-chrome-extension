# Security

## Reporting a vulnerability

Please report security issues privately to <https://voxtranslate.app/contact>, or by
opening a private security advisory on this repository. Do not open a public issue.

We aim to acknowledge within 72 hours.

## Security model

### Least privilege

The extension requests the narrowest permission set that makes the product work:

| Permission   | Why it is required                                                                |
| ------------ | --------------------------------------------------------------------------------- |
| `activeTab`  | grants access to the one tab you press Start on — the alternative is `<all_urls>` |
| `tabCapture` | reads that tab's audio                                                            |
| `offscreen`  | an MV3 service worker cannot hold an `AudioContext` or a long-lived `MediaStream` |
| `sidePanel`  | the UI surface                                                                    |
| `identity`   | `launchWebAuthFlow` for the PKCE login handoff                                    |
| `storage`    | session token (memory-only) and a preference cache                                |
| `scripting`  | injects the subtitle overlay on your explicit gesture, paired with `activeTab`    |

Deliberately **not** requested: `<all_urls>`, `tabs`, `history`, `cookies`, `webRequest`,
`downloads`, `clipboardRead`.

Host permissions are limited to VoxTranslate's own API and app origins.

### Credential handling

- Tokens are obtained through an authorization-code flow with PKCE (S256).
- The token is delivered **only** in a POST response body. The callback parser actively
  rejects a redirect carrying `access_token`, `refresh_token`, or `token` in the query
  string or fragment — a backend regression fails loudly instead of writing a credential
  into browser history.
- `state` is a single-use nonce, compared without an early-exit short-circuit.
- The token lives in `chrome.storage.session` (memory-only, cleared on browser close).
- An unreadable or near-expiry token is treated as expired and discarded — fail closed.
- Tokens are redacted from every diagnostic message before it is written.

### Network boundary

Every inbound WebSocket frame is validated at runtime before it is trusted
(`src/websocket/validate.ts`): type tags, field types, string length caps, numeric
finiteness, and a bounded translations map. TypeScript types do not exist at runtime, so
they are not treated as a security control.

Audio payloads are size-capped. Unknown message types are ignored rather than parsed.

### Content script isolation

The subtitle overlay renders inside a closed Shadow DOM on a single host element. It does
not read, modify, or observe page state, and it does not expose an API to the page. Page
CSS cannot reach into it and its CSS cannot leak out.

### Content Security Policy

`script-src 'self'; object-src 'self'` — no remote code, no `eval`, no inline scripts. All
dependencies are bundled at build time.

### Session integrity

Every session carries a unique client-side id. Frames whose session id does not match the
live session are discarded before they can move state, update usage, or play audio. The
session state machine rejects a second start, prevents audio after stop, and ignores a late
socket close during teardown.

## Known gaps

Stated plainly rather than omitted:

- **No server-side token revocation.** VoxTranslate has no revocation for any client, so
  logout clears the token locally but does not invalidate it server-side.
- **No refresh-token rotation.** There is no refresh token; the session JWT is long-lived.
- **Unpacked development builds get a rotating extension ID**, so the backend allow-list
  must be updated or a manifest `key` pinned.

## Supply chain

Dependencies are minimal and installed with Bun against a committed `bun.lock`. The
extension ships no remote code and makes no network request to any host other than
VoxTranslate's own origins.
