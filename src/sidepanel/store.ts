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

const state = ref<PanelState>(EMPTY_STATE);
let lastRefreshAt = 0;
let preferenceTimer: ReturnType<typeof setTimeout> | null = null;
let pendingPatch: Partial<ExtensionPreferences> = {};

function send(request: PanelRequest): void {
  void chrome.runtime.sendMessage(request).catch(() => {
    // The worker was asleep; Chrome wakes it and the next GET_STATE reconciles.
  });
}

export function useSession() {
  return {
    state: readonly(state),

    async init(): Promise<void> {
      chrome.runtime.onMessage.addListener((message: BackgroundEvent) => {
        if (message?.kind === 'STATE') state.value = message.state;
        return false;
      });
      const current = (await chrome.runtime.sendMessage({ kind: 'GET_STATE' })) as
        PanelState | undefined;
      if (current) state.value = current;
    },

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
