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
import { DEFAULT_BACKOFF, isFatalCloseCode, nextBackoff } from '@/websocket/backoff';
import { fromServerCode, redact, VoxError, type ErrorCode } from '@/shared/errors';
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
  /** Stream id of the live capture, so a reconnect never re-requests tabCapture. */
  streamId: string | null;
  reconnect: { attempt: number; startedAt: number; timer: number | null };
  translatedAudioActive: boolean;
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
  streamId: null,
  reconnect: { attempt: 0, startedAt: 0, timer: null },
  translatedAudioActive: false,
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

  if (patch.originalAudioVolume !== undefined) pushVolume();

  if (patch.translatedAudioEnabled !== undefined && runtime.session.sessionId) {
    void chrome.runtime.sendMessage({
      kind: 'SET_TRANSLATED_AUDIO',
      sessionId: runtime.session.sessionId,
      enabled: patch.translatedAudioEnabled,
    });
  }
  broadcast();
}

function effectiveGain(): number {
  return originalAudioGain({
    mode: runtime.languageMode.mode,
    preferredGain: runtime.preferences.originalAudioVolume,
    translatedAudioActive: runtime.translatedAudioActive,
    // "Degraded" means the user asked for translated speech and is not getting it.
    // With the feature off there is nothing to degrade, so the original must not be
    // force-raised over the user's own volume choice.
    translatedAudioDegraded:
      runtime.preferences.translatedAudioEnabled && runtime.errorCode === 'translated_audio_failed',
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

  // A successful sync IS a valid session. Leaving the machine in `logged_out` here
  // would show the account in the panel while refusing to start a session.
  if (runtime.session.state === 'logged_out' || runtime.session.state === 'authenticating') {
    dispatch({ type: 'LOGIN_SUCCEEDED' });
  }
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
    // Report WHY it was refused. Reporting `already_running` when the real problem is a
    // missing session sends the user hunting for a phantom second session.
    runtime.errorCode = runtime.session.state === 'logged_out' ? 'auth_expired' : 'already_running';
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

  runtime.streamId = streamId;
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
  cancelReconnect();
  if (!dispatch({ type: 'STOP_REQUESTED' })) return;

  if (sessionId) {
    void chrome.runtime.sendMessage({ kind: 'STOP_CAPTURE', sessionId }).catch(() => {});
  }
  if (runtime.capturedTabId !== null) {
    await sendToTab(runtime.capturedTabId, { kind: 'OVERLAY_HIDE' });
    runtime.capturedTabId = null;
  }
  runtime.tabTitle = null;
  runtime.streamId = null;
  runtime.translatedAudioActive = false;
}

// --- reconnection ----------------------------------------------------------

function cancelReconnect(): void {
  if (runtime.reconnect.timer !== null) clearTimeout(runtime.reconnect.timer);
  runtime.reconnect = { attempt: 0, startedAt: 0, timer: null };
}

/**
 * Decide what to do about a dropped socket.
 *
 * Reconnection reopens ONLY the transport. Capture stays alive, because a `tabCapture`
 * stream id cannot be re-minted without another user gesture — tearing it down would
 * force the user to click Start again for a blip of network.
 *
 * Bounded on purpose: a silently reconnecting extension is one that holds a tab captured
 * while the user wonders why nothing is happening.
 */
async function handleSocketClosed(sessionId: string, code: number): Promise<void> {
  if (runtime.session.sessionId !== sessionId) return;

  // Auth, billing and deliberate closes can never succeed on retry — and retrying a
  // billing failure risks a duplicate charged session.
  if (isFatalCloseCode(code) || runtime.streamId === null) {
    dispatch({ type: 'SOCKET_CLOSED', recoverable: false });
    await stopSession();
    return;
  }

  if (runtime.reconnect.startedAt === 0) runtime.reconnect.startedAt = Date.now();
  const elapsed = Date.now() - runtime.reconnect.startedAt;
  const decision = nextBackoff(runtime.reconnect.attempt, elapsed, DEFAULT_BACKOFF);

  if (!decision.retry) {
    console.warn('[voxtranslate] giving up reconnect:', decision.reason);
    dispatch({ type: 'RECONNECT_EXHAUSTED' });
    runtime.errorCode = 'socket_disconnected';
    await stopSession();
    return;
  }

  dispatch({ type: 'SOCKET_CLOSED', recoverable: true });
  runtime.reconnect.attempt = decision.attempt;
  runtime.errorCode = 'socket_disconnected';

  // While the transport is down there is no translation, so the user must hear the
  // original rather than a ducked or silent tab.
  runtime.translatedAudioActive = false;
  pushVolume();
  await showOverlayStatus('Reconnecting…');

  runtime.reconnect.timer = setTimeout(() => {
    void resumeSocket(sessionId);
  }, decision.delayMs) as unknown as number;
  broadcast();
}

async function resumeSocket(sessionId: string): Promise<void> {
  if (runtime.session.sessionId !== sessionId) return;
  const token = await readToken();
  if (!token) {
    await handleAuthLost();
    return;
  }
  void chrome.runtime.sendMessage({
    kind: 'RECONNECT_SOCKET',
    sessionId,
    wsUrl: buildWsUrl(sessionId, token),
  });
}

function pushVolume(): void {
  const sessionId = runtime.session.sessionId;
  if (!sessionId) return;
  void chrome.runtime.sendMessage({
    kind: 'SET_ORIGINAL_VOLUME',
    sessionId,
    volume: effectiveGain(),
  });
}

async function showOverlayStatus(text: string | null): Promise<void> {
  if (runtime.capturedTabId === null) return;
  await sendToTab(runtime.capturedTabId, { kind: 'OVERLAY_STATUS', text });
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
      if (runtime.languageMode.mode !== previous) {
        // Entering bypass must silence queued translated speech immediately.
        if (runtime.languageMode.mode === 'bypassed' && runtime.session.sessionId) {
          runtime.translatedAudioActive = false;
          void chrome.runtime.sendMessage({
            kind: 'FLUSH_TRANSLATED_AUDIO',
            sessionId: runtime.session.sessionId,
          });
        }
        applyAudioMode();
      }
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
    case 'capture_format': {
      if (!('pcm' in message)) break;
      // The server decides the encoding; the client only complies. Ignoring this would
      // keep sending Opus to an engine that needs PCM, and transcription would stop.
      void chrome.runtime.sendMessage({
        kind: 'SET_PCM_MODE',
        sessionId,
        pcm: message.pcm,
      });
      break;
    }
    case 'translated_audio': {
      if (!('pcm16_b64' in message)) break;
      if (!runtime.preferences.translatedAudioEnabled) break;
      // In bypass there is nothing to translate, so any speech still in flight belongs
      // to a moment that has passed — playing it over the original is worse than a gap.
      if (runtime.languageMode.mode === 'bypassed') break;
      void chrome.runtime.sendMessage({
        kind: 'PLAY_TRANSLATED_AUDIO',
        sessionId,
        seq: message.seq,
        pcm16_b64: message.pcm16_b64,
      });
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

// --- boot ------------------------------------------------------------------

/**
 * Rehydration promise for a woken service worker.
 *
 * MV3 terminates the worker after ~30 s idle and restarts it on the next message. On
 * restart the module-level `runtime` begins at `logged_out` and is only corrected after
 * an async storage read — so a command arriving inside that window was silently dropped
 * by the state machine and surfaced as a misleading `already_running`. Every state-
 * touching handler awaits this first.
 */
const ready: Promise<void> = (async () => {
  await loadPreferences();
  const token = await readToken();
  runtime.session = initialContext(Boolean(token));
  if (token) {
    await syncAccount().catch((cause: unknown) => {
      console.warn('[voxtranslate] initial account sync failed', cause);
    });
  }
})();

// --- command handling ------------------------------------------------------

/** Panel intents. Runs only after `ready`, so it can never see half-woken state. */
async function handleCommand(request: PanelRequest): Promise<void> {
  switch (request.kind) {
    case 'LOGIN':
      dispatch({ type: 'LOGIN_STARTED' });
      try {
        await login(api);
        dispatch({ type: 'LOGIN_SUCCEEDED' });
        await syncAccount();
      } catch (cause) {
        const code = cause instanceof VoxError ? cause.code : 'auth_failed';
        console.warn('[voxtranslate] login failed', describe(cause));
        runtime.errorCode = code;
        dispatch({ type: 'LOGIN_FAILED', reason: code });
      }
      return;

    case 'LOGOUT':
      await stopSession();
      await clearSession();
      runtime.account = null;
      dispatch({ type: 'LOGGED_OUT' });
      return;

    case 'REFRESH_ACCOUNT':
      try {
        await syncAccount();
      } catch (cause) {
        // Log the real cause INCLUDING VoxError.detail: mapping every failure to
        // `backend_unavailable` without it makes a client-side bug indistinguishable
        // from an outage.
        console.warn('[voxtranslate] account sync failed', describe(cause));
        runtime.errorCode = cause instanceof VoxError ? cause.code : 'backend_unavailable';
        broadcast();
      }
      return;

    case 'START_SESSION':
      await startSession();
      return;

    case 'STOP_SESSION':
      await stopSession();
      return;

    case 'RESET_USAGE_COUNTER':
      runtime.meter = resetCounter(runtime.meter);
      broadcast();
      return;

    case 'UPDATE_PREFERENCES':
      await savePreferences(request.patch);
      return;

    case 'GET_STATE':
      // Answered directly in the listener so the response channel stays open.
      return;

    default: {
      const exhaustive: never = request;
      return exhaustive;
    }
  }
}

/** Errors reach logs with their detail, and never with a token in them. */
function describe(cause: unknown): string {
  if (cause instanceof VoxError) return redact(`${cause.code}: ${cause.detail ?? ''}`);
  return redact(String(cause));
}

/** Pipeline events from the offscreen document. Also gated on rehydration. */
function handleOffscreenEvent(event: OffscreenEvent): void {
  switch (event.kind) {
    case 'SOCKET_OPEN':
      if (runtime.session.sessionId !== event.sessionId) return;
      // A reconnect that succeeded resumes streaming; a first connect opens it.
      if (runtime.session.state === 'reconnecting') {
        dispatch({ type: 'RECONNECT_SUCCEEDED' });
        runtime.errorCode = null;
        void showOverlayStatus(null);
      } else {
        dispatch({ type: 'SOCKET_OPEN' });
      }
      cancelReconnect();
      pushVolume();
      return;
    case 'SOCKET_CLOSED':
      void handleSocketClosed(event.sessionId, event.code);
      return;
    case 'TRANSLATED_AUDIO_ACTIVE':
      if (runtime.session.sessionId !== event.sessionId) return;
      runtime.translatedAudioActive = event.active;
      pushVolume();
      return;
    case 'SERVER_FRAME':
      handleServerFrame(event.sessionId, event.raw);
      return;
    case 'CAPTURE_FAILED':
      if (runtime.session.sessionId === event.sessionId) {
        console.warn('[voxtranslate] capture failed', redact(event.reason));
        fail(event.code as ErrorCode, event.reason);
        void stopSession();
      }
      return;
    case 'CAPTURE_STARTED':
      return;
    case 'TEARDOWN_COMPLETE':
      dispatch({ type: 'TEARDOWN_COMPLETE' });
      return;
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

const PANEL_KINDS = new Set<string>([
  'LOGIN',
  'LOGOUT',
  'REFRESH_ACCOUNT',
  'START_SESSION',
  'STOP_SESSION',
  'RESET_USAGE_COUNTER',
  'UPDATE_PREFERENCES',
]);

// --- wiring ----------------------------------------------------------------

chrome.runtime.onMessage.addListener(
  (message: PanelRequest | OffscreenEvent, _sender, sendResponse) => {
    if (!message || typeof message !== 'object' || !('kind' in message)) return false;

    if (message.kind === 'GET_STATE') {
      // Must report rehydrated state, so reply asynchronously. Returning true keeps the
      // response channel open — without it Chrome closes it and the caller hangs.
      void ready.then(() => sendResponse(currentPanelState()));
      return true;
    }

    if (PANEL_KINDS.has(message.kind)) {
      void ready.then(() => handleCommand(message as PanelRequest));
      return false;
    }

    void ready.then(() => handleOffscreenEvent(message as OffscreenEvent));
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
