import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AgentDeclarationSource } from '../../../src/verification/sources/agent-declaration.js';
import type {
  DeclaredSource,
  DeclaredSourceConfig,
} from '../../../src/verification/sources/agent-declaration/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(__dirname, '../../fixtures/declared/sample-hr-agent.json');

/**
 * Tests for the agent-declaration source (AAP-48 subagent #6).
 *
 * Three layers in one file (kept together because the surface is small):
 *
 *  1. Unit tests — file backend full coverage, theona-mcp stub config
 *     validation. ~25 cases.
 *  2. Integration test — end-to-end DeclaredSource.read({...}) against
 *     the fixture file.
 *  3. Golden test — snapshot of the canonical DeclaredInventory shape
 *     produced from the HR-agent fixture.
 */

// ─── Cluster 1: DeterministicSource-shape contract ──────────────────────────

describe('AgentDeclarationSource — DeclaredSource interface contract', () => {
  it('exposes id "agent-declaration"', () => {
    const source = new AgentDeclarationSource();
    expect(source.id).toBe('agent-declaration');
  });

  it('exposes a non-empty description', () => {
    const source = new AgentDeclarationSource();
    expect(typeof source.description).toBe('string');
    expect(source.description.length).toBeGreaterThan(0);
  });

  it('structurally satisfies DeclaredSource', () => {
    const source: DeclaredSource = new AgentDeclarationSource();
    expect(typeof source.read).toBe('function');
  });

  it('rejects an unknown backend value as invalid_config', async () => {
    const source = new AgentDeclarationSource();
    const r = await source.read({
      backend: 'git' as unknown as 'file',
      path: '/tmp/whatever',
    } as DeclaredSourceConfig);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_config');
  });

  it('rejects a null config as invalid_config', async () => {
    const source = new AgentDeclarationSource();
    const r = await source.read(null as unknown as DeclaredSourceConfig);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_config');
  });

  it('rejects a config without backend field', async () => {
    const source = new AgentDeclarationSource();
    const r = await source.read({} as unknown as DeclaredSourceConfig);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_config');
  });

  it('rejects file backend without a path field', async () => {
    const source = new AgentDeclarationSource();
    const r = await source.read({ backend: 'file' } as unknown as DeclaredSourceConfig);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_config');
  });

  it('rejects theona-mcp backend without an agentId field', async () => {
    const source = new AgentDeclarationSource();
    const r = await source.read({ backend: 'theona-mcp' } as unknown as DeclaredSourceConfig);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_config');
  });

  it('rejects theona-mcp config where theonaApiBaseUrl is wrong type', async () => {
    const source = new AgentDeclarationSource();
    const r = await source.read({
      backend: 'theona-mcp',
      agentId: 'agent-123',
      theonaApiBaseUrl: 42,
    } as unknown as DeclaredSourceConfig);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_config');
  });

  it('rejects theona-mcp config where bearerToken is wrong type', async () => {
    const source = new AgentDeclarationSource();
    const r = await source.read({
      backend: 'theona-mcp',
      agentId: 'agent-123',
      bearerToken: 42,
    } as unknown as DeclaredSourceConfig);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_config');
  });
});

// ─── Cluster 2: File backend ────────────────────────────────────────────────

