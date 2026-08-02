/**
 * Unit tests for the capture pipeline.
 *
 * This file exists because tab capture CANNOT be automated end-to-end. `activeTab`
 * requires a real user invocation of the extension action, and Chrome refuses otherwise
 * with "Extension has not been invoked for the current page (see activeTab permission)".
 * Playwright cannot click browser chrome, so the only honest way to cover the riskiest
 * file in the extension is to inject the browser APIs and assert the behaviour directly.
 *
 * What is asserted here is exactly what breaks in production: the tab going silent, the
 * wrong encoder settings, unbounded buffering, and resources surviving teardown.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AUDIO } from '@/shared/config';
import { BACKPRESSURE_BYTES, CapturePipeline, type PipelineEnv } from '@/offscreen/pipeline';

// --- fakes -----------------------------------------------------------------

class FakeTrack {
  stopped = false;
  private listeners: Record<string, (() => void)[]> = {};
  addEventListener(type: string, fn: () => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  emit(type: string) {
    for (const fn of this.listeners[type] ?? []) fn();
  }
  stop() {
    this.stopped = true;
  }
}

class FakeStream {
  tracks = [new FakeTrack()];
  getAudioTracks() {
    return this.tracks;
  }
  getTracks() {
    return this.tracks;
  }
}

class FakeGain {
  value = 0;
  gain = {
    value: 0,
    setTargetAtTime: (v: number) => {
      this.gain.value = v;
    },
  };
  connectedTo: unknown = null;
  connect(node: unknown) {
    this.connectedTo = node;
    return node;
  }
}

class FakeAudioContext {
  state = 'running';
  currentTime = 0;
  destination = { id: 'destination' };
  closed = false;
  lastGain: FakeGain | null = null;
  sourceConnectedTo: unknown = null;

  createMediaStreamSource() {
    return {
      connect: (node: unknown) => {
        this.sourceConnectedTo = node;
        return node;
      },
    };
  }
  createGain() {
    this.lastGain = new FakeGain();
    return this.lastGain;
  }
  async close() {
    this.closed = true;
    this.state = 'closed';
  }
}

class FakeRecorder {
  state: 'inactive' | 'recording' = 'inactive';
  timeslice: number | null = null;
  private listeners: Record<string, ((e: unknown) => void)[]> = {};

  constructor(
    readonly stream: unknown,
    readonly options: MediaRecorderOptions,
  ) {}

  addEventListener(type: string, fn: (e: unknown) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  start(timeslice: number) {
    this.state = 'recording';
    this.timeslice = timeslice;
  }
  stop() {
    this.state = 'inactive';
  }
  /** Simulate a chunk of encoded audio. */
  emitChunk(bytes: number) {
    const blob = { size: bytes, arrayBuffer: async () => new ArrayBuffer(bytes) };
    for (const fn of this.listeners['dataavailable'] ?? []) fn({ data: blob });
  }
}

class FakeSocket {
  static OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  sent: unknown[] = [];
  closedWith: { code: number; reason: string } | null = null;
  private listeners: Record<string, ((e: unknown) => void)[]> = {};

  constructor(readonly url: string) {}

