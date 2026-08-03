import { describe, expect, it } from 'vitest';
import {
  capturesPcm,
  shouldSpeakOnDevice,
  wantsTranslatedVoice,
  type VoiceCapabilities,
} from '../src/shared/voice-routing';

/** The four tier shapes that actually ship, by capability rather than by name. */
const SERVER_SPEECH: VoiceCapabilities = { translated_audio: true, client_direct: false };
const CLIENT_DIRECT: VoiceCapabilities = { translated_audio: false, client_direct: true };
const SUBTITLES_ONLY: VoiceCapabilities = { translated_audio: false, client_direct: false };

describe('wantsTranslatedVoice', () => {
  it('is true for a client-direct tier even though the server streams nothing', () => {
    // The regression this file exists for: Enhanced (Cartesia) synthesises in the
    // browser, so `translated_audio` is false while a voice very much exists. Gating on
    // that bit alone reached Cartesia as `ttsEnabled: false` and produced subtitles with
    // total silence.
    expect(wantsTranslatedVoice(true, CLIENT_DIRECT)).toBe(true);
  });

  it('is true for a server speech-to-speech tier', () => {
    expect(wantsTranslatedVoice(true, SERVER_SPEECH)).toBe(true);
  });

  it('is false when the tier produces no voice anywhere', () => {
    expect(wantsTranslatedVoice(true, SUBTITLES_ONLY)).toBe(false);
  });

  it('respects the user preference above any capability', () => {
    expect(wantsTranslatedVoice(false, SERVER_SPEECH)).toBe(false);
    expect(wantsTranslatedVoice(false, CLIENT_DIRECT)).toBe(false);
  });

  it('is false when the tier is unknown rather than assuming a voice', () => {
    expect(wantsTranslatedVoice(true, undefined)).toBe(false);
  });
});

describe('shouldSpeakOnDevice', () => {
  it('never doubles a voice the tier already produces', () => {
    expect(shouldSpeakOnDevice(true, SERVER_SPEECH)).toBe(false);
    expect(shouldSpeakOnDevice(true, CLIENT_DIRECT)).toBe(false);
  });

  it('speaks for a tier that produces none', () => {
    expect(shouldSpeakOnDevice(true, SUBTITLES_ONLY)).toBe(true);
  });

  it('is off when the user turned translated audio off', () => {
    expect(shouldSpeakOnDevice(false, SUBTITLES_ONLY)).toBe(false);
  });
});

describe('the three questions never collapse into one', () => {
  it('separates "server streams audio" from "user hears a voice"', () => {
    // Exactly one tier shape makes the two disagree, and it is the one that broke.
    expect(capturesPcm(CLIENT_DIRECT)).toBe(false);
    expect(wantsTranslatedVoice(true, CLIENT_DIRECT)).toBe(true);
  });

  it('keeps capture encoding tied to the SERVER capability only', () => {
    expect(capturesPcm(SERVER_SPEECH)).toBe(true);
    expect(capturesPcm(SUBTITLES_ONLY)).toBe(false);
    expect(capturesPcm(undefined)).toBe(false);
  });

  it('makes on-device speech the exact complement of a tier-produced voice', () => {
    for (const caps of [SERVER_SPEECH, CLIENT_DIRECT, SUBTITLES_ONLY]) {
      expect(shouldSpeakOnDevice(true, caps)).toBe(!wantsTranslatedVoice(true, caps));
    }
  });
});
