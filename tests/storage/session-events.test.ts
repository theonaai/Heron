import { describe, it, expect, vi } from 'vitest';

import {
  publishSessionEvent,
  sessionListenerCount,
  subscribeSessionEvents,
  type SessionEvent,
} from '../../src/storage/session-events.js';

/**
 * In-process pubsub bus for live audit-session events (AAP-52).
 *
 * Tests cover the contract the SSE route relies on:
 *   - subscribe → receives events for one session id
 *   - cross-session isolation: subscriber A never sees session B
 *   - unsubscribe handle stops delivery
 *   - multiple subscribers per session each get the event
 *   - listenerCount reflects live subscriptions
 *   - publish with no listeners is a no-op (does not throw)
 */

describe('session-events pubsub', () => {
  it('delivers events to a subscriber for the same session id', () => {
    const handler = vi.fn();
    const unsub = subscribeSessionEvents('sess-A', handler);

    const event: SessionEvent = {
      type: 'transcript-append',
      entry: { category: 'identity', question: 'Q1', answer: 'A1' },
    };
    publishSessionEvent('sess-A', event);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(event);
    unsub();
  });

  it('does not deliver across session ids', () => {
    const handlerA = vi.fn();
    const handlerB = vi.fn();
    const unsubA = subscribeSessionEvents('sess-iso-A', handlerA);
    const unsubB = subscribeSessionEvents('sess-iso-B', handlerB);

    publishSessionEvent('sess-iso-A', { type: 'status-change', status: 'analyzing' });
    publishSessionEvent('sess-iso-B', { type: 'status-change', status: 'complete' });

    expect(handlerA).toHaveBeenCalledTimes(1);
    expect(handlerB).toHaveBeenCalledTimes(1);
    expect(handlerA.mock.calls[0]![0]).toMatchObject({ status: 'analyzing' });
    expect(handlerB.mock.calls[0]![0]).toMatchObject({ status: 'complete' });

    unsubA();
    unsubB();
  });

  it('stops delivery after unsubscribe', () => {
    const handler = vi.fn();
    const unsub = subscribeSessionEvents('sess-unsub', handler);

    publishSessionEvent('sess-unsub', { type: 'status-change', status: 'interviewing' });
    expect(handler).toHaveBeenCalledTimes(1);

    unsub();
    publishSessionEvent('sess-unsub', { type: 'status-change', status: 'complete' });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('delivers to multiple subscribers on the same session', () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    const u1 = subscribeSessionEvents('sess-multi', handler1);
    const u2 = subscribeSessionEvents('sess-multi', handler2);

    publishSessionEvent('sess-multi', { type: 'transcript-append', entry: { category: 'data', question: 'Q', answer: 'A' } });

    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler2).toHaveBeenCalledTimes(1);
    u1();
    u2();
  });

  it('listenerCount mirrors live subscriptions', () => {
    expect(sessionListenerCount('sess-count')).toBe(0);
    const u = subscribeSessionEvents('sess-count', () => undefined);
    expect(sessionListenerCount('sess-count')).toBe(1);
    u();
    expect(sessionListenerCount('sess-count')).toBe(0);
  });

  it('publish with no listeners is a silent no-op', () => {
    expect(() => publishSessionEvent('sess-nobody-listening', { type: 'error', message: 'oops' })).not.toThrow();
  });
});
