/**
 * Typed REST client for the VoxTranslate backend.
 *
 * Only endpoints that already exist are used here (see docs/discovery.md §8), plus the
 * two small extension endpoints described in docs/adr/0005-authentication.md. Nothing
 * invents a contract the server does not have.
 */

import { API_ORIGIN } from '@/shared/config';
import { VoxError } from '@/shared/errors';
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

export class ApiClient {
  constructor(
    private readonly getToken: TokenProvider,
    private readonly onUnauthorized: () => void,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

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
