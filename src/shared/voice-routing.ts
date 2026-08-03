/**
 * Where a tier's translated voice comes from, and therefore who is allowed to make it.
 *
 * Three questions get confused constantly, because for most tiers the answers coincide:
 *
 *   1. Does the SERVER stream translated audio?      -> `translated_audio` capability
 *   2. Does the BROWSER produce it itself?           -> `client_direct` capability
 *   3. Should the user hear a voice at all?          -> (1) or (2), and the preference
 *
 * They came apart twice. Standard moved to a speech-to-speech engine, so (1) flipped from
 * false to true. Enhanced (Cartesia) has always answered (1) no and (2) yes: the server
 * streams nothing, yet a voice exists. Answering (3) with (1) alone silenced Enhanced
 * completely, because the flag is passed straight to Cartesia's `ttsEnabled`.
 *
 * Naming each question separately is the fix. A boolean expression inlined at a call site
 * cannot say which of the three it meant.
 */

/** The capability bits a tier advertises (`GET /api/engines`). */
export interface VoiceCapabilities {
  /** The server streams `translated_audio` frames for this tier. */
  translated_audio: boolean;
  /** The browser talks to the provider directly and synthesises its own voice. */
  client_direct: boolean;
}

/**
 * Whether a translated voice should be produced at all — by ANY mechanism.
 *
 * This is what the offscreen pipeline receives, and what Cartesia's `ttsEnabled` reads.
 * It says nothing about who produces the audio.
 */
export function wantsTranslatedVoice(
  preferenceEnabled: boolean,
  caps: VoiceCapabilities | undefined,
): boolean {
  if (!preferenceEnabled || !caps) return false;
  return caps.translated_audio || caps.client_direct;
}

/**
 * Whether the extension should speak a finalized translation with `chrome.tts`.
 *
 * Only for tiers that produce no voice of their own. A speech-to-speech tier already
 * streams one and a client-direct tier synthesises one, so speaking here would lay a
 * second voice over the first.
 */
export function shouldSpeakOnDevice(
  preferenceEnabled: boolean,
  caps: VoiceCapabilities | undefined,
): boolean {
  if (!preferenceEnabled || !caps) return false;
  return !caps.translated_audio && !caps.client_direct;
}

/**
 * Whether the captured audio must be raw PCM16 rather than WebM/Opus.
 *
 * Keyed on the server-side capability only: it describes what OUR server's engine will
 * read. Feeding a speech-to-speech engine Opus is not a degradation — it reads the bytes
 * as samples and produces nothing at all, with no error.
 */
export function capturesPcm(caps: VoiceCapabilities | undefined): boolean {
  return caps?.translated_audio === true;
}
