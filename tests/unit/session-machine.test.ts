import { describe, expect, it } from 'vitest';
import {
  acceptsEventFrom,
  holdsResources,
  initialContext,
  isStreaming,
  transition,
  type SessionContext,
  type SessionState,
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

describe('authentication states', () => {
  it('moves into authenticating when an interactive login begins', () => {
    const result = transition(initialContext(false), { type: 'LOGIN_STARTED' });
    expect(result.accepted).toBe(true);
    expect(result.context.state).toBe('authenticating');
  });

  it('returns to logged_out with the reason when login fails', () => {
    const authenticating = transition(initialContext(false), { type: 'LOGIN_STARTED' }).context;
    const result = transition(authenticating, { type: 'LOGIN_FAILED', reason: 'user cancelled' });
    expect(result.context.state).toBe('logged_out');
    expect(result.context.error).toBe('user cancelled');
  });

  it('clears a previous error once login succeeds', () => {
    const failed = transition(initialContext(false), {
      type: 'FATAL',
      reason: 'boom',
    }).context;
    const authenticating = transition(failed, { type: 'LOGIN_STARTED' }).context;
    const ready = transition(authenticating, { type: 'LOGIN_SUCCEEDED' }).context;
    expect(ready.state).toBe('ready');
    expect(ready.error).toBeNull();
  });

  it('ignores a start request while still logged out', () => {
    const result = transition(initialContext(false), { type: 'START_REQUESTED' }, 's1');
    expect(result.accepted).toBe(false);
    expect(result.context.state).toBe('logged_out');
  });

  it('ignores session events while authenticating', () => {
    const authenticating = transition(initialContext(false), { type: 'LOGIN_STARTED' }).context;
    expect(transition(authenticating, { type: 'SOCKET_OPEN' }).accepted).toBe(false);
    expect(transition(authenticating, { type: 'START_REQUESTED' }, 's1').accepted).toBe(false);
  });

  it('lets a signed-in user re-authenticate from an idle state', () => {
    const result = transition(initialContext(true), { type: 'LOGIN_STARTED' });
    expect(result.context.state).toBe('authenticating');
  });
});

describe('stopping a session before it is live', () => {
  it('accepts a stop while capture permission is still pending', () => {
    const requesting = transition(initialContext(true), { type: 'START_REQUESTED' }, 's1').context;
    const result = transition(requesting, { type: 'STOP_REQUESTED' });
    expect(result.accepted).toBe(true);
    expect(result.context.state).toBe('stopping');
  });

  it('accepts a stop while the socket is still connecting', () => {
    const connecting = transition(
      transition(initialContext(true), { type: 'START_REQUESTED' }, 's1').context,
      { type: 'CAPTURE_GRANTED' },
    ).context;
    expect(transition(connecting, { type: 'STOP_REQUESTED' }).context.state).toBe('stopping');
  });

  it('tears down rather than warning when credits run out mid-connect', () => {
    const connecting = transition(
      transition(initialContext(true), { type: 'START_REQUESTED' }, 's1').context,
      { type: 'CAPTURE_GRANTED' },
    ).context;
    expect(transition(connecting, { type: 'CREDITS_EXHAUSTED' }).context.state).toBe('stopping');
  });

  it('ignores an out-of-order event while requesting capture', () => {
    const requesting = transition(initialContext(true), { type: 'START_REQUESTED' }, 's1').context;
    expect(transition(requesting, { type: 'SOCKET_OPEN' }).accepted).toBe(false);
  });

  it('ignores an out-of-order event while connecting', () => {
    const connecting = transition(
      transition(initialContext(true), { type: 'START_REQUESTED' }, 's1').context,
      { type: 'CAPTURE_GRANTED' },
    ).context;
    expect(transition(connecting, { type: 'CAPTURE_GRANTED' }).accepted).toBe(false);
  });
});

describe('reconnecting', () => {
  /** Drive a session to `reconnecting` after a recoverable drop. */
  function reconnecting() {
    let ctx = transition(initialContext(true), { type: 'START_REQUESTED' }, 's1').context;
    ctx = transition(ctx, { type: 'CAPTURE_GRANTED' }).context;
    ctx = transition(ctx, { type: 'SOCKET_OPEN' }).context;
    return transition(ctx, { type: 'SOCKET_CLOSED', recoverable: true }).context;
  }

  it('returns to streaming when the socket comes back', () => {
    expect(transition(reconnecting(), { type: 'RECONNECT_SUCCEEDED' }).context.state).toBe(
      'streaming',
    );
  });

  it('accepts a user stop mid-reconnect', () => {
    expect(transition(reconnecting(), { type: 'STOP_REQUESTED' }).context.state).toBe('stopping');
  });

  it('tears down when credits run out mid-reconnect', () => {
    expect(transition(reconnecting(), { type: 'CREDITS_EXHAUSTED' }).context.state).toBe(
      'stopping',
    );
  });

  it('ignores an irrelevant event mid-reconnect', () => {
    expect(transition(reconnecting(), { type: 'CAPTURE_GRANTED' }).accepted).toBe(false);
  });

  it('keeps the session id while reconnecting, so its frames stay accepted', () => {
    const ctx = reconnecting();
    expect(ctx.sessionId).toBe('s1');
    expect(acceptsEventFrom(ctx, 's1')).toBe(true);
  });
});

describe('resource and streaming predicates', () => {
  function at(state: SessionState): SessionContext {
    return { state, sessionId: 's1', error: null };
  }

  it('reports streaming only in the streaming state', () => {
    expect(isStreaming(at('streaming'))).toBe(true);
    for (const state of ['ready', 'connecting', 'reconnecting', 'stopping'] as SessionState[]) {
      expect(isStreaming(at(state))).toBe(false);
    }
  });

  it('reports held resources for every state with a live pipeline', () => {
    for (const state of [
      'requesting_capture',
      'connecting',
      'streaming',
      'reconnecting',
      'stopping',
    ] as SessionState[]) {
      expect(holdsResources(at(state))).toBe(true);
    }
  });

  it('reports no held resources once the session is over', () => {
    for (const state of [
      'logged_out',
      'authenticating',
      'ready',
      'stopped',
      'error',
      'credits_exhausted',
    ] as SessionState[]) {
      expect(holdsResources(at(state))).toBe(false);
    }
  });

  it('never accepts an event for a session that has no id', () => {
    expect(acceptsEventFrom({ state: 'ready', sessionId: null, error: null }, null)).toBe(false);
    expect(acceptsEventFrom({ state: 'ready', sessionId: null, error: null }, 's1')).toBe(false);
  });
});
