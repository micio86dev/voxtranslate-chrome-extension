import { describe, expect, it } from 'vitest';
import {
  base64ToBytes,
  base64ToFloat32,
  base64ToInt16,
  floatTo16,
  int16ToFloat,
  shouldPlay,
} from '@/audio/pcm';

/** base64-encode raw bytes the way the server does before putting them on the wire. */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Little-endian PCM16 bytes for the given samples. */
function pcm16Bytes(samples: number[]): Uint8Array {
  const buf = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buf);
  samples.forEach((s, i) => view.setInt16(i * 2, s, true));
  return new Uint8Array(buf);
}

describe('floatTo16', () => {
  it('uses the full negative range so -1 maps to -32768', () => {
    expect(Array.from(floatTo16(new Float32Array([-1])))).toEqual([-32768]);
  });

  it('maps +1 to the largest positive sample', () => {
    expect(Array.from(floatTo16(new Float32Array([1])))).toEqual([32767]);
  });

  it('clamps samples outside [-1, 1] instead of wrapping', () => {
    const out = floatTo16(new Float32Array([2, -2, 1.0001, -1.0001]));
    expect(Array.from(out)).toEqual([32767, -32768, 32767, -32768]);
  });

  it('keeps silence at zero and preserves length', () => {
    const out = floatTo16(new Float32Array(4));
    expect(out.length).toBe(4);
    expect(Array.from(out)).toEqual([0, 0, 0, 0]);
  });

  it('returns an empty Int16Array for an empty input', () => {
    expect(floatTo16(new Float32Array(0)).length).toBe(0);
  });
});

describe('int16ToFloat', () => {
  it('inverts floatTo16 for the extremes', () => {
    expect(Array.from(int16ToFloat(new Int16Array([-32768])))).toEqual([-1]);
    expect(int16ToFloat(new Int16Array([32767]))[0]).toBeCloseTo(1, 4);
  });

  it('round-trips mid-range samples within one quantisation step', () => {
    const source = new Float32Array([0.25, -0.5, 0.75, -0.125]);
    const back = int16ToFloat(floatTo16(source));
    for (let i = 0; i < source.length; i++) {
      expect(back[i]).toBeCloseTo(source[i] as number, 3);
    }
  });
});

describe('base64ToBytes', () => {
  it('decodes to the exact byte sequence', () => {
    expect(Array.from(base64ToBytes(bytesToBase64(new Uint8Array([0, 1, 254, 255]))))).toEqual([
      0, 1, 254, 255,
    ]);
  });

  it('decodes the empty string to zero bytes', () => {
    expect(base64ToBytes('').length).toBe(0);
  });
});

describe('base64ToInt16', () => {
  it('reads little-endian PCM16 samples', () => {
    const b64 = bytesToBase64(pcm16Bytes([0, 1, -1, 32767, -32768]));
    expect(Array.from(base64ToInt16(b64))).toEqual([0, 1, -1, 32767, -32768]);
  });

  it('drops a trailing odd byte rather than throwing', () => {
    const bytes = new Uint8Array([...pcm16Bytes([123]), 0x7f]);
    const out = base64ToInt16(bytesToBase64(bytes));
    expect(Array.from(out)).toEqual([123]);
  });

  it('returns no samples for an empty payload', () => {
    expect(base64ToInt16('').length).toBe(0);
  });
});

describe('base64ToFloat32', () => {
  it('decodes straight to playback-ready floats', () => {
    const out = base64ToFloat32(bytesToBase64(pcm16Bytes([-32768, 0, 16384])));
    expect(out[0]).toBe(-1);
    expect(out[1]).toBe(0);
    expect(out[2]).toBeCloseTo(0.5, 5);
  });
});

describe('shouldPlay', () => {
  it('plays the very first frame', () => {
    expect(shouldPlay(0, -1)).toBe(true);
  });

  it('plays forward progress', () => {
    expect(shouldPlay(5, 4)).toBe(true);
    expect(shouldPlay(100, 4)).toBe(true);
  });

  it('drops duplicates and out-of-order frames', () => {
    expect(shouldPlay(4, 4)).toBe(false);
    expect(shouldPlay(3, 9)).toBe(false);
  });

  it('accepts a seq reset to 0 as an upstream reconnect, not a duplicate', () => {
    // The regression this guards: audio_seq is per-connection, so every reconnect
    // restarts it at 0. Treating that as stale muted translated voice for the rest
    // of the call while subtitles kept working.
    expect(shouldPlay(0, 900)).toBe(true);
  });
});
