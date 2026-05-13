import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { parseToolsListResponse } from '../../src/connectors/mcp-client.js';

/**
 * Golden-output snapshot tests. We pin the full normalized
 * ToolInventoryRecord for a handful of fixtures so future changes to parsing
 * surface as snapshot diffs instead of silently passing. Snapshots live on
 * disk (tests/snapshots/mcp-client/) so a reviewer can read them in the
 * diff alongside the implementation change.
 *
 * Set HERON_UPDATE_GOLDEN=1 to rewrite the snapshots after an intentional
 * change.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '../fixtures/mcp');
const SNAPSHOTS = resolve(__dirname, '../snapshots/mcp-client');
const SERVER_LABEL = 'golden-fixture';
const FIXED_TS = '2026-05-13T12:00:00.000Z';

const cases = ['tools-list-normal', 'tools-list-with-annotations', 'tools-list-extra-fields'];

describe('parseToolsListResponse — golden snapshots', () => {
  for (const name of cases) {
    it(`matches snapshot for ${name}`, () => {
      const raw = JSON.parse(readFileSync(resolve(FIXTURES, `${name}.json`), 'utf-8'));
      const result = parseToolsListResponse(raw, { server: SERVER_LABEL, capturedAt: FIXED_TS });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const snapshotPath = resolve(SNAPSHOTS, `${name}.json`);
      const actual = JSON.stringify(result.value, null, 2) + '\n';

      if (process.env.HERON_UPDATE_GOLDEN === '1' || !existsSync(snapshotPath)) {
        writeFileSync(snapshotPath, actual);
      }
      const expected = readFileSync(snapshotPath, 'utf-8');
      expect(actual).toBe(expected);
    });
  }
});
