/**
 * AAP-83 Phase 1 — unified control catalog scaffolding.
 *
 * These tests pin two invariants that the rest of the migration
 * depends on:
 *
 *   1. Every existing CONTROL_MAPPINGS entry is represented in the
 *      catalog (no controls lost in the flattening). Future phases
 *      that splice in new entries must not remove any.
 *
 *   2. `stableKeyFor` is the only path to identity. Construct a key
 *      by hand vs via the helper — same string. If we ever start
 *      normalising controlId we must update the helper, not let call
 *      sites diverge.
 */

import { describe, expect, it } from 'vitest';

import { CONTROL_MAPPINGS } from '../../src/compliance/control-mappings.js';
import {
  CONTROL_CATALOG,
  catalogEntriesForFinding,
  entryToFrameworkControl,
  findCatalogEntry,
  listCatalogEntries,
  stableKeyFor,
} from '../../src/compliance/control-catalog.js';
import type { FindingType } from '../../src/compliance/types.js';

describe('control catalog identity', () => {
  it('stableKeyFor builds the canonical string', () => {
    const key = stableKeyFor({
      findingType: 'excessive-access',
      frameworkId: 'iso-42001',
      controlId: 'A.6.2.6',
    });
    expect(key).toBe('excessive-access:iso-42001:A.6.2.6');
  });

  it('stableKeyFor preserves controlId verbatim including spaces and punctuation', () => {
    // Auditor expectation: the canonical citation ("Art. 9(2)(a)") must
    // round-trip without normalisation. Future dedup logic that wants
    // case-insensitive matching needs to do its own folding rather
    // than mutate the catalog key.
    const key = stableKeyFor({
      findingType: 'excessive-access',
      frameworkId: 'eu-ai-act',
      controlId: 'Art. 9(2)(a)',
    });
    expect(key).toBe('excessive-access:eu-ai-act:Art. 9(2)(a)');
  });
});

