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

import {
  capturesPcm,
  shouldSpeakOnDevice,
  wantsTranslatedVoice,
  type VoiceCapabilities,
} from '@/shared/voice-routing';
import { ApiClient } from '@/api/client';
import { clearSession, login, readToken } from '@/auth/session';
import {
  applyDetection,
  initialLanguageMode,
  originalAudioGain,
  type LanguageModeState,
} from '@/audio/language-mode';
import { BUILD_STAMP, WS_ORIGIN } from '@/shared/config';
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
  /**
   * Captured at session start rather than read live.
   *
   * It decides where a partial goes, and reading it from the account each time meant a
   * woken worker whose account had not re-synced yet would route captions as if the tier
   * were Standard — mid-session, invisibly.
   */
  sessionTierSpeaks: boolean;
  /** Timestamp of the last caption, to notice captions stopping while audio continues. */
  lastCaptionAt: number;
  captionsPaused: boolean;
  /**
   * The tab the user last invoked the extension on, i.e. the only tab `activeTab` — and
   * therefore `tabCapture` — is granted for. Chrome offers no way to query the grant, so
   * we track the gesture ourselves in order to give an accurate error instead of a bare
   * "permission denied".
   */
  grantedTabId: number | null;
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
  sessionTierSpeaks: false,
  lastCaptionAt: 0,
  captionsPaused: false,
  grantedTabId: null,
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

  // Appearance changes apply to the RUNNING overlay. Making the user stop and restart a
  // session to read a slider's effect is the opposite of how you find the right size.
  if (
    (patch.subtitleFontSize !== undefined || patch.subtitleBottomOffset !== undefined) &&
    runtime.capturedTabId !== null
  ) {
    void sendToTab(runtime.capturedTabId, { kind: 'OVERLAY_STYLE', options: overlayOptions() });
  }

  // Turning subtitles off mid-session must clear what is on screen, not freeze it there.
  if (patch.subtitlesEnabled === false && runtime.capturedTabId !== null) {
    void sendToTab(runtime.capturedTabId, { kind: 'OVERLAY_UPDATE', main: null, secondary: null });
  }

  // A language change must reach the SERVER, not just local storage: it decides which
  // languages to translate into. Without this the session keeps producing the old one
  // and the user has to stop and start to see any effect.
  if (patch.targetLanguage && runtime.session.sessionId) {
    stopSpeaking(); // queued speech is in the previous language
    void chrome.runtime.sendMessage({
      kind: 'SET_TARGET_LANG',
      sessionId: runtime.session.sessionId,
      lang: patch.targetLanguage,
    });
    // The in-flight speech belongs to the previous language.
    void chrome.runtime.sendMessage({
      kind: 'FLUSH_TRANSLATED_AUDIO',
      sessionId: runtime.session.sessionId,
    });
  }

  if (patch.translatedAudioEnabled !== undefined && runtime.session.sessionId) {
    void chrome.runtime.sendMessage({
      kind: 'SET_TRANSLATED_AUDIO',
      sessionId: runtime.session.sessionId,
      enabled: patch.translatedAudioEnabled,
    });
  }
  broadcast();
}

/**
 * Whether the SERVER streams translated audio for the selected tier.
 *
 * This is NOT "can the user hear a voice". Standard's own description says the translated
 * voice is "synthesized on your device": the server sends subtitles only, and the client
 * speaks them. Conflating the two is why Standard appeared to have no voice at all.
 *
 * It decides two things: the capture encoding (PCM16 vs WebM/Opus) and whether to expect
 * `translated_audio` frames.
 */
function tierCapabilities(): VoiceCapabilities | undefined {
  return runtime.account?.engines.find((e) => e.id === runtime.preferences.engineId)
    ?.capabilities;
}

function tierSpeaks(): boolean {
  return capturesPcm(tierCapabilities());
}

/**
 * Whether the selected tier runs its provider in the BROWSER (Cartesia "Enhanced").
 * Such a tier sends no audio to our server; the socket carries billing and the
 * translation hop only.
 */
function tierIsClientDirect(): boolean {
  const engine = runtime.account?.engines.find((e) => e.id === runtime.preferences.engineId);
  return engine?.capabilities.client_direct === true;
}

