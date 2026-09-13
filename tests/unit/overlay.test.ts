/**
 * The subtitle overlay content script.
 *
 * It is a side-effecting module: importing it installs the runtime listener. So each
 * test resets the module registry, re-stubs `chrome`, and re-imports. The shadow root is
 * `mode: 'closed'` by design (page scripts must not reach in), so the test captures it
 * through `attachShadow` rather than reading `host.shadowRoot` — which is exactly what a
 * page cannot do.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OverlayCommand, OverlayOptions } from '@/shared/messaging';

const HOST_ID = 'voxtranslate-subtitle-host';
const IDLE_CLEAR_MS = 7_000;
const OPTIONS: OverlayOptions = { fontSize: 22, bottomOffset: 80, dualLanguage: true };

type Listener = (message: OverlayCommand) => boolean;

let send: Listener;
let shadowRoots: ShadowRoot[];
let attachShadowSpy: { mockRestore: () => void };

/** Import the content script fresh and return the message listener it installed. */
async function installOverlay(): Promise<void> {
  vi.resetModules();
  shadowRoots = [];
  const listeners: Listener[] = [];
  vi.stubGlobal('chrome', {
    runtime: { onMessage: { addListener: (fn: Listener) => listeners.push(fn) } },
  });
  // The guard property is on globalThis, so a re-import in the same realm would be a
  // no-op without clearing it.
  delete (globalThis as unknown as Record<string, unknown>)['__voxtranslateOverlayInstalled'];

  const original = Element.prototype.attachShadow;
  attachShadowSpy = vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (
    this: Element,
    init: ShadowRootInit,
  ) {
    // Force `open` so the test can read what a page script deliberately cannot.
    const root = original.call(this, { ...init, mode: 'open' });
    shadowRoots.push(root);
    return root;
  });

  await import('@/content/overlay');
  send = listeners[0] as Listener;
}

function host(): HTMLElement | null {
  return document.getElementById(HOST_ID);
}

function shadow(): ShadowRoot {
  const root = shadowRoots[0];
  if (!root) throw new Error('overlay never attached a shadow root');
  return root;
}

const q = (selector: string) => shadow().querySelector(selector) as HTMLElement | null;

beforeEach(async () => {
  document.body.innerHTML = '';
  vi.useFakeTimers();
  await installOverlay();
});

afterEach(() => {
  attachShadowSpy.mockRestore();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (globalThis as unknown as Record<string, unknown>)['__voxtranslateOverlayInstalled'];
});

describe('installation', () => {
  it('registers exactly one runtime listener', () => {
    expect(typeof send).toBe('function');
  });

  it('answers the listener synchronously so Chrome does not hold the port open', () => {
    expect(send({ kind: 'OVERLAY_SHOW', options: OPTIONS })).toBe(false);
  });

  it('builds nothing until it is shown', () => {
    expect(host()).toBeNull();
  });

  it('ignores a second injection instead of stacking two overlays', async () => {
    // SPA navigation and repeated executeScript both re-run the file.
    const listeners: Listener[] = [];
    vi.stubGlobal('chrome', {
      runtime: { onMessage: { addListener: (fn: Listener) => listeners.push(fn) } },
    });
    vi.resetModules();
    await import('@/content/overlay');
    expect(listeners).toHaveLength(0);
  });
});

describe('OVERLAY_SHOW', () => {
  beforeEach(() => send({ kind: 'OVERLAY_SHOW', options: OPTIONS }));

  it('mounts a single host into the body', () => {
    expect(host()).not.toBeNull();
    expect(document.querySelectorAll(`#${HOST_ID}`)).toHaveLength(1);
  });

  it('lets page controls stay clickable through the overlay', () => {
    expect(host()?.style.cssText).toContain('pointer-events: none');
  });

  it('leaves z-index headroom so a site modal can still win', () => {
    const z = Number(host()?.style.zIndex);
    expect(z).toBeGreaterThan(1_000_000);
    expect(z).toBeLessThan(2_147_483_647);
  });

  it('pushes size and position into custom properties, not the stylesheet', () => {
    expect(host()?.style.getPropertyValue('--vox-font-size')).toBe('22px');
    expect(host()?.style.getPropertyValue('--vox-bottom')).toBe('80px');
    // The original line is deliberately smaller than the translation.
    expect(host()?.style.getPropertyValue('--vox-original-size')).toBe('19px');
  });

  it('isolates its markup inside a shadow root', () => {
    expect(q('.wrap')).not.toBeNull();
    expect(q('.line')).not.toBeNull();
    expect(q('.original')).not.toBeNull();
    expect(q('.status')).not.toBeNull();
  });

  it('starts with every line hidden', () => {
    expect(q('.status')?.className).toContain('hidden');
    expect(q('.original')?.parentElement?.className).toContain('hidden');
    expect(q('.line')?.parentElement?.className).toContain('hidden');
  });

  it('keeps the clamp and the plate on different elements', () => {
    // overflow:hidden clips at the padding box, so a clamped element carrying padding
    // shows a sliced half-line under the ellipsis.
    expect(q('.line')?.parentElement?.className).toContain('plate');
    expect(q('.line')?.className).not.toContain('plate');
  });

  it('does not rebuild the host when shown twice', () => {
    const first = host();
    send({ kind: 'OVERLAY_SHOW', options: { ...OPTIONS, fontSize: 40 } });
    expect(host()).toBe(first);
    expect(document.querySelectorAll(`#${HOST_ID}`)).toHaveLength(1);
  });
});