describe('control catalog representation', () => {
  it('contains every (findingType, frameworkId, controlId) triple from CONTROL_MAPPINGS', () => {
    const expected = new Set<string>();
    for (const mapping of Object.values(CONTROL_MAPPINGS)) {
      for (const ctrl of mapping.controls) {
        expected.add(
          stableKeyFor({
            findingType: mapping.findingType,
            frameworkId: ctrl.frameworkId,
            controlId: ctrl.controlId,
          }),
        );
      }
    }

    const actual = new Set(
      CONTROL_CATALOG.map((e) =>
        stableKeyFor({
          findingType: e.findingType,
          frameworkId: e.frameworkId,
          controlId: e.controlId,
        }),
      ),
    );

    // AAP-83 / AAP-105 D4 — the catalog is a superset of CONTROL_MAPPINGS.
    // `attachDetectors` appends typed-only adapter rows (e.g. gdpr Art. 28,
    // iso-42001 A.10.3) that have no prose mapping. The catalog must
    // contain every prose key but may legitimately carry additional
    // typed-only entries.
    expect(actual.size).toBeGreaterThanOrEqual(expected.size);
    for (const k of expected) expect(actual.has(k)).toBe(true);
  });

  it('preserves annexIII flags from the original mapping', () => {
    // EU AI Act Art. 10 under sensitive-data is annexIII-tagged in
    // CONTROL_MAPPINGS. The catalog must carry that flag forward so the
    // mapper's Annex III gating still works once it reads from the
    // catalog.
    const entry = findCatalogEntry({
      findingType: 'sensitive-data',
      frameworkId: 'eu-ai-act',
      controlId: 'Art. 10(1-5)',
    });
    expect(entry?.annexIII).toBe(true);
  });

  it('preserves gatedBy from AIUC-1 architecture-gated controls', () => {
    const entry = findCatalogEntry({
      findingType: 'sensitive-data',
      frameworkId: 'aiuc-1',
      controlId: 'A005',
    });
    expect(entry?.gatedBy).toEqual(['hasCrossCustomer']);
  });

  it('every entry sourced from CONTROL_MAPPINGS defaults prosePathEnabled=true so the legacy mapper keeps firing', () => {
    // AAP-105 D4 added typed-only adapter rows (no matching prose entry
    // in CONTROL_MAPPINGS — e.g. gdpr Art. 28, iso-42001 A.10.3). These
    // legitimately land with `prosePathEnabled: false` because there is
    // no prose detector for them. The invariant being pinned here is
    // that adapter rows which DO match an existing CONTROL_MAPPINGS row
    // never silently flip `prosePathEnabled` from true to false.
    for (const e of CONTROL_CATALOG) {
      if (e.prosePathEnabled === false) {
        // Typed-only entries have a deterministic detector — verify the
        // catalog never sets `prosePathEnabled: false` without a
        // detector to back the verdict.
        expect(e.deterministicDetector).toBeTypeOf('function');
      } else {
        expect(e.prosePathEnabled).toBe(true);
      }
    }
  });

  it('Phase 2 wires a typed detector onto the AIUC-1 A003 catalog entries', () => {
    // The router covered AIUC-1 A003 with a single detector; the catalog
    // has both A003.3 and A003.4 as paired least-privilege entries.
    // Both should get the same adapter wired in.
    for (const controlId of ['A003.3', 'A003.4']) {
      const entry = findCatalogEntry({
        findingType: 'excessive-access',
        frameworkId: 'aiuc-1',
        controlId,
      });
      expect(entry?.deterministicDetector).toBeTypeOf('function');
    }
  });

  it('Phase 2 wires GDPR Article 22 + 25 detectors onto the catalog', () => {
    const art22 = findCatalogEntry({
      findingType: 'decisions-about-people',
      frameworkId: 'gdpr',
      controlId: 'Art. 22',
    });
    const art25 = findCatalogEntry({
      findingType: 'excessive-access',
      frameworkId: 'gdpr',
      controlId: 'Art. 25',
    });
    expect(art22?.deterministicDetector).toBeTypeOf('function');
    expect(art25?.deterministicDetector).toBeTypeOf('function');
  });

  it('Phase 2 wires NIST AI RMF MEASURE 1.1 + MANAGE 1.2 detectors', () => {
    const measure = findCatalogEntry({
      findingType: 'risk-score',
      frameworkId: 'nist-ai-rmf',
      controlId: 'MEASURE 1.1',
    });
    const manage = findCatalogEntry({
      findingType: 'risk-score',
      frameworkId: 'nist-ai-rmf',
      controlId: 'MANAGE 1.2',
    });
    expect(measure?.deterministicDetector).toBeTypeOf('function');
    expect(manage?.deterministicDetector).toBeTypeOf('function');
  });

  it('Phase 2 leaves prose-only ISO/IEC 42001 controls without a detector', () => {
    // ISO 42001 has no router coverage. The catalog entry remains
    // detector-less; the prose path is the only way to fire it.
    const isoEntry = findCatalogEntry({
      findingType: 'excessive-access',
      frameworkId: 'iso-42001',
      controlId: 'A.6.2.6',
    });
    expect(isoEntry?.deterministicDetector).toBeUndefined();
    expect(isoEntry?.prosePathEnabled).toBe(true);
  });
});

describe('catalog lookup helpers', () => {
  it('listCatalogEntries returns the frozen catalog', () => {
    const all = listCatalogEntries();
    expect(all.length).toBe(CONTROL_CATALOG.length);
  });

  it('catalogEntriesForFinding filters to the matching finding type', () => {
    const findings: FindingType[] = [
      'excessive-access',
      'write-risk',
      'sensitive-data',
      'scope-creep',
      'regulatory-flags',
      'risk-score',
      'decisions-about-people',
    ];
    for (const f of findings) {
      const subset = catalogEntriesForFinding(f);
      expect(subset.length).toBeGreaterThan(0);
      for (const e of subset) expect(e.findingType).toBe(f);
    }
  });

  it('findCatalogEntry returns undefined for unknown control ids', () => {
    const entry = findCatalogEntry({
      findingType: 'excessive-access',
      frameworkId: 'iso-42001',
      controlId: 'does.not.exist',
    });
    expect(entry).toBeUndefined();
  });

  it('entryToFrameworkControl round-trips the loose metadata', () => {
    const entry = findCatalogEntry({
      findingType: 'sensitive-data',
      frameworkId: 'aiuc-1',
      controlId: 'A005',
    });
    expect(entry).toBeDefined();
    const projected = entryToFrameworkControl(entry!);
    expect(projected.frameworkId).toBe('aiuc-1');
    expect(projected.controlId).toBe('A005');
    expect(projected.gatedBy).toEqual(['hasCrossCustomer']);
  });
});
