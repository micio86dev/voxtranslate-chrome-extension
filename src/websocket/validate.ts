/**
 * Runtime validation for every inbound WebSocket frame.
 *
 * TypeScript types vanish at runtime, so a malformed or hostile frame would otherwise
 * flow straight into the UI and the audio queue. Everything crossing the network
 * boundary is validated here before it is trusted. Unknown message types are NOT
 * errors — the server sends room/WebRTC traffic an extension session doesn't care
 * about — they are simply passed through as `{ type }` for the caller to ignore.
 */

import type { ServerMessage } from '@/types/protocol';

/** Longest subtitle text we accept from the wire, to bound memory and render cost. */
const MAX_TEXT_LENGTH = 4_000;
/** Longest base64 audio payload accepted (~1 MB decoded). */
const MAX_AUDIO_B64_LENGTH = 1_400_000;

export type ValidationResult = { ok: true; message: ServerMessage } | { ok: false; reason: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown, max = MAX_TEXT_LENGTH): string | null {
  return typeof v === 'string' && v.length <= max ? v : null;
}

function finiteNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** A translations map must be flat `string → string` with bounded values. */
function translations(v: unknown): Record<string, string> | null {
  if (!isRecord(v)) return null;
  const out: Record<string, string> = {};
  for (const [k, value] of Object.entries(v)) {
    if (typeof value !== 'string' || value.length > MAX_TEXT_LENGTH) return null;
    out[k] = value;
  }
  return out;
}

/**
 * Parse and validate one raw text frame.
 *
 * Returns a discriminated result rather than throwing or returning null, so the caller
 * can log *why* a frame was rejected instead of silently swallowing it.
 */
export function parseServerMessage(raw: string): ValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'not valid JSON' };
  }
  if (!isRecord(parsed)) return { ok: false, reason: 'frame is not an object' };

  const type = str(parsed['type'], 64);
  if (!type) return { ok: false, reason: 'missing or invalid "type"' };

  switch (type) {
    case 'subtitle_interim': {
      const text = str(parsed['text']);
      const lang = str(parsed['lang'], 16);
      const speakerId = str(parsed['speaker_id'], 128);
      if (text === null || lang === null || speakerId === null) {
        return { ok: false, reason: 'subtitle_interim: bad fields' };
      }
      return {
        ok: true,
        message: {
          type: 'subtitle_interim',
          text,
          lang,
          speaker_id: speakerId,
          speaker_name: str(parsed['speaker_name'], 256) ?? '',
        },
      };
    }

    case 'subtitle_final': {
      const original = str(parsed['original']);
      const lang = str(parsed['lang'], 16);
      const speakerId = str(parsed['speaker_id'], 128);
      const tr = translations(parsed['translations'] ?? {});
      if (original === null || lang === null || speakerId === null || tr === null) {
        return { ok: false, reason: 'subtitle_final: bad fields' };
      }
      return {
        ok: true,
        message: {
          type: 'subtitle_final',
          original,
          lang,
          speaker_id: speakerId,
          speaker_name: str(parsed['speaker_name'], 256) ?? '',
          translations: tr,
        },
      };
    }

    case 'translated_audio': {
      const b64 = str(parsed['pcm16_b64'], MAX_AUDIO_B64_LENGTH);
      const seq = finiteNumber(parsed['seq']);
      const lang = str(parsed['lang'], 16);
      const speakerId = str(parsed['speaker_id'], 128);
      if (b64 === null || seq === null || seq < 0 || lang === null || speakerId === null) {
        return { ok: false, reason: 'translated_audio: bad fields' };
      }
      return {
        ok: true,
        message: { type: 'translated_audio', pcm16_b64: b64, seq, lang, speaker_id: speakerId },
      };
    }

    case 'language_detected': {
      const lang = str(parsed['lang'], 16);
      const peerId = str(parsed['peer_id'], 128);
      if (lang === null || peerId === null) {
        return { ok: false, reason: 'language_detected: bad fields' };
      }
      const confidence = finiteNumber(parsed['confidence']);
      const message: ServerMessage = {
        type: 'language_detected',
        lang,
        peer_id: peerId,
        // Confidence is optional on the wire (manual set_lang omits it). Clamp rather
        // than reject, so an out-of-range value degrades instead of dropping the event.
        ...(confidence === null ? {} : { confidence: Math.min(1, Math.max(0, confidence)) }),
      };
      return { ok: true, message };
    }

    case 'balance_update':
    case 'low_balance': {
      const balance = finiteNumber(parsed['balance']);
      if (balance === null) return { ok: false, reason: `${type}: bad balance` };
      return { ok: true, message: { type, balance } as ServerMessage };
    }

    case 'balance_exhausted':
      return { ok: true, message: { type: 'balance_exhausted' } };

    case 'capture_format': {
      if (typeof parsed['pcm'] !== 'boolean') {
        return { ok: false, reason: 'capture_format: bad pcm' };
      }
      return { ok: true, message: { type: 'capture_format', pcm: parsed['pcm'] } };
    }

    case 'engine_downgraded': {
      const from = str(parsed['from'], 64);
      const to = str(parsed['to'], 64);
      if (from === null || to === null)
        return { ok: false, reason: 'engine_downgraded: bad fields' };
      return {
        ok: true,
        message: {
          type: 'engine_downgraded',
          from,
          to,
          peer_id: str(parsed['peer_id'], 128) ?? '',
          reason: str(parsed['reason'], 128) ?? '',
        },
      };
    }

    case 'error': {
      const message = str(parsed['message'], 1_000);
      if (message === null) return { ok: false, reason: 'error: bad message' };
      const code = str(parsed['code'], 64);
      return { ok: true, message: { type: 'error', message, ...(code ? { code } : {}) } };
    }

    case 'translated_text': {
      const requestId = str(parsed['request_id'], 128);
      const text = str(parsed['text']);
      if (requestId === null || text === null) {
        return { ok: false, reason: 'translated_text: bad fields' };
      }
      return { ok: true, message: { type: 'translated_text', request_id: requestId, text } };
    }
    case 'room_joined': {
      const peerId = str(parsed['peer_id'], 128);
      if (peerId === null) return { ok: false, reason: 'room_joined: bad peer_id' };
      const sessionId = str(parsed['session_id'], 128);
      return {
        ok: true,
        message: {
          type: 'room_joined',
          peer_id: peerId,
          public: parsed['public'] === true,
          ...(sessionId ? { session_id: sessionId } : {}),
        },
      };
    }

    default:
      // Known-unknown: room/WebRTC/chat traffic this client ignores by design.
      return { ok: true, message: { type } };
  }
}
