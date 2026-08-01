/**
 * PKCE (RFC 7636) helpers for the extension login handoff.
 *
 * Flow (see docs/adr/0005-authentication.md):
 *   1. extension generates a verifier + S256 challenge
 *   2. launchWebAuthFlow opens voxtranslate.app with the challenge and a state nonce
 *   3. the web app, using the user's existing session, asks the backend for a one-time code
 *   4. the code comes back on the redirect URL; the extension exchanges code + verifier
 *
 * The access token is only ever delivered in a POST response body — never in a query
 * string, never in a URL fragment.
 */

/** RFC 7636 §4.1: 43–128 chars from the unreserved set. 32 bytes → 43 base64url chars. */
const VERIFIER_BYTES = 32;
const STATE_BYTES = 16;

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: 'S256';
}

export async function createPkcePair(): Promise<PkcePair> {
  const verifier = base64UrlEncode(randomBytes(VERIFIER_BYTES));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64UrlEncode(new Uint8Array(digest)), method: 'S256' };
}

/** Opaque nonce binding the redirect back to the request that started it (CSRF guard). */
export function createStateNonce(): string {
  return base64UrlEncode(randomBytes(STATE_BYTES));
}

/**
 * Constant-time-ish string comparison for the state nonce.
 *
 * JS cannot guarantee constant time, but comparing full length without early exit
 * removes the trivially exploitable short-circuit. The values are single-use nonces,
 * so this is defence in depth rather than the primary control.
 */
export function safeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface CallbackParams {
  code: string;
  state: string;
}

/**
 * Extract `code` + `state` from the redirect URL produced by launchWebAuthFlow.
 *
 * Rejects a URL carrying a token directly: if the backend ever regressed into returning
 * `access_token` in the URL, we must fail loudly rather than quietly accept a credential
 * that has been written to browser history.
 */
export function parseCallbackUrl(
  redirectUrl: string,
  expectedState: string,
): { ok: true; params: CallbackParams } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(redirectUrl);
  } catch {
    return { ok: false, reason: 'callback URL is not a valid URL' };
  }

  const params = new URLSearchParams(url.search);
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ''));

  for (const source of [params, fragment]) {
    if (source.has('access_token') || source.has('refresh_token') || source.has('token')) {
      return { ok: false, reason: 'callback carried a token in the URL — refusing' };
    }
  }

  const error = params.get('error');
  if (error) return { ok: false, reason: `authorization failed: ${error}` };

  const code = params.get('code');
  const state = params.get('state');
  if (!code) return { ok: false, reason: 'callback missing code' };
  if (!state) return { ok: false, reason: 'callback missing state' };
  if (!safeEquals(state, expectedState)) return { ok: false, reason: 'state mismatch' };

  return { ok: true, params: { code, state } };
}

/** Seconds of slack before expiry at which we proactively refresh. */
export const TOKEN_REFRESH_SKEW_SECONDS = 120;

/** Decode a JWT's `exp` without verifying it — for scheduling only, never for trust. */
export function readTokenExpiry(jwt: string): number | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  const payload = parts[1];
  if (!payload) return null;
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(atob(normalized)) as { exp?: unknown };
    return typeof json.exp === 'number' && Number.isFinite(json.exp) ? json.exp : null;
  } catch {
    return null;
  }
}

export function isExpired(jwt: string, nowSeconds: number): boolean {
  const exp = readTokenExpiry(jwt);
  // An unreadable token is treated as expired: fail closed, re-authenticate.
  if (exp === null) return true;
  return nowSeconds >= exp - TOKEN_REFRESH_SKEW_SECONDS;
}
