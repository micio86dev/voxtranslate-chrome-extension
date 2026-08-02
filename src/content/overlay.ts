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

/**
 * Clear the lines after this long with nothing new.
 *
 * Without it the last thing said stays burned onto the video indefinitely — during a
 * pause, a silent passage, or after the session ends badly. Long enough that a normal
 * gap between sentences does not blink the text away.
 */
const IDLE_CLEAR_MS = 7_000;

interface OverlayHandle {
  show(options: OverlayOptions): void;
  /** Omitted = leave that line alone; explicit null = clear it. */
  update(main: string | null | undefined, secondary: string | null | undefined): void;
  /** Restyle a LIVE overlay — size and position change without restarting the session. */
  restyle(options: OverlayOptions): void;
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
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Keep the overlay inside whatever element is currently fullscreen. Without this the
   * subtitles vanish exactly when the user most wants them.
   */
  function attachToCorrectParent(): void {
    if (!host) return;
    const target = document.fullscreenElement ?? document.body;
    if (host.parentElement !== target) target.appendChild(host);
  }

  /** Push the adjustable values into the host's custom properties. */
  function applyStyleVars(options: OverlayOptions): void {
    if (!host) return;
    host.style.setProperty('--vox-font-size', `${options.fontSize}px`);
    host.style.setProperty('--vox-original-size', `${Math.round(options.fontSize * 0.86)}px`);
    host.style.setProperty('--vox-bottom', `${options.bottomOffset}px`);
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
    // Size and position live in custom properties so they can be changed on a running
    // overlay by setting two values, instead of rebuilding the stylesheet.
    applyStyleVars(options);

    shadow = host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; }
      .wrap {
        position: absolute;
        left: 50%;
        transform: translateX(-50%);
        bottom: var(--vox-bottom, 80px);
        max-width: min(90vw, 1100px);
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 6px;
        font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        text-align: center;
        pointer-events: none;
      }
      /* A very long segment must not cover the video. Clamp instead of growing. */
      .line, .original {
        display: -webkit-box;
        -webkit-line-clamp: 3;
        -webkit-box-orient: vertical;
        overflow: hidden;
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
      .line { font-size: var(--vox-font-size, 22px); font-weight: 600; }
      /* The original has to stay READABLE, not decorative: it is a second subtitle, and
         at 78% size and 78% opacity over moving video it was not. Slightly smaller than
         the translation and tinted, so the two are told apart by hue rather than by
         being hard to see. */
      .original {
        font-size: var(--vox-original-size, 19px);
        color: #d7e3ff;
        opacity: 0.95;
        font-weight: 500;
      }
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

    update(main, secondary) {
      // Each line is written only when the caller says something about it. New text
      // replaces old IN PLACE rather than clearing first — clearing is what produces the
      // visible flicker between segments.
      if (main !== undefined && line) {
        line.textContent = main ?? '';
        line.classList.toggle('hidden', !main);
      }
      if (secondary !== undefined && originalLine) {
        originalLine.textContent = secondary ?? '';
        originalLine.classList.toggle('hidden', !secondary);
      }

      // Restart the idle countdown: subtitles should fade out of the way during a pause
      // rather than leaving the last sentence sitting on the picture.
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimer = null;
        line?.classList.add('hidden');
        originalLine?.classList.add('hidden');
      }, IDLE_CLEAR_MS);
    },

    restyle(options) {
      applyStyleVars(options);
    },

    status(text) {
      if (!statusLine) return;
      statusLine.textContent = text ?? '';
      statusLine.classList.toggle('hidden', !text);
    },

    hide() {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
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
        overlay.update(message.main, message.secondary);
        break;
      case 'OVERLAY_STYLE':
        overlay.restyle(message.options);
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
