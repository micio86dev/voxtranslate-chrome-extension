/**
 * Service worker: the session orchestrator.
 *
 * It owns the state machine and the account, and it is the ONLY component that decides
 * whether a session may start. The side panel expresses intent; the offscreen document
 * owns hardware; this file arbitrates between them.
 *
 * MV3 workers are killed aggressively, so nothing important lives only in a closure —
 * durable state is re-derivable from storage on wake, and in-flight session state is
 * intentionally lost (a killed worker means the session is over anyway, and the
 * offscreen document is torn down with it).
 */

import { ApiClient } from '@/api/client';
import { clearSession, login, readToken } from '@/auth/session';
import {
  applyDetection,
  initialLanguageMode,
  originalAudioGain,
  type LanguageModeState,
} from '@/audio/language-mode';
import { WS_ORIGIN } from '@/shared/config';
import { fromServerCode, VoxError, type ErrorCode } from '@/shared/errors';
import {
  DEFAULT_PREFERENCES,
  type AccountSnapshot,
  type ExtensionPreferences,
  type OffscreenEvent,
  type OverlayCommand,
  type PanelRequest,
  type PanelState,
} from '@/shared/messaging';
import {
  initialContext,
  transition,
  type SessionContext,
  type SessionEvent,
} from '@/state/session-machine';
import { resolveTargetLanguage } from '@/preferences/language';
import {
  applyBalanceUpdate,
  beginSession,
  initialMeter,
  resetCounter,
  snapshot,
  type MeterState,
} from '@/usage/meter';
import { parseServerMessage } from '@/websocket/validate';

const PREFS_KEY = 'vox.preferences';
const OFFSCREEN_PATH = 'offscreen/document.html';

interface Runtime {
  session: SessionContext;
  meter: MeterState;
  languageMode: LanguageModeState;
  account: AccountSnapshot | null;
  preferences: ExtensionPreferences;
  errorCode: ErrorCode | null;
  lowBalance: boolean;
  capturedTabId: number | null;
  tabTitle: string | null;
}

const runtime: Runtime = {
  session: initialContext(false),
  meter: initialMeter(),
  languageMode: initialLanguageMode(),
  account: null,
  preferences: { ...DEFAULT_PREFERENCES },
  errorCode: null,
  lowBalance: false,
  capturedTabId: null,
  tabTitle: null,
};

const api = new ApiClient(readToken, () => {
  void handleAuthLost();
});

// --- state plumbing --------------------------------------------------------

function currentPanelState(): PanelState {
  return {
    session: runtime.session.state,
    sessionId: runtime.session.sessionId,
    error: runtime.session.error,
    errorCode: runtime.errorCode,
    account: runtime.account,
    preferences: runtime.preferences,
    usage: snapshot(runtime.meter),
    audioMode: runtime.languageMode.mode,
    detectedLanguage: runtime.languageMode.detected,
    lowBalance: runtime.lowBalance,
    tabTitle: runtime.tabTitle,
  };
}

function broadcast(): void {
  void chrome.runtime.sendMessage({ kind: 'STATE', state: currentPanelState() }).catch(() => {
    // The side panel is closed. State is pulled fresh on open, so this is expected.
  });
}

function dispatch(event: SessionEvent, newSessionId?: string): boolean {
  const result = transition(runtime.session, event, newSessionId);
  runtime.session = result.context;
  if (result.accepted) broadcast();
  return result.accepted;
}

function fail(code: ErrorCode, detail?: string): void {
  runtime.errorCode = code;
  console.warn('[voxtranslate]', code, detail ?? '');
  dispatch({ type: 'FATAL', reason: code });
}

// --- preferences -----------------------------------------------------------

async function loadPreferences(): Promise<void> {
  const stored = await chrome.storage.local.get(PREFS_KEY);
  const saved = stored[PREFS_KEY];
  runtime.preferences = {
    ...DEFAULT_PREFERENCES,
    ...(saved && typeof saved === 'object' ? (saved as Partial<ExtensionPreferences>) : {}),
  };
}

