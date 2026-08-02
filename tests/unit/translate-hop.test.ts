import { describe, expect, it, vi } from 'vitest';
import { TranslateHop } from '@/offscreen/translate-hop';

describe('Enhanced translate hop', () => {
  it('correlates replies by request id, not arrival order', async () => {
    // A short segment translates faster than a long one sent before it. Matching by
    // order would put the wrong words under the wrong speech.
    const sent: string[] = [];
    const hop = new TranslateHop((f) => (sent.push(f), true));

    const first = hop.translate('primera frase larga', 'es', 'it');
    const second = hop.translate('sí', 'es', 'it');

    const ids = sent.map((f) => JSON.parse(f).request_id as string);
    // Reply to the SECOND request first.
    hop.accept(ids[1]!, 'sì');
    hop.accept(ids[0]!, 'prima frase lunga');

    await expect(second).resolves.toBe('sì');
    await expect(first).resolves.toBe('prima frase lunga');
  });

  it('sends a well-formed translate_text frame', () => {
    const sent: string[] = [];
    const hop = new TranslateHop((f) => (sent.push(f), true));
    void hop.translate('hola', 'es', 'it');

    const frame = JSON.parse(sent[0]!);
    expect(frame).toMatchObject({
      type: 'translate_text',
      text: 'hola',
      source: 'es',
      target: 'it',
    });
    expect(frame.request_id).toBeTruthy();
  });

  it('resolves null when the socket refuses the frame', async () => {
    const hop = new TranslateHop(() => false);
    await expect(hop.translate('hola', 'es', 'it')).resolves.toBeNull();
    expect(hop.inFlight).toBe(0);
  });

  it('times out rather than leaving a segment pending forever', async () => {
    vi.useFakeTimers();
    const hop = new TranslateHop(() => true);
    const p = hop.translate('hola', 'es', 'it');
    vi.advanceTimersByTime(9_000);
    await expect(p).resolves.toBeNull();
    expect(hop.inFlight).toBe(0);
    vi.useRealTimers();
  });

  it('ignores a reply that no longer matches anything', () => {
    const hop = new TranslateHop(() => true);
    // Already timed out, or from a previous session — not an error, just not ours.
    expect(hop.accept('nope', 'ciao')).toBe(false);
  });

  it('bounds in-flight requests instead of pinning the whole session in memory', async () => {
    const hop = new TranslateHop(() => true);
    const promises = Array.from({ length: 40 }, (_, i) => hop.translate(`s${i}`, 'es', 'it'));
    expect(hop.inFlight).toBeLessThanOrEqual(24);
    // The overflow resolves immediately as null so the caller shows the source text.
    await expect(promises[39]).resolves.toBeNull();
  });

  it('cancelAll releases every waiter', async () => {
    const hop = new TranslateHop(() => true);
    const p = hop.translate('hola', 'es', 'it');
    hop.cancelAll();
    await expect(p).resolves.toBeNull();
    expect(hop.inFlight).toBe(0);
  });
});