describe('AgentDeclarationSource — file backend', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'heron-decl-src-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.HERON_DECLARED_SOURCE_CWD_ONLY;
  });

  it('parses a valid JSON file into a DeclaredInventory', async () => {
    const p = join(tmpDir, 'decl.json');
    writeFileSync(
      p,
      JSON.stringify({
        agent: { name: 'Test Agent' },
        declared: {
          tools: [{ name: 'a', description: 'd' }, { name: 'b' }],
          scopes: [{ service: 'gmail', scope: 'gmail.send' }],
        },
      }),
    );
    const source = new AgentDeclarationSource();
    const r = await source.read({ backend: 'file', path: p });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.inventory.source).toBe('agent-declaration');
    expect(r.inventory.tools).toEqual([
      { name: 'a', description: 'd' },
      { name: 'b' },
    ]);
    expect(r.inventory.scopes).toEqual([{ service: 'gmail', scope: 'gmail.send' }]);
  });

  it('missing required agent.name → clean parse error naming the field', async () => {
    const p = join(tmpDir, 'decl.json');
    writeFileSync(p, JSON.stringify({ agent: {}, declared: {} }));
    const source = new AgentDeclarationSource();
    const r = await source.read({ backend: 'file', path: p });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('parse');
    expect(r.error.message.toLowerCase()).toContain('agent.name');
  });

  it('extra unknown top-level key → warning, NOT failure', async () => {
    const p = join(tmpDir, 'decl.json');
    writeFileSync(
      p,
      JSON.stringify({
        agent: { name: 'A' },
        declared: { tools: [] },
        rogueKey: 'lol',
      }),
    );
    const source = new AgentDeclarationSource();
    const r = await source.read({ backend: 'file', path: p });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings).toBeDefined();
    expect(r.warnings!.join('\n').toLowerCase()).toContain('unknown');
  });

  it('rejects when tools array length > 256', async () => {
    const tools = Array.from({ length: 257 }, (_, i) => ({ name: `t${i}` }));
    const p = join(tmpDir, 'decl.json');
    writeFileSync(p, JSON.stringify({ agent: { name: 'A' }, declared: { tools } }));
    const source = new AgentDeclarationSource();
    const r = await source.read({ backend: 'file', path: p });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('parse');
    expect(r.error.message.toLowerCase()).toContain('tools');
  });

  it('rejects when scopes array length > 256', async () => {
    const scopes = Array.from({ length: 257 }, (_, i) => ({ service: 's', scope: `x${i}` }));
    const p = join(tmpDir, 'decl.json');
    writeFileSync(p, JSON.stringify({ agent: { name: 'A' }, declared: { scopes } }));
    const source = new AgentDeclarationSource();
    const r = await source.read({ backend: 'file', path: p });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('parse');
    expect(r.error.message.toLowerCase()).toContain('scopes');
  });

  it('rejects a file larger than 1 MiB BEFORE reading its contents', async () => {
    const p = join(tmpDir, 'big.json');
    // Generate a >1 MiB blob — but it doesn't need to be valid JSON because
    // the size check fires before parse.
    const padding = 'x'.repeat(1024 * 1024 + 16);
    writeFileSync(p, padding);
    const source = new AgentDeclarationSource();
    const r = await source.read({ backend: 'file', path: p });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('parse');
    // Error mentions size limit, not the file contents.
    expect(r.error.message.toLowerCase()).toMatch(/size|1 mib|too large/);
    expect(r.error.message).not.toContain('xxxxxxxx');
  });

  it('file not found → clean error naming the path', async () => {
    const p = join(tmpDir, 'no-such.json');
    const source = new AgentDeclarationSource();
    const r = await source.read({ backend: 'file', path: p });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('not_found');
    expect(r.error.message).toContain(p);
  });

  it('invalid JSON → clean error, file contents NOT echoed', async () => {
    const p = join(tmpDir, 'bad.json');
    const secretLookingContent = 'API_KEY=super-secret-987654321 ;;; { not json';
    writeFileSync(p, secretLookingContent);
    const source = new AgentDeclarationSource();
    const r = await source.read({ backend: 'file', path: p });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('parse');
    expect(r.error.message).not.toContain('super-secret-987654321');
    expect(r.error.message).not.toContain('API_KEY=');
  });

  it('rejects a path with ".." segments after normalization', async () => {
    // Construct a path that LOOKS clean to a naive consumer but contains a
    // `..` segment. We expect the source to reject it.
    const p = `${tmpDir}/sub/../decl.json`;
    const source = new AgentDeclarationSource();
    const r = await source.read({ backend: 'file', path: p });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_config');
    expect(r.error.message.toLowerCase()).toContain('..');
  });

  it('with HERON_DECLARED_SOURCE_CWD_ONLY=true, rejects paths outside CWD', async () => {
    process.env.HERON_DECLARED_SOURCE_CWD_ONLY = 'true';
    // tmpDir is in /tmp, almost certainly NOT a subpath of process.cwd().
    const p = join(tmpDir, 'outside.json');
    writeFileSync(p, JSON.stringify({ agent: { name: 'A' }, declared: {} }));
    const source = new AgentDeclarationSource();
    const r = await source.read({ backend: 'file', path: p });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_config');
    expect(r.error.message.toLowerCase()).toContain('cwd');
  });

  it('without HERON_DECLARED_SOURCE_CWD_ONLY, any readable path works', async () => {
    const p = join(tmpDir, 'ok.json');
    writeFileSync(p, JSON.stringify({ agent: { name: 'A' }, declared: { tools: [] } }));
    const source = new AgentDeclarationSource();
    const r = await source.read({ backend: 'file', path: p });
    expect(r.ok).toBe(true);
  });

  it('strips control chars from tool name via stripControlChars', async () => {
    const p = join(tmpDir, 'hostile.json');
    // \x00 (C0 null), \n (C0 line feed),  (line separator) all stripped
    const hostile = JSON.stringify({
      agent: { name: 'A' },
      declared: {
        tools: [{ name: 'safe\x00\nname' }],
      },
    });
    writeFileSync(p, hostile);
    const source = new AgentDeclarationSource();
    const r = await source.read({ backend: 'file', path: p });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.inventory.tools).toBeDefined();
    expect(r.inventory.tools![0].name).toBe('safename');
  });

  it('rejects an empty tool name', async () => {
    const p = join(tmpDir, 'empty.json');
    writeFileSync(p, JSON.stringify({ agent: { name: 'A' }, declared: { tools: [{ name: '' }] } }));
    const source = new AgentDeclarationSource();
    const r = await source.read({ backend: 'file', path: p });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('parse');
  });

  it('rejects a scope entry missing service', async () => {
    const p = join(tmpDir, 'missing-service.json');
    writeFileSync(
      p,
      JSON.stringify({
        agent: { name: 'A' },
        declared: { scopes: [{ scope: 'gmail.send' }] },
      }),
    );
    const source = new AgentDeclarationSource();
    const r = await source.read({ backend: 'file', path: p });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('parse');
    expect(r.error.message.toLowerCase()).toContain('service');
  });

  it('rejects a scope entry missing scope', async () => {
    const p = join(tmpDir, 'missing-scope.json');
    writeFileSync(
      p,
      JSON.stringify({
        agent: { name: 'A' },
        declared: { scopes: [{ service: 'gmail' }] },
      }),
    );
    const source = new AgentDeclarationSource();
    const r = await source.read({ backend: 'file', path: p });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('parse');
    expect(r.error.message.toLowerCase()).toContain('scope');
  });

  it('rejects top-level value that is a JSON array', async () => {
    const p = join(tmpDir, 'array.json');
    writeFileSync(p, JSON.stringify([1, 2, 3]));
    const source = new AgentDeclarationSource();
    const r = await source.read({ backend: 'file', path: p });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('parse');
  });

  it('rejects when agent block is not an object', async () => {
    const p = join(tmpDir, 'agent-not-obj.json');
    writeFileSync(p, JSON.stringify({ agent: 'not-an-object', declared: {} }));
    const source = new AgentDeclarationSource();
    const r = await source.read({ backend: 'file', path: p });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('parse');
  });

  it('rejects when declared block is not an object', async () => {
    const p = join(tmpDir, 'declared-not-obj.json');
    writeFileSync(p, JSON.stringify({ agent: { name: 'A' }, declared: 'oops' }));
    const source = new AgentDeclarationSource();
    const r = await source.read({ backend: 'file', path: p });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('parse');
  });

  it('warns on unknown agent.* key but still succeeds', async () => {
    const p = join(tmpDir, 'extra-agent-key.json');
    writeFileSync(p, JSON.stringify({ agent: { name: 'A', team: 'X' }, declared: {} }));
    const source = new AgentDeclarationSource();
    const r = await source.read({ backend: 'file', path: p });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings?.join('\n')).toMatch(/team/);
  });

  it('warns on unknown declared.* key but still succeeds', async () => {
    const p = join(tmpDir, 'extra-decl-key.json');
    writeFileSync(p, JSON.stringify({ agent: { name: 'A' }, declared: { future: 'x' } }));
    const source = new AgentDeclarationSource();
    const r = await source.read({ backend: 'file', path: p });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings?.join('\n')).toMatch(/future/);
  });

  it('rejects tools[0] that is a primitive (not an object)', async () => {
    const p = join(tmpDir, 'primitive-tool.json');
    writeFileSync(p, JSON.stringify({ agent: { name: 'A' }, declared: { tools: ['oops'] } }));
    const source = new AgentDeclarationSource();
    const r = await source.read({ backend: 'file', path: p });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('parse');
  });

  it('rejects tools[0].name that is not a string', async () => {
    const p = join(tmpDir, 'numeric-name.json');
    writeFileSync(p, JSON.stringify({ agent: { name: 'A' }, declared: { tools: [{ name: 123 }] } }));
    const source = new AgentDeclarationSource();
    const r = await source.read({ backend: 'file', path: p });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('parse');
  });

  it('rejects tools[0].description that is not a string', async () => {
    const p = join(tmpDir, 'numeric-desc.json');
    writeFileSync(
      p,
      JSON.stringify({
        agent: { name: 'A' },
        declared: { tools: [{ name: 'x', description: 99 }] },
      }),
    );
    const source = new AgentDeclarationSource();
    const r = await source.read({ backend: 'file', path: p });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('parse');
  });

  it('rejects when path resolves to a directory rather than a file', async () => {
    const source = new AgentDeclarationSource();
    const r = await source.read({ backend: 'file', path: tmpDir });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('parse');
    expect(r.error.message.toLowerCase()).toContain('not a regular file');
  });

  it('rejects tools where the array entry is null', async () => {
    const p = join(tmpDir, 'null-tool.json');
    writeFileSync(p, JSON.stringify({ agent: { name: 'A' }, declared: { tools: [null] } }));
    const source = new AgentDeclarationSource();
    const r = await source.read({ backend: 'file', path: p });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('parse');
  });

  it('rejects scopes that is not an array', async () => {
    const p = join(tmpDir, 'scopes-not-array.json');
    writeFileSync(
      p,
      JSON.stringify({ agent: { name: 'A' }, declared: { scopes: { not: 'array' } } }),
    );
    const source = new AgentDeclarationSource();
    const r = await source.read({ backend: 'file', path: p });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('parse');
  });

  it('rejects tools that is not an array', async () => {
    const p = join(tmpDir, 'tools-not-array.json');
    writeFileSync(
      p,
      JSON.stringify({ agent: { name: 'A' }, declared: { tools: 'string-not-array' } }),
    );
    const source = new AgentDeclarationSource();
    const r = await source.read({ backend: 'file', path: p });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('parse');
  });

  it('rejects a scope entry where service is not a string', async () => {
    const p = join(tmpDir, 'numeric-service.json');
    writeFileSync(
      p,
      JSON.stringify({
        agent: { name: 'A' },
        declared: { scopes: [{ service: 42, scope: 'x' }] },
      }),
    );
    const source = new AgentDeclarationSource();
    const r = await source.read({ backend: 'file', path: p });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('parse');
  });

  it('rejects an empty-string path at validation', async () => {
    const source = new AgentDeclarationSource();
    const r = await source.read({ backend: 'file', path: '' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_config');
  });

  it('rejects a scope service that becomes empty after sanitisation', async () => {
    const p = join(tmpDir, 'all-control-service.json');
    writeFileSync(
      p,
      JSON.stringify({
        agent: { name: 'A' },
        declared: { scopes: [{ service: '\x00\x01\x02', scope: 'x' }] },
      }),
    );
    const source = new AgentDeclarationSource();
    const r = await source.read({ backend: 'file', path: p });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('parse');
  });

  it('rejects a scope.scope that becomes empty after sanitisation', async () => {
    const p = join(tmpDir, 'all-control-scope.json');
    writeFileSync(
      p,
      JSON.stringify({
        agent: { name: 'A' },
        declared: { scopes: [{ service: 'gmail', scope: '\x00\x01' }] },
      }),
    );
    const source = new AgentDeclarationSource();
    const r = await source.read({ backend: 'file', path: p });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('parse');
  });

  it('rejects scopes[entry] that is null', async () => {
    const p = join(tmpDir, 'null-scope.json');
    writeFileSync(
      p,
      JSON.stringify({ agent: { name: 'A' }, declared: { scopes: [null] } }),
    );
    const source = new AgentDeclarationSource();
    const r = await source.read({ backend: 'file', path: p });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('parse');
  });

  it('rejects a tool name that becomes empty after sanitisation', async () => {
    const p = join(tmpDir, 'all-control-tool.json');
    writeFileSync(
      p,
      JSON.stringify({
        agent: { name: 'A' },
        declared: { tools: [{ name: '\x00\x01\x02' }] },
      }),
    );
    const source = new AgentDeclarationSource();
    const r = await source.read({ backend: 'file', path: p });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('parse');
  });
});

