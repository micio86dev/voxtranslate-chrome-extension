# ADR 0004 — WebM/Opus 32 kbps at 100 ms

**Status:** accepted · 2026-08-01

## Context

The extension must stream tab audio to a backend that already ingests audio from the web
client. Candidate formats: raw PCM16 via AudioWorklet, WebM/Opus via MediaRecorder, or
something new.

## Decision

**WebM/Opus, 32 kbps, mono, 100 ms `MediaRecorder` timeslice** — byte-for-byte the format
the web client already sends.

Honour the server's `capture_format { pcm: true }` frame by switching to PCM16 @ 24 kHz
mono when asked.

## Rationale

This was not a free choice, and deliberately so. The backend opens Deepgram with
`container=webm` and lets the WebM header carry the encoding, sample rate, and channel
count (`server/src/deepgram.rs`). Matching the existing format means **zero** backend codec
work and zero risk of a subtly different stream breaking transcription.

100 ms sits inside the brief's 100–250 ms target and is the value the web client settled on
(spec 0043) as the latency/overhead balance.

PCM16 is only needed when one captured stream must feed both OpenAI and Deepgram — a
server-side decision the server already knows how to signal.

## Consequences

- No new codec, no new Deepgram configuration, no new failure mode.
- `MediaRecorder` output is opaque, so client-side voice activity detection is not
  available. Not needed: the server already skips billing when nothing is translated.
- Frames are dropped rather than queued when the socket backs up past 1 MB — stale audio is
  worthless for live subtitles, and an unbounded queue is how extensions leak memory.
