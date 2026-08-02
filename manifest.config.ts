import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

/**
 * Manifest V3 for VoxTranslate for Chrome.
 *
 * Permission rationale (mirrored in docs/store/permissions.md — keep both in sync):
 *
 * - `activeTab`   the user's click on "Start" grants access to THAT tab only. This is what
 *                 lets us inject the subtitle overlay without asking for every site.
 * - `tabCapture`  reads the audio of the tab the user explicitly started on. Note that
 *                 capturing a tab MUTES it for the user, so the offscreen document routes
 *                 the captured stream back to the speakers through a GainNode — which is
 *                 also the original-audio volume control.
 * - `offscreen`   an MV3 service worker cannot hold an AudioContext or a long-lived
 *                 MediaStream; the offscreen document is the only supported place for a
 *                 continuous capture pipeline.
 * - `sidePanel`   the main UI surface. NOTE: the panel cannot grant `activeTab` — only
 *                 an action click, context menu, keyboard shortcut or omnibox can — so
 *                 the toolbar click is what authorises capture, and it opens the panel
 *                 programmatically (see background/index.ts).
 * - `identity`    launchWebAuthFlow for the PKCE login handoff.
 * - `storage`     tokens + a cache of server-owned preferences.
 * - `scripting`   programmatic overlay injection on user gesture (paired with activeTab,
 *                 so it is NOT a blanket content-script grant).
 *
 * Deliberately NOT requested: `<all_urls>`, `tabs`, `history`, `cookies`, `webRequest`.
 */
export function buildManifest(env: {
  apiOrigin: string;
  appOrigin: string;
  dev: boolean;
}): chrome.runtime.ManifestV3 {
  return {
    manifest_version: 3,
    name: env.dev ? 'VoxTranslate (dev)' : 'VoxTranslate',
    short_name: 'VoxTranslate',
    version: pkg.version,
    description: 'Real-time translated subtitles and speech for the audio playing in your tab.',
    minimum_chrome_version: '116',

    permissions: [
      'activeTab',
      'storage',
      'tabCapture',
      'offscreen',
      'sidePanel',
      'identity',
      'scripting',
    ],

    // Narrow host permissions: only VoxTranslate's own origins. The overlay reaches
    // arbitrary sites through activeTab + scripting on an explicit user gesture instead.
    host_permissions: [`${env.apiOrigin}/*`, `${env.appOrigin}/*`],

    background: {
      service_worker: 'background/index.js',
      type: 'module',
    },

    side_panel: {
      default_path: 'sidepanel/index.html',
    },

    action: {
      // Deliberately NO `default_popup` and NO `openPanelOnActionClick`: the click must
      // reach `action.onClicked`, because that is the gesture that grants `activeTab`
      // for the tab being captured. Letting Chrome open the panel for us would consume
      // the click and leave capture permanently denied.
      default_title: 'Translate this tab with VoxTranslate',
      default_icon: {
        '16': 'icons/icon-16.png',
        '32': 'icons/icon-32.png',
        '48': 'icons/icon-48.png',
        '128': 'icons/icon-128.png',
      },
    },

    icons: {
      '16': 'icons/icon-16.png',
      '32': 'icons/icon-32.png',
      '48': 'icons/icon-48.png',
      '128': 'icons/icon-128.png',
    },

    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self'",
    },
  };
}