/** The tier's behaviour for THIS session — pinned at start, see `sessionTierSpeaks`. */
function sessionSpeaks(): boolean {
  return runtime.sessionTierSpeaks;
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

function buildWsUrl(_sessionId: string, token: string): string {
  // The dedicated extension route, NOT the room `/ws`. The server builds a private
  // two-peer room internally (source + listener) so fan-out, billing and the
  // same-language bypass all work — see server/src/extension.rs.
  const params = new URLSearchParams({
    lang: runtime.preferences.targetLanguage,
    source: runtime.preferences.sourceLanguage,
    token,
    engine: runtime.preferences.engineId,
  });
  return `${WS_ORIGIN}/ws/extension?${params.toString()}`;
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

  // Fail early with an ACTIONABLE message. Without the gesture, getMediaStreamId returns
  // "Extension has not been invoked for the current page", which tells the user nothing
  // about what to do next.
  if (runtime.grantedTabId !== tab.id) {
    dispatch({ type: 'CAPTURE_DENIED', reason: 'capture_needs_gesture' });
    runtime.errorCode = 'capture_needs_gesture';
    broadcast();
    return;
  }

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
  runtime.sessionTierSpeaks = tierSpeaks();
  runtime.lastCaptionAt = Date.now();
  runtime.captionsPaused = false;
  dispatch({ type: 'CAPTURE_GRANTED' });

  if (runtime.preferences.subtitlesEnabled) await injectOverlay(tab.id);

  await ensureOffscreen();
  runtime.meter = beginSession(runtime.meter, runtime.account?.balance ?? 0, Date.now());

  await chrome.runtime.sendMessage({
    kind: 'START_CAPTURE',
    sessionId,
    streamId,
    wsUrl: buildWsUrl(sessionId, token),
    clientDirect: tierIsClientDirect(),
    sourceLang: runtime.preferences.sourceLanguage,
    targetLang: runtime.preferences.targetLanguage,
    originalVolume: effectiveGain(),
    translatedAudioEnabled: wantsTranslatedVoice(
      runtime.preferences.translatedAudioEnabled,
      tierCapabilities(),
    ),
    // The speech-to-speech tiers consume PCM16; Standard consumes WebM/Opus. Sending the
    // wrong one is not a degradation — the engine reads Opus bytes as samples and
    // produces nothing at all, with no error. The tier is known here, so the encoder is
    // decided before the socket opens rather than waiting for `capture_format`.
    pcm: tierSpeaks(),
  });
}

/** The overlay's adjustable appearance, in one place so panel and injection agree. */
function overlayOptions() {
  return {
    fontSize: runtime.preferences.subtitleFontSize,
    bottomOffset: runtime.preferences.subtitleBottomOffset,
    dualLanguage: runtime.preferences.dualLanguageSubtitles,
  };
}

async function injectOverlay(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/overlay.js'] });
    console.info('[voxtranslate] overlay injected on tab', tabId);
    await sendToTab(tabId, { kind: 'OVERLAY_SHOW', options: overlayOptions() });
  } catch (cause) {
    // A page that forbids injection (chrome://, the Web Store) still gets audio
    // translation — only the on-page overlay is unavailable. Not fatal.
    console.warn(
      '[voxtranslate] overlay injection FAILED on tab',
      tabId,
      '— audio still translates, but no subtitles will show:',
      String(cause),
    );
  }
}

