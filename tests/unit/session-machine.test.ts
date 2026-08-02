import { describe, expect, it } from 'vitest';
import {
  acceptsEventFrom,
  holdsResources,
  initialContext,
  isStreaming,
  transition,
  type SessionContext,
} from '@/state/session-machine';

/** Drive the machine through a list of events, asserting each one was accepted. */
function run(ctx: SessionContext, events: Parameters<typeof transition>[1][], id = 's1') {
  let current = ctx;
  for (const event of events) {
    const result = transition(current, event, id);
    current = result.context;
  }
  return current;
}

describe('session state machine', () => {
  it('starts logged out or ready depending on stored auth', () => {
    expect(initialContext(false).state).toBe('logged_out');
    expect(initialContext(true).state).toBe('ready');
  });

  it('walks the happy path from ready to streaming', () => {
    const ctx = run(initialContext(true), [
      { type: 'START_REQUESTED' },
      { type: 'CAPTURE_GRANTED' },
      { type: 'SOCKET_OPEN' },
    ]);
    expect(ctx.state).toBe('streaming');
    expect(ctx.sessionId).toBe('s1');
    expect(isStreaming(ctx)).toBe(true);
  });

  it('refuses to start a second session while one is active', () => {
    const streaming = run(initialContext(true), [
      { type: 'START_REQUESTED' },
      { type: 'CAPTURE_GRANTED' },
      { type: 'SOCKET_OPEN' },
    ]);
    const second = transition(streaming, { type: 'START_REQUESTED' }, 's2');
    expect(second.accepted).toBe(false);
    expect(second.context.state).toBe('streaming');
    // Crucially the session id is untouched — a second start must not steal the session.
    expect(second.context.sessionId).toBe('s1');
  });

  it('ignores a late socket close during teardown instead of reconnecting', () => {
    const stopping = run(initialContext(true), [
      { type: 'START_REQUESTED' },
      { type: 'CAPTURE_GRANTED' },
      { type: 'SOCKET_OPEN' },
      { type: 'STOP_REQUESTED' },
    ]);
    expect(stopping.state).toBe('stopping');

    const late = transition(stopping, { type: 'SOCKET_CLOSED', recoverable: true });
    expect(late.accepted).toBe(false);
    expect(late.context.state).toBe('stopping');
  });

  it('clears the session id only once teardown completes', () => {
    const stopping = run(initialContext(true), [
      { type: 'START_REQUESTED' },
      { type: 'CAPTURE_GRANTED' },
      { type: 'SOCKET_OPEN' },
      { type: 'STOP_REQUESTED' },
    ]);
    expect(stopping.sessionId).toBe('s1');
    expect(holdsResources(stopping)).toBe(true);

    const done = transition(stopping, { type: 'TEARDOWN_COMPLETE' });
    expect(done.context.state).toBe('stopped');
    expect(done.context.sessionId).toBeNull();
    expect(holdsResources(done.context)).toBe(false);
  });

  it('routes a recoverable close to reconnecting and a fatal one to error', () => {
    const streaming = run(initialContext(true), [
      { type: 'START_REQUESTED' },
      { type: 'CAPTURE_GRANTED' },
      { type: 'SOCKET_OPEN' },
    ]);

    const recoverable = transition(streaming, { type: 'SOCKET_CLOSED', recoverable: true });
    expect(recoverable.context.state).toBe('reconnecting');

    const fatal = transition(streaming, { type: 'SOCKET_CLOSED', recoverable: false });
    expect(fatal.context.state).toBe('error');
    expect(fatal.context.sessionId).toBeNull();
  });

  it('tears down the pipeline when credits are exhausted rather than just warning', () => {
    const streaming = run(initialContext(true), [
      { type: 'START_REQUESTED' },
      { type: 'CAPTURE_GRANTED' },
      { type: 'SOCKET_OPEN' },
    ]);
    const exhausted = transition(streaming, { type: 'CREDITS_EXHAUSTED' });
    expect(exhausted.context.state).toBe('stopping');
  });

  it('gives up after reconnect attempts are exhausted', () => {
    const reconnecting = run(initialContext(true), [
      { type: 'START_REQUESTED' },
      { type: 'CAPTURE_GRANTED' },
      { type: 'SOCKET_OPEN' },
      { type: 'SOCKET_CLOSED', recoverable: true },
    ]);
    expect(reconnecting.state).toBe('reconnecting');

    const gaveUp = transition(reconnecting, { type: 'RECONNECT_EXHAUSTED' });
    expect(gaveUp.context.state).toBe('error');
    expect(gaveUp.context.error).toBe('could not reconnect');
  });

  it('surfaces capture denial as an error without holding a session', () => {
    const requesting = run(initialContext(true), [{ type: 'START_REQUESTED' }]);
    const denied = transition(requesting, {
      type: 'CAPTURE_DENIED',
      reason: 'permission denied',
    });
    expect(denied.context.state).toBe('error');
    expect(denied.context.sessionId).toBeNull();
    expect(denied.context.error).toBe('permission denied');
  });

  it('accepts logout and fatal from any state', () => {
    const streaming = run(initialContext(true), [
      { type: 'START_REQUESTED' },
      { type: 'CAPTURE_GRANTED' },
      { type: 'SOCKET_OPEN' },
    ]);
    expect(transition(streaming, { type: 'LOGGED_OUT' }).context.state).toBe('logged_out');
    expect(transition(streaming, { type: 'FATAL', reason: 'boom' }).context.state).toBe('error');
  });

  it('rejects events from a stale session', () => {
    const streaming = run(initialContext(true), [
      { type: 'START_REQUESTED' },
      { type: 'CAPTURE_GRANTED' },
      { type: 'SOCKET_OPEN' },
    ]);
    expect(acceptsEventFrom(streaming, 's1')).toBe(true);
    expect(acceptsEventFrom(streaming, 's0')).toBe(false);
    expect(acceptsEventFrom(streaming, null)).toBe(false);
    // And nothing is accepted once no session is held.
    expect(acceptsEventFrom(initialContext(true), 's1')).toBe(false);
  });

  it('allows a fresh start after stopping, erroring, or exhausting credits', () => {
    for (const state of ['stopped', 'error', 'credits_exhausted'] as const) {
      const ctx: SessionContext = { state, sessionId: null, error: null };
      const started = transition(ctx, { type: 'START_REQUESTED' }, 's2');
      expect(started.accepted).toBe(true);
      expect(started.context.state).toBe('requesting_capture');
      expect(started.context.sessionId).toBe('s2');
    }
  });
});

