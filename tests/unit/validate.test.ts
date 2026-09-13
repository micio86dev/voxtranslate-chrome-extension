import { describe, expect, it } from 'vitest';
import { parseServerMessage } from '@/websocket/validate';

const ok = (raw: string) => {
  const result = parseServerMessage(raw);
  if (!result.ok) throw new Error(`expected ok, got: ${result.reason}`);
  return result.message;
};

describe('inbound frame validation', () => {
  it('rejects non-JSON and non-objects', () => {
    expect(parseServerMessage('not json').ok).toBe(false);
    expect(parseServerMessage('[]').ok).toBe(false);
    expect(parseServerMessage('"a string"').ok).toBe(false);
    expect(parseServerMessage('null').ok).toBe(false);
  });

  it('rejects a frame with no type', () => {
    expect(parseServerMessage('{"text":"hi"}').ok).toBe(false);
  });

  it('parses subtitle_final with its translations map', () => {
    const msg = ok(
      JSON.stringify({
        type: 'subtitle_final',
        speaker_id: 'tab',
        speaker_name: 'Tab',
        original: 'ciao',
        lang: 'it',
        translations: { en: 'hello', es: 'hola' },
      }),
    );
    expect(msg).toMatchObject({ type: 'subtitle_final', original: 'ciao' });
    expect((msg as { translations: Record<string, string> }).translations['en']).toBe('hello');
  });

  it('rejects a translations map containing non-strings', () => {
    const bad = JSON.stringify({
      type: 'subtitle_final',
      speaker_id: 'tab',
      original: 'ciao',
      lang: 'it',
      translations: { en: 42 },
    });
    expect(parseServerMessage(bad).ok).toBe(false);
  });

  it('accepts subtitle_final with no translations yet', () => {
    const msg = ok(
      JSON.stringify({ type: 'subtitle_final', speaker_id: 'tab', original: 'x', lang: 'it' }),
    );
    expect((msg as { translations: Record<string, string> }).translations).toEqual({});
  });

  it('validates translated_audio and rejects a negative sequence', () => {
    expect(
      parseServerMessage(
        JSON.stringify({
          type: 'translated_audio',
          speaker_id: 'tab',
          lang: 'en',
          seq: -1,
          pcm16_b64: 'AAAB',
        }),
      ).ok,
    ).toBe(false);

    const good = ok(
      JSON.stringify({
        type: 'translated_audio',
        speaker_id: 'tab',
        lang: 'en',
        seq: 7,
        pcm16_b64: 'AAAB',
      }),
    );
    expect(good).toMatchObject({ seq: 7, pcm16_b64: 'AAAB' });
  });

  it('clamps an out-of-range detection confidence instead of dropping the event', () => {
    const msg = ok(
      JSON.stringify({ type: 'language_detected', peer_id: 'tab', lang: 'it', confidence: 5 }),
    );
    expect((msg as { confidence: number }).confidence).toBe(1);
  });

  it('omits confidence when the server omits it (manual set_lang)', () => {
    const msg = ok(JSON.stringify({ type: 'language_detected', peer_id: 'tab', lang: 'it' }));
    expect('confidence' in msg).toBe(false);
  });

  it('rejects a non-finite balance', () => {
    // JSON has no NaN literal, so the realistic hostile shape is a string.
    expect(parseServerMessage('{"type":"balance_update","balance":"1.0"}').ok).toBe(false);
  });

  it('keeps the error code so the UI can branch on it', () => {
    const msg = ok(
      JSON.stringify({ type: 'error', message: 'no funds', code: 'insufficient_balance' }),
    );
    expect(msg).toMatchObject({ code: 'insufficient_balance' });
  });

  it('passes through unknown message types instead of failing', () => {
    // The server sends room/WebRTC traffic this client ignores by design.
    const msg = ok('{"type":"peer_joined","peer_id":"x"}');
    expect(msg.type).toBe('peer_joined');
  });

  it('rejects an oversized subtitle rather than rendering it', () => {
    const huge = JSON.stringify({
      type: 'subtitle_interim',
      speaker_id: 'tab',
      lang: 'it',
      text: 'x'.repeat(10_000),
    });
    expect(parseServerMessage(huge).ok).toBe(false);
  });
});

