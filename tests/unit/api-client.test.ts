import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '@/api/client';
import { VoxError } from '@/shared/errors';

const ORIGIN = 'http://localhost:0';

/** A `fetch` stub that records its calls and replays queued responses. */
function stubFetch(responses: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error('unexpected extra fetch call');
    if (next instanceof Error) throw next;
    return next;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Header lookup that works for both a Headers instance and a plain record. */
function header(init: RequestInit, name: string): string | null {
  return new Headers(init.headers).get(name);
}

describe('ApiClient request plumbing', () => {
  it('sends the bearer token and JSON Accept header on authenticated calls', async () => {
    const { impl, calls } = stubFetch([json({ id: 'u1' })]);
    const client = new ApiClient(async () => 'tok-123', vi.fn(), impl);

    await client.me();

    expect(calls[0]?.url).toBe(`${ORIGIN}/api/user/me`);
    expect(header(calls[0]!.init, 'Authorization')).toBe('Bearer tok-123');
    expect(header(calls[0]!.init, 'Accept')).toBe('application/json');
  });

  it('refuses to call out at all when there is no stored token', async () => {
    const { impl, calls } = stubFetch([]);
    const client = new ApiClient(async () => null, vi.fn(), impl);

    await expect(client.me()).rejects.toMatchObject({ code: 'auth_expired' });
    expect(calls).toHaveLength(0);
  });

  it('omits Authorization on endpoints declared unauthenticated', async () => {
    const { impl, calls } = stubFetch([json({ engines: [] })]);
    const getToken = vi.fn(async () => 'tok');
    const client = new ApiClient(getToken, vi.fn(), impl);

    await client.engines();

    expect(header(calls[0]!.init, 'Authorization')).toBeNull();
    expect(getToken).not.toHaveBeenCalled();
  });

  it('sets Content-Type only when there is a body', async () => {
    const { impl, calls } = stubFetch([new Response(null, { status: 204 })]);
    const client = new ApiClient(async () => 'tok', vi.fn(), impl);

    await client.setLanguage('it');

    expect(header(calls[0]!.init, 'Content-Type')).toBe('application/json');
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.body).toBe(JSON.stringify({ language: 'it' }));
  });

  it('maps a network failure to backend_unavailable', async () => {
    const { impl } = stubFetch([new TypeError('Failed to fetch')]);
    const client = new ApiClient(async () => 'tok', vi.fn(), impl);

    await expect(client.me()).rejects.toMatchObject({ code: 'backend_unavailable' });
  });

  it.each([401, 403])('signals the caller to re-authenticate on HTTP %i', async (status) => {
    const { impl } = stubFetch([new Response('', { status })]);
    const onUnauthorized = vi.fn();
    const client = new ApiClient(async () => 'tok', onUnauthorized, impl);

    await expect(client.me()).rejects.toMatchObject({ code: 'auth_expired' });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('maps HTTP 402 to insufficient_balance, not a generic outage', async () => {
    const { impl } = stubFetch([new Response('', { status: 402 })]);
    const onUnauthorized = vi.fn();
    const client = new ApiClient(async () => 'tok', onUnauthorized, impl);

    await expect(client.me()).rejects.toMatchObject({ code: 'insufficient_balance' });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('maps any other non-ok status to backend_unavailable', async () => {
    const { impl } = stubFetch([new Response('', { status: 500 })]);
    const client = new ApiClient(async () => 'tok', vi.fn(), impl);

    await expect(client.me()).rejects.toMatchObject({ code: 'backend_unavailable' });
  });

  it('returns undefined for a 204 without trying to parse a body', async () => {
    const { impl } = stubFetch([new Response(null, { status: 204 })]);
    const client = new ApiClient(async () => 'tok', vi.fn(), impl);

    await expect(client.setLanguage('fr')).resolves.toBeUndefined();
  });

  it('reports malformed JSON as backend_unavailable rather than leaking a parse error', async () => {
    const { impl } = stubFetch([new Response('not json', { status: 200 })]);
    const client = new ApiClient(async () => 'tok', vi.fn(), impl);

    const error = await client.me().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VoxError);
    expect((error as VoxError).code).toBe('backend_unavailable');
    expect((error as VoxError).detail).toContain('bad JSON');
  });

  it('binds fetch to the global when none is injected', async () => {
    // Storing an unbound `fetch` and calling it as a method makes Chrome throw
    // "Illegal invocation", which looks exactly like an unreachable backend.
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(json({ engines: [] }) as unknown as Response);
    const client = new ApiClient(async () => null, vi.fn());

    await expect(client.engines()).resolves.toEqual([]);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('ApiClient endpoints', () => {
  it('me() returns the profile with its authoritative balance', async () => {
    const profile = {
      id: 'u1',
      email: 'a@b.c',
      name: 'A',
      avatar_url: null,
      balance: 4.2,
      consent_given: true,
      language: 'it',
    };
    const { impl } = stubFetch([json(profile)]);
    const client = new ApiClient(async () => 'tok', vi.fn(), impl);

    await expect(client.me()).resolves.toEqual(profile);
  });

  it('engines() unwraps the envelope', async () => {
    const { impl } = stubFetch([json({ engines: [{ id: 'standard', rate_per_minute: 0.02 }] })]);
    const client = new ApiClient(async () => null, vi.fn(), impl);

    await expect(client.engines()).resolves.toEqual([{ id: 'standard', rate_per_minute: 0.02 }]);
  });

  it('engines() falls back to an empty list when the envelope has no engines', async () => {
    const { impl } = stubFetch([json({})]);
    const client = new ApiClient(async () => null, vi.fn(), impl);

    await expect(client.engines()).resolves.toEqual([]);
  });

  it('languages() is served, never bundled, and needs no token', async () => {
    const catalogue = { languages: [], regions: [], by_tier: {} };
    const { impl, calls } = stubFetch([json(catalogue)]);
    const client = new ApiClient(async () => 'tok', vi.fn(), impl);

    await expect(client.languages()).resolves.toEqual(catalogue);
    expect(calls[0]?.url).toBe(`${ORIGIN}/api/languages`);
    expect(header(calls[0]!.init, 'Authorization')).toBeNull();
  });

  it('exchangeCode() posts the verifier unauthenticated and identifies the client', async () => {
    const { impl, calls } = stubFetch([json({ token: 't', user: { id: 'u1' } })]);
    const client = new ApiClient(async () => null, vi.fn(), impl);

    const result = await client.exchangeCode('the-code', 'the-verifier');

    expect(result.token).toBe('t');
    expect(calls[0]?.url).toBe(`${ORIGIN}/api/extension/token`);
    expect(header(calls[0]!.init, 'Authorization')).toBeNull();
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      code: 'the-code',
      code_verifier: 'the-verifier',
      client: 'chrome-extension',
    });
  });
});

describe('ApiClient.enhancedSession', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it('returns the minted Cartesia grant', async () => {
    const dto = {
      token: 'cart-token',
      expires_at: 1_800_000_000,
      cartesia_version: '2025-04-16',
      stt: { endpoint: 'wss://stt', model: 'ink-whisper' },
      tts: { endpoint: 'wss://tts', model: 'sonic-2' },
      voice_cloning_enabled: false,
    };
    const { impl, calls } = stubFetch([json(dto)]);
    const client = new ApiClient(async () => 'tok', vi.fn(), impl);

    await expect(client.enhancedSession()).resolves.toEqual(dto);
    expect(calls[0]!.init.method).toBe('POST');
  });

  it('returns null instead of throwing so the caller can fall back mid-session', async () => {
    const { impl } = stubFetch([new Response('', { status: 402 })]);
    const client = new ApiClient(async () => 'tok', vi.fn(), impl);

    await expect(client.enhancedSession()).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('returns null when the backend is unreachable', async () => {
    const { impl } = stubFetch([new TypeError('offline')]);
    const client = new ApiClient(async () => 'tok', vi.fn(), impl);

    await expect(client.enhancedSession()).resolves.toBeNull();
  });
});