// ─── Round 2 security fixes ────────────────────────────────────────────────
//
// Five fixes from the round-1 security audit:
//   Fix 1 (HIGH):   symlink-traversal — CWD-only check must `fs.realpath`
//                   before string-prefix comparison so a symlink under CWD
//                   pointing OUT of CWD is rejected.
//   Fix 2 (HIGH):   unknown-key warnings must NOT echo the literal key
//                   name. A gcloud service-account JSON accidentally
//                   targeted at the source would otherwise leak
//                   `private_key_id`, `client_email`, etc. into the CLI
//                   output and fingerprint the file type.
//   Fix 4 (LOW):    whitespace-only tool / scope names must reject (the
//                   sanitiseString path already drops control chars, but a
//                   pure-space name was being accepted).
//   Fix 5 (LOW):    duplicate tool names and duplicate (service, scope)
//                   pairs must reject as parse errors — diff semantics on
//                   duplicates are undefined.
// (Fix 3 lives in `tests/util/markdown-escape.test.ts`.)

describe('AgentDeclarationSource — round-2 Fix 1: realpath check for CWD-only', () => {
  let tmpDir: string;
  let outsideDir: string;

  beforeEach(() => {
    // CWD-rooted temp dir: this directory IS inside process.cwd(), so a
    // file placed directly here passes the CWD-only check. We then plant
    // a symlink in it that points OUT of CWD.
    tmpDir = mkdtempSync(join(process.cwd(), 'heron-decl-realpath-'));
    // The symlink target lives in os.tmpdir() — almost certainly outside
    // process.cwd() in any CI / dev environment. Use realpathSync to get
    // the canonical form (macOS tmpdir is itself a symlink, which makes
    // string-prefix comparisons unreliable).
    outsideDir = realpathSync(mkdtempSync(join(tmpdir(), 'heron-decl-realpath-out-')));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
    delete process.env.HERON_DECLARED_SOURCE_CWD_ONLY;
  });

  it('rejects a symlink under CWD whose target lives outside CWD', async () => {
    process.env.HERON_DECLARED_SOURCE_CWD_ONLY = 'true';
    // The sensitive file (stands in for a gcloud service-account JSON).
    const secretPath = join(outsideDir, 'service-account.json');
    writeFileSync(
      secretPath,
      JSON.stringify({
        project_id: 'pwn-project',
        private_key_id: 'leaked-key-id',
        client_email: 'leak@pwn.iam.gserviceaccount.com',
      }),
    );
    // Symlink lives INSIDE CWD — passes string-prefix check — but points
    // OUT of CWD. Without realpath, the old code would happily read it.
    const linkPath = join(tmpDir, 'decl.json');
    symlinkSync(secretPath, linkPath);

    const source = new AgentDeclarationSource();
    const r = await source.read({ backend: 'file', path: linkPath });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_config');
    expect(r.error.message.toLowerCase()).toContain('cwd');
    // Defence in depth: must NOT disclose the symlink target. Operators
    // troubleshooting should not learn that the link pointed at e.g.
    // `/Users/foo/.config/gcloud/...`.
    expect(r.error.message).not.toContain(secretPath);
    expect(r.error.message).not.toContain('service-account');
  });

  it('accepts a symlink under CWD whose target ALSO lives under CWD', async () => {
    process.env.HERON_DECLARED_SOURCE_CWD_ONLY = 'true';
    // Real config file inside CWD.
    const realPath = join(tmpDir, 'real-decl.json');
    writeFileSync(
      realPath,
      JSON.stringify({ agent: { name: 'A' }, declared: { tools: [] } }),
    );
    // Symlink to it, also inside CWD.
    const linkPath = join(tmpDir, 'link.json');
    symlinkSync(realPath, linkPath);

    const source = new AgentDeclarationSource();
    const r = await source.read({ backend: 'file', path: linkPath });
    expect(r.ok).toBe(true);
  });

  it('without CWD-only mode, a symlink pointing outside CWD is still readable', async () => {
    // Sanity check: the realpath defence is OPT-IN via the env var. With
    // the default (anywhere readable) behaviour, the symlink resolves and
    // we read the target — that's the intended unsandboxed mode.
    const realPath = join(outsideDir, 'outside-decl.json');
    writeFileSync(
      realPath,
      JSON.stringify({ agent: { name: 'A' }, declared: { tools: [] } }),
    );
    const linkPath = join(tmpDir, 'link-to-outside.json');
    symlinkSync(realPath, linkPath);

    const source = new AgentDeclarationSource();
    const r = await source.read({ backend: 'file', path: linkPath });
    expect(r.ok).toBe(true);
  });
});