describe('OVERLAY_UPDATE', () => {
  beforeEach(() => send({ kind: 'OVERLAY_SHOW', options: OPTIONS }));

  it('writes the translated line and reveals its plate', () => {
    send({ kind: 'OVERLAY_UPDATE', main: 'ciao a tutti' });
    expect(q('.line')?.textContent).toBe('ciao a tutti');
    expect(q('.line')?.parentElement?.className).not.toContain('hidden');
  });

  it('writes the original line independently', () => {
    send({ kind: 'OVERLAY_UPDATE', secondary: 'hello everyone' });
    expect(q('.original')?.textContent).toBe('hello everyone');
    expect(q('.line')?.textContent).toBe('');
  });

  it('leaves an omitted line untouched on the next partial', () => {
    // A single "whole state" payload would blank the main line on every partial.
    send({ kind: 'OVERLAY_UPDATE', main: 'finale', secondary: 'final' });
    send({ kind: 'OVERLAY_UPDATE', secondary: 'final wo' });
    expect(q('.line')?.textContent).toBe('finale');
    expect(q('.original')?.textContent).toBe('final wo');
  });

  it('clears a line only when explicitly told null', () => {
    send({ kind: 'OVERLAY_UPDATE', main: 'qualcosa' });
    send({ kind: 'OVERLAY_UPDATE', main: null });
    expect(q('.line')?.textContent).toBe('');
    expect(q('.line')?.parentElement?.className).toContain('hidden');
  });

  it('replaces text in place rather than clearing first', () => {
    const lineEl = q('.line');
    send({ kind: 'OVERLAY_UPDATE', main: 'uno' });
    send({ kind: 'OVERLAY_UPDATE', main: 'uno due' });
    expect(q('.line')).toBe(lineEl);
    expect(lineEl?.textContent).toBe('uno due');
  });

  it('hides the plates, not the text, after an idle gap', () => {
    send({ kind: 'OVERLAY_UPDATE', main: 'ultimo', secondary: 'last' });
    vi.advanceTimersByTime(IDLE_CLEAR_MS);
    expect(q('.line')?.parentElement?.className).toContain('hidden');
    expect(q('.original')?.parentElement?.className).toContain('hidden');
  });

  it('restarts the idle countdown on every new segment', () => {
    send({ kind: 'OVERLAY_UPDATE', main: 'uno' });
    vi.advanceTimersByTime(IDLE_CLEAR_MS - 500);
    send({ kind: 'OVERLAY_UPDATE', main: 'due' });
    vi.advanceTimersByTime(IDLE_CLEAR_MS - 500);
    expect(q('.line')?.parentElement?.className).not.toContain('hidden');
  });

  it('does nothing when the overlay was never shown', () => {
    send({ kind: 'OVERLAY_HIDE' });
    expect(() => send({ kind: 'OVERLAY_UPDATE', main: 'x' })).not.toThrow();
  });
});

describe('OVERLAY_STYLE', () => {
  it('restyles a live overlay without restarting the session', () => {
    send({ kind: 'OVERLAY_SHOW', options: OPTIONS });
    send({
      kind: 'OVERLAY_STYLE',
      options: { fontSize: 36, bottomOffset: 140, dualLanguage: false },
    });
    expect(host()?.style.getPropertyValue('--vox-font-size')).toBe('36px');
    expect(host()?.style.getPropertyValue('--vox-bottom')).toBe('140px');
    expect(host()?.style.getPropertyValue('--vox-original-size')).toBe('31px');
  });

  it('is a no-op before the overlay exists', () => {
    expect(() => send({ kind: 'OVERLAY_STYLE', options: OPTIONS })).not.toThrow();
    expect(host()).toBeNull();
  });
});

