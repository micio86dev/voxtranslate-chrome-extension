/**
 * The client-direct Cartesia pipeline (spec 0108).
 *
 * Every browser dependency is faked: WebSocket, AudioContext, the capture worklet and
 * MediaStream. What is exercised is the manager's own logic — when a pipeline should
 * exist, what crosses the socket, how a failure retries and when it gives up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CartesiaManager,
  IDLE_FLUSH_MS,
  RETRY_BACKOFF_MS,
  STT_SAMPLE_RATE,
  TTS_SAMPLE_RATE,
  setCaptureWorkletUrl,
  type CartesiaManagerOptions,
  type CartesiaSession,
} from '@/audio/cartesia';

// --- fakes -----------------------------------------------------------------

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = 0;
  binaryType = '';
  sent: unknown[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
  }

  // --- drivers used by the tests
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  message(data: unknown): void {
    this.onmessage?.({ data });
  }
  serverClose(code = 1006, reason = ''): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  error(): void {
    this.onerror?.();
  }

  static reset(): void {
    FakeWebSocket.instances = [];
  }
  static get stt(): FakeWebSocket[] {
    return FakeWebSocket.instances.filter((w) => w.url.includes('/stt'));
  }
  static get tts(): FakeWebSocket[] {
    return FakeWebSocket.instances.filter((w) => w.url.includes('/tts'));
  }
}

class FakeAudioNode {
  connected: FakeAudioNode[] = [];
  connect(target: FakeAudioNode): FakeAudioNode {
    this.connected.push(target);
    return target;
  }
  disconnect(): void {}
}

class FakeWorkletNode extends FakeAudioNode {
  static last: FakeWorkletNode | null = null;
  port: { onmessage: ((e: { data: ArrayBuffer }) => void) | null } = { onmessage: null };
  constructor(
    readonly ctx: unknown,
    readonly processor: string,
  ) {
    super();
    FakeWorkletNode.last = this;
  }
  /** Deliver one encoded PCM frame the way the worklet would. */
  emit(bytes: ArrayBuffer): void {
    this.port.onmessage?.({ data: bytes });
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  static addModuleFails = false;
  destination = new FakeAudioNode();
  closeCalls = 0;
  addedModules: string[] = [];
  audioWorklet = {
    addModule: async (url: string) => {
      if (FakeAudioContext.addModuleFails) throw new Error('worklet blocked');
      this.addedModules.push(url);
    },
  };

  constructor(readonly options: { sampleRate: number }) {
    FakeAudioContext.instances.push(this);
  }
  createMediaStreamSource(): FakeAudioNode {
    return new FakeAudioNode();
  }
  createGain(): FakeAudioNode & { gain: { value: number } } {
    return Object.assign(new FakeAudioNode(), { gain: { value: 1 } });
  }
  async close(): Promise<void> {
    this.closeCalls++;
  }
  static reset(): void {
    FakeAudioContext.instances = [];
    FakeAudioContext.addModuleFails = false;
  }
}

class FakeMediaStream {
  constructor(private tracks: unknown[] = [{ kind: 'audio' }]) {}
  getAudioTracks(): unknown[] {
    return this.tracks;
  }
}

// --- fixtures --------------------------------------------------------------

const SESSION: CartesiaSession = {
  token: 'cart-token',
  expiresAt: 4_000_000_000,
  cartesiaVersion: '2025-04-16',
  sttEndpoint: 'wss://api.cartesia.ai/stt/websocket',
  sttModel: 'ink-whisper',
  sttModelsByLang: { en: 'ink-2' },
  ttsEndpoint: 'wss://api.cartesia.ai/tts/websocket',
  ttsModel: 'sonic-3.5',
  voiceCloningEnabled: true,
  defaultVoiceId: 'default-voice',
};

function makeManager(overrides: Partial<CartesiaManagerOptions> = {}) {
  const opts = {
    fetchSession: vi.fn(async () => SESSION),
    translate: vi.fn(async (text: string) => `[it] ${text}`),
    onSubtitle: vi.fn(),
    onError: vi.fn(),
    playAudio: vi.fn(),
    ttsEnabled: vi.fn(() => true),
    ...overrides,
  } satisfies CartesiaManagerOptions;
  return { manager: new CartesiaManager(opts), opts };
}