describe('AgentDeclarationSource — round-2 Fix 2: unknown-key warnings must not echo key names', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'heron-decl-key-disclose-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does NOT echo unknown TOP-LEVEL key names in warnings (count only)', async () => {
    // Stand-in for an accidentally-targeted gcloud service-account file.
    // These exact key names fingerprint the file type to a CLI operator
    // even though no values are echoed.
    const sensitiveKeys = [
      'project_id',
      'private_key_id',
      'private_key',
      'client_email',
      'client_id',
      'auth_uri',
    ];
    const obj: Record<string, unknown> = { agent: { name: 'A' }, declared: {} };
    for (const k of sensitiveKeys) obj[k] = 'redacted';
    const p = join(tmpDir, 'gcloud-shaped.json');
    writeFileSync(p, JSON.stringify(obj));

    const source = new AgentDeclarationSource();
    const r = await source.read({ backend: 'file', path: p });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings).toBeDefined();
    const joined = (r.warnings ?? []).join('\n');
    for (const k of sensitiveKeys) {
      expect(joined).not.toContain(k);
    }
    // Must still surface the count so operators know SOMETHING was ignored.
    expect(joined).toMatch(/\d/);
    expect(joined.toLowerCase()).toContain('unknown');
  });

  it('does NOT echo unknown agent.* key names in warnings', async () => {
    const obj = {
      agent: {
        name: 'A',
        // These would be unexpected on an agent block but plausibly
        // sensitive in a misrouted file.
        private_key_id: 'leak',
        client_email: 'leak@evil.com',
      },
      declared: {},
    };
    const p = join(tmpDir, 'agent-extras.json');
    writeFileSync(p, JSON.stringify(obj));

    const source = new AgentDeclarationSource();
    const r = await source.read({ backend: 'file', path: p });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const joined = (r.warnings ?? []).join('\n');
    expect(joined).not.toContain('private_key_id');
    expect(joined).not.toContain('client_email');
    expect(joined.toLowerCase()).toContain('unknown');
  });

  it('does NOT echo unknown declared.* key names in warnings', async () => {
    const obj = {
      agent: { name: 'A' },
      declared: {
        tools: [],
        // sensitive-looking key under the declared block
        secret_key_material: 'leak',
        another_leak: 'leak',
      },
    };
    const p = join(tmpDir, 'declared-extras.json');
    writeFileSync(p, JSON.stringify(obj));

    const source = new AgentDeclarationSource();
    const r = await source.read({ backend: 'file', path: p });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const joined = (r.warnings ?? []).join('\n');
    expect(joined).not.toContain('secret_key_material');
    expect(joined).not.toContain('another_leak');
    expect(joined.toLowerCase()).toContain('unknown');
  });

  it('still surfaces a count when only ONE unknown top-level key is present', async () => {
    // Edge case: count-only wording should still be readable for n=1.
    const p = join(tmpDir, 'one-extra.json');
    writeFileSync(
      p,
      JSON.stringify({ agent: { name: 'A' }, declared: {}, single_leak: 'x' }),
    );
    const source = new AgentDeclarationSource();
    const r = await source.read({ backend: 'file', path: p });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const joined = (r.warnings ?? []).join('\n');
    expect(joined).not.toContain('single_leak');
    expect(joined.toLowerCase()).toContain('unknown');
    expect(joined).toMatch(/1/);
  });
});