async function savePreferences(patch: Partial<ExtensionPreferences>): Promise<void> {
  runtime.preferences = { ...runtime.preferences, ...patch };
  await chrome.storage.local.set({ [PREFS_KEY]: runtime.preferences });

  // The backend is the cross-device source of truth for the target language, so a
  // change is pushed up; local storage is only a cache.
  if (patch.targetLanguage) {
    try {
      await api.setLanguage(patch.targetLanguage);
    } catch (cause) {
      // A failed preference sync must not break the session — the local value still
      // applies, it just won't follow the user to another device yet.
      console.warn('[voxtranslate] preference sync failed', cause);
    }
  }

  if (patch.originalAudioVolume !== undefined && runtime.session.sessionId) {
    void chrome.runtime.sendMessage({
      kind: 'SET_ORIGINAL_VOLUME',
      sessionId: runtime.session.sessionId,
      volume: effectiveGain(),
    });
  }
  broadcast();
}

function effectiveGain(): number {
  return originalAudioGain({
    mode: runtime.languageMode.mode,
    preferredGain: runtime.preferences.originalAudioVolume,
    translatedAudioActive: false,
    translatedAudioDegraded: !runtime.preferences.translatedAudioEnabled,
  });
}

// --- account ---------------------------------------------------------------

async function syncAccount(): Promise<void> {
  const token = await readToken();
  if (!token) {
    runtime.account = null;
    dispatch({ type: 'LOGGED_OUT' });
    return;
  }

  const [profile, engines] = await Promise.all([api.me(), api.engines()]);

  // The account preference wins over the local cache — that is what makes settings
  // follow the user across devices.
  const targetLanguage = resolveTargetLanguage({
    accountPreference: profile.language,
    uiLanguage: chrome.i18n.getUILanguage(),
  });
  if (targetLanguage !== runtime.preferences.targetLanguage) {
    runtime.preferences = { ...runtime.preferences, targetLanguage };
    await chrome.storage.local.set({ [PREFS_KEY]: runtime.preferences });
  }

  runtime.account = {
    user: {
      id: profile.id,
      email: profile.email,
      name: profile.name,
      avatar_url: profile.avatar_url,
    },
    balance: profile.balance,
    engines,
    preferences: runtime.preferences,
  };
  runtime.meter = applyBalanceUpdate(runtime.meter, profile.balance, Date.now());
  broadcast();
}

async function handleAuthLost(): Promise<void> {
  await clearSession();
  runtime.account = null;
  runtime.errorCode = 'auth_expired';
  await stopSession();
  dispatch({ type: 'LOGGED_OUT' });
}

// --- session lifecycle -----------------------------------------------------

/**
 * Promise wrapper for `tabCapture.getMediaStreamId`.
 *
 * The API is callback-style in the shipped typings, and a failure surfaces through
 * `chrome.runtime.lastError` rather than a thrown exception — so without this wrapper a
 * denied capture would silently produce an undefined stream id instead of an error.
 */
function getMediaStreamId(targetTabId: number): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId }, (streamId?: string) => {
      const failure = chrome.runtime.lastError;
      if (failure || !streamId) {
        reject(new Error(failure?.message ?? 'no stream id returned'));
        return;
      }
      resolve(streamId);
    });
  });
}

async function ensureOffscreen(): Promise<void> {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
  });
  if (existing.length > 0) return;

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['USER_MEDIA' as chrome.offscreen.Reason],
    justification:
      'Capturing and streaming the active tab’s audio requires a long-lived AudioContext, ' +
      'which an MV3 service worker cannot hold.',
  });
}

function buildWsUrl(sessionId: string, token: string): string {
  // Room is derived from the session id: an extension session is a private room of one,
  // never joinable and never listed publicly.
  const params = new URLSearchParams({
    room: `ext-${sessionId}`,
    lang: runtime.preferences.targetLanguage,
    token,
    engine: runtime.preferences.engineId,
    name: 'Tab audio',
    public: 'false',
    client: 'chrome-extension',
    source: runtime.preferences.sourceLanguage,
  });
  return `${WS_ORIGIN}/ws?${params.toString()}`;
}

