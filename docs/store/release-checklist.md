# Release checklist

Nothing here is automated. Every step is deliberate.

## Versioning

`MAJOR.MINOR.PATCH` in `package.json`; the manifest version is generated from it, so there
is one place to change. The Chrome Web Store requires a strictly increasing version — a
rejected upload still burns the number, so bump again rather than reusing.

Pre-1.0 while the backend session mode is unimplemented.

## Before packaging

- [ ] `bun run verify` passes (typecheck, lint, test, build).
- [ ] `docs/manual-testing.md` completed on the current build, results recorded.
- [ ] Version bumped in `package.json`.
- [ ] `PRIVACY.md`, `docs/store/permissions.md`, and `docs/store/data-disclosure.md` still
      match the manifest and the code.
- [ ] No `console.log` of tokens, audio, transcripts, or URLs.
- [ ] `.env` is not committed; no secret in the bundle (`rg -i 'api[_-]?key|secret' dist/`).
- [ ] Production origins in the built `dist/manifest.json`.

## Package

```bash
bun run package     # → release/voxtranslate-chrome-<version>.zip
```

The script refuses to package if any manifest-declared file is missing.

## Store listing

- [ ] Name, short description, detailed description reviewed.
- [ ] Screenshots current (1280×800 or 640×400).
- [ ] Icon 128×128 present.
- [ ] Permission justifications pasted from `docs/store/permissions.md`.
- [ ] Privacy practices completed from `docs/store/data-disclosure.md`.
- [ ] Privacy policy URL set.

## No misleading claims

The listing must not overstate:

- **Accuracy** — say "real-time translation", never "perfect" or "accurate translation".
- **Latency** — do not quote a number that has not been measured on the shipped build.
- **Language support** — only the languages the selected tier actually produces.
- **Privacy** — do not imply audio is never stored; retention follows the platform policy.
- **Coverage** — do not claim support for browsers other than Chrome.

## Publish

- [ ] Upload the ZIP to the Developer Dashboard.
- [ ] Submit for review **manually**. Nothing publishes automatically.
- [ ] Tag the release `vX.Y.Z` and push the tag.
- [ ] Bump the submodule pointer in the parent VoxTranslate workspace.