describe('AgentDeclarationSource — round-2 Fix 4: whitespace-only names rejected', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'heron-decl-ws-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects a tool whose name is only spaces', async () => {
    const p = join(tmpDir, 'ws-tool.json');
    writeFileSync(
      p,
      JSON.stringify({ agent: { name: 'A' }, declared: { tools: [{ name: '   ' }] } }),
    );
    const source = new AgentDeclarationSource();
    const r = await source.read({ backend: 'file', path: p });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('parse');
  });

  it('rejects a scope whose service is only spaces', async () => {
    const p = join(tmpDir, 'ws-service.json');
    writeFileSync(
      p,
      JSON.stringify({
        agent: { name: 'A' },
        declared: { scopes: [{ service: '   ', scope: 'gmail.send' }] },
      }),
    );
    const source = new AgentDeclarationSource();
    const r = await source.read({ backend: 'file', path: p });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('parse');
  });

  it('rejects a scope whose scope value is only spaces', async () => {
    const p = join(tmpDir, 'ws-scope.json');
    writeFileSync(
      p,
      JSON.stringify({
        agent: { name: 'A' },
        declared: { scopes: [{ service: 'gmail', scope: '   ' }] },
      }),
    );
    const source = new AgentDeclarationSource();
    const r = await source.read({ backend: 'file', path: p });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('parse');
  });
});