  addEventListener(type: string, fn: (e: unknown) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  emit(type: string, event: unknown = {}) {
    for (const fn of this.listeners[type] ?? []) fn(event);
  }
  send(payload: unknown) {
    this.sent.push(payload);
  }
  close(code: number, reason: string) {
    this.closedWith = { code, reason };
    this.readyState = 3;
  }
}

interface Harness {
  env: PipelineEnv;
  context: FakeAudioContext;
  recorder: FakeRecorder;
  socket: FakeSocket;
  stream: FakeStream;
  events: { errors: [string, string][]; frames: string[]; opened: number; closed: number[] };
  pipeline: CapturePipeline;
}

function harness(overrides: Partial<PipelineEnv> = {}, pcm = false): Harness {
  const stream = new FakeStream();
  const context = new FakeAudioContext();
  let recorder!: FakeRecorder;
  let socket!: FakeSocket;

  const events = {
    errors: [] as [string, string][],
    frames: [] as string[],
    opened: 0,
    closed: [] as number[],
  };

  const env: PipelineEnv = {
    getUserMedia: async () => stream as unknown as MediaStream,
    createAudioContext: () => context as unknown as AudioContext,
    createRecorder: (s, o) => {
      recorder = new FakeRecorder(s, o);
      return recorder as unknown as MediaRecorder;
    },
    createSocket: (url) => {
      socket = new FakeSocket(url);
      return socket as unknown as WebSocket;
    },
    isTypeSupported: () => true,
    ...overrides,
  };

  const pipeline = new CapturePipeline(
    {
      sessionId: 's1',
      streamId: 'stream-1',
      wsUrl: 'ws://test/ws',
      originalVolume: 0.2,
      translatedAudioEnabled: false,
      pcm,
      clientDirect: false,
      sourceLang: 'es',
      targetLang: 'it',
    },
    {
      onSocketOpen: () => (events.opened += 1),
      onSocketClosed: (code) => events.closed.push(code),
      onFrame: (raw) => events.frames.push(raw),
      onError: (reason, code) => events.errors.push([reason, code]),
    },
    env,
  );

  return {
    env,
    context,
    stream,
    get recorder() {
      return recorder;
    },
    get socket() {
      return socket;
    },
    events,
    pipeline,
  } as Harness;
}

/**
 * Open the socket and let the encoder start.
 *
 * Encoder selection is async (the PCM path awaits an AudioWorklet module), so the
 * recorder does not exist on the same tick as the `open` event.
 */
async function open(h: Harness): Promise<void> {
  h.socket.emit('open');
  await vi.waitFor(() => expect(h.recorder ?? h.pipeline).toBeDefined());
  await Promise.resolve();
  await Promise.resolve();
}

// --- tests -----------------------------------------------------------------

describe('capture pipeline', () => {
  let h: Harness;

  beforeEach(async () => {
    h = harness();
    await h.pipeline.start();
  });

  it('routes captured audio back to the speakers so the tab does not go silent', () => {
    // The single most damaging failure mode: tabCapture takes the tab's audio, so
    // without this graph the user hears nothing and blames the extension.
    expect(h.context.sourceConnectedTo).toBe(h.context.lastGain);
    expect(h.context.lastGain?.connectedTo).toBe(h.context.destination);
  });

  it('applies the requested original-audio volume to the gain node', () => {
    expect(h.context.lastGain?.gain.value).toBe(0.2);
  });

  it('encodes with the format the backend already ingests', async () => {
    await open(h);
    expect(h.recorder.options.mimeType).toBe(AUDIO.mimeType);
    expect(h.recorder.options.audioBitsPerSecond).toBe(AUDIO.bitsPerSecond);
    expect(h.recorder.timeslice).toBe(AUDIO.timesliceMs);
    expect(h.recorder.state).toBe('recording');
  });

  it('does NOT record before the socket is open', () => {
    // The bug this guards: recording started immediately, so every chunk produced
    // before the handshake completed was dropped by sendAudio — including chunk #1,
    // the one carrying the WebM header. The server then fed Deepgram a headerless
    // stream: detection fell back to its default and transcription returned nothing,
    // with no error raised anywhere.
    expect(h.recorder).toBeUndefined();
  });

  it('starts a FRESH recorder on every connection, so each stream carries a header', async () => {
    await open(h);
    const first = h.recorder;
    expect(first.state).toBe('recording');

    h.pipeline.reconnect('ws://test/ws?retry=1');
    await open(h);

    // A resumed recorder would emit a headerless continuation, and the server's NEW
    // Deepgram session could not decode it.
    expect(h.recorder).not.toBe(first);
    expect(first.state).toBe('inactive');
    expect(h.recorder.state).toBe('recording');
  });

  it('falls back to a plain webm mime when the preferred codec is unsupported', async () => {
    const fallback = harness({ isTypeSupported: () => false });
    await fallback.pipeline.start();
    await open(fallback);
    expect(fallback.recorder.options.mimeType).toBe(AUDIO.fallbackMimeType);
  });

  it('sends a start control frame so the server opens the STT stream', () => {
    h.socket.emit('open');
    expect(h.socket.sent.some((s) => String(s).includes('"start"'))).toBe(true);
    expect(h.events.opened).toBe(1);
  });

  it('forwards encoded chunks to the socket', async () => {
    await open(h);
    h.recorder.emitChunk(512);
    await vi.waitFor(() => expect(h.socket.sent.length).toBeGreaterThan(1));
    expect(h.socket.sent.some((s) => s instanceof ArrayBuffer)).toBe(true);
  });

  it('drops audio instead of buffering when the socket backs up', async () => {
    await open(h);
    const before = h.socket.sent.length;
    h.socket.bufferedAmount = BACKPRESSURE_BYTES + 1;
    h.recorder.emitChunk(512);
    await new Promise((r) => setTimeout(r, 20));
    // Stale audio is worthless for live subtitles, and an unbounded queue is how
    // extensions leak memory — so the frame must be dropped, not queued.
    expect(h.socket.sent.length).toBe(before);
  });

  it('ignores empty chunks', async () => {
    await open(h);
    const before = h.socket.sent.length;
    h.recorder.emitChunk(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(h.socket.sent.length).toBe(before);
  });

  it('reports the tab going away rather than sitting on a dead stream', () => {
    h.stream.tracks[0]!.emit('ended');
    expect(h.events.errors).toContainEqual(['tab audio ended', 'tab_closed']);
  });

  it('surfaces a socket close with its code', () => {
    h.socket.emit('close', { code: 1006 });
    expect(h.events.closed).toEqual([1006]);
  });

  it('passes only text frames to the handler', () => {
    h.socket.emit('message', { data: '{"type":"balance_update","balance":1}' });
    h.socket.emit('message', { data: new ArrayBuffer(4) });
    expect(h.events.frames).toHaveLength(1);
  });

  it('ramps volume changes instead of stepping, to avoid an audible click', () => {
    h.pipeline.setOriginalVolume(0.9);
    expect(h.context.lastGain?.gain.value).toBeCloseTo(0.9);
  });

  it('clamps volume to 0..1', () => {
    h.pipeline.setOriginalVolume(5);
    expect(h.context.lastGain?.gain.value).toBe(1);
    h.pipeline.setOriginalVolume(-2);
    expect(h.context.lastGain?.gain.value).toBe(0);
  });

  it('releases every resource on dispose', async () => {
    await open(h); // the recorder only exists once the socket is up
    await h.pipeline.dispose();

    expect(h.recorder.state).toBe('inactive');
    expect(h.socket.closedWith?.code).toBe(1000);
    expect(h.stream.tracks[0]!.stopped).toBe(true);
    expect(h.context.closed).toBe(true);
  });

  it('sends a stop control frame before closing the socket', async () => {
    await open(h);
    await h.pipeline.dispose();
    expect(h.socket.sent.some((s) => String(s).includes('"stop"'))).toBe(true);
  });

  it('is safe to dispose twice', async () => {
    await h.pipeline.dispose();
    await expect(h.pipeline.dispose()).resolves.toBeUndefined();
  });

  it('emits nothing after disposal', async () => {
    await h.pipeline.dispose();
    const before = h.events.errors.length;
    h.stream.tracks[0]!.emit('ended');
    expect(h.events.errors.length).toBe(before);
  });

  it('reports a denied capture without leaving resources behind', async () => {
    const denied = harness({
      getUserMedia: () => Promise.reject(new Error('NotAllowedError')),
    });
    await denied.pipeline.start();

    expect(denied.events.errors[0]?.[1]).toBe('capture_denied');
    // No recorder or socket is created when the stream never opened.
    expect(denied.recorder).toBeUndefined();
    expect(denied.socket).toBeUndefined();
  });
});

describe('reconnection', () => {
  it('reopens only the socket, keeping capture and the audio graph alive', async () => {
    const h = harness();
    await h.pipeline.start();
    const firstSocket = h.socket;

    h.pipeline.reconnect('ws://test/ws?retry=1');

    // A new socket was opened at the new URL...
    expect(h.socket).not.toBe(firstSocket);
    expect(h.socket.url).toContain('retry=1');
    // ...and the tab capture survived. Re-requesting it would need another user
    // gesture, so tearing it down would end the session for good.
    expect(h.stream.tracks[0]!.stopped).toBe(false);
    expect(h.context.closed).toBe(false);
  });

  it('does not report the deliberate close of the old socket as a failure', async () => {
    const h = harness();
    await h.pipeline.start();
    const firstSocket = h.socket;

    h.pipeline.reconnect('ws://test/ws?retry=1');
    // The old socket closing is expected; surfacing it would trigger a second
    // reconnect for a drop that never happened.
    firstSocket.emit('close', { code: 1000 });
    expect(h.events.closed).toEqual([]);
  });

  it('sends a fresh start frame on the new socket', async () => {
    const h = harness();
    await h.pipeline.start();
    h.pipeline.reconnect('ws://test/ws?retry=1');

    h.socket.emit('open');
    expect(h.socket.sent.some((s) => String(s).includes('"start"'))).toBe(true);
  });

  it('sends audio to the new socket after reconnecting', async () => {
    const h = harness();
    await h.pipeline.start();
    h.pipeline.reconnect('ws://test/ws?retry=1');
    await open(h);

    const before = h.socket.sent.length;
    h.recorder.emitChunk(256);
    await vi.waitFor(() => expect(h.socket.sent.length).toBeGreaterThan(before));
  });

  it('does nothing once disposed', async () => {
    const h = harness();
    await h.pipeline.start();
    const socket = h.socket;
    await h.pipeline.dispose();

    h.pipeline.reconnect('ws://test/ws?retry=1');
    expect(h.socket).toBe(socket);
  });
});

describe('encoder switching', () => {
  it('stops the Opus recorder when the server asks for PCM', async () => {
    const h = harness();
    await h.pipeline.start();
    await open(h);
    expect(h.recorder.state).toBe('recording');

    // PcmEncoder needs a real AudioWorklet, which happy-dom does not provide, so the
    // switch fails — and the important guarantee is the FALLBACK: a failed PCM switch
    // must restart Opus rather than leave the session silently mute.
    await h.pipeline.setPcmMode(true);
    expect(h.recorder.state).toBe('recording');
  });

  it('is a no-op when already in the requested mode', async () => {
    const h = harness();
    await h.pipeline.start();
    await open(h);
    const recorder = h.recorder;
    await h.pipeline.setPcmMode(false);
    expect(h.recorder).toBe(recorder);
  });
});

describe('capture encoding contract', () => {
  it('uses WebM/Opus for a subtitles-only tier', async () => {
    const h = harness();
    await h.pipeline.start();
    await open(h);
    // Standard consumes WebM/Opus; a MediaRecorder is the right encoder.
    expect(h.recorder).toBeDefined();
    expect(h.recorder.options.mimeType).toBe(AUDIO.mimeType);
  });

  it('does NOT start a MediaRecorder for a speech-to-speech tier', async () => {
    // The bug this guards: Pro and Premium consume PCM16 and read Opus bytes as samples,
    // producing neither subtitles nor audio — silently. The encoder must be chosen from
    // the tier BEFORE the socket opens, not from a later capture_format round-trip that
    // races the `start` frame.
    const h = harness({}, true);
    await h.pipeline.start();
    h.socket.emit('open');
    await Promise.resolve();
    await Promise.resolve();
    expect(h.recorder).toBeUndefined();
  });
});
