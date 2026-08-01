# ADR 0005 — PKCE handoff instead of a new OAuth authorization server

**Status:** accepted · 2026-08-01

## Context

The brief specified an authorization-code + PKCE flow against VoxTranslate, with
short-lived access tokens, rotating refresh tokens, and server-side revocation.

Discovery (`docs/discovery.md` §2) found that **none of that exists**. VoxTranslate is an
OAuth _client_ to Google, not an authorization server. `POST /api/auth/google` returns a
single long-lived HS256 JWT. There is no refresh token, no `/authorize`, no token table,
and no revocation — for any client, including the web app.

Additional constraint: the VoxTranslate server cannot be compiled on every developer
machine (rustc 1.92 required; a 1.89 toolchain fails on the `typst` dependency tree), so
backend changes are CI-verified only.

## Decision

Reuse the existing Google login behind a **one-time, PKCE-bound handoff code**:

1. The extension generates a verifier and an S256 challenge.
2. `launchWebAuthFlow` opens `voxtranslate.app/extension/connect` with the challenge and a
   state nonce.
3. The web app — using the user's _existing_ session — requests a one-time code from
   `POST /api/extension/code`.
4. The code returns on the redirect; the extension exchanges it plus the verifier at
   `POST /api/extension/token` for the session token.

Two new endpoints and one small table, instead of five endpoints and an authorization server.

## Rationale

This keeps the security properties the brief actually cared about — no token in a query
string, single-use code, PKCE-bound, CSRF-protected — while reusing a login that already
works and is already trusted.

Building a real authorization server means a client table, a code table, a refresh-token
table with rotation and reuse detection, revocation semantics, and migrating the web app
onto it. That is its own project, it touches production billing auth, and it cannot be
compiled locally. Shipping it as a side effect of a Chrome extension would be reckless.

## Consequences

**Accepted:** the token is the existing long-lived JWT. Short-lived access tokens with
rotating refresh are **not** achieved, and logout is client-side only. Both are documented
in `PRIVACY.md` and `SECURITY.md` rather than glossed over — the extension is no weaker
than the web app, but it is not what the brief asked for.

**Enforced:** `parseCallbackUrl` rejects any callback carrying a token in the URL, so if
the backend ever regresses into returning credentials in the redirect, login fails loudly
instead of silently writing a credential into browser history.

**Deferred:** a real authorization server, if the platform later needs one, should be
specced independently and migrate the web app at the same time.