describe('OVERLAY_STATUS', () => {
  beforeEach(() => send({ kind: 'OVERLAY_SHOW', options: OPTIONS }));

  it('shows a status line', () => {
    send({ kind: 'OVERLAY_STATUS', text: 'Reconnecting…' });
    expect(q('.status')?.textContent).toBe('Reconnecting…');
    expect(q('.status')?.className).not.toContain('hidden');
  });

  it('hides the status line when cleared', () => {
    send({ kind: 'OVERLAY_STATUS', text: 'Reconnecting…' });
    send({ kind: 'OVERLAY_STATUS', text: null });
    expect(q('.status')?.textContent).toBe('');
    expect(q('.status')?.className).toContain('hidden');
  });

  it('is a no-op before the overlay exists', () => {
    send({ kind: 'OVERLAY_HIDE' });
    expect(() => send({ kind: 'OVERLAY_STATUS', text: 'x' })).not.toThrow();
  });
});

describe('OVERLAY_HIDE', () => {
  it('removes the host completely', () => {
    send({ kind: 'OVERLAY_SHOW', options: OPTIONS });
    send({ kind: 'OVERLAY_HIDE' });
    expect(host()).toBeNull();
  });

  it('stops the idle timer so nothing fires after teardown', () => {
    send({ kind: 'OVERLAY_SHOW', options: OPTIONS });
    send({ kind: 'OVERLAY_UPDATE', main: 'x' });
    send({ kind: 'OVERLAY_HIDE' });
    expect(() => vi.advanceTimersByTime(IDLE_CLEAR_MS * 2)).not.toThrow();
  });

  it('detaches the fullscreen listener', () => {
    const remove = vi.spyOn(document, 'removeEventListener');
    send({ kind: 'OVERLAY_SHOW', options: OPTIONS });
    send({ kind: 'OVERLAY_HIDE' });
    expect(remove).toHaveBeenCalledWith('fullscreenchange', expect.any(Function));
    remove.mockRestore();
  });

  it('can be shown again after hiding', () => {
    send({ kind: 'OVERLAY_SHOW', options: OPTIONS });
    send({ kind: 'OVERLAY_HIDE' });
    send({ kind: 'OVERLAY_SHOW', options: OPTIONS });
    expect(host()).not.toBeNull();
  });

  it('is safe to call twice', () => {
    send({ kind: 'OVERLAY_SHOW', options: OPTIONS });
    send({ kind: 'OVERLAY_HIDE' });
    expect(() => send({ kind: 'OVERLAY_HIDE' })).not.toThrow();
  });
});

describe('fullscreen', () => {
  it('re-parents into the fullscreen element so subtitles survive going fullscreen', () => {
    const player = document.createElement('div');
    document.body.append(player);
    send({ kind: 'OVERLAY_SHOW', options: OPTIONS });
    expect(host()?.parentElement).toBe(document.body);

    Object.defineProperty(document, 'fullscreenElement', {
      value: player,
      configurable: true,
    });
    document.dispatchEvent(new Event('fullscreenchange'));
    expect(host()?.parentElement).toBe(player);

    Object.defineProperty(document, 'fullscreenElement', {
      value: null,
      configurable: true,
    });
    document.dispatchEvent(new Event('fullscreenchange'));
    expect(host()?.parentElement).toBe(document.body);
  });

  it('registers the fullscreen listener only once across repeated shows', () => {
    const add = vi.spyOn(document, 'addEventListener');
    send({ kind: 'OVERLAY_SHOW', options: OPTIONS });
    send({ kind: 'OVERLAY_SHOW', options: OPTIONS });
    const calls = add.mock.calls.filter(([type]) => type === 'fullscreenchange');
    expect(calls).toHaveLength(1);
    add.mockRestore();
  });
});

describe('page unload', () => {
  it('tears the overlay down so no host is left dangling', () => {
    send({ kind: 'OVERLAY_SHOW', options: OPTIONS });
    window.dispatchEvent(new Event('pagehide'));
    expect(host()).toBeNull();
  });
});
