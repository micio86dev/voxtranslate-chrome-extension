/**
 * Typed contracts for the three internal message channels:
 *   side panel  → background   (user intent)
 *   background  → side panel   (state)
 *   background  ↔ offscreen    (pipeline control + events)
 *   background  → content      (subtitle rendering)
 *
 * Everything is a discriminated union so a handler that forgets a case fails to compile
 * rather than silently dropping messages.
 */

import type { AudioMode } from '@/audio/language-mode';
import type { ErrorCode } from '@/shared/errors';
import type { SessionState } from '@/state/session-machine';
import type { UsageSnapshot } from '@/usage/meter';

export interface EngineInfo {
  id: string;
  display_name: string;
  tier: string;
  description: string;
  /** USD per minute charged to the user. The only price the server exposes. */
  rate_per_minute: number;
  input_languages: string[];
  output_languages: string[];
  capabilities: {
    translated_audio: boolean;
    cost_scales_per_language: boolean;
    client_direct: boolean;
    max_room_size: number;
  };
}

export interface AccountSnapshot {
  user: { id: string; email: string; name: string; avatar_url: string | null };
  /** USD. VoxTranslate consumer accounts hold dollars, not credits. */
  balance: number;
  engines: EngineInfo[];
  preferences: ExtensionPreferences;
}

export interface ExtensionPreferences {
  targetLanguage: string;
  /** Always `auto` today; kept explicit so a manual override is a one-line change. */
  sourceLanguage: string;
  engineId: string;
  subtitlesEnabled: boolean;
  translatedAudioEnabled: boolean;
  /** 0..1 */
  originalAudioVolume: number;
  subtitleFontSize: number;
  subtitleBottomOffset: number;
  dualLanguageSubtitles: boolean;
}

export const DEFAULT_PREFERENCES: ExtensionPreferences = {
  targetLanguage: 'en',
  sourceLanguage: 'auto',
  engineId: 'standard',
  subtitlesEnabled: true,
  translatedAudioEnabled: false,
  originalAudioVolume: 0.2,
  subtitleFontSize: 22,
  subtitleBottomOffset: 80,
  dualLanguageSubtitles: false,
};

// --- side panel → background ----------------------------------------------

export type PanelRequest =
  | { kind: 'GET_STATE' }
  | { kind: 'LOGIN' }
  | { kind: 'LOGOUT' }
  | { kind: 'REFRESH_ACCOUNT' }
  | { kind: 'START_SESSION' }
  | { kind: 'STOP_SESSION' }
  | { kind: 'RESET_USAGE_COUNTER' }
  | { kind: 'UPDATE_PREFERENCES'; patch: Partial<ExtensionPreferences> };

// --- background → side panel ----------------------------------------------

export interface PanelState {
  session: SessionState;
  sessionId: string | null;
  error: string | null;
  /** A stable code the panel maps to localized copy; never a raw stack trace. */
  errorCode: ErrorCode | null;
  account: AccountSnapshot | null;
  preferences: ExtensionPreferences;
  usage: UsageSnapshot;
  audioMode: AudioMode;
  detectedLanguage: string | null;
  lowBalance: boolean;
  /** Set when the captured tab is gone or unusable. */
  tabTitle: string | null;
}

export type BackgroundEvent = { kind: 'STATE'; state: PanelState };

// --- background ↔ offscreen -----------------------------------------------

