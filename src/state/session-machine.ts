/**
 * Session state machine.
 *
 * Pure and Chrome-free on purpose: this is the single component that prevents the
 * failure modes that actually bite a capture extension — starting twice, opening two
 * WebSockets for one session, sending audio after stop, applying usage updates from a
 * dead session, and leaving an overlay on the page. Keeping it a pure reducer means all
 * of that is provable in unit tests instead of discovered in production.
 *
 * Illegal transitions are not thrown — they are *ignored* and reported, because a race
 * between a user click and a socket event is normal, not exceptional.
 */

export type SessionState =
  | 'logged_out'
  | 'authenticating'
  | 'ready'
  | 'requesting_capture'
  | 'connecting'
  | 'streaming'
  | 'reconnecting'
  | 'stopping'
  | 'stopped'
  | 'error'
  | 'credits_exhausted';

export type SessionEvent =
  | { type: 'LOGIN_STARTED' }
  | { type: 'LOGIN_SUCCEEDED' }
  | { type: 'LOGIN_FAILED'; reason: string }
  | { type: 'LOGGED_OUT' }
  | { type: 'START_REQUESTED' }
  | { type: 'CAPTURE_GRANTED' }
  | { type: 'CAPTURE_DENIED'; reason: string }
  | { type: 'SOCKET_OPEN' }
  | { type: 'SOCKET_CLOSED'; recoverable: boolean }
  | { type: 'RECONNECT_SUCCEEDED' }
  | { type: 'RECONNECT_EXHAUSTED' }
  | { type: 'CREDITS_EXHAUSTED' }
  | { type: 'STOP_REQUESTED' }
  | { type: 'TEARDOWN_COMPLETE' }
  | { type: 'FATAL'; reason: string };

export interface SessionContext {
  state: SessionState;
  /** Unique per start attempt. Every inbound event is checked against it. */
  sessionId: string | null;
  error: string | null;
}

/** States in which a live capture/transport pipeline exists and must be torn down. */
const ACTIVE_STATES: ReadonlySet<SessionState> = new Set<SessionState>([
  'requesting_capture',
  'connecting',
  'streaming',
  'reconnecting',
]);

export function initialContext(loggedIn: boolean): SessionContext {
  return { state: loggedIn ? 'ready' : 'logged_out', sessionId: null, error: null };
}

/** True when the pipeline is live enough that audio frames may be sent. */
export function isStreaming(ctx: SessionContext): boolean {
  return ctx.state === 'streaming';
}

/** True when resources (capture, socket, overlay) are held and need releasing. */
export function holdsResources(ctx: SessionContext): boolean {
  return ACTIVE_STATES.has(ctx.state) || ctx.state === 'stopping';
}

/**
 * Whether an inbound event carrying `eventSessionId` belongs to the live session.
 * Frames from a previous session must never move state, update usage, or play audio.
 */
export function acceptsEventFrom(ctx: SessionContext, eventSessionId: string | null): boolean {
  if (ctx.sessionId === null) return false;
  return ctx.sessionId === eventSessionId;
}

export interface TransitionResult {
  context: SessionContext;
  /** False when the event was not legal in the current state and was ignored. */
  accepted: boolean;
}

/**
 * Apply an event. `newSessionId` is only consulted for START_REQUESTED; the caller
 * supplies it so this stays free of any id generation (and therefore deterministic).
 */
export function transition(
  ctx: SessionContext,
  event: SessionEvent,
  newSessionId?: string,
): TransitionResult {
  const ignore = (): TransitionResult => ({ context: ctx, accepted: false });
  const to = (state: SessionState, patch: Partial<SessionContext> = {}): TransitionResult => ({
    context: { ...ctx, state, ...patch },
    accepted: true,
  });

  // Logout and fatal errors are accepted from anywhere — they are the escape hatches.
  if (event.type === 'LOGGED_OUT') {
    return to('logged_out', { sessionId: null, error: null });
  }
  if (event.type === 'FATAL') {
    return to('error', { sessionId: null, error: event.reason });
  }

  switch (ctx.state) {
    case 'logged_out':
      if (event.type === 'LOGIN_STARTED') return to('authenticating');
      return ignore();

    case 'authenticating':
      if (event.type === 'LOGIN_SUCCEEDED') return to('ready', { error: null });
      if (event.type === 'LOGIN_FAILED') return to('logged_out', { error: event.reason });
      return ignore();

    case 'ready':
    case 'stopped':
    case 'error':
    case 'credits_exhausted':
      // The only way into a session, and the guard against starting twice: a second
      // START_REQUESTED while active falls through to the active-state cases below,
      // which ignore it.
      if (event.type === 'START_REQUESTED') {
        return to('requesting_capture', { sessionId: newSessionId ?? null, error: null });
      }
      if (event.type === 'LOGIN_STARTED') return to('authenticating');
      return ignore();

    case 'requesting_capture':
      if (event.type === 'CAPTURE_GRANTED') return to('connecting');
      if (event.type === 'CAPTURE_DENIED') {
        return to('error', { sessionId: null, error: event.reason });
      }
      if (event.type === 'STOP_REQUESTED') return to('stopping');
      return ignore();

    case 'connecting':
      if (event.type === 'SOCKET_OPEN') return to('streaming');
      if (event.type === 'SOCKET_CLOSED') {
        return event.recoverable
          ? to('reconnecting')
          : to('error', { sessionId: null, error: 'connection failed' });
      }
      if (event.type === 'STOP_REQUESTED') return to('stopping');
      if (event.type === 'CREDITS_EXHAUSTED') return to('stopping');
      return ignore();

    case 'streaming':
      if (event.type === 'SOCKET_CLOSED') {
        return event.recoverable
          ? to('reconnecting')
          : to('error', { sessionId: null, error: 'connection lost' });
      }
      if (event.type === 'STOP_REQUESTED') return to('stopping');
      // Credits exhausted must tear the pipeline down, not just show a banner:
      // the backend has already stopped billing and translating.
      if (event.type === 'CREDITS_EXHAUSTED') return to('stopping');
      return ignore();

    case 'reconnecting':
      if (event.type === 'RECONNECT_SUCCEEDED') return to('streaming');
      if (event.type === 'RECONNECT_EXHAUSTED') {
        return to('error', { sessionId: null, error: 'could not reconnect' });
      }
      if (event.type === 'STOP_REQUESTED') return to('stopping');
      if (event.type === 'CREDITS_EXHAUSTED') return to('stopping');
      return ignore();

    case 'stopping':
      if (event.type === 'TEARDOWN_COMPLETE') {
        return to('stopped', { sessionId: null });
      }
      // Everything else during teardown is ignored — notably a late SOCKET_CLOSED,
      // which must not bounce the session into `reconnecting`.
      return ignore();

    default: {
      const exhaustive: never = ctx.state;
      return exhaustive;
    }
  }
}
