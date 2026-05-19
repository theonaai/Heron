/**
 * Windsurf config reader tests — AAP-53.
 *
 * Schema matches Claude Desktop. ${env:VAR} / ${file:path} interpolation
 * is preserved verbatim — Heron never resolves it.
 */

import { describe, expect, it } from 'vitest';

import { windsurfReader } from '../../../src/discovery/readers/windsurf.js';

describe('windsurfReader', () => {
  it('enumerates user path only (no workspace path on Windsurf)', () => {
    expect(windsurfReader.paths('/home/me')).toEqual([
      '/home/me/.codeium/windsurf/mcp_config.json',
    ]);
  });

  it('preserves ${env:VAR} interpolation as-is (never resolves it)', async () => {
    const content = JSON.stringify({
      mcpServers: {
        sentry: {
          command: 'sentry-mcp',
          env: {
            SENTRY_AUTH_TOKEN: '${env:SENTRY_TOKEN}',
          },
        },
      },
    });
    const out = await windsurfReader.parse(content, '/home/me/.codeium/windsurf/mcp_config.json');
    expect(out.length).toBe(1);
    const s = out[0];
    expect(s.name).toBe('sentry');
    expect(s.transport).toBe('stdio');
    expect(s.command).toBe('sentry-mcp');
    expect(s.hasCredentials).toBe(true);
    expect(s.redactedEnvKeys).toEqual(['SENTRY_AUTH_TOKEN']);
  });
});
