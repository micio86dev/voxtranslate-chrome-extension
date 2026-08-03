/**
 * Typed REST client for the VoxTranslate backend.
 *
 * Only endpoints that already exist are used here (see docs/discovery.md §8), plus the
 * two small extension endpoints described in docs/adr/0005-authentication.md. Nothing
 * invents a contract the server does not have.
 */

import { API_ORIGIN } from '@/shared/config';
import { VoxError } from '@/shared/errors';
import type { Catalogue } from '@/preferences/language';
import type { EngineInfo } from '@/shared/messaging';

export interface UserProfile {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  /** USD. */
  balance: number;
  consent_given: boolean;
  language: string | null;
}

export interface TokenResponse {
  token: string;
  user: UserProfile;
}

export type TokenProvider = () => Promise<string | null>;

/** Wire shape of `POST /api/sessions/enhanced/session` (server/src/api.rs). */
export interface CartesiaSessionDto {
  token: string;
  expires_at: number;
  cartesia_version: string;
  stt: { endpoint: string; model: string; models_by_lang?: Record<string, string> };
  tts: { endpoint: string; model: string };
  voice_cloning_enabled: boolean;
  default_voice_id?: string | null;
}

export class ApiClient {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly getToken: TokenProvider,
    private readonly onUnauthorized: () => void,
    fetchImpl?: typeof fetch,
  ) {
    // `fetch` MUST be bound to the global. Storing it as an instance property and
    // calling `this.fetchImpl(...)` rebinds `this` to the ApiClient, which Chrome
    // rejects with "Illegal invocation" — a failure that looks exactly like the
    // backend being unreachable. Caught by the e2e suite, not by unit tests, because
    // unit tests inject their own function.
    this.fetchImpl = fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  private async request<T>(
    path: string,
    init: RequestInit & { authenticated?: boolean } = {},
  ): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    if (init.body) headers.set('Content-Type', 'application/json');

    if (init.authenticated !== false) {
      const token = await this.getToken();
      if (!token) throw new VoxError('auth_expired', 'no stored token');
      headers.set('Authorization', `Bearer ${token}`);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${API_ORIGIN}${path}`, { ...init, headers });
    } catch (cause) {
      // Network-level failure: unreachable backend, DNS, offline.
      throw new VoxError('backend_unavailable', String(cause));
    }

    if (response.status === 401 || response.status === 403) {
      this.onUnauthorized();
      throw new VoxError('auth_expired', `HTTP ${response.status} on ${path}`);
    }
    if (response.status === 402) {
      throw new VoxError('insufficient_balance', `HTTP 402 on ${path}`);
    }
    if (!response.ok) {
      throw new VoxError('backend_unavailable', `HTTP ${response.status} on ${path}`);
    }

    if (response.status === 204) return undefined as T;
    try {
      return (await response.json()) as T;
    } catch (cause) {
      throw new VoxError('backend_unavailable', `bad JSON from ${path}: ${String(cause)}`);
    }
  }

  /** `GET /api/user/me` — profile + authoritative USD balance. */
  me(): Promise<UserProfile> {
    return this.request<UserProfile>('/api/user/me');
  }

  /** `GET /api/engines` — the tier catalogue, with `rate_per_minute` only. */
  async engines(): Promise<EngineInfo[]> {
    const body = await this.request<{ engines: EngineInfo[] }>('/api/engines', {
      authenticated: false,
    });
    return body.engines ?? [];
  }

  /**
   * `GET /api/languages` — the shared language catalogue (metadata, region order, and
   * the tier → output-languages map). Served rather than bundled so this extension never
   * carries its own copy to drift out of step with what the engines can actually speak.
   */
  async languages(): Promise<Catalogue> {
    return this.request<Catalogue>('/api/languages', { authenticated: false });
  }

  /**
   * `POST /api/sessions/enhanced/session` — mint a short-lived, scoped Cartesia token.
   *
   * The raw Cartesia key never reaches a client; the server mints a grant and returns the
   * public endpoints with it. Returns null when the tier is not configured or the account
   * cannot cover it, so the caller can fall back rather than throw mid-session.
   */
  async enhancedSession(): Promise<CartesiaSessionDto | null> {
    try {
      return await this.request<CartesiaSessionDto>('/api/sessions/enhanced/session', {
        method: 'POST',
        body: JSON.stringify({}),
      });
    } catch (cause) {
      console.warn('[voxtranslate] enhanced session unavailable', String(cause));
      return null;
    }
  }

  /** `POST /api/user/language` — persists the target language across devices. */
  setLanguage(language: string): Promise<void> {
    return this.request<void>('/api/user/language', {
      method: 'POST',
      body: JSON.stringify({ language }),
    });
  }

  /**
   * `POST /api/extension/token` — exchange the one-time code + PKCE verifier.
   * Unauthenticated by definition: this is what produces the token.
   */
  exchangeCode(code: string, verifier: string): Promise<TokenResponse> {
    return this.request<TokenResponse>('/api/extension/token', {
      method: 'POST',
      authenticated: false,
      body: JSON.stringify({ code, code_verifier: verifier, client: 'chrome-extension' }),
    });
  }
}