describe('session restoration', () => {
  it('accepts a validated stored token as a login, without an interactive flow', () => {
    // A woken worker that finds a valid token must reach `ready`. Otherwise the account
    // renders in the panel while Start stays refused.
    const restored = transition(initialContext(false), { type: 'LOGIN_SUCCEEDED' });
    expect(restored.accepted).toBe(true);
    expect(restored.context.state).toBe('ready');
  });

  it('lets a restored session start immediately', () => {
    const restored = transition(initialContext(false), { type: 'LOGIN_SUCCEEDED' }).context;
    const started = transition(restored, { type: 'START_REQUESTED' }, 's1');
    expect(started.accepted).toBe(true);
    expect(started.context.state).toBe('requesting_capture');
  });
});

describe('capture gesture requirement', () => {
  it('treats a missing activeTab gesture as a denial that clears the session', () => {
    // Chrome grants activeTab (and so tabCapture) only for an action click, context
    // menu, keyboard shortcut or omnibox pick — never for the side panel. Starting
    // without that gesture must fail cleanly, not hold a half-open session.
    const requesting = run(initialContext(true), [{ type: 'START_REQUESTED' }]);
    const denied = transition(requesting, {
      type: 'CAPTURE_DENIED',
      reason: 'capture_needs_gesture',
    });
    expect(denied.context.state).toBe('error');
    expect(denied.context.sessionId).toBeNull();
    expect(denied.context.error).toBe('capture_needs_gesture');
  });

  it('allows a retry once the user has performed the gesture', () => {
    const denied: SessionContext = {
      state: 'error',
      sessionId: null,
      error: 'capture_needs_gesture',
    };
    const retried = transition(denied, { type: 'START_REQUESTED' }, 's2');
    expect(retried.accepted).toBe(true);
    expect(retried.context.state).toBe('requesting_capture');
  });
});