describe('AgentDeclarationSource — round-2 Fix 5: duplicate names/scopes rejected', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'heron-decl-dup-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects duplicate tool names as a parse error', async () => {
    const p = join(tmpDir, 'dup-tools.json');
    writeFileSync(
      p,
      JSON.stringify({
        agent: { name: 'A' },
        declared: { tools: [{ name: 'send_email' }, { name: 'send_email' }] },
      }),
    );
    const source = new AgentDeclarationSource();
    const r = await source.read({ backend: 'file', path: p });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('parse');
    expect(r.error.message.toLowerCase()).toContain('duplicate');
    expect(r.error.message).toContain('send_email');
  });

  it('rejects duplicate (service, scope) pairs as a parse error', async () => {
    const p = join(tmpDir, 'dup-scopes.json');
    writeFileSync(
      p,
      JSON.stringify({
        agent: { name: 'A' },
        declared: {
          scopes: [
            { service: 'gmail', scope: 'gmail.readonly' },
            { service: 'gmail', scope: 'gmail.readonly' },
          ],
        },
      }),
    );
    const source = new AgentDeclarationSource();
    const r = await source.read({ backend: 'file', path: p });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('parse');
    expect(r.error.message.toLowerCase()).toContain('duplicate');
  });

  it('accepts the same scope value on DIFFERENT services (not a duplicate)', async () => {
    // `gmail.readonly` on `gmail` is not the same as `gmail.readonly` on
    // `bambooHR-mirror`; the dedup key is `service:scope`, not `scope`
    // alone. (Whether this real-world combination makes sense is the
    // caller's problem; we only reject true duplicates.)
    const p = join(tmpDir, 'cross-service-scope.json');
    writeFileSync(
      p,
      JSON.stringify({
        agent: { name: 'A' },
        declared: {
          scopes: [
            { service: 'gmail', scope: 'gmail.readonly' },
            { service: 'bamboohr', scope: 'gmail.readonly' },
          ],
        },
      }),
    );
    const source = new AgentDeclarationSource();
    const r = await source.read({ backend: 'file', path: p });
    expect(r.ok).toBe(true);
  });
});

