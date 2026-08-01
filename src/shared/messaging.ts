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
    }
  | { kind: 'STOP_CAPTURE'; sessionId: string }
  | { kind: 'SET_ORIGINAL_VOLUME'; sessionId: string; volume: number }
  | { kind: 'SET_TRANSLATED_AUDIO'; sessionId: string; enabled: boolean };

export type OffscreenEvent =
  | { kind: 'CAPTURE_STARTED'; sessionId: string }
  | { kind: 'CAPTURE_FAILED'; sessionId: string; reason: string; code: string }
  | { kind: 'SOCKET_OPEN'; sessionId: string }
  | { kind: 'SOCKET_CLOSED'; sessionId: string; code: number; serverCode?: string }
  | { kind: 'SERVER_FRAME'; sessionId: string; raw: string }
  | { kind: 'TEARDOWN_COMPLETE'; sessionId: string };

// --- background → content script ------------------------------------------

export type OverlayCommand =
  | { kind: 'OVERLAY_SHOW'; options: OverlayOptions }
  | {
      kind: 'OVERLAY_UPDATE';
      partial: string | null;
      final: string | null;
      original: string | null;
    }
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
