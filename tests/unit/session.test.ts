import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cacheProfile, clearSession, login, readCachedProfile, readToken } from '@/auth/session';
import type { ApiClient, UserProfile } from '@/api/client';

const REDIRECT = 'https://abcdefghijklmnop.chromiumapp.org/';

/** Unsigned JWT with the given `exp`, which is all `isExpired` reads. */
function jwtExpiringAt(exp: number): string {
  const b64 = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'HS256' })}.${b64({ exp })}.signature`;
}

/** In-memory stand-in for one `chrome.storage` area. */
function storageArea() {
  const data: Record<string, unknown> = {};
  return {
    data,
    get: vi.fn(async (key: string) => (key in data ? { [key]: data[key] } : {})),
    set: vi.fn(async (patch: Record<string, unknown>) => {
      Object.assign(data, patch);
    }),
    remove: vi.fn(async (key: string) => {
      delete data[key];
    }),
  };
}

let sessionArea: ReturnType<typeof storageArea>;
let localArea: ReturnType<typeof storageArea>;
let launchWebAuthFlow: ReturnType<typeof vi.fn>;

const PROFILE: UserProfile = {
  id: 'u1',
  email: 'a@b.c',
  name: 'A',
  avatar_url: null,
  balance: 3,
  consent_given: true,
  language: 'it',
};

beforeEach(() => {
  sessionArea = storageArea();
  localArea = storageArea();
  launchWebAuthFlow = vi.fn();
  vi.stubGlobal('chrome', {
    storage: { session: sessionArea, local: localArea },
    identity: { getRedirectURL: () => REDIRECT, launchWebAuthFlow },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('readToken', () => {
  it('returns a token that is still comfortably valid', async () => {
    const token = jwtExpiringAt(Math.floor(Date.now() / 1000) + 3600);
    sessionArea.data['vox.session.token'] = token;

    await expect(readToken()).resolves.toBe(token);
  });

  it('returns null when nothing is stored', async () => {
    await expect(readToken()).resolves.toBeNull();
  });

  it('returns null when the stored value is not a string', async () => {
    sessionArea.data['vox.session.token'] = { not: 'a token' };
    await expect(readToken()).resolves.toBeNull();
  });

  it('returns null for an empty string', async () => {
    sessionArea.data['vox.session.token'] = '';
    await expect(readToken()).resolves.toBeNull();
  });

  it('fails closed on an expired token and wipes the whole session', async () => {
    sessionArea.data['vox.session.token'] = jwtExpiringAt(Math.floor(Date.now() / 1000) - 10);
    localArea.data['vox.profile'] = PROFILE;

    await expect(readToken()).resolves.toBeNull();
    expect(sessionArea.remove).toHaveBeenCalledWith('vox.session.token');
    expect(localArea.remove).toHaveBeenCalledWith('vox.profile');
  });

  it('fails closed on an unreadable token', async () => {
    sessionArea.data['vox.session.token'] = 'not-a-jwt';
    await expect(readToken()).resolves.toBeNull();
  });
});

describe('profile cache', () => {
  it('round-trips a profile through chrome.storage.local', async () => {
    await cacheProfile(PROFILE);
    await expect(readCachedProfile()).resolves.toEqual(PROFILE);
  });

  it('returns null when nothing is cached', async () => {
    await expect(readCachedProfile()).resolves.toBeNull();
  });

  it('returns null when the cached value is not an object', async () => {
    localArea.data['vox.profile'] = 'corrupted';
    await expect(readCachedProfile()).resolves.toBeNull();
  });
});

describe('clearSession', () => {
  it('removes the token and the profile, never just one', async () => {
    sessionArea.data['vox.session.token'] = 'tok';
    localArea.data['vox.profile'] = PROFILE;

    await clearSession();

    expect(sessionArea.data['vox.session.token']).toBeUndefined();
    expect(localArea.data['vox.profile']).toBeUndefined();
  });
});

describe('login', () => {
  function apiStub(overrides: Partial<ApiClient> = {}): ApiClient {
    return {
      exchangeCode: vi.fn(async () => ({ token: jwtExpiringAt(2_000_000_000), user: PROFILE })),
      ...overrides,
    } as unknown as ApiClient;
  }

  /** Capture the `state` the flow generated, then answer with a matching callback. */
  function answerWithCode(code = 'the-code') {
    launchWebAuthFlow.mockImplementation(async ({ url }: { url: string }) => {
      const state = new URL(url).searchParams.get('state');
      return `${REDIRECT}?code=${code}&state=${state}`;
    });
  }

  it('completes PKCE, stores the token, and caches the profile', async () => {
    answerWithCode();
    const api = apiStub();

    await expect(login(api)).resolves.toEqual(PROFILE);

    expect(api.exchangeCode).toHaveBeenCalledWith('the-code', expect.any(String));
    expect(sessionArea.data['vox.session.token']).toBeTruthy();
    expect(localArea.data['vox.profile']).toEqual(PROFILE);
  });

  it('asks Chrome for an interactive flow at the authorize URL', async () => {
    answerWithCode();

    await login(apiStub());

    const arg = launchWebAuthFlow.mock.calls[0]?.[0] as { url: string; interactive: boolean };
    expect(arg.interactive).toBe(true);
    const url = new URL(arg.url);
    expect(url.pathname).toBe('/extension/connect');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
  });

  it('sends a verifier that is never the challenge on the wire', async () => {
    answerWithCode();
    const api = apiStub();

    await login(api);

    const [, verifier] = (api.exchangeCode as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string,
    ];
    const challenge = new URL(
      (launchWebAuthFlow.mock.calls[0]?.[0] as { url: string }).url,
    ).searchParams.get('code_challenge');
    expect(verifier).not.toBe(challenge);
  });

  it('reports auth_failed when the user closes the window', async () => {
    launchWebAuthFlow.mockRejectedValue(new Error('The user did not approve access.'));

    await expect(login(apiStub())).rejects.toMatchObject({ code: 'auth_failed' });
  });

  it('reports auth_failed when Chrome returns no redirect URL', async () => {
    launchWebAuthFlow.mockResolvedValue(undefined);

    await expect(login(apiStub())).rejects.toMatchObject({ code: 'auth_failed' });
  });

  it('rejects a callback whose state does not match', async () => {
    launchWebAuthFlow.mockResolvedValue(`${REDIRECT}?code=c&state=forged`);

    await expect(login(apiStub())).rejects.toMatchObject({ code: 'auth_failed' });
    expect(sessionArea.data['vox.session.token']).toBeUndefined();
  });

  it('refuses a callback that carries a token in the URL', async () => {
    // A backend regression that put the credential in browser history must fail loudly.
    launchWebAuthFlow.mockImplementation(async ({ url }: { url: string }) => {
      const state = new URL(url).searchParams.get('state');
      return `${REDIRECT}?code=c&state=${state}&access_token=leaked`;
    });

    await expect(login(apiStub())).rejects.toMatchObject({ code: 'auth_failed' });
  });

  it('does not store anything when the code exchange fails', async () => {
    answerWithCode();
    const api = apiStub({
      exchangeCode: vi.fn(async () => {
        throw new Error('boom');
      }) as unknown as ApiClient['exchangeCode'],
    });

    await expect(login(api)).rejects.toThrow('boom');
    expect(sessionArea.data['vox.session.token']).toBeUndefined();
    expect(localArea.data['vox.profile']).toBeUndefined();
  });
});
