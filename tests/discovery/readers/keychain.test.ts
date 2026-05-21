/**
 * L3 — macOS Keychain reader tests (AAP-67).
 *
 * The reader shells out to `security dump-keychain`, so we inject a
 * fake spawn that returns canned stdout. Real `child_process.spawn` is
 * NEVER called from the test suite — every test runs hermetically on
 * any platform (including CI Linux runners) and zero risk of triggering
 * a real Keychain prompt on a developer's workstation.
 *
 * Privacy assertions:
 *   - Even if the canned dump contains an `acct` (account name) or any
 *     other field, ONLY the `svce` value ever surfaces.
 *   - Service names outside the curated allowlist are dropped entirely
 *     (e.g. a random `com.example.unrelated` entry would NOT appear).
 *   - Non-macOS hosts get an empty result + a warning, never a thrown
 *     error.
 */

import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  extractServiceNames,
  readKeychain,
  type KeychainSpawn,
} from '../../../src/discovery/readers/keychain.js';

/**
 * Build a fake spawn that emits the supplied stdout, then closes with
 * the supplied exit code. Useful as a drop-in replacement for
 * `child_process.spawn` in the reader.
 */
function fakeSpawn(stdout: string, opts: { code?: number; stderr?: string } = {}): KeychainSpawn {
  return () => {
    const emitter = new EventEmitter() as EventEmitter & {
      stdout: Readable;
      stderr: Readable;
    };
    const stdoutStream = Readable.from([stdout]);
    const stderrStream = Readable.from([opts.stderr ?? '']);
    emitter.stdout = stdoutStream;
    emitter.stderr = stderrStream;
    // Defer the close so listeners attached by the reader actually fire.
    setImmediate(() => {
      emitter.emit('close', opts.code ?? 0);
    });
    return emitter as unknown as ReturnType<KeychainSpawn>;
  };
}

const DUMP_FIXTURE = `keychain: "/Users/heron/Library/Keychains/login.keychain-db"
class: "genp"
attributes:
    0x00000007 <blob>="Slack"
    "acct"<blob>="heron-user@example.com"
    "svce"<blob>="com.tinyspeck.slackmacgap.heron-user"
keychain: "/Users/heron/Library/Keychains/login.keychain-db"
class: "genp"
attributes:
    "acct"<blob>="api"
    "svce"<blob>="Anthropic API Key"
keychain: "/Users/heron/Library/Keychains/login.keychain-db"
class: "genp"
attributes:
    "svce"<blob>="GitHub – heron-bot"
keychain: "/Users/heron/Library/Keychains/login.keychain-db"
class: "genp"
attributes:
    "svce"<blob>="com.example.unrelated.app"
keychain: "/Users/heron/Library/Keychains/login.keychain-db"
class: "genp"
attributes:
    "svce"<blob>=<NULL>
`;

describe('readKeychain — L3 (AAP-67)', () => {
  it('returns empty result + warning on non-macOS platforms', async () => {
    const out = await readKeychain({ platform: 'linux' });
    expect(out.services).toEqual([]);
    expect(out.warnings).toEqual(['keychain reader not available on this platform']);
  });

  it('returns empty result + warning on Windows', async () => {
    const out = await readKeychain({ platform: 'win32' });
    expect(out.services).toEqual([]);
    expect(out.warnings).toEqual(['keychain reader not available on this platform']);
  });

  it('filters to the curated allowlist, dropping unrelated services', async () => {
    const out = await readKeychain({
      platform: 'darwin',
      spawn: fakeSpawn(DUMP_FIXTURE),
    });
    const services = out.services.map((s) => s.service).sort();
    expect(services).toEqual([
      'Anthropic API Key',
      'GitHub – heron-bot',
      'com.tinyspeck.slackmacgap.heron-user',
    ]);
    expect(services).not.toContain('com.example.unrelated.app');
    expect(out.warnings).toEqual([]);
  });

  it('attaches a coarse category from the allowlist match', async () => {
    const out = await readKeychain({
      platform: 'darwin',
      spawn: fakeSpawn(DUMP_FIXTURE),
    });
    const byService = new Map(out.services.map((s) => [s.service, s.category]));
    expect(byService.get('Anthropic API Key')).toBe('ai-provider');
    expect(byService.get('com.tinyspeck.slackmacgap.heron-user')).toBe('communications');
    expect(byService.get('GitHub – heron-bot')).toBe('code-host');
  });

  it('NEVER surfaces acct (account) values — only svce', async () => {
    const out = await readKeychain({
      platform: 'darwin',
      spawn: fakeSpawn(DUMP_FIXTURE),
    });
    const serialised = JSON.stringify(out);
    // `heron-user@example.com` appears as the acct in the dump fixture.
    // It must NOT survive into the reader output, even though that line
    // sits adjacent to a Slack svce.
    expect(serialised).not.toContain('heron-user@example.com');
  });

  it('surfaces a warning + empty services when spawn exits non-zero', async () => {
    const out = await readKeychain({
      platform: 'darwin',
      spawn: fakeSpawn('', { code: 1, stderr: 'no default keychain' }),
    });
    expect(out.services).toEqual([]);
    expect(out.warnings.length).toBe(1);
    expect(out.warnings[0]).toContain('security dump-keychain exited 1');
    expect(out.warnings[0]).toContain('no default keychain');
  });

  it('extractServiceNames pulls svce strings (and ignores NULL svce + acct)', () => {
    const names = extractServiceNames(DUMP_FIXTURE);
    expect(names).toEqual([
      'com.tinyspeck.slackmacgap.heron-user',
      'Anthropic API Key',
      'GitHub – heron-bot',
      'com.example.unrelated.app',
    ]);
  });
});
