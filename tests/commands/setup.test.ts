import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultCredentialsPath,
  loadCredentials,
  saveCredentials,
} from '../../src/commands/setup.js';

describe('heron setup — credentials persistence', () => {
  let scratchDir: string | undefined;
  const originalEnv = process.env.HERON_CREDENTIALS_PATH;

  afterEach(() => {
    if (scratchDir) {
      rmSync(scratchDir, { recursive: true, force: true });
      scratchDir = undefined;
    }
    if (originalEnv === undefined) delete process.env.HERON_CREDENTIALS_PATH;
    else process.env.HERON_CREDENTIALS_PATH = originalEnv;
  });

  it('saves and reloads anthropic credentials', async () => {
    scratchDir = mkdtempSync(join(tmpdir(), 'heron-setup-'));
    const path = join(scratchDir, 'creds.json');
    await saveCredentials({ provider: 'anthropic', apiKey: 'sk-ant-test-1' }, path);
    const loaded = await loadCredentials(path);
    expect(loaded).toBeDefined();
    expect(loaded?.provider).toBe('anthropic');
    expect(loaded?.apiKey).toBe('sk-ant-test-1');
    expect(loaded?.baseURL).toBeUndefined();
    expect(loaded?.savedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('saves and reloads litellm credentials with baseURL', async () => {
    scratchDir = mkdtempSync(join(tmpdir(), 'heron-setup-'));
    const path = join(scratchDir, 'creds.json');
    await saveCredentials(
      { provider: 'openai', apiKey: 'sk-litellm-x', baseURL: 'https://litellm.example.com' },
      path,
    );
    const loaded = await loadCredentials(path);
    expect(loaded?.provider).toBe('openai');
    expect(loaded?.baseURL).toBe('https://litellm.example.com');
  });

  it('returns undefined when file is missing', async () => {
    scratchDir = mkdtempSync(join(tmpdir(), 'heron-setup-'));
    const loaded = await loadCredentials(join(scratchDir, 'does-not-exist.json'));
    expect(loaded).toBeUndefined();
  });

  it('returns undefined for malformed JSON', async () => {
    scratchDir = mkdtempSync(join(tmpdir(), 'heron-setup-'));
    const path = join(scratchDir, 'creds.json');
    await fs.writeFile(path, '{not valid json', 'utf8');
    expect(await loadCredentials(path)).toBeUndefined();
  });

  it('returns undefined when required fields are missing', async () => {
    scratchDir = mkdtempSync(join(tmpdir(), 'heron-setup-'));
    const path = join(scratchDir, 'creds.json');
    await fs.writeFile(path, JSON.stringify({ provider: 'anthropic' }), 'utf8');
    expect(await loadCredentials(path)).toBeUndefined();
  });

  it('rejects unknown provider values', async () => {
    scratchDir = mkdtempSync(join(tmpdir(), 'heron-setup-'));
    const path = join(scratchDir, 'creds.json');
    await fs.writeFile(
      path,
      JSON.stringify({ provider: 'evil-corp', apiKey: 'x' }),
      'utf8',
    );
    expect(await loadCredentials(path)).toBeUndefined();
  });

  it('writes the file with 0600 perms', async () => {
    scratchDir = mkdtempSync(join(tmpdir(), 'heron-setup-'));
    const path = join(scratchDir, 'creds.json');
    await saveCredentials({ provider: 'openai', apiKey: 'sk-test' }, path);
    const stat = await fs.stat(path);
    // Mask to ignore platform-specific high bits.
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('defaultCredentialsPath honours HERON_CREDENTIALS_PATH override', () => {
    process.env.HERON_CREDENTIALS_PATH = '/tmp/heron-test-creds.json';
    expect(defaultCredentialsPath()).toBe('/tmp/heron-test-creds.json');
  });

  it('overwrite preserves later savedAt', async () => {
    scratchDir = mkdtempSync(join(tmpdir(), 'heron-setup-'));
    const path = join(scratchDir, 'creds.json');
    await saveCredentials({ provider: 'anthropic', apiKey: 'sk-ant-1' }, path);
    const first = await loadCredentials(path);
    await new Promise((r) => setTimeout(r, 5));
    await saveCredentials({ provider: 'openai', apiKey: 'sk-2' }, path);
    const second = await loadCredentials(path);
    expect(second?.provider).toBe('openai');
    expect(second?.apiKey).toBe('sk-2');
    expect(new Date(second!.savedAt).getTime())
      .toBeGreaterThanOrEqual(new Date(first!.savedAt).getTime());
  });
});
