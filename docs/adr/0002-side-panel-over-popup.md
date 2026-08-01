# ADR 0002 — Side panel rather than a popup

**Status:** accepted · 2026-08-01

## Context

The main UI could be a browser-action popup, a side panel, or an injected in-page panel.

The UI must stay open and live-updating for the whole session: it shows detected language,
running cost, elapsed time, and the stop control.

## Decision

Use the Chrome Side Panel API as the primary surface.

## Rationale

A popup **closes on any outside click**. That is disqualifying here: the user's entire
workflow is clicking around the page they are watching — pressing play, seeking, going
fullscreen. A popup would vanish on the first interaction, taking the stop button and the
live cost display with it.

An injected in-page panel would require broad host permissions and would fight the page's
own layout and CSS on every site.

The side panel persists next to the page, survives interaction, and needs no host
permission.

## Consequences

- Chrome 114+ required (subsumed by ADR 0001's 116 floor).
- The panel is a _view_: it holds no session state. State lives in the service worker and
  is pushed to the panel, so closing and reopening the panel cannot disturb a session.
- The action click is configured to open the panel (`setPanelBehavior`).
