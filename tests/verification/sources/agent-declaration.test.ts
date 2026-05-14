import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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