export type OffscreenCommand =
  | {
      kind: 'START_CAPTURE';
      sessionId: string;
      streamId: string;
      wsUrl: string;
      originalVolume: number;
      translatedAudioEnabled: boolean;
      /**
       * Encode as PCM16/24k instead of WebM/Opus.
       *
       * Not a preference — a contract. Standard consumes WebM/Opus; the speech-to-speech
       * engines consume PCM16 and will read Opus bytes as garbage samples. The tier is
       * known before the socket opens, so the encoder is chosen up front rather than
       * waiting for the server's `capture_format`, which would race the `start` frame.
       */
      pcm: boolean;
      /** Run the provider in this browser (Cartesia "Enhanced"). */
      clientDirect: boolean;
      /** The spoken language — required for Enhanced, which cannot auto-detect. */
      sourceLang: string;
      targetLang: string;
    }
  | { kind: 'STOP_CAPTURE'; sessionId: string }
  | { kind: 'SET_ORIGINAL_VOLUME'; sessionId: string; volume: number }
  | { kind: 'SET_TRANSLATED_AUDIO'; sessionId: string; enabled: boolean }
  /** Reopen the socket only; capture and the audio graph stay alive (see pipeline.ts). */
  | { kind: 'RECONNECT_SOCKET'; sessionId: string; wsUrl: string }
  /** Server asked for a different capture encoding (`capture_format`). */
  | { kind: 'SET_PCM_MODE'; sessionId: string; pcm: boolean }
  /** One validated translated-audio frame, already checked at the network boundary. */
  | { kind: 'PLAY_TRANSLATED_AUDIO'; sessionId: string; seq: number; pcm16_b64: string }
  /** Drop pending speech — stop, reconnect, or the language bypass engaging. */
  | { kind: 'FLUSH_TRANSLATED_AUDIO'; sessionId: string }
  /**
   * Retarget a LIVE session. The server fans out translations to the languages present
   * in the room, so changing the target locally is not enough — it has to be told, or
   * it keeps producing the old language and the client finds nothing to render.
   */
  | { kind: 'SET_TARGET_LANG'; sessionId: string; lang: string }
  /** A `translated_text` reply relayed to the pending Enhanced request. */
  | { kind: 'TRANSLATED_TEXT'; sessionId: string; requestId: string; text: string };

export type OffscreenEvent =
  | { kind: 'CAPTURE_STARTED'; sessionId: string }
  | { kind: 'CAPTURE_FAILED'; sessionId: string; reason: string; code: string }
  | { kind: 'SOCKET_OPEN'; sessionId: string }
  | { kind: 'SOCKET_CLOSED'; sessionId: string; code: number; serverCode?: string }
  | { kind: 'SERVER_FRAME'; sessionId: string; raw: string }
  | { kind: 'TRANSLATED_AUDIO_ACTIVE'; sessionId: string; active: boolean }
  /** A caption produced in-browser by the Enhanced pipeline (never a server frame). */
  | { kind: 'LOCAL_SUBTITLE'; sessionId: string; text: string; interim: boolean; original?: string }
  /** Enhanced needs a Cartesia grant; only the worker holds the session token. */
  | { kind: 'FETCH_CARTESIA_SESSION' }
  | { kind: 'TEARDOWN_COMPLETE'; sessionId: string };

// --- background → content script ------------------------------------------

export type OverlayCommand =
  | { kind: 'OVERLAY_SHOW'; options: OverlayOptions }
  /**
   * Update the overlay's two lines INDEPENDENTLY.
   *
   * An omitted field leaves that line untouched; an explicit `null` clears it. A single
   * "here is the whole state" payload cannot express "a new partial arrived, keep the
   * translated line as it is" — it would blank the main line on every partial.
   */
  | { kind: 'OVERLAY_UPDATE'; main?: string | null; secondary?: string | null }
  /** Restyle a LIVE overlay: size and position must not need a session restart. */
  | { kind: 'OVERLAY_STYLE'; options: OverlayOptions }
  | { kind: 'OVERLAY_STATUS'; text: string | null }
  | { kind: 'OVERLAY_HIDE' };

export interface OverlayOptions {
  fontSize: number;
  bottomOffset: number;
  dualLanguage: boolean;
}

/** Runtime channel names, so a typo is a single-point failure rather than silent. */
export const CHANNEL = {
  offscreenDocument: 'offscreen/document.html',
} as const;
