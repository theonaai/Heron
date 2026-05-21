/**
 * L5 — per-workspace `.env*` reader tests (AAP-67).
 *
 * Privacy invariant front and center: every fixture seeds real-looking
 * secret VALUES (AWS access key, Slack xoxb, OpenAI skFAKE_, GCP marker
 * JSON), and every test asserts the serialised output carries the
 * variable NAMES while the secret values themselves never appear.
 */

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readWorkspaceEnv } from '../../../src/discovery/readers/workspace-env.js';

let workspace = '';

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'heron-aap67-l5-'));
});
afterEach(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

async function seed(rel: string, contents: string): Promise<void> {
  const abs = join(workspace, rel);
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, contents, 'utf8');
}

describe('readWorkspaceEnv — L5 (AAP-67)', () => {
  it('returns empty files when no env files exist', async () => {
    const out = await readWorkspaceEnv({ workspaces: [workspace] });
    expect(out.files).toEqual([]);
    expect(out.scannedPaths.length).toBe(10);
  });

  it('parses .env variable NAMES, NEVER values (AWS + Slack regression)', async () => {
    await seed(
      '.env',
      `# Heron test env
AWS_ACCESS_KEY_ID=AKHRNIOSFODNN7EXAMPLE
AWS_SECRET_ACCESS_KEY=HERONfakeJalr/K7MDENG/bPxRfiCYEXAMPLEKEY
SLACK_BOT_TOKEN=XOXBFAKE_1234567890-1234567890123-aBcDeFgHiJkLmNoPqRsTuVwX
OPENAI_API_KEY=skFAKE_fakeOPENAIkeyABCDEFGHIJKLMNOPQRSTUVWXYZ123456
DATABASE_URL="postgres://user:secretpassword@db.example.com:5432/heron"
NODE_ENV=production
`,
    );
    const out = await readWorkspaceEnv({ workspaces: [workspace] });
    const f = out.files.find((x) => x.path.endsWith('/.env'))!;
    expect(f.keys).toEqual([
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'SLACK_BOT_TOKEN',
      'OPENAI_API_KEY',
      'DATABASE_URL',
      'NODE_ENV',
    ]);

    const serialised = JSON.stringify(out);
    expect(serialised).not.toContain('AKHRNIOSFODNN7EXAMPLE');
    expect(serialised).not.toContain('HERONfakeJalr');
    expect(serialised).not.toContain('XOXBFAKE_1234567890');
    expect(serialised).not.toContain('skFAKE_fakeOPENAIkey');
    expect(serialised).not.toContain('secretpassword');
  });

  it('parses every conventional env-file variant (.env.local, .env.development, .env.production, .env.example, .envrc, .dev.vars)', async () => {
    await seed('.env.local', 'LOCAL_KEY=val\n');
    await seed('.env.development', 'DEV_KEY=val\n');
    await seed('.env.production', 'PROD_KEY=val\n');
    await seed('.env.example', 'EXAMPLE_KEY=placeholder\n');
    await seed('.envrc', 'export ENVRC_KEY=val\nexport ANOTHER_ENVRC=val\n');
    await seed('.dev.vars', 'WRANGLER_KEY=val\n');

    const out = await readWorkspaceEnv({ workspaces: [workspace] });
    const byBase = (b: string) => out.files.find((f) => f.path.endsWith('/' + b))!;
    expect(byBase('.env.local').keys).toEqual(['LOCAL_KEY']);
    expect(byBase('.env.development').keys).toEqual(['DEV_KEY']);
    expect(byBase('.env.production').keys).toEqual(['PROD_KEY']);
    expect(byBase('.env.example').keys).toEqual(['EXAMPLE_KEY']);
    expect(byBase('.envrc').keys).toEqual(['ENVRC_KEY', 'ANOTHER_ENVRC']);
    expect(byBase('.dev.vars').keys).toEqual(['WRANGLER_KEY']);
  });

  it('parses secrets.json — top-level + one-level-nested keys', async () => {
    await seed(
      'secrets.json',
      JSON.stringify({
        ANTHROPIC_API_KEY: 'skFAKE_ant-leakDONOTleakXXXXXXXXXXXXXXXXXXXXXXX',
        stripe: {
          STRIPE_SECRET_KEY: 'sktestFAKE_leakDONOTleak1234567890ABCDEFGHIJ',
          STRIPE_WEBHOOK_SECRET: 'whsecFAKE_leakDONOTleak1234567890ABCDEFGHIJ',
        },
      }),
    );
    const out = await readWorkspaceEnv({ workspaces: [workspace] });
    const f = out.files.find((x) => x.path.endsWith('/secrets.json'))!;
    expect(f.keys).toContain('ANTHROPIC_API_KEY');
    expect(f.keys).toContain('stripe');
    expect(f.keys).toContain('stripe.STRIPE_SECRET_KEY');
    expect(f.keys).toContain('stripe.STRIPE_WEBHOOK_SECRET');

    const serialised = JSON.stringify(out);
    expect(serialised).not.toContain('skFAKE_ant-leakDONOTleak');
    expect(serialised).not.toContain('sktestFAKE_leakDONOTleak');
    expect(serialised).not.toContain('whsecFAKE_leakDONOTleak');
  });

  it('parses secrets.yml — top-level + one-level-nested keys', async () => {
    await seed(
      'secrets.yml',
      `database:
  url: postgres://leakuser:leakDONOTleakPASSWORD@db.example.com/heron
  pool_size: 20
slack:
  bot_token: XOXBFAKE_FAKEleakBOT-1234567890-fakefakefakefake
api_key: skFAKE_leakDONOTleakAPIkeyXXXXXXXXXXXXXXXX
`,
    );
    const out = await readWorkspaceEnv({ workspaces: [workspace] });
    const f = out.files.find((x) => x.path.endsWith('/secrets.yml'))!;
    expect(f.keys).toContain('database');
    expect(f.keys).toContain('database.url');
    expect(f.keys).toContain('database.pool_size');
    expect(f.keys).toContain('slack');
    expect(f.keys).toContain('slack.bot_token');
    expect(f.keys).toContain('api_key');

    const serialised = JSON.stringify(out);
    expect(serialised).not.toContain('leakDONOTleakPASSWORD');
    expect(serialised).not.toContain('XOXBFAKE_FAKEleakBOT');
    expect(serialised).not.toContain('skFAKE_leakDONOTleakAPI');
  });

  it('handles quoted + commented + exported shell-env lines', async () => {
    await seed(
      '.env',
      `# leading comment
QUOTED_DOUBLE="value one"
QUOTED_SINGLE='value two'
EXPORTED=bare
export EXPORTED_DOUBLE="value three"
WITH_TRAILING=value # trailing comment
1INVALID=should-not-match
EMPTY=
`,
    );
    const out = await readWorkspaceEnv({ workspaces: [workspace] });
    const f = out.files.find((x) => x.path.endsWith('/.env'))!;
    expect(f.keys).toEqual([
      'QUOTED_DOUBLE',
      'QUOTED_SINGLE',
      'EXPORTED',
      'EXPORTED_DOUBLE',
      'WITH_TRAILING',
      'EMPTY',
    ]);
    expect(f.keys).not.toContain('1INVALID');
  });

  it('handles malformed JSON / YAML gracefully (returns empty keys)', async () => {
    await seed('secrets.json', '{ not valid');
    const out = await readWorkspaceEnv({ workspaces: [workspace] });
    const f = out.files.find((x) => x.path.endsWith('/secrets.json'))!;
    expect(f.keys).toEqual([]);
  });

  it('scans multiple workspaces independently', async () => {
    const second = await mkdtemp(join(tmpdir(), 'heron-aap67-l5-ws2-'));
    try {
      await writeFile(join(workspace, '.env'), 'WORKSPACE_ONE_KEY=v\n');
      await writeFile(join(second, '.env'), 'WORKSPACE_TWO_KEY=v\n');
      const out = await readWorkspaceEnv({ workspaces: [workspace, second] });
      const w1 = out.files.find((f) => f.workspace === workspace && f.path.endsWith('/.env'))!;
      const w2 = out.files.find((f) => f.workspace === second && f.path.endsWith('/.env'))!;
      expect(w1.keys).toEqual(['WORKSPACE_ONE_KEY']);
      expect(w2.keys).toEqual(['WORKSPACE_TWO_KEY']);
    } finally {
      await rm(second, { recursive: true, force: true });
    }
  });

  it('deduplicates duplicate workspaces in input', async () => {
    await seed('.env', 'KEY=v\n');
    const out = await readWorkspaceEnv({ workspaces: [workspace, workspace] });
    // Both workspace hints same dir; the second is skipped.
    const matches = out.files.filter((f) => f.path.endsWith('/.env'));
    expect(matches.length).toBe(1);
  });

  it('deep-grep: NO known fixture secret value ever survives in the serialised output', async () => {
    // The load-bearing invariant: even with multiple file types holding
    // realistic secrets, the serialised reader output must contain ZERO
    // verbatim secret values.
    await seed(
      '.env',
      `AWS_ACCESS_KEY_ID=AKHRNdeepgrepL5ENVVALUE\nSLACK_BOT_TOKEN=XOXBFAKE_deepgrepL5-9999999999-abcdefghijklmnop\n`,
    );
    await seed(
      'secrets.json',
      JSON.stringify({ OPENAI_API_KEY: 'skFAKE_deepgrepL5jsonVALUExxxxxxxxxxxxxxxxx' }),
    );
    await seed(
      '.envrc',
      `export PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\\nMIIdeepgrepL5envrcVALUE\\n-----END PRIVATE KEY-----"\n`,
    );

    const out = await readWorkspaceEnv({ workspaces: [workspace] });
    const serialised = JSON.stringify(out);
    for (const needle of [
      'AKHRNdeepgrepL5ENVVALUE',
      'XOXBFAKE_deepgrepL5-9999999999',
      'skFAKE_deepgrepL5jsonVALUE',
      'MIIdeepgrepL5envrcVALUE',
      'BEGIN PRIVATE KEY',
    ]) {
      expect(serialised).not.toContain(needle);
    }
  });
});
