import { describe, expect, it } from 'vitest';
import { decodePcm16, TRANSLATED_SAMPLE_RATE } from '@/offscreen/translated-audio-player';

/** Encode Int16 samples the way the server does: little-endian, base64. */
function encode(samples: number[]): string {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  samples.forEach((s, i) => view.setInt16(i * 2, s, true));
  let binary = '';
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

describe('PCM16 decoding', () => {
  it('decodes little-endian samples to normalised floats', () => {
    // Little-endian matters: reading these big-endian would produce noise, not audio.
    const decoded = decodePcm16(encode([0, 16384, -16384]));
    expect(decoded).toHaveLength(3);
    expect(decoded[0]).toBeCloseTo(0, 5);
    expect(decoded[1]).toBeCloseTo(0.5, 4);
    expect(decoded[2]).toBeCloseTo(-0.5, 4);
  });

  it('maps the extremes into [-1, 1]', () => {
    const decoded = decodePcm16(encode([32767, -32768]));
    expect(decoded[0]).toBeLessThanOrEqual(1);
    expect(decoded[0]).toBeGreaterThan(0.99);
    expect(decoded[1]).toBe(-1);
  });

  it('returns an empty buffer for empty input rather than throwing', () => {
    expect(decodePcm16('')).toHaveLength(0);
  });

  it('drops a trailing odd byte instead of misaligning the stream', () => {
    // A truncated frame must not shift every subsequent sample by one byte — that turns
    // speech into static for the rest of the segment.
    const truncated = btoa('\x00\x40\x00'); // 3 bytes = 1 whole sample + 1 stray
    expect(decodePcm16(truncated)).toHaveLength(1);
  });

  it('round-trips a longer buffer without drift', () => {
    const samples = Array.from({ length: 240 }, (_, i) => (i % 2 === 0 ? 8000 : -8000));
    const decoded = decodePcm16(encode(samples));
    expect(decoded).toHaveLength(240);
    expect(decoded[0]).toBeCloseTo(8000 / 0x8000, 5);
    expect(decoded[239]).toBeCloseTo(-8000 / 0x8000, 5);
  });

  it('pins the sample rate to what the wire carries', () => {
    // Resampling here would desync the translated voice from the subtitles.
    expect(TRANSLATED_SAMPLE_RATE).toBe(24_000);
  });
});
