import { describe, expect, it } from 'vitest';
import {
  createPkcePair,
  createStateNonce,
  isExpired,
  parseCallbackUrl,
  readTokenExpiry,
  safeEquals,
} from '@/auth/pkce';

const REDIRECT = 'https://abcdefghijklmnop.chromiumapp.org/';

/** Build an unsigned JWT-shaped string with the given payload (test fixture only). */
function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'HS256' })}.${b64(payload)}.signature`;
}

describe('PKCE pair', () => {
  it('produces an RFC 7636-length verifier and an S256 challenge', async () => {
    const pair = await createPkcePair();
    expect(pair.method).toBe('S256');
    expect(pair.verifier.length).toBeGreaterThanOrEqual(43);
    expect(pair.verifier.length).toBeLessThanOrEqual(128);
    // base64url only — no +, /, or padding.
    expect(pair.verifier).toMatch(/^[A-Za-z0-9\-_]+$/);
    expect(pair.challenge).toMatch(/^[A-Za-z0-9\-_]+$/);
    expect(pair.challenge).not.toBe(pair.verifier);
  });

  it('never repeats a verifier', async () => {
    const pairs = await Promise.all([createPkcePair(), createPkcePair(), createPkcePair()]);
    expect(new Set(pairs.map((p) => p.verifier)).size).toBe(3);
  });

  it('generates distinct state nonces', () => {
    expect(new Set([createStateNonce(), createStateNonce(), createStateNonce()]).size).toBe(3);
  });
});

describe('callback parsing', () => {
  it('accepts a well-formed callback', () => {
    const result = parseCallbackUrl(`${REDIRECT}?code=abc123&state=nonce`, 'nonce');
    expect(result).toEqual({ ok: true, params: { code: 'abc123', state: 'nonce' } });
  });

  it('rejects a state mismatch', () => {
    const result = parseCallbackUrl(`${REDIRECT}?code=abc&state=wrong`, 'nonce');
    expect(result).toMatchObject({ ok: false, reason: 'state mismatch' });
  });

  it('REFUSES a callback that carries a token in the URL', () => {
    // The whole point of the code flow: credentials must never reach browser history.
    for (const param of ['access_token', 'refresh_token', 'token']) {
      const result = parseCallbackUrl(`${REDIRECT}?${param}=leaked&state=nonce`, 'nonce');
      expect(result.ok, `${param} must be refused`).toBe(false);
    }
  });

  it('refuses a token hidden in the URL fragment too', () => {
    const result = parseCallbackUrl(`${REDIRECT}?state=nonce#access_token=leaked`, 'nonce');
    expect(result.ok).toBe(false);
  });

  it('surfaces an authorization error from the provider', () => {
    const result = parseCallbackUrl(`${REDIRECT}?error=access_denied&state=nonce`, 'nonce');
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toContain('access_denied');
  });

  it('rejects a missing code or state', () => {
    expect(parseCallbackUrl(`${REDIRECT}?state=nonce`, 'nonce').ok).toBe(false);
    expect(parseCallbackUrl(`${REDIRECT}?code=abc`, 'nonce').ok).toBe(false);
  });

  it('rejects a malformed URL rather than throwing', () => {
    expect(parseCallbackUrl('::::not a url', 'nonce').ok).toBe(false);
  });
});

describe('state comparison', () => {
  it('matches equal strings and rejects different ones', () => {
    expect(safeEquals('abc', 'abc')).toBe(true);
    expect(safeEquals('abc', 'abd')).toBe(false);
    expect(safeEquals('abc', 'abcd')).toBe(false);
    expect(safeEquals('', '')).toBe(true);
  });
});

describe('token expiry', () => {
  it('reads exp from a JWT payload', () => {
    expect(readTokenExpiry(fakeJwt({ exp: 1_700_000_000 }))).toBe(1_700_000_000);
  });

  it('returns null for a malformed token', () => {
    expect(readTokenExpiry('not.a.jwt.at.all')).toBeNull();
    expect(readTokenExpiry('onlyonepart')).toBeNull();
    expect(readTokenExpiry('a.!!!notbase64!!!.c')).toBeNull();
  });

  it('treats an unreadable token as expired — fail closed', () => {
    expect(isExpired('garbage', 0)).toBe(true);
  });

  it('refreshes early, before the token actually expires', () => {
    const exp = 1_000_000;
    // 60 s before expiry is inside the 120 s skew, so it counts as expired.
    expect(isExpired(fakeJwt({ exp }), exp - 60)).toBe(true);
    // 10 minutes before expiry is still good.
    expect(isExpired(fakeJwt({ exp }), exp - 600)).toBe(false);
  });
});
