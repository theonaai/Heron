/**
 * AAP-105 F1 — post-`complete` verification polling predicate.
 *
 * The bug: deterministic verification runs AFTER the audit reaches
 * `complete`. The instant status flips to `complete`, `isLive` goes
 * false, so the SSE listener and the polling fallback both tear down.
 * The one-shot refetch the SSE `complete` handler fires captures the
 * report while `verification.status` is still unverified; when the real
 * verdict lands ~75s later nothing is listening, so the topbar keeps a
 * stale "VERIFICATION REQUIRED" pill until a manual reload.
 *
 * The fix gates the polling effect on `shouldPoll = isLive ||
 * verificationPending`, where `isVerificationPending` decides whether to
 * keep polling past `complete`. It reads the REPORT-JSON verification
 * vocabulary (`report.json:verification.status`):
 *
 *   pending  → complete + {undefined, 'unverified', 'interrogation-only'}
 *   terminal → {'verified', 'partially-verified', 'verification-failed'}
 *
 * `isVerificationPending` is a pure helper exported from SessionDetail so
 * its decision logic is unit-testable without jsdom / React Testing
 * Library (neither is wired into this project's vitest config — the same
 * constraint that drove `shouldAutoFlipToReport` to be a pure export).
 *
 * Each case maps a concrete scenario to the expected boolean so the test
 * names alone document the locked behaviour.
 */

import { describe, it, expect } from 'vitest';
import { isVerificationPending } from '../../components/heron-v1/dashboard/SessionDetail';

describe('AAP-105 F1 — isVerificationPending (post-complete polling gate)', () => {
  it('complete + no verification field → pending (keep polling)', () => {
    // The verdict writer has not landed anything yet. report.json carries
    // no `verification` block, so getSession surfaces no status. Poll for
    // the verdict that runs after the audit completes.
    expect(
      isVerificationPending({ status: 'complete', reportVerificationStatus: undefined }),
    ).toBe(true);
  });

  it("complete + 'unverified' → pending (keep polling)", () => {
    expect(
      isVerificationPending({ status: 'complete', reportVerificationStatus: 'unverified' }),
    ).toBe(true);
  });

  it("complete + 'interrogation-only' → pending (keep polling)", () => {
    // interrogation-only means only the LLM interview ran; deterministic
    // verification is still expected to land a terminal verdict.
    expect(
      isVerificationPending({
        status: 'complete',
        reportVerificationStatus: 'interrogation-only',
      }),
    ).toBe(true);
  });

  it("complete + 'partially-verified' → terminal (stop polling)", () => {
    // The exact verdict the live race produced. Once it lands, polling
    // must stop or the API gets hammered forever.
    expect(
      isVerificationPending({
        status: 'complete',
        reportVerificationStatus: 'partially-verified',
      }),
    ).toBe(false);
  });

  it("complete + 'verified' → terminal (stop polling)", () => {
    expect(
      isVerificationPending({ status: 'complete', reportVerificationStatus: 'verified' }),
    ).toBe(false);
  });

  it("complete + 'verification-failed' → terminal (stop polling)", () => {
    // A failed verification is still a terminal verdict — the operator's
    // run is over, do not keep polling.
    expect(
      isVerificationPending({
        status: 'complete',
        reportVerificationStatus: 'verification-failed',
      }),
    ).toBe(false);
  });

  it('interviewing → not pending (live path owns this state)', () => {
    // While the audit is live the SSE stream + isLive polling keep the
    // view fresh; verificationPending must not double-count it (and an
    // interviewing session has no terminal verdict to wait on yet).
    expect(
      isVerificationPending({ status: 'interviewing', reportVerificationStatus: undefined }),
    ).toBe(false);
  });

  it('analyzing → not pending (live path owns this state)', () => {
    expect(
      isVerificationPending({ status: 'analyzing', reportVerificationStatus: undefined }),
    ).toBe(false);
  });

  it('awaiting_answer → not pending (live path owns this state)', () => {
    expect(
      isVerificationPending({ status: 'awaiting_answer', reportVerificationStatus: undefined }),
    ).toBe(false);
  });

  it('analysis_failed → not pending (no verification window)', () => {
    // A failed analysis produces no report and no verification verdict;
    // there is nothing to poll for.
    expect(
      isVerificationPending({ status: 'analysis_failed', reportVerificationStatus: undefined }),
    ).toBe(false);
  });

  it('error → not pending (no verification window)', () => {
    expect(
      isVerificationPending({ status: 'error', reportVerificationStatus: undefined }),
    ).toBe(false);
  });

  it('models the pending → terminal transition that stops the interval', () => {
    // Drive the exact live sequence the fix targets: a complete session
    // sits pending (poll active) until the partial verdict lands, then
    // becomes terminal (poll torn down). shouldPoll = isLive ||
    // verificationPending; isLive is false once complete, so the boolean
    // is driven entirely by this predicate.
    const before = isVerificationPending({
      status: 'complete',
      reportVerificationStatus: undefined,
    });
    const after = isVerificationPending({
      status: 'complete',
      reportVerificationStatus: 'partially-verified',
    });
    expect(before).toBe(true); // polling active during the verification window
    expect(after).toBe(false); // verdict landed → polling stops, no API hammering
  });
});
