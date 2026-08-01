# Chrome Web Store — data-use disclosure checklist

Answers for the "Privacy practices" tab. Every answer must remain true; if the code
changes, this file changes with it.

## Data collected

| Category                            | Collected? | Detail                                                                                                          |
| ----------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------- |
| Personally identifiable information | **Yes**    | Name and email address, from the user's VoxTranslate account, to identify the account and display it in the UI. |
| Health information                  | No         |                                                                                                                 |
| Financial and payment information   | No         | Purchases happen on voxtranslate.app. The extension displays a balance; it never handles payment details.       |
| Authentication information          | **Yes**    | A session token, stored in memory-only session storage.                                                         |
| Personal communications             | **Yes**    | The audio of the tab the user explicitly chooses, and its transcription/translation.                            |
| Location                            | No         |                                                                                                                 |
| Web history                         | **No**     | The extension does not read or transmit browsing history, page URLs, or page content.                           |
| User activity                       | No         | No click, scroll, or interaction monitoring.                                                                    |
| Website content                     | **No**     | No page text, HTML, images, cookies, or form values are read or transmitted.                                    |

## Required certifications

- [x] I do not sell or transfer user data to third parties, outside of the approved use cases.
- [x] I do not use or transfer user data for purposes unrelated to my item's single purpose.
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes.

## Single purpose

> VoxTranslate provides real-time translated subtitles for the audio playing in the browser
> tab the user chooses.

Every permission maps to that one purpose — see `permissions.md`.

## Third parties

Captured audio is sent to the VoxTranslate backend, which uses speech-recognition and
translation providers to produce the transcription and translation. This is the same
processing as the VoxTranslate web application and is covered by the
[VoxTranslate Privacy Policy](https://voxtranslate.app/privacy).

## Privacy policy URL

`https://voxtranslate.app/privacy` (extension-specific notice: `PRIVACY.md` in this repo).
