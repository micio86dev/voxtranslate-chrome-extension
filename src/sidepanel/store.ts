/**
 * The side panel's only connection to the rest of the extension.
 *
 * Components read `state` and call intents — they never talk to chrome.* directly and
 * they contain no business logic. That keeps the Vue layer swappable and keeps the
 * decisions (what a session costs, whether it may start) in the background worker where
 * they can be tested.
 */

import { readonly, ref } from 'vue';
import { ACCOUNT_REFRESH_MIN_INTERVAL_MS, PREFERENCE_DEBOUNCE_MS } from '@/shared/config';
import {
  DEFAULT_PREFERENCES,
  type BackgroundEvent,
  type ExtensionPreferences,
  type PanelRequest,
  type PanelState,
} from '@/shared/messaging';
import type { Catalogue } from '@/preferences/language';
import { initialMeter, snapshot } from '@/usage/meter';

const EMPTY_STATE: PanelState = {
  session: 'logged_out',
  sessionId: null,
  error: null,
  errorCode: null,
  account: null,
  preferences: { ...DEFAULT_PREFERENCES },
  usage: snapshot(initialMeter()),
  audioMode: 'translating',
  detectedLanguage: null,
  lowBalance: false,
  tabTitle: null,
};

const EMPTY_CATALOGUE: Catalogue = { regions: [], languages: [], tiers: {} };

const state = ref<PanelState>(EMPTY_STATE);

/**
 * The language catalogue, held as a REF rather than read from `@/preferences/language`.
 *
 * That module's catalogue is module-global state hydrated by the service worker, and the
 * panel is a different JS realm: its copy is permanently empty. On top of that a plain
 * `let` is invisible to Vue, so a computed reading it would never re-run when the answer
 * lands. Both language pickers were blank for exactly these two reasons.
 */
const catalogue = ref<Catalogue>(EMPTY_CATALOGUE);
let lastRefreshAt = 0;
let preferenceTimer: ReturnType<typeof setTimeout> | null = null;
let pendingPatch: Partial<ExtensionPreferences> = {};

function send(request: PanelRequest): void {
  void chrome.runtime.sendMessage(request).catch(() => {
    // The worker was asleep; Chrome wakes it and the next GET_STATE reconciles.
  });
}

/** Pull the served catalogue from the worker, which owns the fetch and the cache. */
async function loadCatalogue(): Promise<void> {
  try {
    const next = (await chrome.runtime.sendMessage({ kind: 'GET_CATALOGUE' })) as
      Catalogue | undefined;
    if (next?.languages?.length) catalogue.value = next;
  } catch {
    // The worker was asleep. Chrome wakes it; the pickers stay empty until then, which is
    // honest — an empty picker is visibly broken, a guessed one is invisibly wrong.
  }
}

export function useSession() {
  return {
    state: readonly(state),
    catalogue: readonly(catalogue),

    async init(): Promise<void> {
      chrome.runtime.onMessage.addListener((message: BackgroundEvent) => {
        if (message?.kind === 'STATE') state.value = message.state;
        return false;
      });
      const current = (await chrome.runtime.sendMessage({ kind: 'GET_STATE' })) as
        PanelState | undefined;
      if (current) state.value = current;
      // Not awaited with the state above: the catalogue reply waits on the worker's
      // fetch, and the panel must paint the account and controls before then.
      void loadCatalogue();
    },

    loadCatalogue,

    login: () => send({ kind: 'LOGIN' }),
    logout: () => send({ kind: 'LOGOUT' }),
    start: () => send({ kind: 'START_SESSION' }),
    stop: () => send({ kind: 'STOP_SESSION' }),
    resetCounter: () => send({ kind: 'RESET_USAGE_COUNTER' }),

    /** Throttled so returning from a purchase refreshes, but focus churn does not. */
    refreshAccount(force = false): void {
      const now = Date.now();
      if (!force && now - lastRefreshAt < ACCOUNT_REFRESH_MIN_INTERVAL_MS) return;
      lastRefreshAt = now;
      send({ kind: 'REFRESH_ACCOUNT' });
    },

    /**
     * Debounced: dragging the volume slider must not fire a request per pixel.
     * The local value updates immediately so the UI stays responsive.
     */
    updatePreferences(patch: Partial<ExtensionPreferences>): void {
      state.value = { ...state.value, preferences: { ...state.value.preferences, ...patch } };
      pendingPatch = { ...pendingPatch, ...patch };
      if (preferenceTimer) clearTimeout(preferenceTimer);
      preferenceTimer = setTimeout(() => {
        send({ kind: 'UPDATE_PREFERENCES', patch: pendingPatch });
        pendingPatch = {};
        preferenceTimer = null;
      }, PREFERENCE_DEBOUNCE_MS);
    },
  };
}
