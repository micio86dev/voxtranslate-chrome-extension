# Chrome Web Store — permission justifications

Paste these into the Web Store listing. Keep in sync with `manifest.config.ts`.

| Permission                                        | Justification                                                                                                                                                                                       |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `activeTab`                                       | Lets VoxTranslate access only the single tab the user explicitly starts a translation session on, so that subtitles can be displayed over that page. This avoids requesting access to all websites. |
| `tabCapture`                                      | Captures the audio of that one tab so it can be transcribed and translated in real time. This is the core function of the extension. Audio is captured only after the user presses Start.           |
| `offscreen`                                       | Chrome's Manifest V3 service worker cannot hold an audio context or a long-lived media stream. An offscreen document hosts the audio pipeline for the duration of a session.                        |
| `sidePanel`                                       | Provides the extension's user interface, which must stay open during a session to show live status, cost, and a stop control.                                                                       |
| `identity`                                        | Used for `launchWebAuthFlow` to sign the user in to their existing VoxTranslate account using an OAuth authorization-code flow with PKCE.                                                           |
| `storage`                                         | Stores the user's session token (in memory-only session storage) and their preferences such as target language and subtitle settings.                                                               |
| `scripting`                                       | Injects the subtitle overlay into the tab the user chose, at the moment they press Start. Used together with `activeTab` so no broad site access is required.                                       |
| Host permission: `https://api.voxtranslate.app/*` | Sends captured audio for transcription and translation, and reads the user's account and balance.                                                                                                   |
| Host permission: `https://voxtranslate.app/*`     | Used for sign-in and for opening the page where the user can add credit.                                                                                                                            |

## Remote code

None. All code is bundled at build time. CSP is `script-src 'self'; object-src 'self'`.

## Not requested

`<all_urls>`, `tabs`, `history`, `cookies`, `webRequest`, `downloads`, `clipboardRead`,
`nativeMessaging`.
