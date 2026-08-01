/**
 * Token acquisition and storage.
 *
 * Storage choice: `chrome.storage.session` for the token (in-memory, cleared when the
 * browser closes, never written to disk) with `chrome.storage.local` holding only the
 * non-secret profile cache. A refresh token would need durable storage — we don't have
 * one (see docs/discovery.md §2), so the stricter option costs us nothing.
 */

import { authorizeUrl } from '@/shared/config';
import { VoxError } from '@/shared/errors';
import { createPkcePair, createStateNonce, isExpired, parseCallbackUrl } from './pkce';
import type { ApiClient, UserProfile } from '@/api/client';

const TOKEN_KEY = 'vox.session.token';
const PROFILE_KEY = 'vox.profile';

export async function readToken(): Promise<string | null> {
  const stored = await chrome.storage.session.get(TOKEN_KEY);
  const token = stored[TOKEN_KEY];
  if (typeof token !== 'string' || !token) return null;
  // Fail closed: an expired or unreadable token is discarded rather than sent.
  if (isExpired(token, Math.floor(Date.now() / 1000))) {
    await clearSession();
    return null;
  }
  return token;
}

async function writeToken(token: string): Promise<void> {
  await chrome.storage.session.set({ [TOKEN_KEY]: token });
}

export async function readCachedProfile(): Promise<UserProfile | null> {
  const stored = await chrome.storage.local.get(PROFILE_KEY);
  const profile = stored[PROFILE_KEY];
  return profile && typeof profile === 'object' ? (profile as UserProfile) : null;
}

export async function cacheProfile(profile: UserProfile): Promise<void> {
  await chrome.storage.local.set({ [PROFILE_KEY]: profile });
}

/**
 * Clear every trace of the session.
 *
 * There is no server-side revocation endpoint in VoxTranslate today — for any client,
 * not just this one — so logout is local. This is documented in PRIVACY.md rather than
 * quietly glossed over.
 */
export async function clearSession(): Promise<void> {
  await chrome.storage.session.remove(TOKEN_KEY);
  await chrome.storage.local.remove(PROFILE_KEY);
}

/**
 * Run the interactive login: PKCE pair → launchWebAuthFlow → code exchange.
 *
 * The token only ever arrives in the POST response body. `parseCallbackUrl` actively
 * refuses a callback carrying a token in the URL, so a backend regression fails loudly
 * instead of silently writing a credential into browser history.
 */
export async function login(api: ApiClient): Promise<UserProfile> {
  const { verifier, challenge } = await createPkcePair();
  const state = createStateNonce();
  const redirectUri = chrome.identity.getRedirectURL();

  let redirectUrl: string | undefined;
  try {
    redirectUrl = await chrome.identity.launchWebAuthFlow({
      url: authorizeUrl({ challenge, state, redirectUri }),
      interactive: true,
    });
  } catch (cause) {
    // User closed the window, or Chrome refused the flow.
    throw new VoxError('auth_failed', String(cause));
  }
  if (!redirectUrl) throw new VoxError('auth_failed', 'no redirect URL returned');

  const parsed = parseCallbackUrl(redirectUrl, state);
  if (!parsed.ok) throw new VoxError('auth_failed', parsed.reason);

  const { token, user } = await api.exchangeCode(parsed.params.code, verifier);
  await writeToken(token);
  await cacheProfile(user);
  return user;
}