async function startSession(): Promise<void> {
  const sessionId = crypto.randomUUID();
  // The state machine is the guard against a double start: if it refuses, we stop here
  // and never touch the tab or the socket.
  if (!dispatch({ type: 'START_REQUESTED' }, sessionId)) {
    runtime.errorCode = 'already_running';
    broadcast();
    return;
  }

  runtime.errorCode = null;
  runtime.languageMode = initialLanguageMode();

  const token = await readToken();
  if (!token) {
    await handleAuthLost();
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    fail('tab_unavailable', 'no active tab');
    return;
  }
  runtime.capturedTabId = tab.id;
  runtime.tabTitle = tab.title ?? null;

  let streamId: string;
  try {
    streamId = await getMediaStreamId(tab.id);
  } catch (cause) {
    dispatch({ type: 'CAPTURE_DENIED', reason: 'capture_denied' });
    runtime.errorCode = 'capture_denied';
    console.warn('[voxtranslate] getMediaStreamId failed', cause);
    broadcast();
    return;
  }

  dispatch({ type: 'CAPTURE_GRANTED' });

  if (runtime.preferences.subtitlesEnabled) await injectOverlay(tab.id);

  await ensureOffscreen();
  runtime.meter = beginSession(runtime.meter, runtime.account?.balance ?? 0, Date.now());

  await chrome.runtime.sendMessage({
    kind: 'START_CAPTURE',
    sessionId,
    streamId,
    wsUrl: buildWsUrl(sessionId, token),
    originalVolume: effectiveGain(),
    translatedAudioEnabled: runtime.preferences.translatedAudioEnabled,
  });
}

async function injectOverlay(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/overlay.js'] });
    await sendToTab(tabId, {
      kind: 'OVERLAY_SHOW',
      options: {
        fontSize: runtime.preferences.subtitleFontSize,
        bottomOffset: runtime.preferences.subtitleBottomOffset,
        dualLanguage: runtime.preferences.dualLanguageSubtitles,
      },
    });
  } catch (cause) {
    // A page that forbids injection (chrome://, the Web Store) still gets audio
    // translation — only the on-page overlay is unavailable. Not fatal.
    console.warn('[voxtranslate] overlay injection unavailable', cause);
  }
}

async function sendToTab(tabId: number, command: OverlayCommand): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, command);
  } catch {
    // The tab navigated or closed; the session teardown path handles it.
  }
}

async function stopSession(): Promise<void> {
  const sessionId = runtime.session.sessionId;
  if (!dispatch({ type: 'STOP_REQUESTED' })) return;

  if (sessionId) {
    void chrome.runtime.sendMessage({ kind: 'STOP_CAPTURE', sessionId }).catch(() => {});
  }
  if (runtime.capturedTabId !== null) {
    await sendToTab(runtime.capturedTabId, { kind: 'OVERLAY_HIDE' });
    runtime.capturedTabId = null;
  }
  runtime.tabTitle = null;
}

// --- inbound server frames -------------------------------------------------

function handleServerFrame(sessionId: string, raw: string): void {
  // Stale-session rejection: a frame from a previous session must never move state,
  // update usage, or render a subtitle.
  if (runtime.session.sessionId !== sessionId) return;

  const parsed = parseServerMessage(raw);
  if (!parsed.ok) {
    console.warn('[voxtranslate] rejected frame:', parsed.reason);
    return;
  }
  const message = parsed.message;

  switch (message.type) {
    case 'subtitle_interim': {
      if (!('text' in message)) break;
      void renderSubtitle(message.text, null, null);
      break;
    }
    case 'subtitle_final': {
      if (!('original' in message)) break;
      const target = runtime.preferences.targetLanguage;
      const translated = message.translations[target] ?? null;
      void renderSubtitle(
        null,
        translated ?? message.original,
        runtime.preferences.dualLanguageSubtitles && translated ? message.original : null,
      );
      break;
    }
    case 'language_detected': {
      if (!('lang' in message)) break;
      const previous = runtime.languageMode.mode;
      runtime.languageMode = applyDetection(
        runtime.languageMode,
        {
          lang: message.lang,
          ...(typeof message.confidence === 'number' ? { confidence: message.confidence } : {}),
          at: Date.now(),
        },
        runtime.preferences.targetLanguage,
      );
      if (runtime.languageMode.mode !== previous) applyAudioMode();
      broadcast();
      break;
    }
    case 'balance_update': {
      if (!('balance' in message)) break;
      runtime.meter = applyBalanceUpdate(runtime.meter, message.balance, Date.now());
      if (runtime.account) runtime.account = { ...runtime.account, balance: message.balance };
      broadcast();
      break;
    }
    case 'low_balance': {
      runtime.lowBalance = true;
      broadcast();
      break;
    }
    case 'balance_exhausted': {
      runtime.errorCode = 'insufficient_balance';
      dispatch({ type: 'CREDITS_EXHAUSTED' });
      void stopSession();
      break;
    }
    case 'error': {
      if (!('message' in message)) break;
      const code = fromServerCode('code' in message ? message.code : undefined);
      runtime.errorCode = code;
      broadcast();
      break;
    }
    default:
      break;
  }
}

