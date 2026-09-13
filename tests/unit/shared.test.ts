import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_REFRESH_MIN_INTERVAL_MS,
  API_ORIGIN,
  AUDIO,
  APP_ORIGIN,
  BUILD_STAMP,
  IS_DEV,
  PREFERENCE_DEBOUNCE_MS,
  WS_ORIGIN,
  authorizeUrl,
  buyCreditsUrl,
} from '@/shared/config';
import { VoxError, fromServerCode, redact, userMessageFor } from '@/shared/errors';
import { CHANNEL, DEFAULT_PREFERENCES } from '@/shared/messaging';

describe('build-time config', () => {
  it('derives the WebSocket origin from the API origin, so there is one thing to configure', () => {
    expect(WS_ORIGIN).toBe(API_ORIGIN.replace(/^http/, 'ws'));
    expect(WS_ORIGIN.startsWith('ws')).toBe(true);
  });

  it('exposes the build identity the wake log prints', () => {
    expect(typeof BUILD_STAMP).toBe('string');
    expect(typeof IS_DEV).toBe('boolean');
    expect(APP_ORIGIN).toBeTruthy();
  });

  it('deep-links top-up into the app modal with acquisition attribution', () => {
    const url = new URL(buyCreditsUrl());
    expect(url.origin).toBe(new URL(APP_ORIGIN).origin);
    expect(url.searchParams.get('buy')).toBe('1');
    expect(url.searchParams.get('source')).toBe('chrome-extension');
  });

  it('builds an authorize URL carrying the S256 challenge and redirect', () => {
    const url = new URL(
      authorizeUrl({ challenge: 'chal', state: 'st', redirectUri: 'https://x.chromiumapp.org/' }),
    );
    expect(url.pathname).toBe('/extension/connect');
    expect(url.searchParams.get('client')).toBe('chrome-extension');
    expect(url.searchParams.get('code_challenge')).toBe('chal');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('st');
    expect(url.searchParams.get('redirect_uri')).toBe('https://x.chromiumapp.org/');
  });

  it('percent-encodes a redirect URI instead of breaking the query', () => {
    const url = new URL(
      authorizeUrl({ challenge: 'c', state: 's', redirectUri: 'https://x/?a=1&b=2' }),
    );
    expect(url.searchParams.get('redirect_uri')).toBe('https://x/?a=1&b=2');
  });

  it('captures in the format the backend already ingests (spec 0043)', () => {
    expect(AUDIO.mimeType).toBe('audio/webm;codecs=opus');
    expect(AUDIO.fallbackMimeType).toBe('audio/webm');
    expect(AUDIO.bitsPerSecond).toBe(32_000);
    expect(AUDIO.timesliceMs).toBe(100);
  });

  it('keeps the refresh and debounce windows positive', () => {
    expect(ACCOUNT_REFRESH_MIN_INTERVAL_MS).toBeGreaterThan(0);
    expect(PREFERENCE_DEBOUNCE_MS).toBeGreaterThan(0);
  });
});

describe('VoxError', () => {
  it('carries a code and a user-safe message', () => {
    const error = new VoxError('insufficient_balance', 'HTTP 402 on /api/user/me');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('VoxError');
    expect(error.code).toBe('insufficient_balance');
    expect(error.userMessage).toBe(error.message);
    expect(error.userMessage).toMatch(/out of credit/i);
  });

  it('keeps the internal detail off the user-facing message', () => {
    const error = new VoxError('backend_unavailable', 'wss://internal.example/secret');
    expect(error.detail).toBe('wss://internal.example/secret');
    expect(error.userMessage).not.toContain('internal.example');
  });

  it('never renders a stack trace or a provider name to the user', () => {
    for (const code of ['auth_expired', 'provider_unavailable', 'tier_unavailable'] as const) {
      const message = userMessageFor(code);
      expect(message).not.toMatch(/deepgram|groq|cartesia|qwen|openai/i);
      expect(message.length).toBeGreaterThan(0);
    }
  });

  it('falls back to the generic message for an unknown or missing code', () => {
    expect(userMessageFor(undefined)).toBe(userMessageFor('unknown'));
    expect(userMessageFor(null)).toBe(userMessageFor('unknown'));
  });
});

describe('fromServerCode', () => {
  it.each([
    ['invalid_token', 'auth_expired'],
    ['insufficient_balance', 'insufficient_balance'],
    ['banned', 'auth_failed'],
    ['unsupported_language', 'unsupported_language'],
  ])('maps the server code %s to %s', (server, expected) => {
    expect(fromServerCode(server)).toBe(expected);
  });

  it('defaults to unknown rather than guessing at a code it has never seen', () => {
    expect(fromServerCode('some_new_server_code')).toBe('unknown');
    expect(fromServerCode(undefined)).toBe('unknown');
  });
});

describe('redact', () => {
  it('strips a token query parameter', () => {
    expect(redact('wss://api/ws?token=abc123&lang=it')).toBe(
      'wss://api/ws?token=[redacted]&lang=it',
    );
  });

  it('strips a bearer credential regardless of case', () => {
    expect(redact('Authorization: bearer aBc.dEf-123')).toContain('[redacted]');
    expect(redact('Authorization: Bearer aBc.dEf-123')).not.toContain('aBc.dEf-123');
  });

  it('strips a bare JWT anywhere in the line', () => {
    const line = 'stored eyJhbGciOi.eyJzdWIiOj.sig for later';
    expect(redact(line)).toBe('stored [jwt] for later');
  });

  it('leaves an ordinary log line untouched', () => {
    expect(redact('session 42 started, 3 frames')).toBe('session 42 started, 3 frames');
  });
});

describe('messaging contracts', () => {
  it('defaults to subtitles on and translated audio off', () => {
    // Translated speech costs money and surprises people; subtitles do neither.
    expect(DEFAULT_PREFERENCES.subtitlesEnabled).toBe(true);
    expect(DEFAULT_PREFERENCES.translatedAudioEnabled).toBe(false);
  });

  it('defaults to the Standard engine with auto source detection', () => {
    expect(DEFAULT_PREFERENCES.engineId).toBe('standard');
    expect(DEFAULT_PREFERENCES.sourceLanguage).toBe('auto');
    expect(DEFAULT_PREFERENCES.targetLanguage).toBe('en');
  });

  it('ducks rather than mutes the original audio', () => {
    expect(DEFAULT_PREFERENCES.originalAudioVolume).toBeGreaterThan(0);
    expect(DEFAULT_PREFERENCES.originalAudioVolume).toBeLessThan(1);
  });

  it('names the offscreen document in one place', () => {
    expect(CHANNEL.offscreenDocument).toBe('offscreen/document.html');
  });
});
