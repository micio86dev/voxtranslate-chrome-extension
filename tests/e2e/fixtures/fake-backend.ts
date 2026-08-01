/**
 * A fake VoxTranslate backend for end-to-end tests.
 *
 * Speaks enough of the real contract (`server/src/protocol.rs`, `/api/user/me`,
 * `/api/engines`) to drive the extension through a full session without touching
 * production, without a provider, and without spending a cent.
 *
 * It also records what the extension actually SENT — the binary audio frames and the
 * `start`/`stop` control frames — which is the only way to prove the capture pipeline
 * really produced encoded audio rather than silently failing.
 *
 * Built on `node:http` + `ws` because Playwright's runner is Node, not Bun.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';

export interface Recorded {
  connections: number;
  /** Query params of each /ws upgrade, so tests can assert lang/engine/token. */
  connectParams: URLSearchParams[];
  controlFrames: string[];
  audioFrameCount: number;
  audioByteTotal: number;
  closed: number;
}

export interface FakeBackend {
  port: number;
  origin: string;
  recorded: Recorded;
  /** Push a raw protocol frame to every live socket. */
  broadcast(frame: unknown): void;
  /** Resolves once at least `n` audio frames have arrived; rejects on timeout. */
  waitForAudio(n: number, timeoutMs?: number): Promise<void>;
  stop(): Promise<void>;
}

const TEST_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Audio fixture</title></head>
<body style="margin:0;background:#111;color:#eee;font:16px system-ui">
  <h1 id="title">Tab audio fixture</h1>
  <div id="player" style="padding:2rem">playing a tone</div>
  <script>
    // A continuous oscillator gives the tab real, capturable audio without shipping a
    // media file. Autoplay is permitted via --autoplay-policy in the test launch args.
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0.05;
    osc.type = 'sine';
    osc.frequency.value = 220;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    window.__audioState = ctx.state;
  </script>
</body></html>`;

const CORS = {
  // The real backend must allow-list the extension origin; the fake one is permissive
  // so these tests exercise the client, not CORS configuration.
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization,content-type',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
};

export async function startFakeBackend(): Promise<FakeBackend> {
  const recorded: Recorded = {
    connections: 0,
    connectParams: [],
    controlFrames: [],
    audioFrameCount: 0,
    audioByteTotal: 0,
    closed: 0,
  };

  const sockets = new Set<WebSocket>();

  const json = (res: ServerResponse, body: unknown, status = 200): void => {
    res.writeHead(status, { 'content-type': 'application/json', ...CORS });
    res.end(JSON.stringify(body));
  };

  const httpServer: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      res.end();
      return;
    }

    if (url.pathname === '/page') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(TEST_PAGE);
      return;
    }

    if (url.pathname === '/api/user/me') {
      json(res, {
        id: 'usr_test',
        email: 'tester@example.com',
        name: 'Test User',
        avatar_url: null,
        balance: 5.0,
        consent_given: true,
        language: 'it',
      });
      return;
    }

    if (url.pathname === '/api/engines') {
      // Shapes mirror the real EngineInfo DTO — rate only, never raw cost or markup.
      json(res, {
        engines: [
          {
            id: 'standard',
            display_name: 'Standard',
            tier: 'standard',
            description: 'Subtitles',
            rate_per_minute: 0.01,
            input_languages: ['en', 'it'],
            output_languages: ['en', 'it'],
            capabilities: {
              translated_audio: false,
              cost_scales_per_language: false,
              client_direct: false,
              max_room_size: 4,
            },
          },
        ],
        flags: {},
      });
      return;
    }

    if (url.pathname === '/api/user/language') {
      json(res, {});
      return;
    }

    res.writeHead(404, CORS);
    res.end('not found');
  });

  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    sockets.add(ws);
    recorded.connections += 1;
    recorded.connectParams.push(new URLSearchParams(new URL(req.url ?? '', 'http://x').search));

    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        // Binary = encoded audio. Counting bytes proves the recorder really ran.
        recorded.audioFrameCount += 1;
        recorded.audioByteTotal += data.byteLength;
        return;
      }
      recorded.controlFrames.push(data.toString('utf8'));
    });

    ws.on('close', () => {
      sockets.delete(ws);
      recorded.closed += 1;
    });
  });

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const port = (httpServer.address() as AddressInfo).port;

  return {
    port,
    origin: `http://localhost:${port}`,
    recorded,

    broadcast(frame) {
      const payload = typeof frame === 'string' ? frame : JSON.stringify(frame);
      for (const ws of sockets) {
        if (ws.readyState === ws.OPEN) ws.send(payload);
      }
    },

    async waitForAudio(n, timeoutMs = 20_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (recorded.audioFrameCount >= n) return;
        if (Date.now() > deadline) {
          throw new Error(
            `timed out waiting for ${n} audio frames (got ${recorded.audioFrameCount})`,
          );
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    },

    async stop() {
      for (const ws of sockets) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
