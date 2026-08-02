/**
 * Offscreen document entry point. Owns at most ONE pipeline at a time — the structural
 * guarantee that a single extension instance cannot run two capture sessions.
 *
 * Every command carries a session id and is ignored unless it matches the live session,
 * so a late message from a session the user already stopped can never touch the hardware.
 */

import { CapturePipeline } from './pipeline';
import type { OffscreenCommand, OffscreenEvent } from '@/shared/messaging';

let pipeline: CapturePipeline | null = null;
let activeSessionId: string | null = null;

function emit(event: OffscreenEvent): void {
  void chrome.runtime.sendMessage(event).catch(() => {
    // The service worker may be asleep; it re-reads state on wake, so a dropped
    // notification is recoverable and must not throw here.
  });
}

async function startCapture(command: Extract<OffscreenCommand, { kind: 'START_CAPTURE' }>) {
  // Defensive: the background state machine already rejects a double start, but the
  // offscreen document enforces it too, because it owns the actual hardware.
  if (pipeline) await teardown();

  activeSessionId = command.sessionId;
  const sessionId = command.sessionId;

  pipeline = new CapturePipeline(
    {
      sessionId,
      streamId: command.streamId,
      wsUrl: command.wsUrl,
      originalVolume: command.originalVolume,
      translatedAudioEnabled: command.translatedAudioEnabled,
      pcm: command.pcm,
      clientDirect: command.clientDirect,
      sourceLang: command.sourceLang,
      targetLang: command.targetLang,
    },
    {
      onSocketOpen: () => emit({ kind: 'SOCKET_OPEN', sessionId }),
      onSocketClosed: (code) => emit({ kind: 'SOCKET_CLOSED', sessionId, code }),
      onFrame: (raw) => emit({ kind: 'SERVER_FRAME', sessionId, raw }),
      onError: (reason, code) => emit({ kind: 'CAPTURE_FAILED', sessionId, reason, code }),
      onTranslatedAudioActive: (active) =>
        emit({ kind: 'TRANSLATED_AUDIO_ACTIVE', sessionId, active }),
      // Enhanced captions are produced HERE, so they never arrive as a server frame.
      onLocalSubtitle: (text, interim, original) =>
        emit({ kind: 'LOCAL_SUBTITLE', sessionId, text, interim, original }),
      fetchCartesiaSession: async () => {
        const dto = await chrome.runtime.sendMessage({ kind: 'FETCH_CARTESIA_SESSION' });
        if (!dto) return null;
        return {
          token: dto.token,
          expiresAt: dto.expires_at,
          cartesiaVersion: dto.cartesia_version,
          sttEndpoint: dto.stt.endpoint,
          sttModel: dto.stt.model,
          sttModelsByLang: dto.stt.models_by_lang ?? {},
          ttsEndpoint: dto.tts.endpoint,
          ttsModel: dto.tts.model,
          voiceCloningEnabled: dto.voice_cloning_enabled,
          defaultVoiceId: dto.default_voice_id ?? undefined,
        };
      },
    },
  );

  await pipeline.start();
  emit({ kind: 'CAPTURE_STARTED', sessionId });
}

async function teardown(): Promise<void> {
  const sessionId = activeSessionId;
  if (pipeline) await pipeline.dispose();
  pipeline = null;
  activeSessionId = null;
  if (sessionId) emit({ kind: 'TEARDOWN_COMPLETE', sessionId });
}

/** True when a command belongs to the session this document is actually running. */
function owns(sessionId: string): boolean {
  return sessionId === activeSessionId && pipeline !== null;
}

chrome.runtime.onMessage.addListener((message: OffscreenCommand) => {
  switch (message.kind) {
    case 'START_CAPTURE':
      void startCapture(message);
      break;

    case 'STOP_CAPTURE':
      // Ignore a stop aimed at a session we no longer own — a late stop must not kill
      // a session the user has already restarted.
      if (message.sessionId === activeSessionId) void teardown();
      break;

    case 'RECONNECT_SOCKET':
      if (owns(message.sessionId)) pipeline?.reconnect(message.wsUrl);
      break;

    case 'SET_ORIGINAL_VOLUME':
      if (owns(message.sessionId)) pipeline?.setOriginalVolume(message.volume);
      break;

    case 'SET_PCM_MODE':
      if (owns(message.sessionId)) void pipeline?.setPcmMode(message.pcm);
      break;

    case 'SET_TRANSLATED_AUDIO':
      if (owns(message.sessionId)) {
        void (message.enabled
          ? pipeline?.enableTranslatedAudio()
          : pipeline?.disableTranslatedAudio());
      }
      break;

    case 'PLAY_TRANSLATED_AUDIO':
      if (owns(message.sessionId)) {
        pipeline?.playTranslatedAudio({
          seq: message.seq,
          pcm16_b64: message.pcm16_b64,
          sessionId: message.sessionId,
        });
      }
      break;

    case 'FLUSH_TRANSLATED_AUDIO':
      if (owns(message.sessionId)) pipeline?.flushTranslatedAudio();
      break;

    case 'TRANSLATED_TEXT':
      if (owns(message.sessionId)) pipeline?.acceptTranslation(message.requestId, message.text);
      break;

    case 'SET_TARGET_LANG':
      if (owns(message.sessionId)) pipeline?.setTargetLanguage(message.lang);
      break;

    default: {
      const exhaustive: never = message;
      return exhaustive;
    }
  }
  // Not using the async response channel — events flow back via sendMessage.
  return false;
});