describe('error copy', () => {
  it('tells the user what to DO when the capture gesture is missing', async () => {
    const { userMessageFor } = await import('@/shared/errors');
    const msg = userMessageFor('capture_needs_gesture');
    // Chrome's own wording ("Extension has not been invoked for the current page") is
    // unactionable. The copy must name the icon and the order of operations.
    expect(msg).toMatch(/icon/i);
    expect(msg).toMatch(/start/i);
  });

  it('never leaks an internal detail into user-facing copy', async () => {
    const { VoxError } = await import('@/shared/errors');
    const err = new VoxError('capture_denied', 'chromeMediaSourceId rejected at 0x7f');
    expect(err.userMessage).not.toContain('chromeMediaSourceId');
    expect(err.detail).toContain('chromeMediaSourceId');
  });
});

describe('every modelled frame type', () => {
  /** Parse and assert the frame was accepted, returning the validated message. */
  function accept(frame: Record<string, unknown>) {
    const result = parseServerMessage(JSON.stringify(frame));
    if (!result.ok) throw new Error(`expected accept, got: ${result.reason}`);
    return result.message;
  }

  /** Parse and assert the frame was rejected, returning the reason. */
  function reject(frame: unknown): string {
    const result = parseServerMessage(JSON.stringify(frame));
    if (result.ok) throw new Error('expected reject');
    return result.reason;
  }

  describe('subtitle_interim', () => {
    it('carries the speaker and defaults a missing name to empty', () => {
      expect(
        accept({ type: 'subtitle_interim', text: 'ciao', lang: 'it', speaker_id: 'p1' }),
      ).toEqual({
        type: 'subtitle_interim',
        text: 'ciao',
        lang: 'it',
        speaker_id: 'p1',
        speaker_name: '',
      });
    });

    it('keeps the original when the server sends one', () => {
      expect(
        accept({
          type: 'subtitle_interim',
          text: 'ciao',
          lang: 'it',
          speaker_id: 'p1',
          speaker_name: 'Ada',
          original: 'hello',
        }),
      ).toMatchObject({ speaker_name: 'Ada', original: 'hello' });
    });

    it('drops an oversized speaker name rather than rendering it', () => {
      expect(
        accept({
          type: 'subtitle_interim',
          text: 'ciao',
          lang: 'it',
          speaker_id: 'p1',
          speaker_name: 'x'.repeat(300),
        }),
      ).toMatchObject({ speaker_name: '' });
    });

    it('rejects a frame missing its speaker', () => {
      expect(reject({ type: 'subtitle_interim', text: 'ciao', lang: 'it' })).toContain(
        'subtitle_interim',
      );
    });

    it('rejects an over-long language tag', () => {
      expect(
        reject({ type: 'subtitle_interim', text: 'x', lang: 'x'.repeat(20), speaker_id: 'p1' }),
      ).toContain('subtitle_interim');
    });
  });

  describe('balance frames', () => {
    it('accepts balance_update and low_balance with the same shape', () => {
      expect(accept({ type: 'balance_update', balance: 3.5 })).toEqual({
        type: 'balance_update',
        balance: 3.5,
      });
      expect(accept({ type: 'low_balance', balance: 0.2 })).toEqual({
        type: 'low_balance',
        balance: 0.2,
      });
    });

    it('accepts a zero balance rather than treating it as missing', () => {
      expect(accept({ type: 'balance_update', balance: 0 })).toMatchObject({ balance: 0 });
    });

    it('rejects a low_balance with no number at all', () => {
      expect(reject({ type: 'low_balance' })).toContain('low_balance');
    });

    it('accepts balance_exhausted, which carries nothing', () => {
      expect(accept({ type: 'balance_exhausted', ignored: 1 })).toEqual({
        type: 'balance_exhausted',
      });
    });
  });

  describe('capture_format', () => {
    it('accepts an explicit boolean', () => {
      expect(accept({ type: 'capture_format', pcm: true })).toEqual({
        type: 'capture_format',
        pcm: true,
      });
      expect(accept({ type: 'capture_format', pcm: false })).toMatchObject({ pcm: false });
    });

    it('rejects a truthy non-boolean — the encoder choice must not be guessed', () => {
      expect(reject({ type: 'capture_format', pcm: 'true' })).toContain('bad pcm');
      expect(reject({ type: 'capture_format' })).toContain('bad pcm');
    });
  });

  describe('engine_downgraded', () => {
    it('keeps both tiers and defaults the optional fields', () => {
      expect(accept({ type: 'engine_downgraded', from: 'premium', to: 'standard' })).toEqual({
        type: 'engine_downgraded',
        from: 'premium',
        to: 'standard',
        peer_id: '',
        reason: '',
      });
    });

    it('keeps the peer and reason when present', () => {
      expect(
        accept({
          type: 'engine_downgraded',
          from: 'premium',
          to: 'standard',
          peer_id: 'p1',
          reason: 'at_capacity',
        }),
      ).toMatchObject({ peer_id: 'p1', reason: 'at_capacity' });
    });

    it('rejects a downgrade that does not say what it moved to', () => {
      expect(reject({ type: 'engine_downgraded', from: 'premium' })).toContain('engine_downgraded');
    });
  });

  describe('error', () => {
    it('accepts an error with no code', () => {
      expect(accept({ type: 'error', message: 'something broke' })).toEqual({
        type: 'error',
        message: 'something broke',
      });
    });

    it('rejects an error with no message', () => {
      expect(reject({ type: 'error', code: 'banned' })).toContain('bad message');
    });
  });

  describe('translated_text', () => {
    it('pairs the reply with the request that asked for it', () => {
      expect(accept({ type: 'translated_text', request_id: 'r1', text: 'ciao' })).toEqual({
        type: 'translated_text',
        request_id: 'r1',
        text: 'ciao',
      });
    });

    it('rejects a reply that cannot be routed', () => {
      expect(reject({ type: 'translated_text', text: 'ciao' })).toContain('translated_text');
    });

    it('accepts an empty translation without inventing one', () => {
      expect(accept({ type: 'translated_text', request_id: 'r1', text: '' })).toMatchObject({
        text: '',
      });
    });
  });

  describe('room_joined', () => {
    it('treats visibility as public only when the server says so explicitly', () => {
      expect(accept({ type: 'room_joined', peer_id: 'p1' })).toEqual({
        type: 'room_joined',
        peer_id: 'p1',
        public: false,
      });
      expect(accept({ type: 'room_joined', peer_id: 'p1', public: 'true' })).toMatchObject({
        public: false,
      });
      expect(accept({ type: 'room_joined', peer_id: 'p1', public: true })).toMatchObject({
        public: true,
      });
    });

    it('keeps the session id when one is issued', () => {
      expect(accept({ type: 'room_joined', peer_id: 'p1', session_id: 's1' })).toMatchObject({
        session_id: 's1',
      });
    });

    it('rejects a join with no peer id', () => {
      expect(reject({ type: 'room_joined' })).toContain('room_joined');
    });
  });

  describe('bounds', () => {
    it('rejects an audio payload beyond the memory bound', () => {
      expect(
        reject({
          type: 'translated_audio',
          pcm16_b64: 'A'.repeat(1_400_001),
          seq: 0,
          lang: 'it',
          speaker_id: 'p1',
        }),
      ).toContain('translated_audio');
    });

    it('rejects a type field long enough to be an attack rather than a typo', () => {
      expect(reject({ type: 'x'.repeat(65) })).toContain('type');
    });

    it('rejects an array frame — a list is not a message', () => {
      expect(reject([{ type: 'error', message: 'x' }])).toBe('frame is not an object');
    });
  });
});
