import { describe, it, expect } from 'vitest';
import { CORE_QUESTIONS } from '../../src/interview/questions.js';

// Q14.6 (oauth_scopes_forward_directive) tells the agent to refresh an
// expired/invalid token ONCE through the deployment's own documented refresh
// path before falling back to forwarding the error. Without this, any
// file-based OAuth deployment idle longer than the provider's access-token
// TTL (~1h for Google) lands in "Could not verify" even though the
// deployment is healthy (live evidence: sess-20260610-035726-59fe71, Google
// returned invalid_token for a token file that expired 4 days earlier and
// had a documented refresh script). Decision: Ilya, 2026-06-10.
describe('oauth_scopes_forward_directive refresh-and-resend instruction', () => {
  const directive = CORE_QUESTIONS.find(q => q.id === 'oauth_scopes_forward_directive');

  it('exists at priority 14.6 in the access category', () => {
    expect(directive).toBeDefined();
    expect(directive?.priority).toBe(14.6);
    expect(directive?.category).toBe('access');
  });

  it('instructs a single refresh through the documented path on invalid_token', () => {
    const text = directive?.text ?? '';
    expect(text).toContain('invalid_token');
    expect(text).toContain('refresh the token ONCE');
    expect(text).toContain('documented token-refresh path');
    // The refresh must stay inside the already-given consent boundary and
    // must not escalate: no new credentials, no scope changes.
    expect(text).toContain('consent already given');
    expect(text).toContain('do not mint new credentials');
  });

  it('keeps the honest fallback when no refresh path exists or refresh fails', () => {
    const text = directive?.text ?? '';
    expect(text).toContain('forward the error response anyway');
    expect(text).toContain('"introspection attempted"');
  });
});
