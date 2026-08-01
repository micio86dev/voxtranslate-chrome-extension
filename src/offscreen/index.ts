/**
 * Offscreen document entry point. Owns at most ONE pipeline at a time — the structural
 * guarantee that a single extension instance cannot run two capture sessions.
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
    },
    {
      onSocketOpen: () => emit({ kind: 'SOCKET_OPEN', sessionId }),
      onSocketClosed: (code) => emit({ kind: 'SOCKET_CLOSED', sessionId, code }),
      onFrame: (raw) => emit({ kind: 'SERVER_FRAME', sessionId, raw }),
      onError: (reason, code) => emit({ kind: 'CAPTURE_FAILED', sessionId, reason, code }),
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

chrome.runtime.onMessage.addListener((message: OffscreenCommand) => {
  switch (message.kind) {
    case 'START_CAPTURE':
      void startCapture(message);
      break;
    case 'STOP_CAPTURE':
      // Ignore a stop aimed at a session we no longer own — a late stop must not
      // kill a session the user has already restarted.
      if (message.sessionId === activeSessionId) void teardown();
      break;
    case 'SET_ORIGINAL_VOLUME':
      if (message.sessionId === activeSessionId) pipeline?.setOriginalVolume(message.volume);
      break;
    case 'SET_TRANSLATED_AUDIO':
      // Translated-audio playback is Phase 9; the toggle is accepted and stored by the
      // background so the UI is truthful, but no audio path exists yet.
      break;
  }
  // Not using the async response channel — events flow back via sendMessage.
  return false;
});