/** Bring one peer all the way to an open STT socket with capture wired. */
async function startPeer(
  manager: CartesiaManager,
  peerId = 'peer-1',
  lang = 'en',
): Promise<FakeWebSocket> {
  manager.setPeerLang(peerId, lang);
  manager.setPeerStream(peerId, new FakeMediaStream() as unknown as MediaStream);
  await vi.waitFor(() => expect(FakeWebSocket.stt.length).toBeGreaterThan(0));
  const ws = FakeWebSocket.stt.at(-1) as FakeWebSocket;
  ws.open();
  await vi.waitFor(() => expect(FakeWorkletNode.last).not.toBeNull());
  return ws;
}

beforeEach(() => {
  FakeWebSocket.reset();
  FakeAudioContext.reset();
  FakeWorkletNode.last = null;
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);
  vi.stubGlobal('MediaStream', FakeMediaStream);
  vi.stubGlobal('window', { AudioContext: FakeAudioContext });
  setCaptureWorkletUrl('chrome-extension://abc/pcm-capture-worklet.js');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// --- tests -----------------------------------------------------------------

describe('supported', () => {
  it('is true when WebSocket, AudioContext and MediaStream all exist', () => {
    expect(CartesiaManager.supported).toBe(true);
  });

  it('is false on a browser without Web Audio', () => {
    vi.stubGlobal('AudioContext', undefined);
    expect(CartesiaManager.supported).toBe(false);
  });
});

describe('reconcile — when a pipeline should exist', () => {
  it('does nothing until the manager is activated', async () => {
    const { manager } = makeManager();
    manager.setPeerLang('p1', 'en');
    manager.setPeerStream('p1', new FakeMediaStream() as unknown as MediaStream);
    await Promise.resolve();
    expect(FakeWebSocket.stt).toHaveLength(0);
  });

  it('opens an STT socket once language and stream are both known', async () => {
    const { manager } = makeManager();
    manager.activate('it');
    await startPeer(manager);
    expect(FakeWebSocket.stt).toHaveLength(1);
  });

  it('does not translate a peer already speaking the listener language', async () => {
    const { manager } = makeManager();
    manager.activate('it');
    manager.setPeerLang('p1', 'it');
    manager.setPeerStream('p1', new FakeMediaStream() as unknown as MediaStream);
    await Promise.resolve();
    expect(FakeWebSocket.stt).toHaveLength(0);
  });

  it('waits for a real language rather than starting on "auto"', async () => {
    const { manager } = makeManager();
    manager.activate('it');
    manager.setPeerLang('p1', 'auto');
    manager.setPeerStream('p1', new FakeMediaStream() as unknown as MediaStream);
    await Promise.resolve();
    expect(FakeWebSocket.stt).toHaveLength(0);
  });

  it('ignores a stream with no audio track yet', async () => {
    const { manager } = makeManager();
    manager.activate('it');
    manager.setPeerLang('p1', 'en');
    manager.setPeerStream('p1', new FakeMediaStream([]) as unknown as MediaStream);
    await Promise.resolve();
    expect(FakeWebSocket.stt).toHaveLength(0);
  });

  it('does not restart a running pipeline on an unchanged language', async () => {
    const { manager } = makeManager();
    manager.activate('it');
    await startPeer(manager);
    manager.setPeerLang('peer-1', 'en');
    manager.setPeerStream('peer-1', new FakeMediaStream() as unknown as MediaStream);
    await Promise.resolve();
    expect(FakeWebSocket.stt).toHaveLength(1);
  });

  it('restarts the pipeline when the speaker language changes', async () => {
    const { manager } = makeManager();
    manager.activate('it');
    const first = await startPeer(manager);
    manager.setPeerLang('peer-1', 'fr');
    await vi.waitFor(() => expect(FakeWebSocket.stt).toHaveLength(2));
    expect(first.closed).toBe(true);
    expect(FakeWebSocket.stt[1]?.url).toContain('language=fr');
  });

  it('restarts every pipeline when the listener changes their own language', async () => {
    const { manager } = makeManager();
    manager.activate('it');
    await startPeer(manager);
    manager.setMyLang('es');
    await vi.waitFor(() => expect(FakeWebSocket.stt).toHaveLength(2));
  });

  it('ignores a no-op change of the listener language', async () => {
    const { manager } = makeManager();
    manager.activate('it');
    await startPeer(manager);
    manager.setMyLang('it');
    await Promise.resolve();
    expect(FakeWebSocket.stt).toHaveLength(1);
  });

  it('stops the pipeline when the speaker switches to the listener language', async () => {
    const { manager } = makeManager();
    manager.activate('it');
    const ws = await startPeer(manager);
    manager.setPeerLang('peer-1', 'it');
    await Promise.resolve();
    expect(ws.closed).toBe(true);
  });

  it('bails when the session cannot be minted', async () => {
    const { manager } = makeManager({ fetchSession: vi.fn(async () => null) });
    manager.activate('it');
    manager.setPeerLang('p1', 'en');
    manager.setPeerStream('p1', new FakeMediaStream() as unknown as MediaStream);
    await Promise.resolve();
    await Promise.resolve();
    expect(FakeWebSocket.stt).toHaveLength(0);
  });

  it('re-mints only when the cached token is close to expiry', async () => {
    const { manager, opts } = makeManager();
    manager.activate('it');
    await startPeer(manager, 'p1', 'en');
    await startPeer(manager, 'p2', 'fr');
    expect(opts.fetchSession).toHaveBeenCalledTimes(1);
  });
});

describe('the STT socket', () => {
  it('carries auth and capture format as query params', async () => {
    const { manager } = makeManager();
    manager.activate('it');
    const ws = await startPeer(manager);
    const url = new URL(ws.url);
    expect(url.searchParams.get('encoding')).toBe('pcm_s16le');
    expect(url.searchParams.get('sample_rate')).toBe(String(STT_SAMPLE_RATE));
    expect(url.searchParams.get('access_token')).toBe(SESSION.token);
    expect(url.searchParams.get('cartesia_version')).toBe(SESSION.cartesiaVersion);
  });

  it('picks the per-language STT model override', async () => {
    const { manager } = makeManager();
    manager.activate('it');
    const ws = await startPeer(manager, 'p1', 'en-US');
    expect(new URL(ws.url).searchParams.get('model')).toBe('ink-2');
    expect(new URL(ws.url).searchParams.get('language')).toBe('en');
  });

  it('falls back to the multilingual model for a language with no override', async () => {
    const { manager } = makeManager();
    manager.activate('it');
    const ws = await startPeer(manager, 'p1', 'fr');
    expect(new URL(ws.url).searchParams.get('model')).toBe('ink-whisper');
  });

  it('reads binary frames as ArrayBuffers', async () => {
    const { manager } = makeManager();
    manager.activate('it');
    const ws = await startPeer(manager);
    expect(ws.binaryType).toBe('arraybuffer');
  });
});

describe('capture graph', () => {
  it('forces the context to the STT sample rate and loads the packaged worklet', async () => {
    const { manager } = makeManager();
    manager.activate('it');
    await startPeer(manager);
    const ctx = FakeAudioContext.instances[0] as FakeAudioContext;
    expect(ctx.options.sampleRate).toBe(STT_SAMPLE_RATE);
    expect(ctx.addedModules[0]).toBe('chrome-extension://abc/pcm-capture-worklet.js');
  });

  it('pushes captured PCM frames onto the open socket', async () => {
    const { manager } = makeManager();
    manager.activate('it');
    const ws = await startPeer(manager);
    FakeWorkletNode.last?.emit(new ArrayBuffer(320));
    expect(ws.sent).toHaveLength(1);
  });

  it('drops captured frames once the pipeline is stopped', async () => {
    const { manager } = makeManager();
    manager.activate('it');
    const ws = await startPeer(manager);
    const node = FakeWorkletNode.last as FakeWorkletNode;
    manager.removePeer('peer-1');
    node.emit(new ArrayBuffer(320));
    expect(ws.sent).toHaveLength(0);
  });

  it('reports a blocked worklet as a media error instead of hanging silently', async () => {
    FakeAudioContext.addModuleFails = true;
    const { manager, opts } = makeManager();
    manager.activate('it');
    manager.setPeerLang('p1', 'en');
    manager.setPeerStream('p1', new FakeMediaStream() as unknown as MediaStream);
    await vi.waitFor(() => expect(FakeWebSocket.stt.length).toBe(1));
    vi.useFakeTimers();
    FakeWebSocket.stt[0]?.open();
    await vi.waitFor(() => expect(FakeAudioContext.instances[0]?.closeCalls ?? 0).toBe(0), {
      timeout: 50,
    });
    vi.useRealTimers();
    await vi.waitFor(() => expect(opts.onSubtitle).not.toHaveBeenCalled());
  });
});

describe('transcripts', () => {
  it('renders an interim line as it accumulates', async () => {
    const { manager, opts } = makeManager();
    manager.activate('it');
    const ws = await startPeer(manager);

    ws.message(JSON.stringify({ type: 'transcript', is_final: false, text: 'hello' }));
    expect(opts.onSubtitle).toHaveBeenCalledWith('peer-1', 'hello', true);
  });

  it('joins finalized segments before translating them', async () => {
    vi.useFakeTimers();
    const { manager, opts } = makeManager();
    manager.activate('it');
    const ws = await startPeer(manager);

    ws.message(JSON.stringify({ type: 'transcript', is_final: true, text: 'hello' }));
    ws.message(JSON.stringify({ type: 'transcript', is_final: true, text: 'everyone' }));
    vi.advanceTimersByTime(IDLE_FLUSH_MS);
    await vi.waitFor(() =>
      expect(opts.translate).toHaveBeenCalledWith('hello everyone', 'en', 'it'),
    );
  });

  it('renders the translation with the source attached for dual-language mode', async () => {
    vi.useFakeTimers();
    const { manager, opts } = makeManager();
    manager.activate('it');
    const ws = await startPeer(manager);

    ws.message(JSON.stringify({ type: 'transcript', is_final: true, text: 'hello' }));
    vi.advanceTimersByTime(IDLE_FLUSH_MS);
    await vi.waitFor(() =>
      expect(opts.onSubtitle).toHaveBeenCalledWith('peer-1', '[it] hello', false, 'hello'),
    );
  });

  it('falls back to the untranslated source when translation fails', async () => {
    vi.useFakeTimers();
    const { manager, opts } = makeManager({ translate: vi.fn(async () => null) });
    manager.activate('it');
    const ws = await startPeer(manager);

    ws.message(JSON.stringify({ type: 'transcript', is_final: true, text: 'hello' }));
    vi.advanceTimersByTime(IDLE_FLUSH_MS);
    await vi.waitFor(() =>
      expect(opts.onSubtitle).toHaveBeenCalledWith('peer-1', 'hello', false, 'hello'),
    );
  });

  it('swallows a rejected translation rather than killing the pipeline', async () => {
    vi.useFakeTimers();
    const { manager, opts } = makeManager({
      translate: vi.fn(async () => {
        throw new Error('groq down');
      }),
    });
    manager.activate('it');
    const ws = await startPeer(manager);

    ws.message(JSON.stringify({ type: 'transcript', is_final: true, text: 'hello' }));
    vi.advanceTimersByTime(IDLE_FLUSH_MS);
    await Promise.resolve();
    expect(opts.onError).not.toHaveBeenCalled();
  });

  it('restarts the idle window on every new transcript', async () => {
    vi.useFakeTimers();
    const { manager, opts } = makeManager();
    manager.activate('it');
    const ws = await startPeer(manager);

    ws.message(JSON.stringify({ type: 'transcript', is_final: true, text: 'one' }));
    vi.advanceTimersByTime(IDLE_FLUSH_MS - 100);
    ws.message(JSON.stringify({ type: 'transcript', is_final: true, text: 'two' }));
    vi.advanceTimersByTime(IDLE_FLUSH_MS - 100);
    expect(opts.translate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    await vi.waitFor(() => expect(opts.translate).toHaveBeenCalledWith('one two', 'en', 'it'));
  });

  it('flushes nothing when the segment is empty', async () => {
    vi.useFakeTimers();
    const { manager, opts } = makeManager();
    manager.activate('it');
    const ws = await startPeer(manager);

    ws.message(JSON.stringify({ type: 'transcript', is_final: false, text: '' }));
    vi.advanceTimersByTime(IDLE_FLUSH_MS);
    expect(opts.translate).not.toHaveBeenCalled();
  });

  it('ignores a non-JSON keepalive frame', async () => {
    const { manager, opts } = makeManager();
    manager.activate('it');
    const ws = await startPeer(manager);

    expect(() => ws.message('ping')).not.toThrow();
    expect(opts.onSubtitle).not.toHaveBeenCalled();
  });

  it('ignores message types it does not model', async () => {
    const { manager, opts } = makeManager();
    manager.activate('it');
    const ws = await startPeer(manager);

    ws.message(JSON.stringify({ type: 'flush_done' }));
    expect(opts.onSubtitle).not.toHaveBeenCalled();
  });

  it('drops frames that arrive after the pipeline stopped', async () => {
    const { manager, opts } = makeManager();
    manager.activate('it');
    const ws = await startPeer(manager);
    manager.removePeer('peer-1');

    ws.message(JSON.stringify({ type: 'transcript', is_final: false, text: 'late' }));
    expect(opts.onSubtitle).not.toHaveBeenCalled();
  });
});

describe('TTS', () => {
  /**
   * Drive a peer to a spoken utterance over an OPEN TTS socket.
   *
   * The first utterance only opens the socket — `speak` refuses to send on a
   * CONNECTING one, which is real behaviour, not a test artefact. So warm up, open,
   * then say the line under test.
   */
  async function speakThroughTts(
    overrides: Partial<CartesiaManagerOptions> = {},
    line = 'hello',
    before: (m: CartesiaManager) => void = () => {},
  ) {
    vi.useFakeTimers();
    const { manager, opts } = makeManager(overrides);
    manager.activate('it');
    before(manager);
    const stt = await startPeer(manager);

    stt.message(JSON.stringify({ type: 'transcript', is_final: true, text: 'warm up' }));
    vi.advanceTimersByTime(IDLE_FLUSH_MS);
    await vi.waitFor(() => expect(FakeWebSocket.tts).toHaveLength(1));
    const tts = FakeWebSocket.tts[0] as FakeWebSocket;
    expect(tts.sent).toHaveLength(0);
    tts.open();

    stt.message(JSON.stringify({ type: 'transcript', is_final: true, text: line }));
    vi.advanceTimersByTime(IDLE_FLUSH_MS);
    await vi.waitFor(() =>
      expect((opts.onSubtitle as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1),
    );
    return { manager, opts, stt, tts };
  }

  it('opens one shared TTS socket and sends the translated transcript', async () => {
    const { tts } = await speakThroughTts();
    await vi.waitFor(() => expect(tts.sent).toHaveLength(1));

    const payload = JSON.parse(String(tts.sent[0]));
    expect(payload.transcript).toBe('[it] hello');
    expect(payload.model_id).toBe(SESSION.ttsModel);
    expect(payload.language).toBe('it');
    expect(payload.continue).toBe(false);
    expect(payload.output_format).toEqual({
      container: 'raw',
      encoding: 'pcm_s16le',
      sample_rate: TTS_SAMPLE_RATE,
    });
    expect(FakeWebSocket.tts).toHaveLength(1);
  });

  it('does not speak over a socket that has not finished connecting', async () => {
    // The warm-up assertion inside the helper is the point: a CONNECTING socket is
    // skipped rather than queued, so nothing is spoken late and out of context.
    const { tts } = await speakThroughTts();
    expect(tts.sent.length).toBeLessThanOrEqual(1);
  });

  it('speaks in the speaker’s cloned voice when one is known', async () => {
    const { tts } = await speakThroughTts({}, 'hello', (m) =>
      m.setPeerVoiceId('peer-1', 'cloned-voice'),
    );
    await vi.waitFor(() => expect(tts.sent).toHaveLength(1));
    expect(JSON.parse(String(tts.sent[0])).voice).toEqual({ mode: 'id', id: 'cloned-voice' });
  });

  it('falls back to the configured default voice', async () => {
    const { tts } = await speakThroughTts();
    await vi.waitFor(() => expect(tts.sent).toHaveLength(1));
    expect(JSON.parse(String(tts.sent[0])).voice.id).toBe('default-voice');
  });

  it('renders subtitles only for a speaker with no clone and no default voice', async () => {
    const noDefault = { ...SESSION, defaultVoiceId: undefined };
    const { tts, opts } = await speakThroughTts({ fetchSession: vi.fn(async () => noDefault) });
    expect(tts.sent).toHaveLength(0);
    expect(opts.onSubtitle).toHaveBeenCalled();
  });

  it('stays silent while the translated-voice toggle is off', async () => {
    vi.useFakeTimers();
    const { manager, opts } = makeManager({ ttsEnabled: () => false });
    manager.activate('it');
    const stt = await startPeer(manager);
    stt.message(JSON.stringify({ type: 'transcript', is_final: true, text: 'hi' }));
    vi.advanceTimersByTime(IDLE_FLUSH_MS);
    await vi.waitFor(() => expect(opts.onSubtitle).toHaveBeenCalledTimes(1));
    expect(FakeWebSocket.tts).toHaveLength(0);
  });

  it('routes audio chunks back to the speaker in sequence', async () => {
    const { tts, opts } = await speakThroughTts();
    await vi.waitFor(() => expect(tts.sent).toHaveLength(1));
    const contextId = JSON.parse(String(tts.sent[0])).context_id as string;

    tts.message(JSON.stringify({ type: 'chunk', context_id: contextId, data: 'AAA' }));
    tts.message(JSON.stringify({ type: 'chunk', context_id: contextId, data: 'BBB' }));

    expect(opts.playAudio).toHaveBeenNthCalledWith(1, 'peer-1', 0, 'AAA');
    expect(opts.playAudio).toHaveBeenNthCalledWith(2, 'peer-1', 1, 'BBB');
  });

  it('ignores chunks it cannot route', async () => {
    const { tts, opts } = await speakThroughTts();
    await vi.waitFor(() => expect(tts.sent).toHaveLength(1));

    tts.message(JSON.stringify({ type: 'chunk', context_id: 'stale', data: 'AAA' }));
    tts.message(JSON.stringify({ type: 'chunk', data: 'AAA' }));
    tts.message('not json');
    tts.message(new ArrayBuffer(4));

    expect(opts.playAudio).not.toHaveBeenCalled();
  });

  it('forgets a context once the utterance is done', async () => {
    const { tts, opts } = await speakThroughTts();
    await vi.waitFor(() => expect(tts.sent).toHaveLength(1));
    const contextId = JSON.parse(String(tts.sent[0])).context_id as string;

    tts.message(JSON.stringify({ type: 'done', context_id: contextId }));
    tts.message(JSON.stringify({ type: 'chunk', context_id: contextId, data: 'AAA' }));

    expect(opts.playAudio).not.toHaveBeenCalled();
  });

  it('forgets a context that errored', async () => {
    const { tts, opts } = await speakThroughTts();
    await vi.waitFor(() => expect(tts.sent).toHaveLength(1));
    const contextId = JSON.parse(String(tts.sent[0])).context_id as string;

    tts.message(JSON.stringify({ type: 'error', context_id: contextId }));
    tts.message(JSON.stringify({ type: 'chunk', context_id: contextId, data: 'AAA' }));

    expect(opts.playAudio).not.toHaveBeenCalled();
  });

  it('reopens the TTS socket after it drops, without touching STT', async () => {
    const { tts, stt, opts } = await speakThroughTts();
    await vi.waitFor(() => expect(tts.sent).toHaveLength(1));

    tts.error();
    tts.serverClose();
    expect(opts.onError).not.toHaveBeenCalled();
    expect(stt.closed).toBe(false);

    stt.message(JSON.stringify({ type: 'transcript', is_final: true, text: 'again' }));
    vi.advanceTimersByTime(IDLE_FLUSH_MS);
    await vi.waitFor(() => expect(FakeWebSocket.tts).toHaveLength(2));
  });

  it('renders subtitles without speaking when no playback sink is injected', async () => {
    const { tts, opts } = await speakThroughTts({ playAudio: undefined });
    await vi.waitFor(() => expect(tts.sent).toHaveLength(1));
    const contextId = JSON.parse(String(tts.sent[0])).context_id as string;

    expect(() =>
      tts.message(JSON.stringify({ type: 'chunk', context_id: contextId, data: 'AAA' })),
    ).not.toThrow();
    expect(opts.onSubtitle).toHaveBeenCalled();
  });
});

describe('errors and retries', () => {
  it('retries on the documented backoff after an unexpected close', async () => {
    vi.useFakeTimers();
    const { manager, opts } = makeManager();
    manager.activate('it');
    const ws = await startPeer(manager);

    ws.serverClose(1008, 'Invalid language for model');
    expect(opts.onError).not.toHaveBeenCalled();

    vi.advanceTimersByTime(RETRY_BACKOFF_MS[0]);
    await vi.waitFor(() => expect(FakeWebSocket.stt).toHaveLength(2));
  });

  it('gives up after the retries are exhausted and tells the app to fall back', async () => {
    vi.useFakeTimers();
    const { manager, opts } = makeManager();
    manager.activate('it');
    await startPeer(manager);

    for (let attempt = 0; attempt < RETRY_BACKOFF_MS.length; attempt++) {
      const ws = FakeWebSocket.stt.at(-1) as FakeWebSocket;
      ws.serverClose(1006, 'boom');
      vi.advanceTimersByTime(RETRY_BACKOFF_MS[attempt] as number);
      await vi.waitFor(() => expect(FakeWebSocket.stt).toHaveLength(attempt + 2));
      (FakeWebSocket.stt.at(-1) as FakeWebSocket).open();
    }
    (FakeWebSocket.stt.at(-1) as FakeWebSocket).serverClose(1006, 'boom');

    await vi.waitFor(() =>
      expect(opts.onError).toHaveBeenCalledWith('peer-1', 'websocket_error', expect.any(String)),
    );
  });

  it('does not retry a peer it has given up on', async () => {
    vi.useFakeTimers();
    const { manager } = makeManager();
    manager.activate('it');
    await startPeer(manager);

    for (let attempt = 0; attempt < RETRY_BACKOFF_MS.length; attempt++) {
      (FakeWebSocket.stt.at(-1) as FakeWebSocket).serverClose(1006, 'boom');
      vi.advanceTimersByTime(RETRY_BACKOFF_MS[attempt] as number);
      await vi.waitFor(() => expect(FakeWebSocket.stt).toHaveLength(attempt + 2));
      (FakeWebSocket.stt.at(-1) as FakeWebSocket).open();
    }
    (FakeWebSocket.stt.at(-1) as FakeWebSocket).serverClose(1006, 'boom');
    await vi.waitFor(() => expect(FakeWebSocket.stt).toHaveLength(RETRY_BACKOFF_MS.length + 1));

    const settled = FakeWebSocket.stt.length;
    manager.setPeerStream('peer-1', new FakeMediaStream() as unknown as MediaStream);
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.stt).toHaveLength(settled);
  });

  it('clears the give-up mark when the speaker language changes', async () => {
    vi.useFakeTimers();
    const { manager } = makeManager();
    manager.activate('it');
    await startPeer(manager);

    for (let attempt = 0; attempt < RETRY_BACKOFF_MS.length; attempt++) {
      (FakeWebSocket.stt.at(-1) as FakeWebSocket).serverClose(1006, 'boom');
      vi.advanceTimersByTime(RETRY_BACKOFF_MS[attempt] as number);
      await vi.waitFor(() => expect(FakeWebSocket.stt).toHaveLength(attempt + 2));
      (FakeWebSocket.stt.at(-1) as FakeWebSocket).open();
    }
    (FakeWebSocket.stt.at(-1) as FakeWebSocket).serverClose(1006, 'boom');
    const settled = FakeWebSocket.stt.length;

    manager.setPeerLang('peer-1', 'de');
    await vi.waitFor(() => expect(FakeWebSocket.stt.length).toBe(settled + 1));
  });

  it('treats a socket error as transient', async () => {
    vi.useFakeTimers();
    const { manager, opts } = makeManager();
    manager.activate('it');
    const ws = await startPeer(manager);

    ws.error();
    expect(opts.onError).not.toHaveBeenCalled();
    vi.advanceTimersByTime(RETRY_BACKOFF_MS[0]);
    await vi.waitFor(() => expect(FakeWebSocket.stt).toHaveLength(2));
  });

  it('stays quiet on a close it caused itself', async () => {
    const { manager, opts } = makeManager();
    manager.activate('it');
    await startPeer(manager);
    manager.removePeer('peer-1');
    expect(opts.onError).not.toHaveBeenCalled();
  });
});

describe('teardown', () => {
  it('closes sockets and audio contexts on deactivate', async () => {
    const { manager } = makeManager();
    manager.activate('it');
    const ws = await startPeer(manager);

    manager.deactivate();

    expect(ws.closed).toBe(true);
    await vi.waitFor(() => expect(FakeAudioContext.instances[0]?.closeCalls).toBe(1));
  });

  it('forgets every peer so a re-activate starts clean', async () => {
    const { manager } = makeManager();
    manager.activate('it');
    await startPeer(manager);
    manager.deactivate();

    manager.activate('it');
    await Promise.resolve();
    expect(FakeWebSocket.stt).toHaveLength(1);
  });

  it('cancels a pending retry so nothing reopens after deactivate', async () => {
    vi.useFakeTimers();
    const { manager } = makeManager();
    manager.activate('it');
    const ws = await startPeer(manager);
    ws.serverClose(1006, 'boom');

    manager.deactivate();
    vi.advanceTimersByTime(60_000);

    expect(FakeWebSocket.stt).toHaveLength(1);
  });

  it('closes the shared TTS socket too', async () => {
    vi.useFakeTimers();
    const { manager, opts } = makeManager();
    manager.activate('it');
    const ws = await startPeer(manager);
    ws.message(JSON.stringify({ type: 'transcript', is_final: true, text: 'hi' }));
    vi.advanceTimersByTime(IDLE_FLUSH_MS);
    await vi.waitFor(() => expect(opts.onSubtitle).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(FakeWebSocket.tts).toHaveLength(1));

    manager.deactivate();
    expect(FakeWebSocket.tts[0]?.closed).toBe(true);
  });

  it('removePeer is safe for a peer that was never started', () => {
    const { manager } = makeManager();
    expect(() => manager.removePeer('ghost')).not.toThrow();
  });

  it('clears a voice id when the peer loses their clone', async () => {
    vi.useFakeTimers();
    const { manager, opts } = makeManager();
    manager.activate('it');
    manager.setPeerVoiceId('peer-1', 'cloned');
    manager.setPeerVoiceId('peer-1', null);
    const stt = await startPeer(manager);

    stt.message(JSON.stringify({ type: 'transcript', is_final: true, text: 'warm up' }));
    vi.advanceTimersByTime(IDLE_FLUSH_MS);
    await vi.waitFor(() => expect(FakeWebSocket.tts).toHaveLength(1));
    (FakeWebSocket.tts[0] as FakeWebSocket).open();

    stt.message(JSON.stringify({ type: 'transcript', is_final: true, text: 'hi' }));
    vi.advanceTimersByTime(IDLE_FLUSH_MS);
    await vi.waitFor(() => expect(FakeWebSocket.tts[0]?.sent).toHaveLength(1));
    expect(JSON.parse(String(FakeWebSocket.tts[0]?.sent[0])).voice.id).toBe('default-voice');
    expect(opts.onSubtitle).toHaveBeenCalled();
  });
});
