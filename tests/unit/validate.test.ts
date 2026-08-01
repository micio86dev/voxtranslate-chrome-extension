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