/** Overlay commands are best-effort, but a failure must be VISIBLE. */
let overlayUnreachableLogged = false;
async function sendToTab(tabId: number, command: OverlayCommand): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, command);
    overlayUnreachableLogged = false;
  } catch (cause) {
    // Swallowing this silently is how subtitles "just don't appear" with no clue why:
    // if the content script never installed, every update vanishes here. Logged once
    // per outage so a navigating tab cannot flood the console.
    if (!overlayUnreachableLogged) {
      overlayUnreachableLogged = true;
      console.warn(
        '[voxtranslate] overlay unreachable on tab',
        tabId,
        '— subtitles will not render:',
        String(cause),
      );
    }
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
  stopSpeaking();
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
  // Frame TYPES only — never the transcript text, which must not reach logs. Without
  // this there is no way to tell "the server sent nothing" from "we dropped it".
  console.debug('[voxtranslate] frame:', message.type);

  switch (message.type) {
    case 'subtitle_interim': {
      if (!('text' in message)) break;
      // Whether a partial is translated depends on the ENGINE, and the frame cannot tell
      // you: the speech-to-speech engines send an already-translated caption but still
      // label it with the SOURCE language (`emit_interim_to_lang` in engine/pro.rs), and
      // they only deliver it to listeners of the target language — which is us.
      //
      // Standard is the opposite: its partials are the raw transcript, broadcast to
      // everyone. Putting THOSE on the main line is what produced subtitles alternating
      // between Italian and Spanish.
      //
      // So the engine we picked decides where a partial goes. Getting this wrong on the
      // speech tiers meant discarding the live caption entirely and showing only the
      // finals — most of the text never appeared.
      noteCaption();
      if (sessionSpeaks()) {
        // The partial IS the translation. When the frame also carries the speaker's
        // original, stream BOTH lines live: previously the original could only appear on
        // `subtitle_final`, a whole idle gap later, so dual-language subtitles looked
        // like the source lagged seconds behind its own translation.
        void renderSubtitle({
          main: message.text,
          ...(runtime.preferences.dualLanguageSubtitles && message.original
            ? { secondary: message.original }
            : {}),
        });
      } else if (runtime.preferences.dualLanguageSubtitles) {
        void renderSubtitle({ secondary: message.text });
      }
      break;
    }
    case 'subtitle_final': {
      if (!('original' in message)) break;
      noteCaption();
      const target = runtime.preferences.targetLanguage;
      const translated = message.translations[target] ?? null;

      if (translated) {
        void renderSubtitle({
          main: translated,
          secondary: runtime.preferences.dualLanguageSubtitles ? message.original : null,
        });
        speakLocally(translated);
        break;
      }

      // No usable translation for the target.
      //
      // On a speech tier that is an EXPECTED outcome, not a language mismatch: pro.rs
      // says so outright — "translated may be empty (upstream AND the Groq fallback both
      // blank) — the client then shows the original source line". Same in bypass, where
      // the speaker already uses this language. In both cases the original IS the
      // subtitle, so it belongs on the main line.
      if (runtime.languageMode.mode === 'bypassed' || sessionSpeaks()) {
        void renderSubtitle({ main: message.original, secondary: null });
      } else {
        console.debug('[voxtranslate] no translation for', target, '— showing original dimmed');
        void renderSubtitle({ main: null, secondary: message.original });
      }
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
          stopSpeaking();
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
    case 'translated_text': {
      // The Enhanced hop's reply. It belongs to the offscreen document, which owns the
      // pending request — the worker only relays it.
      if (!('request_id' in message)) break;
      void chrome.runtime.sendMessage({
        kind: 'TRANSLATED_TEXT',
        sessionId,
        requestId: (message as { request_id: string }).request_id,
        text: (message as { text: string }).text,
      });
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
      noticeCaptionsStopped();
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

/**
 * Speak a finalized translation on the device.
 *
 * Only for tiers whose voice is synthesised locally — the speech-to-speech tiers stream
 * their own audio and speaking here would double it. Segments are enqueued rather than
 * interrupting, so a fast speaker does not clip their own previous sentence, and the
 * original is ducked for as long as the voice is talking.
 */
function speakLocally(text: string): void {
  if (!shouldSpeakOnDevice(runtime.preferences.translatedAudioEnabled, tierCapabilities()))
    return;
  if (runtime.languageMode.mode === 'bypassed') return; // nothing to translate
  if (!text.trim()) return;

  chrome.tts.speak(text, {
    lang: runtime.preferences.targetLanguage,
    enqueue: true,
    onEvent: (event) => {
      if (event.type === 'start') {
        runtime.translatedAudioActive = true;
        pushVolume();
      } else if (event.type === 'end' || event.type === 'interrupted' || event.type === 'error') {
        runtime.translatedAudioActive = false;
        pushVolume();
      }
    },
  });
}

/** Stop any queued speech — on stop, on bypass, and on a language change. */
function stopSpeaking(): void {
  chrome.tts.stop();
  if (runtime.translatedAudioActive) {
    runtime.translatedAudioActive = false;
    pushVolume();
  }
}

/** A caption arrived: clear any "captions paused" notice. */
function noteCaption(): void {
  runtime.lastCaptionAt = Date.now();
  if (runtime.captionsPaused) {
    runtime.captionsPaused = false;
    void showOverlayStatus(null);
  }
}

/**
 * Audio is still arriving but captions have stopped.
 *
 * The speech-to-speech models emit their transcript and their audio as SEPARATE upstream
 * streams, and gpt-realtime-translate is documented to ship an empty output transcript
 * intermittently — the voice keeps going, the captions do not. Leaving the last line on
 * screen makes it look current when it is minutes old, so it is cleared and the reason is
 * shown. A stale subtitle is worse than none: it asserts something untrue.
 */
const CAPTIONS_STALL_MS = 8_000;
function noticeCaptionsStopped(): void {
  if (runtime.captionsPaused || !runtime.preferences.subtitlesEnabled) return;
  if (Date.now() - runtime.lastCaptionAt < CAPTIONS_STALL_MS) return;
  runtime.captionsPaused = true;
  console.warn('[voxtranslate] captions stalled while audio continues (upstream transcript gap)');
  void renderSubtitle({ main: null, secondary: null });
  void showOverlayStatus('Voice only — this tier stopped sending captions');
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

/** Update the overlay's lines. An omitted argument leaves that line untouched. */
async function renderSubtitle(update: {
  main?: string | null;
  secondary?: string | null;
}): Promise<void> {
  if (!runtime.preferences.subtitlesEnabled || runtime.capturedTabId === null) return;
  await sendToTab(runtime.capturedTabId, { kind: 'OVERLAY_UPDATE', ...update });
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
  console.info(`[voxtranslate] build ${BUILD_STAMP}`);
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

    case 'LOCAL_SUBTITLE': {
      if (runtime.session.sessionId !== event.sessionId) return;
      // Enhanced captions are produced in the browser, so they never pass through
      // handleServerFrame — but they are still captions, and the stall detector must see
      // them or it would announce "voice only" over a perfectly working tier.
      noteCaption();
      if (event.interim) {
        // Cartesia's interim IS the source text: the translation only exists once the
        // segment is finalized and has been round-tripped through our server.
        if (runtime.preferences.dualLanguageSubtitles) {
          void renderSubtitle({ secondary: event.text });
        }
      } else {
        void renderSubtitle({
          main: event.text,
          secondary: runtime.preferences.dualLanguageSubtitles ? (event.original ?? null) : null,
        });
      }
      return;
    }

    case 'FETCH_CARTESIA_SESSION':
      // Handled in the listener below, which owns the response channel.
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

    // Enhanced mints its Cartesia grant through the worker: only it holds the session
    // token, and the offscreen document must never see one.
    if (message.kind === 'FETCH_CARTESIA_SESSION') {
      void ready
        .then(() => api.enhancedSession())
        .then((dto) => sendResponse(dto))
        .catch(() => sendResponse(null));
      return true;
    }

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

/**
 * The toolbar click is the load-bearing gesture, not just UI.
 *
 * `activeTab` — and with it `tabCapture` — is granted ONLY by executing an action, a
 * context menu item, a keyboard shortcut, or an omnibox suggestion. Opening or clicking
 * inside a side panel grants nothing. So `openPanelOnActionClick` must stay OFF: letting
 * Chrome open the panel for us consumes the click, `onClicked` never fires, and capture
 * is denied forever with a message the user cannot act on.
 *
 * Instead the click lands here — granting capture for THIS tab — and we open the panel
 * ourselves. `sidePanel.open` is allowed because we are inside a user gesture.
 */
chrome.action.onClicked.addListener((tab) => {
  if (tab.id === undefined) return;
  runtime.grantedTabId = tab.id;
  runtime.errorCode = null;
  void chrome.sidePanel.open({ tabId: tab.id }).catch((cause: unknown) => {
    console.warn('[voxtranslate] could not open side panel', cause);
  });
  broadcast();
});

/**
 * The grant dies with the page: Chrome revokes `activeTab` when the tab navigates to
 * another origin or closes. Forgetting it here is what lets the panel say "click the
 * icon again" instead of failing with a denial the user cannot explain.
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === runtime.grantedTabId && changeInfo.url) {
    runtime.grantedTabId = null;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  // Explicitly OFF — see the comment on action.onClicked above.
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
});
