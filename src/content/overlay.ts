/**
 * Subtitle overlay content script.
 *
 * Constraints that drove the design:
 *  - It must not touch the page's own state. Everything lives inside a Shadow DOM on a
 *    single host element, so page CSS cannot reach in and our CSS cannot leak out.
 *  - It must survive fullscreen. A fixed-position element in `document.body` disappears
 *    when a <video> goes fullscreen, so the host is re-parented into the fullscreen
 *    element when one exists.
 *  - It must never be injected twice. SPA navigation and repeated executeScript calls
 *    both re-run this file, so it guards on a marker property.
 *  - It must be removable instantly and completely when the session stops.
 */

import type { OverlayCommand, OverlayOptions } from '@/shared/messaging';

const HOST_ID = 'voxtranslate-subtitle-host';
const GUARD = '__voxtranslateOverlayInstalled';

interface OverlayHandle {
  show(options: OverlayOptions): void;
  update(partial: string | null, final: string | null, original: string | null): void;
  status(text: string | null): void;
  hide(): void;
}

function createOverlay(): OverlayHandle {
  let host: HTMLDivElement | null = null;
  let shadow: ShadowRoot | null = null;
  let line: HTMLDivElement | null = null;
  let originalLine: HTMLDivElement | null = null;
  let statusLine: HTMLDivElement | null = null;
  let fullscreenListener: (() => void) | null = null;

  /**
   * Keep the overlay inside whatever element is currently fullscreen. Without this the
   * subtitles vanish exactly when the user most wants them.
   */
  function attachToCorrectParent(): void {
    if (!host) return;
    const target = document.fullscreenElement ?? document.body;
    if (host.parentElement !== target) target.appendChild(host);
  }

  function build(options: OverlayOptions): void {
    host = document.createElement('div');
    host.id = HOST_ID;
    // `pointer-events: none` on the host is what keeps page controls clickable
    // through the overlay — a subtitle bar that eats clicks is a broken page.
    host.style.cssText = 'all: initial; position: fixed; inset: 0; pointer-events: none;';
    // High, but not 2147483647: leaving headroom lets a site's own modal still win,
    // which is the polite behaviour and avoids covering cookie/consent dialogs.
    host.style.zIndex = '2147483000';

    shadow = host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; }
      .wrap {
        position: absolute;
        left: 50%;
        transform: translateX(-50%);
        bottom: ${options.bottomOffset}px;
        max-width: min(90vw, 1100px);
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 6px;
        font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        text-align: center;
        pointer-events: none;
      }
      .line, .original, .status {
        /* A translucent plate plus a text shadow keeps the text readable over both
           bright and dark video without a heavy opaque box. */
        background: rgba(12, 12, 14, 0.72);
        color: #fff;
        border-radius: 8px;
        padding: 6px 14px;
        text-shadow: 0 1px 3px rgba(0, 0, 0, 0.9);
        line-height: 1.35;
        overflow-wrap: anywhere;
      }
      .line { font-size: ${options.fontSize}px; font-weight: 600; }
      .original { font-size: ${Math.round(options.fontSize * 0.78)}px; opacity: 0.78; font-weight: 400; }
      .status { font-size: 13px; opacity: 0.85; font-weight: 500; }
      .hidden { display: none; }
      /* Partials fade in so text does not pop; finals replace them in place, which is
         what stops the flicker you get from clearing before writing. */
      .line, .original { transition: opacity 120ms ease; }
    `;

    const wrap = document.createElement('div');
    wrap.className = 'wrap';

    statusLine = document.createElement('div');
    statusLine.className = 'status hidden';

    originalLine = document.createElement('div');
    originalLine.className = 'original hidden';

    line = document.createElement('div');
    line.className = 'line hidden';

    wrap.append(statusLine, originalLine, line);
    shadow.append(style, wrap);
  }

  return {
    show(options) {
      if (!host) build(options);
      attachToCorrectParent();
      if (!fullscreenListener) {
        fullscreenListener = () => attachToCorrectParent();
        document.addEventListener('fullscreenchange', fullscreenListener);
      }
    },

    update(partial, final, original) {
      if (!line || !originalLine) return;
      // A final replaces the partial in place rather than clearing first — clearing
      // is what produces the visible flicker between segments.
      const text = final ?? partial;
      line.textContent = text ?? '';
      line.classList.toggle('hidden', !text);

      originalLine.textContent = original ?? '';
      originalLine.classList.toggle('hidden', !original);
    },

    status(text) {
      if (!statusLine) return;
      statusLine.textContent = text ?? '';
      statusLine.classList.toggle('hidden', !text);
    },

    hide() {
      if (fullscreenListener) {
        document.removeEventListener('fullscreenchange', fullscreenListener);
        fullscreenListener = null;
      }
      host?.remove();
      host = null;
      shadow = null;
      line = null;
      originalLine = null;
      statusLine = null;
    },
  };
}

// Guard against double injection from repeated executeScript / SPA navigation.
const globalScope = globalThis as unknown as Record<string, unknown>;
if (!globalScope[GUARD]) {
  globalScope[GUARD] = true;
  const overlay = createOverlay();

  chrome.runtime.onMessage.addListener((message: OverlayCommand) => {
    switch (message.kind) {
      case 'OVERLAY_SHOW':
        overlay.show(message.options);
        break;
      case 'OVERLAY_UPDATE':
        overlay.update(message.partial, message.final, message.original);
        break;
      case 'OVERLAY_STATUS':
        overlay.status(message.text);
        break;
      case 'OVERLAY_HIDE':
        overlay.hide();
        break;
    }
    return false;
  });

  // A page unload during a session must not leave a dangling host element behind.
  window.addEventListener('pagehide', () => overlay.hide(), { once: true });
}
