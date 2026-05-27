/**
 * AAP-92 — dashboard auto-flip to "Report" tab when an audit completes.
 *
 * Before AAP-92, `SessionDetail` seeded its active tab once at mount
 * via `useState<Tab>(hasReport ? 'report' : 'transcript')`. The
 * initializer ran only on the first render, so a session opened
 * mid-audit (status=analyzing, hasReport=false) stayed pinned to
 * Transcript even after the SSE `status-change` event flipped status
 * to 'complete' and the report blob landed.
 *
 * The fix introduces `shouldAutoFlipToReport`, a pure decision helper
 * the in-component `useEffect` consults on every status change. The
 * helper is exported so its decision logic can be unit-tested without
 * spinning up jsdom or React Testing Library (neither is wired into
 * this project's vitest config today).
 *
 * Each case below maps a concrete user scenario to the expected boolean
 * — Codex post-review and any future regression catcher can read the
 * test names alone and see what behaviour is locked.
 */

import { describe, it, expect } from 'vitest';
import { shouldAutoFlipToReport } from '../../components/heron-v1/dashboard/SessionDetail';

describe('AAP-92 — shouldAutoFlipToReport', () => {
  it('flips on the analyzing → complete transition when report is ready', () => {
    expect(
      shouldAutoFlipToReport({
        prevStatus: 'analyzing',
        nextStatus: 'complete',
        hasReport: true,
        userTabChosen: false,
      }),
    ).toBe(true);
  });

  it('flips on the awaiting_answer → complete transition when report is ready (tool-call mode)', () => {
    expect(
      shouldAutoFlipToReport({
        prevStatus: 'awaiting_answer',
        nextStatus: 'complete',
        hasReport: true,
        userTabChosen: false,
      }),
    ).toBe(true);
  });

  it('flips on the interviewing → complete transition when report is ready (sampling mode)', () => {
    expect(
      shouldAutoFlipToReport({
        prevStatus: 'interviewing',
        nextStatus: 'complete',
        hasReport: true,
        userTabChosen: false,
      }),
    ).toBe(true);
  });

  it('does NOT flip if the user has manually clicked a tab', () => {
    // Once the operator has chosen a tab, we never auto-steal focus.
    expect(
      shouldAutoFlipToReport({
        prevStatus: 'analyzing',
        nextStatus: 'complete',
        hasReport: true,
        userTabChosen: true,
      }),
    ).toBe(false);
  });

  it('does NOT flip when hasReport is still false (report blob not yet attached)', () => {
    // SSE delivers status-change before the GET that fetches the
    // rendered markdown. The useEffect runs once on status change with
    // hasReport=false, then a second time when the GET response sets
    // liveSession.report and hasReport flips true. The second run is
    // the one that should flip — pin that here.
    expect(
      shouldAutoFlipToReport({
        prevStatus: 'analyzing',
        nextStatus: 'complete',
        hasReport: false,
        userTabChosen: false,
      }),
    ).toBe(false);
  });

  it('does NOT flip for non-complete terminal statuses (analysis_failed, error)', () => {
    expect(
      shouldAutoFlipToReport({
        prevStatus: 'analyzing',
        nextStatus: 'analysis_failed',
        hasReport: false,
        userTabChosen: false,
      }),
    ).toBe(false);
    expect(
      shouldAutoFlipToReport({
        prevStatus: 'interviewing',
        nextStatus: 'error',
        hasReport: false,
        userTabChosen: false,
      }),
    ).toBe(false);
  });

  it('does NOT flip on the first render of an already-complete session', () => {
    // Mount of a complete session: prevStatus is undefined (no prior
    // tick has fired). The initial useState already seeded tab='report',
    // so the useEffect should be a no-op here.
    expect(
      shouldAutoFlipToReport({
        prevStatus: undefined,
        nextStatus: 'complete',
        hasReport: true,
        userTabChosen: false,
      }),
    ).toBe(false);
  });

  it('does NOT flip if the previous status was already complete (status echo / noop tick)', () => {
    // Defensive: a duplicate status-change event with the same status
    // must not re-flip the tab if the user has since switched away.
    expect(
      shouldAutoFlipToReport({
        prevStatus: 'complete',
        nextStatus: 'complete',
        hasReport: true,
        userTabChosen: false,
      }),
    ).toBe(false);
  });
});