function applyAudioMode(): void {
  const sessionId = runtime.session.sessionId;
  if (!sessionId) return;
  void chrome.runtime.sendMessage({
    kind: 'SET_ORIGINAL_VOLUME',
    sessionId,
    volume: effectiveGain(),
  });
  if (runtime.capturedTabId !== null) {
    void sendToTab(runtime.capturedTabId, {
      kind: 'OVERLAY_STATUS',
      text:
        runtime.languageMode.mode === 'bypassed'
          ? 'Already in your language — translation paused'
          : null,
    });
  }
}

async function renderSubtitle(
  partial: string | null,
  final: string | null,
  original: string | null,
): Promise<void> {
  if (!runtime.preferences.subtitlesEnabled || runtime.capturedTabId === null) return;
  await sendToTab(runtime.capturedTabId, { kind: 'OVERLAY_UPDATE', partial, final, original });
}

// --- wiring ----------------------------------------------------------------

chrome.runtime.onMessage.addListener(
  (message: PanelRequest | OffscreenEvent, _sender, sendResponse) => {
    if ('kind' in message) {
      switch (message.kind) {
        // --- offscreen events ---
        case 'SOCKET_OPEN':
          if (runtime.session.sessionId === message.sessionId) dispatch({ type: 'SOCKET_OPEN' });
          return false;
        case 'SOCKET_CLOSED':
          if (runtime.session.sessionId === message.sessionId) {
            dispatch({ type: 'SOCKET_CLOSED', recoverable: false });
            void stopSession();
          }
          return false;
        case 'SERVER_FRAME':
          handleServerFrame(message.sessionId, message.raw);
          return false;
        case 'CAPTURE_FAILED':
          if (runtime.session.sessionId === message.sessionId) {
            fail(message.code as ErrorCode, message.reason);
            void stopSession();
          }
          return false;
        case 'TEARDOWN_COMPLETE':
          dispatch({ type: 'TEARDOWN_COMPLETE' });
          return false;

        // --- panel requests ---
        case 'GET_STATE':
          sendResponse(currentPanelState());
          return false;
        case 'LOGIN':
          dispatch({ type: 'LOGIN_STARTED' });
          void login(api)
            .then(async () => {
              dispatch({ type: 'LOGIN_SUCCEEDED' });
              await syncAccount();
            })
            .catch((cause: unknown) => {
              const code = cause instanceof VoxError ? cause.code : 'auth_failed';
              runtime.errorCode = code;
              dispatch({ type: 'LOGIN_FAILED', reason: code });
            });
          return false;
        case 'LOGOUT':
          void (async () => {
            await stopSession();
            await clearSession();
            runtime.account = null;
            dispatch({ type: 'LOGGED_OUT' });
          })();
          return false;
        case 'REFRESH_ACCOUNT':
          void syncAccount().catch((cause: unknown) => {
            runtime.errorCode = cause instanceof VoxError ? cause.code : 'backend_unavailable';
            broadcast();
          });
          return false;
        case 'START_SESSION':
          void startSession();
          return false;
        case 'STOP_SESSION':
          void stopSession();
          return false;
        case 'RESET_USAGE_COUNTER':
          runtime.meter = resetCounter(runtime.meter);
          broadcast();
          return false;
        case 'UPDATE_PREFERENCES':
          void savePreferences(message.patch);
          return false;
        default:
          return false;
      }
    }
    return false;
  },
);

/** The captured tab going away must end the session — not leave a zombie pipeline. */
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === runtime.capturedTabId) {
    runtime.errorCode = 'tab_closed';
    void stopSession();
  }
});

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

void (async () => {
  await loadPreferences();
  const token = await readToken();
  runtime.session = initialContext(Boolean(token));
  if (token) await syncAccount().catch(() => {});
})();
