import { describe, expect, it } from 'vitest';
import { trimInvocation } from '../../src/discovery/args-trim.js';

describe('trimInvocation', () => {
  it('returns empty args when no args are given', () => {
    expect(trimInvocation('node', undefined).args).toEqual([]);
    expect(trimInvocation('node', []).args).toEqual([]);
  });

  it('keeps the base command and collapses inline whitespace', () => {
    expect(trimInvocation('node ./agent.js --token=xxx', []).command).toBe('node');
  });

  it('preserves non-secret flags verbatim (--db main, --port 5432)', () => {
    const out = trimInvocation('postgres-mcp', ['--db', 'main', '--port', '5432']);
    expect(out.args).toEqual(['--db', 'main', '--port', '5432']);
  });

  it('redacts the value half of --token=<secret>', () => {
    const out = trimInvocation('github-mcp', ['--token=ghp_abcdef1234567890']);
    expect(out.args).toEqual(['--token=[REDACTED]']);
  });

  it('redacts the next positional after a standalone --token flag', () => {
    const out = trimInvocation('github-mcp', ['--token', 'ghp_abcdef1234567890', '--workspace', './foo']);
    expect(out.args).toEqual(['--token', '[REDACTED]', '--workspace', './foo']);
  });

  it('redacts --api-key, --password, --secret, --auth', () => {
    const out = trimInvocation('mcp', [
      '--api-key=key1',
      '--password=p1',
      '--secret=s1',
      '--auth=a1',
    ]);
    expect(out.args).toEqual([
      '--api-key=[REDACTED]',
      '--password=[REDACTED]',
      '--secret=[REDACTED]',
      '--auth=[REDACTED]',
    ]);
  });

  it('redacts connection strings in args', () => {
    const out = trimInvocation('postgres-mcp', ['postgres://u:pw@host/db']);
    expect(out.args).toEqual(['[REDACTED:connection-string]']);
  });

  it('mixed: keeps legit + redacts secrets', () => {
    const out = trimInvocation('mcp', [
      '--workspace',
      './repo',
      '--token=ghp_xxx',
      '--port',
      '8080',
    ]);
    expect(out.args).toEqual(['--workspace', './repo', '--token=[REDACTED]', '--port', '8080']);
  });

  it('case-insensitive flag matching', () => {
    const out = trimInvocation('mcp', ['--TOKEN=xxx', '--Api-Key=yyy']);
    expect(out.args[0]).toBe('--TOKEN=[REDACTED]');
    expect(out.args[1]).toBe('--Api-Key=[REDACTED]');
  });
});
