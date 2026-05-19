/**
 * Redaction utility tests — AAP-53.
 *
 * Whitelist redaction: only the schema fields explicitly listed in
 * `DiscoveredAgent` ever land in memory; everything else from a parsed
 * agent config is dropped. These helpers compute the "key names retained,
 * values discarded entirely" projection for env blocks, HTTP headers, and
 * connection-string identification.
 */

import { describe, expect, it } from 'vitest';

import { redactEnvKeys, redactHeaders, isConnectionString } from '../../src/discovery/redaction.js';

describe('redactEnvKeys', () => {
  it('returns an empty array for undefined / empty input', () => {
    expect(redactEnvKeys(undefined)).toEqual([]);
    expect(redactEnvKeys({})).toEqual([]);
  });

  it('matches names by case-insensitive suffix', () => {
    const env = {
      MY_API_KEY: 'sk-leak',
      Some_Token: 'leak',
      OTHER_SECRET: 'leak',
      DUMMY_PASSWORD: 'leak',
      FOO_KEY: 'leak',
      BAR_CREDENTIAL: 'leak',
    };
    const keys = redactEnvKeys(env);
    // Order must mirror insertion order so consumers can render stable lists.
    expect(keys).toEqual([
      'MY_API_KEY',
      'Some_Token',
      'OTHER_SECRET',
      'DUMMY_PASSWORD',
      'FOO_KEY',
      'BAR_CREDENTIAL',
    ]);
  });

  it('matches exact concrete names that lack the standard suffix', () => {
    const env = {
      GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp-leak',
      SLACK_BOT_TOKEN: 'xoxb-leak',
      BRAVE_API_KEY: 'leak',
      POSTGRES_CONNECTION_STRING: 'postgres://u:p@h/db',
      ANTHROPIC_API_KEY: 'leak',
      OPENAI_API_KEY: 'leak',
    };
    expect(redactEnvKeys(env).sort()).toEqual(
      [
        'ANTHROPIC_API_KEY',
        'BRAVE_API_KEY',
        'GITHUB_PERSONAL_ACCESS_TOKEN',
        'OPENAI_API_KEY',
        'POSTGRES_CONNECTION_STRING',
        'SLACK_BOT_TOKEN',
      ].sort(),
    );
  });

  it('ignores non-secret keys', () => {
    const env = {
      PATH: '/usr/bin',
      NODE_ENV: 'production',
      LOG_LEVEL: 'info',
      BASE_URL: 'https://example.com',
    };
    expect(redactEnvKeys(env)).toEqual([]);
  });

  it('never returns the original values anywhere', () => {
    const env = {
      MY_API_KEY: 'sk-VERY-SECRET-VALUE',
      OTHER_TOKEN: 'tok-VERY-SECRET-VALUE-2',
    };
    const out = redactEnvKeys(env);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('VERY-SECRET-VALUE');
    expect(serialized).not.toContain('VERY-SECRET-VALUE-2');
  });
});

describe('redactHeaders', () => {
  it('returns an empty array for undefined / empty input', () => {
    expect(redactHeaders(undefined)).toEqual([]);
    expect(redactHeaders({})).toEqual([]);
  });

  it('always returns the key names regardless of value content', () => {
    // For HTTP MCP servers, all header values are stripped — even
    // benign-looking ones like Content-Type. The schema only needs to
    // record that an Authorization header was configured, never its value.
    const headers = {
      Authorization: 'Bearer secret-token',
      'X-Api-Key': 'sk-leak',
      'Content-Type': 'application/json',
    };
    expect(redactHeaders(headers).sort()).toEqual(
      ['Authorization', 'Content-Type', 'X-Api-Key'].sort(),
    );
  });

  it('does not leak header values', () => {
    const headers = {
      Authorization: 'Bearer VERY-SECRET-VALUE',
      'X-Custom': 'plaintext-but-still-stripped',
    };
    const out = redactHeaders(headers);
    expect(JSON.stringify(out)).not.toContain('VERY-SECRET-VALUE');
    expect(JSON.stringify(out)).not.toContain('plaintext-but-still-stripped');
  });
});

describe('isConnectionString', () => {
  it('flags common DB protocols with credentials', () => {
    expect(isConnectionString('postgres://user:pass@host/db')).toBe(true);
    expect(isConnectionString('postgresql://user:pass@host/db')).toBe(true);
    expect(isConnectionString('mongodb://user:pass@host:27017/db')).toBe(true);
    expect(isConnectionString('mongodb+srv://user:pass@host/db')).toBe(true);
    expect(isConnectionString('mysql://user:pass@host:3306/db')).toBe(true);
    expect(isConnectionString('redis://user:pass@host:6379')).toBe(true);
  });

  it('does not flag a bare URL without credentials', () => {
    expect(isConnectionString('https://example.com')).toBe(false);
    expect(isConnectionString('postgres://host/db')).toBe(false);
  });

  it('does not flag arbitrary strings', () => {
    expect(isConnectionString('hello world')).toBe(false);
    expect(isConnectionString('')).toBe(false);
    expect(isConnectionString('not-a-url')).toBe(false);
  });
});
