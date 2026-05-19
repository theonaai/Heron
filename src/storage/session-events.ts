/**
 * In-process pub/sub bus for live session events (AAP-52).
 *
 * The MCP `start_audit_session` tool handler writes Q/A pairs to disk
 * and *publishes* a small event onto this bus. The Next.js SSE route
 * (`/api/audit/sessions/:id/stream`) subscribes to the same bus and
 * pipes events to the browser dashboard so the user sees the live
 * transcript appear without polling.
 *
 * Single-process only — both publisher and subscriber live in the same
 * Node process (the standalone Next.js server). Out-of-process
 * subscribers (e.g. a future hosted multi-worker setup) need a real
 * broker; the SSE route falls back to polling when no events arrive.
 */

import { EventEmitter } from 'node:events';

export type SessionEvent =
  | {
      type: 'transcript-append';
      entry: { category: string; question: string; answer: string };
    }
  | { type: 'status-change'; status: string; riskLevel?: string }
  | { type: 'error'; message: string };

// One bus per process. Bounded listener count: the SSE route attaches
// at most one listener per (session × open browser tab), and abandoned
// listeners get cleaned up by the route's onclose handler. Lift the
// default ceiling so high-traffic local-dev (multiple dashboard tabs +
// the MCP tool itself) doesn't trigger Node's MaxListenersExceeded
// warning.
const bus = new EventEmitter();
bus.setMaxListeners(0);

/** Topic name for the given session id. */
function topic(sessionId: string): string {
  return `session:${sessionId}`;
}

/** Publish an event for one session. Best-effort. */
export function publishSessionEvent(sessionId: string, event: SessionEvent): void {
  bus.emit(topic(sessionId), event);
}

/** Subscribe to one session's events. Returns an unsubscribe handle. */
export function subscribeSessionEvents(
  sessionId: string,
  handler: (event: SessionEvent) => void,
): () => void {
  const t = topic(sessionId);
  bus.on(t, handler);
  return (): void => {
    bus.off(t, handler);
  };
}

/** Count subscribers for one session (testing/debugging hook). */
export function sessionListenerCount(sessionId: string): number {
  return bus.listenerCount(topic(sessionId));
}
