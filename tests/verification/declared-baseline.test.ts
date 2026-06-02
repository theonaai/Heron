/**
 * AAP-115 (S1, half a) — declared-baseline builder tests.
 *
 * The unlock for the "verified wedge": the dashboard OAuth path used to pass
 * `declared: []`, so every granted scope read as an `extra` diff and the
 * verdict was always FAIL. This builder turns the analyzer's structured Q2/Q3
 * capture (`report.json.systems[]`) into a `DeclaredInventory` keyed onto the
 * connector kinds being introspected, so the differ does a real
 * declared-vs-actual comparison.
 *
 * These tests pin:
 *   - systemId → connector-kind mapping (conservative; unmapped → no scopes).
 *   - declared scopes re-keyed onto the connector's `service` (so they match
 *     the actual side's `service`).
 *   - the end-to-end differ behaviour: a granted scope matching a declared
 *     scope VERIFIES (zero diffs), while an undeclared granted scope still
 *     surfaces as an `extra`.
 */
import { describe, expect, it } from 'vitest';

import {
  buildDeclaredBaselineForConnectors,
  connectorForSystemId,
  type DeclaredSystemLike,
} from '../../src/verification/declared-baseline.js';
import { diff } from '../../src/verification/differ.js';
import type { ActualInventory } from '../../src/verification/types.js';

const FIXED = new Date('2026-06-02T00:00:00.000Z');

describe('connectorForSystemId', () => {
  it('maps the Google product family to google-workspace', () => {
    expect(connectorForSystemId('google-workspace')).toBe('google-workspace');
    expect(connectorForSystemId('google-sheets')).toBe('google-workspace');
    expect(connectorForSystemId('gmail')).toBe('google-workspace');
    expect(connectorForSystemId('gmail-bot')).toBe('google-workspace');
    expect(connectorForSystemId('drive-sync')).toBe('google-workspace');
    expect(connectorForSystemId('gcal')).toBe('google-workspace');
  });

  it('maps greenhouse / bamboohr brand stems (incl. -prod suffix)', () => {
    expect(connectorForSystemId('greenhouse')).toBe('greenhouse');
    expect(connectorForSystemId('greenhouse-prod')).toBe('greenhouse');
    expect(connectorForSystemId('bamboohr')).toBe('bamboohr');
    expect(connectorForSystemId('bamboo')).toBe('bamboohr');
  });

  it('returns undefined for systems with no known connector (conservative)', () => {
    expect(connectorForSystemId('linear-theona')).toBeUndefined();
    expect(connectorForSystemId('slack-workspace')).toBeUndefined();
    expect(connectorForSystemId('anthropic-claude-api')).toBeUndefined();
    expect(connectorForSystemId('')).toBeUndefined();
    // "overdrive" contains "drive" as a substring but not as a delimited
    // token — must NOT misclassify as google-workspace.
    expect(connectorForSystemId('overdrive-metrics')).toBeUndefined();
  });
});

