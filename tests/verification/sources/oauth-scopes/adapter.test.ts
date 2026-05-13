import { describe, it, expect } from 'vitest';

import { OAuthScopesSource } from '../../../../src/verification/sources/oauth-scopes.js';
import type { DeterministicSource } from '../../../../src/verification/types.js';
import type { OAuthScopesSourceConfig } from '../../../../src/verification/sources/oauth-scopes/types.js';

/**
 * Cluster 1: type-contract + adapter scaffold.
 *
 * The OAuth-scopes adapter must satisfy the same `DeterministicSource`
 * uniform interface as `McpToolsSource`. The orchestrator only touches
 * `id`, `description`, and `read` — so we pin those three plus the
 * `id` value (must be `'oauth-scopes'` per `ActualInventory['source']`).
 */
describe('OAuthScopesSource — DeterministicSource interface contract', () => {
  it('exposes id "oauth-scopes"', () => {
    const source = new OAuthScopesSource();
    expect(source.id).toBe('oauth-scopes');
  });

  it('exposes a non-empty description', () => {
    const source = new OAuthScopesSource();
    expect(typeof source.description).toBe('string');
    expect(source.description.length).toBeGreaterThan(0);
  });

  it('structurally satisfies DeterministicSource<OAuthScopesSourceConfig>', () => {
    // Compile-time and runtime check: pass through the type assertion.
    const source: DeterministicSource<OAuthScopesSourceConfig> = new OAuthScopesSource();
    expect(typeof source.read).toBe('function');
  });

  it('rejects an invalid connector value as invalid_config', async () => {
    const source = new OAuthScopesSource();
    const r = await source.read({
      // Force an unknown connector to assert the dispatcher rejects it.
      connector: 'bamboohr' as unknown as 'greenhouse',
      credentials: { apiKey: 'fake-test-key' },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_config');
  });

  it('rejects a missing apiKey as invalid_config', async () => {
    const source = new OAuthScopesSource();
    const r = await source.read({
      connector: 'greenhouse',
      credentials: { apiKey: '' },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_config');
  });

  it('never echoes the apiKey in an invalid_config error message', async () => {
    const source = new OAuthScopesSource();
    const r = await source.read({
      connector: 'unknown' as unknown as 'greenhouse',
      credentials: { apiKey: 'super-secret-key-do-not-leak' },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).not.toContain('super-secret-key-do-not-leak');
  });
});
