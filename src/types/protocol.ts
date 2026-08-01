/**
 * Wire types for the VoxTranslate WebSocket, mirrored from the Rust source of truth at
 * `server/src/protocol.rs`. Field names are snake_case because serde tags them that way.
 *
 * Only the subset an extension session can actually receive is modelled here. Room /
 * WebRTC / whiteboard / game messages exist on the wire but are irrelevant to a
 * single-listener session, so they are represented by `UnknownMessage` and ignored
 * rather than being mistyped as errors.
 */

/** Language code as used across VoxTranslate (see engine/languages.json). */
export type LanguageCode = string;

/** `auto` means "let the backend detect the spoken language". */
export const AUTO_LANGUAGE = 'auto';

// --- Server → client -------------------------------------------------------

export interface SubtitleInterim {
  type: 'subtitle_interim';
  speaker_id: string;
  speaker_name: string;
  text: string;
  lang: LanguageCode;
}

export interface SubtitleFinal {
  type: 'subtitle_final';
  speaker_id: string;
  speaker_name: string;
  original: string;
  lang: LanguageCode;
  /** language code → translated text. The client renders `translations[target]`. */
  translations: Record<string, string>;
}

/**
 * PCM16 mono @ 24 kHz, base64. `seq` orders chunks within a speaker's stream; the
 * client drops out-of-order and duplicate frames (see audio/translated-audio-queue.ts).
 */
export interface TranslatedAudio {
  type: 'translated_audio';
  speaker_id: string;
  lang: LanguageCode;
  seq: number;
  pcm16_b64: string;
}

export interface LanguageDetected {
  type: 'language_detected';
  peer_id: string;
  lang: LanguageCode;
  confidence?: number;
}

export interface BalanceUpdate {
  type: 'balance_update';
  /** Remaining account balance in USD. */
  balance: number;
}

export interface LowBalance {
  type: 'low_balance';
  balance: number;
}

export interface BalanceExhausted {
  type: 'balance_exhausted';
}

/** Server tells the client which capture format to use (spec 0099). */
export interface CaptureFormat {
  type: 'capture_format';
  pcm: boolean;
}

export interface EngineDowngraded {
  type: 'engine_downgraded';
  peer_id: string;
  from: string;
  to: string;
  reason: string;
}

export interface ServerError {
  type: 'error';
  message: string;
  /** e.g. `insufficient_balance`, `invalid_token`, `banned`. */
  code?: string;
}

export interface RoomJoined {
  type: 'room_joined';
  peer_id: string;
  public: boolean;
  session_id?: string;
}

/** Any tagged message we knowingly ignore. Never treated as a protocol failure. */
export interface UnknownMessage {
  type: string;
}

export type ServerMessage =
  | RoomJoined
  | SubtitleInterim
  | SubtitleFinal
  | TranslatedAudio
  | LanguageDetected
  | BalanceUpdate
  | LowBalance
  | BalanceExhausted
  | CaptureFormat
  | EngineDowngraded
  | ServerError
  | UnknownMessage;

// --- Client → server -------------------------------------------------------

export type ClientMessage =
  { type: 'start' } | { type: 'stop' } | { type: 'set_lang'; lang: LanguageCode };

// --- Connection parameters -------------------------------------------------

/**
 * Query parameters for `GET /ws`.
 *
 * `token` travels in the query string because that is the existing VoxTranslate
 * convention (`server/src/protocol.rs` WsParams) — browsers cannot set headers on a
 * WebSocket handshake. It is a session JWT over TLS, never a refresh credential.
 */
export interface WsConnectParams {
  room: string;
  lang: LanguageCode;
  token: string;
  engine: string;
  name?: string;
  id?: string;
}