describe('buildDeclaredBaselineForConnectors', () => {
  it('re-keys declared scopes onto the connector kind being introspected', () => {
    const systems: DeclaredSystemLike[] = [
      {
        systemId: 'google-sheets',
        scopesRequested: ['gmail.readonly', 'spreadsheets'],
      },
    ];
    const inv = buildDeclaredBaselineForConnectors({
      systems,
      connectors: ['google-workspace'],
      now: () => FIXED,
    });
    expect(inv).toBeDefined();
    expect(inv?.source).toBe('interview');
    expect(inv?.capturedAt).toBe('2026-06-02T00:00:00.000Z');
    // service is the CONNECTOR kind, not the systemId — matches the actual side.
    expect(inv?.scopes).toEqual([
      { service: 'google-workspace', scope: 'gmail.readonly' },
      { service: 'google-workspace', scope: 'spreadsheets' },
    ]);
  });

  it('omits systems that do not map to an IN-SCOPE connector', () => {
    const systems: DeclaredSystemLike[] = [
      { systemId: 'google-sheets', scopesRequested: ['drive.readonly'] },
      // greenhouse declared, but only google-workspace is being introspected.
      { systemId: 'greenhouse-prod', scopesRequested: ['candidates:read'] },
      // never maps to any connector.
      { systemId: 'linear-theona', scopesRequested: ['linear.list_issues'] },
    ];
    const inv = buildDeclaredBaselineForConnectors({
      systems,
      connectors: ['google-workspace'],
      now: () => FIXED,
    });
    expect(inv?.scopes).toEqual([
      { service: 'google-workspace', scope: 'drive.readonly' },
    ]);
  });

  it('de-dups identical service+scope across multiple systems', () => {
    const systems: DeclaredSystemLike[] = [
      { systemId: 'gmail', scopesRequested: ['gmail.readonly'] },
      { systemId: 'google-sheets', scopesRequested: ['gmail.readonly', 'spreadsheets'] },
    ];
    const inv = buildDeclaredBaselineForConnectors({
      systems,
      connectors: ['google-workspace'],
      now: () => FIXED,
    });
    expect(inv?.scopes).toEqual([
      { service: 'google-workspace', scope: 'gmail.readonly' },
      { service: 'google-workspace', scope: 'spreadsheets' },
    ]);
  });

  it('returns undefined when there is nothing to declare', () => {
    expect(
      buildDeclaredBaselineForConnectors({ systems: [], connectors: ['google-workspace'] }),
    ).toBeUndefined();
    expect(
      buildDeclaredBaselineForConnectors({ systems: undefined, connectors: ['google-workspace'] }),
    ).toBeUndefined();
    // systems exist but none map to an in-scope connector.
    expect(
      buildDeclaredBaselineForConnectors({
        systems: [{ systemId: 'linear-theona', scopesRequested: ['linear.x'] }],
        connectors: ['google-workspace'],
      }),
    ).toBeUndefined();
    // no connectors in scope.
    expect(
      buildDeclaredBaselineForConnectors({
        systems: [{ systemId: 'gmail', scopesRequested: ['gmail.readonly'] }],
        connectors: [],
      }),
    ).toBeUndefined();
  });

  it('degrades gracefully on malformed system blobs', () => {
    const systems: DeclaredSystemLike[] = [
      { systemId: 'gmail', scopesRequested: ['gmail.readonly', '', '  ', 42 as unknown as string] },
      { systemId: 42 as unknown as string, scopesRequested: ['drive'] }, // bad systemId
      { systemId: 'google-sheets', scopesRequested: 'not-an-array' as unknown as string[] },
    ];
    const inv = buildDeclaredBaselineForConnectors({
      systems,
      connectors: ['google-workspace'],
      now: () => FIXED,
    });
    // Only the one clean token survives.
    expect(inv?.scopes).toEqual([{ service: 'google-workspace', scope: 'gmail.readonly' }]);
  });
});

describe('declared baseline → differ (the real declared-vs-actual unlock)', () => {
  // The actual side as the google-workspace connector emits it: service is the
  // connector kind, scopes are canonical short forms.
  function actualGoogle(scopes: string[]): ActualInventory {
    return {
      source: 'oauth-scopes',
      capturedAt: FIXED.toISOString(),
      scopes: scopes.map((scope) => ({ service: 'google-workspace', scope })),
    };
  }

  it('a granted scope matching a declared scope produces ZERO diffs (VERIFIED)', () => {
    const inv = buildDeclaredBaselineForConnectors({
      systems: [{ systemId: 'gmail', scopesRequested: ['gmail.readonly'] }],
      connectors: ['google-workspace'],
      now: () => FIXED,
    });
    expect(inv).toBeDefined();
    const diffs = diff([inv!], actualGoogle(['gmail.readonly']));
    // Pre-AAP-115 (declared []) this would be one `extra`; now it is clean.
    expect(diffs).toEqual([]);
  });

  it('an UNDECLARED granted scope still surfaces as an extra diff', () => {
    const inv = buildDeclaredBaselineForConnectors({
      systems: [{ systemId: 'gmail', scopesRequested: ['gmail.readonly'] }],
      connectors: ['google-workspace'],
      now: () => FIXED,
    });
    // Agent declared only gmail.readonly but the token also grants drive (broad).
    const diffs = diff([inv!], actualGoogle(['gmail.readonly', 'drive']));
    const extras = diffs.filter((d) => d.kind === 'extra');
    expect(extras).toHaveLength(1);
    expect(extras[0].dimension).toBe('scope');
    expect((extras[0] as { actual: { scope: string } }).actual.scope).toBe('drive');
  });
});
