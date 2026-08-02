/**
 * Build-time configuration. Values come from Vite `define` (see vite.config.ts), which
 * reads them from the environment — never hard-coded literals, so a dev build points at
 * a local backend without editing source.
 */

declare const __API_ORIGIN__: string;
declare const __APP_ORIGIN__: string;
declare const __DEV_BUILD__: boolean;
declare const __BUILD_STAMP__: string;

export const API_ORIGIN: string = __API_ORIGIN__;
export const APP_ORIGIN: string = __APP_ORIGIN__;
export const IS_DEV: boolean = __DEV_BUILD__;
/** When this bundle was built. Logged on wake so "did you rebuild?" is never a guess. */
export const BUILD_STAMP: string = __BUILD_STAMP__;

/** WebSocket origin derived from the API origin, so there is one thing to configure. */
export const WS_ORIGIN: string = API_ORIGIN.replace(/^http/, 'ws');

/**
 * Where the user goes to top up.
 *
 * There is no standalone billing page — purchasing is a modal inside the web app — so
 * this deep-links to the app with `?buy=1`, which the app turns into an open modal.
 * `source` feeds the existing acquisition attribution.
 */
export function buyCreditsUrl(): string {
  return `${APP_ORIGIN}/?buy=1&source=chrome-extension`;
}

/** The page that performs the login handoff (see docs/adr/0005-authentication.md). */
export function authorizeUrl(params: {
  challenge: string;
  state: string;
  redirectUri: string;
}): string {
  const query = new URLSearchParams({
    client: 'chrome-extension',
    code_challenge: params.challenge,
    code_challenge_method: 'S256',
    state: params.state,
    redirect_uri: params.redirectUri,
  });
  return `${APP_ORIGIN}/extension/connect?${query.toString()}`;
}

/**
 * Audio capture settings.
 *
 * These are NOT free choices — they mirror the format the backend already ingests
 * (`client/src/scripts/audio-capture.ts`, spec 0043) so Deepgram is opened with
 * `container=webm` and no server-side codec work is needed.
 */
export const AUDIO = {
  mimeType: 'audio/webm;codecs=opus',
  fallbackMimeType: 'audio/webm',
  bitsPerSecond: 32_000,
  /** Emit a chunk every 100 ms — the latency/overhead balance the web client settled on. */
  timesliceMs: 100,
} as const;

/** How long the side panel waits before re-syncing the account on focus. */
export const ACCOUNT_REFRESH_MIN_INTERVAL_MS = 30_000;

/** Debounce window for pushing preference changes to the backend. */
export const PREFERENCE_DEBOUNCE_MS = 800;
