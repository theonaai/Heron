/**
 * AAP-88 — snapshot test on THRESHOLD_MANIFEST.
 *
 * Any future change to a verdict threshold (numeric cutoff OR categorical
 * gate) shows up as a snapshot diff in PR review. This is the safety net
 * preventing accidental threshold tuning — a reviewer cannot miss it
 * because the snapshot must be regenerated and the diff appears in the
 * PR.
 *
 * Plus shape invariants: every entry must have a non-empty name,
 * rationale, source, and at least one site. Catches malformed entries at
 * test time rather than at snapshot review time.
 */

import { describe, it, expect } from 'vitest';
import {
  THRESHOLD_MANIFEST,
  type ThresholdEntry,
} from '../../src/verification/threshold-manifest.js';

describe('THRESHOLD_MANIFEST snapshot', () => {
  it('matches snapshot of all verdict thresholds', () => {
    expect(THRESHOLD_MANIFEST).toMatchSnapshot();
  });

  it('every entry has a non-empty name, rationale, source, and at least one site', () => {
    const entries = Object.entries(THRESHOLD_MANIFEST);
    expect(entries.length).toBeGreaterThan(0);
    for (const [key, entry] of entries) {
      // Key matches the entry.name (manifest self-consistency).
      expect(entry.name, `entry key "${key}" must equal entry.name`).toBe(key);
      expect(entry.name.length, `entry "${key}" name must be non-empty`).toBeGreaterThan(0);
      expect(entry.rationale.length, `entry "${key}" rationale must be non-empty`).toBeGreaterThan(0);
      expect(entry.source.length, `entry "${key}" source must be non-empty`).toBeGreaterThan(0);
      expect(entry.sites.length, `entry "${key}" must have at least one site`).toBeGreaterThan(0);
      expect(entry.affects.length, `entry "${key}" affects must list at least one output`).toBeGreaterThan(0);
      // Each site must reference a real file path (we cannot verify
      // existence here without filesystem access in a unit test, but at
      // least the string must be non-empty and look path-like).
      for (const site of entry.sites) {
        expect(site.file.length, `entry "${key}" site has empty file`).toBeGreaterThan(0);
        expect(site.file.startsWith('src/'), `entry "${key}" site must be repo-relative under src/, got "${site.file}"`).toBe(true);
      }
      // Type must be one of the allowed values.
      expect(['numeric', 'categorical']).toContain(entry.type);
      // For numeric type, value must be a number; for categorical, a string.
      if (entry.type === 'numeric') {
        expect(typeof entry.value, `entry "${key}" type is numeric but value is ${typeof entry.value}`).toBe('number');
      } else {
        expect(typeof entry.value, `entry "${key}" type is categorical but value is ${typeof entry.value}`).toBe('string');
      }
    }
  });

  it('manifest covers all 10 threshold-site files from the AAP-88 brief', () => {
    const expectedFiles = [
      'src/verification/verdict.ts',
      'src/verification/verdict-pipeline.ts',
      'src/compliance/mapper.ts',
      'src/analysis/risk-scorer.ts',
      'src/report/control-results-projection.ts',
      'src/report/html-renderer.ts',
      'src/verification/frameworks/detectors.ts',
      'src/verification/frameworks/classify.ts',
      'src/verification/hr-pack/detectors.ts',
      'src/compliance/detectors/discovery-detectors.ts',
    ];
    const seenFiles = new Set<string>();
    for (const entry of Object.values(THRESHOLD_MANIFEST) as ThresholdEntry[]) {
      for (const site of entry.sites) {
        seenFiles.add(site.file);
      }
    }
    for (const f of expectedFiles) {
      expect(
        seenFiles.has(f),
        `THRESHOLD_MANIFEST must include at least one entry from "${f}" (AAP-88 brief enumerates this as a threshold site)`,
      ).toBe(true);
    }
  });
});