// ─── Theona MCP backend: additional coverage ───────────────────────────────

describe('AgentDeclarationSource — theona-mcp additional config validation', () => {
  it('rejects a bearerToken shorter than the minimum length', async () => {
    const source = new AgentDeclarationSource();
    const r = await source.read({
      backend: 'theona-mcp',
      agentId: 'agent-123',
      bearerToken: 'short',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_config');
  });

  it('rejects an empty theonaApiBaseUrl', async () => {
    const source = new AgentDeclarationSource();
    const r = await source.read({
      backend: 'theona-mcp',
      agentId: 'agent-123',
      theonaApiBaseUrl: '',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_config');
  });

  it('rejects an over-long agentId', async () => {
    const source = new AgentDeclarationSource();
    const r = await source.read({
      backend: 'theona-mcp',
      agentId: 'x'.repeat(257),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_config');
  });

  it('rejects an agentId with control characters', async () => {
    const source = new AgentDeclarationSource();
    const r = await source.read({
      backend: 'theona-mcp',
      agentId: 'agent\x00bad',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_config');
  });

  it('rejects a bearerToken with control characters', async () => {
    const source = new AgentDeclarationSource();
    const r = await source.read({
      backend: 'theona-mcp',
      agentId: 'agent-123',
      bearerToken: 'token-with-control\x00bytes-1234567890',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_config');
  });
});

// ─── Cluster 3: Theona MCP backend (stub) ───────────────────────────────────

describe('AgentDeclarationSource — theona-mcp backend (stub)', () => {
  it('valid config (agentId only) → returns not_implemented cleanly', async () => {
    const source = new AgentDeclarationSource();
    const r = await source.read({ backend: 'theona-mcp', agentId: 'agent-123' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('not_implemented');
    expect(r.error.message.toLowerCase()).toContain('theona');
  });

  it('rejects empty agentId at validation', async () => {
    const source = new AgentDeclarationSource();
    const r = await source.read({ backend: 'theona-mcp', agentId: '' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_config');
    expect(r.error.message.toLowerCase()).toContain('agentid');
  });

  it('rejects whitespace-only agentId at validation', async () => {
    const source = new AgentDeclarationSource();
    const r = await source.read({ backend: 'theona-mcp', agentId: '   ' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_config');
  });

  it('rejects an agentId with embedded whitespace', async () => {
    const source = new AgentDeclarationSource();
    const r = await source.read({ backend: 'theona-mcp', agentId: 'agent 123' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_config');
  });

  it('rejects an over-long bearerToken', async () => {
    const source = new AgentDeclarationSource();
    const r = await source.read({
      backend: 'theona-mcp',
      agentId: 'agent-123',
      bearerToken: 'x'.repeat(8193),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_config');
    expect(r.error.message.toLowerCase()).toContain('bearertoken');
  });

  it('rejects a bearerToken with leading/trailing whitespace', async () => {
    const source = new AgentDeclarationSource();
    const r = await source.read({
      backend: 'theona-mcp',
      agentId: 'agent-123',
      bearerToken: 'token-with-padding-1234567890   ',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_config');
  });

  it('rejects a theonaApiBaseUrl pointing at AWS metadata (SSRF)', async () => {
    const source = new AgentDeclarationSource();
    const r = await source.read({
      backend: 'theona-mcp',
      agentId: 'agent-123',
      theonaApiBaseUrl: 'http://169.254.169.254/latest/meta-data/',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_config');
    expect(r.error.message.toLowerCase()).toContain('target_endpoint');
  });

  it('rejects a theonaApiBaseUrl pointing at localhost', async () => {
    const source = new AgentDeclarationSource();
    const r = await source.read({
      backend: 'theona-mcp',
      agentId: 'agent-123',
      theonaApiBaseUrl: 'http://127.0.0.1:9000/',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_config');
  });

  it('never echoes a bearerToken into any error message', async () => {
    const source = new AgentDeclarationSource();
    const secret = 'super-secret-bearer-token-do-not-leak-1234567890';
    // Trigger an SSRF-validation error path so an error message gets produced.
    const r = await source.read({
      backend: 'theona-mcp',
      agentId: 'agent-123',
      bearerToken: secret,
      theonaApiBaseUrl: 'http://127.0.0.1/',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).not.toContain(secret);
    expect(JSON.stringify(r.error)).not.toContain(secret);
  });

  it('never echoes a bearerToken on the not_implemented happy-path', async () => {
    const source = new AgentDeclarationSource();
    const secret = 'pretend-token-1234567890abcdef';
    const r = await source.read({
      backend: 'theona-mcp',
      agentId: 'agent-abc',
      bearerToken: secret,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('not_implemented');
    expect(JSON.stringify(r.error)).not.toContain(secret);
  });
});

// ─── Cluster 4: Integration test ────────────────────────────────────────────

describe('AgentDeclarationSource — integration', () => {
  it('end-to-end file backend against fixture file', async () => {
    const source = new AgentDeclarationSource();
    const r = await source.read({ backend: 'file', path: FIXTURE_PATH });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.inventory.source).toBe('agent-declaration');
    expect(r.inventory.tools?.map((t) => t.name)).toEqual([
      'list_candidates',
      'send_email',
      'schedule_meeting',
    ]);
    expect(r.inventory.scopes?.length).toBe(4);
  });
});

// ─── Cluster 5: Golden test ─────────────────────────────────────────────────

describe('AgentDeclarationSource — golden snapshot', () => {
  it('canonical HR-agent fixture produces the expected DeclaredInventory shape', async () => {
    const source = new AgentDeclarationSource();
    const r = await source.read({ backend: 'file', path: FIXTURE_PATH });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Strip the dynamic capturedAt timestamp before snapshot.
    const { capturedAt: _ts, ...rest } = r.inventory;
    void _ts;
    expect(rest).toMatchSnapshot();
  });
});
