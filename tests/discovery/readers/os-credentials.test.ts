/**
 * L4 — cross-cutting OS credentials reader tests (AAP-67).
 *
 * The load-bearing invariant: NAMES, never VALUES. Each fixture seeds a
 * realistic credential value into the file and asserts the resulting
 * `OsCredentialFinding.tokens` array carries the identifying NAME
 * (profile, registry, host, helper) and the serialised output never
 * contains the secret value verbatim.
 *
 * We use `mkdtemp` per test so each fixture is hermetic. No shelling out,
 * no real network calls.
 */

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readOsCredentials } from '../../../src/discovery/readers/os-credentials.js';

let home = '';

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'heron-aap67-l4-'));
});
afterEach(async () => {
  if (home) await rm(home, { recursive: true, force: true });
});

async function seed(rel: string, contents: string): Promise<void> {
  const abs = join(home, rel);
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, contents, 'utf8');
}

describe('readOsCredentials — L4 (AAP-67)', () => {
  it('returns empty findings (only scannedPaths) when no files exist', async () => {
    const out = await readOsCredentials({ home });
    expect(out.findings).toEqual([]);
    expect(out.scannedPaths.length).toBe(10);
    expect(out.scannedPaths.every((p) => p.startsWith(home))).toBe(true);
  });

  it('parses ~/.aws/credentials profile names, NEVER aws_secret_access_key', async () => {
    await seed(
      '.aws/credentials',
      `[default]
aws_access_key_id = AKHRNIOSFODNN7EXAMPLE
aws_secret_access_key = HERONfakeJalr/K7MDENG/bPxRfiCYEXAMPLEKEY

[profile prod]
aws_access_key_id = AKHRNI44QH8DHBEXAMPLE
aws_secret_access_key = je7MtGbClwBF/2Zp9Utk/h3yCo8nvbEXAMPLEKEY
`,
    );
    const out = await readOsCredentials({ home });
    const aws = out.findings.find((f) => f.kind === 'aws-credentials')!;
    expect(aws).toBeTruthy();
    expect(aws.tokens.sort()).toEqual(['default', 'prod']);

    const serialised = JSON.stringify(out);
    expect(serialised).not.toContain('AKHRNIOSFODNN7EXAMPLE');
    expect(serialised).not.toContain('HERONfakeJalr');
    expect(serialised).not.toContain('AKHRNI44QH8DHBEXAMPLE');
    expect(serialised).not.toContain('je7MtGbClwBF');
  });

  it('parses ~/.aws/config profile names', async () => {
    await seed('.aws/config', `[default]
region = us-east-1

[profile staging]
region = eu-west-1
`);
    const out = await readOsCredentials({ home });
    const cfg = out.findings.find((f) => f.kind === 'aws-config')!;
    expect(cfg.tokens.sort()).toEqual(['default', 'staging']);
  });

  it('parses ~/.gcloud/application_default_credentials.json — project + type only, no private_key', async () => {
    await seed(
      '.gcloud/application_default_credentials.json',
      JSON.stringify({
        type: 'service_account',
        project_id: 'heron-test-project',
        quota_project_id: 'heron-billing',
        client_email: 'heron-sa@heron-test-project.iam.gserviceaccount.com',
        private_key:
          '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDXXX\n-----END PRIVATE KEY-----\n',
        private_key_id: 'fakekeyid12345',
      }),
    );
    const out = await readOsCredentials({ home });
    const gcp = out.findings.find((f) => f.kind === 'gcloud-adc')!;
    expect(gcp.tokens).toContain('type:service_account');
    expect(gcp.tokens).toContain('project_id:heron-test-project');
    expect(gcp.tokens).toContain('quota_project_id:heron-billing');
    expect(gcp.tokens).toContain('client_email_host:heron-test-project.iam.gserviceaccount.com');

    const serialised = JSON.stringify(out);
    expect(serialised).not.toContain('BEGIN PRIVATE KEY');
    expect(serialised).not.toContain('fakekeyid12345');
    expect(serialised).not.toContain('heron-sa@'); // local-part of email
  });

  it('parses ~/.kube/config cluster + context + user names', async () => {
    await seed(
      '.kube/config',
      `apiVersion: v1
kind: Config
clusters:
- cluster:
    server: https://k8s-prod.example.com
  name: prod-cluster
- cluster:
    server: https://k8s-staging.example.com
  name: staging-cluster
contexts:
- context:
    cluster: prod-cluster
    user: prod-user
  name: prod-ctx
users:
- name: prod-user
  user:
    token: eyJhbGciOiJIUzI1NiJ9.payloadpayloadpayload.SECRETSIGNATURE
- name: staging-user
  user:
    client-certificate-data: BASE64CERTDATAxyzxyzxyz
    client-key-data: BASE64KEYDATAabcabcabc
`,
    );
    const out = await readOsCredentials({ home });
    const k = out.findings.find((f) => f.kind === 'kube-config')!;
    expect(k.tokens).toContain('cluster:prod-cluster');
    expect(k.tokens).toContain('cluster:staging-cluster');
    expect(k.tokens).toContain('context:prod-ctx');
    expect(k.tokens).toContain('user:prod-user');
    expect(k.tokens).toContain('user:staging-user');

    const serialised = JSON.stringify(out);
    expect(serialised).not.toContain('SECRETSIGNATURE');
    expect(serialised).not.toContain('BASE64CERTDATAxyzxyzxyz');
    expect(serialised).not.toContain('BASE64KEYDATAabcabcabc');
  });

  it('parses ~/.docker/config.json auth registry hosts + cred helpers', async () => {
    await seed(
      '.docker/config.json',
      JSON.stringify({
        auths: {
          'index.docker.io': { auth: 'BASE64authBLOB1234' },
          'ghcr.io': { auth: 'BASE64authBLOB5678' },
        },
        credHelpers: {
          'us-docker.pkg.dev': 'gcloud',
        },
        credsStore: 'desktop',
      }),
    );
    const out = await readOsCredentials({ home });
    const d = out.findings.find((f) => f.kind === 'docker-config')!;
    expect(d.tokens).toContain('registry:index.docker.io');
    expect(d.tokens).toContain('registry:ghcr.io');
    expect(d.tokens).toContain('credHelper:us-docker.pkg.dev=gcloud');
    expect(d.tokens).toContain('credsStore:desktop');

    const serialised = JSON.stringify(out);
    expect(serialised).not.toContain('BASE64authBLOB1234');
    expect(serialised).not.toContain('BASE64authBLOB5678');
  });

  it('parses ~/.npmrc registry + scopes, NEVER _authToken values', async () => {
    await seed(
      '.npmrc',
      `registry=https://registry.npmjs.org/
@myorg:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=ghpFAKE_SECRETnpmTOKEN1234567890ABCDEFGHIJ
//registry.npmjs.org/:_authToken=npm_anotherSECRETtoken9876543210
`,
    );
    const out = await readOsCredentials({ home });
    const n = out.findings.find((f) => f.kind === 'npmrc')!;
    expect(n.tokens).toContain('registry:registry.npmjs.org');
    expect(n.tokens).toContain('scope:@myorg=npm.pkg.github.com');
    expect(n.tokens).toContain('auth-host:npm.pkg.github.com');
    expect(n.tokens).toContain('auth-host:registry.npmjs.org');

    const serialised = JSON.stringify(out);
    expect(serialised).not.toContain('ghpFAKE_SECRETnpmTOKEN');
    expect(serialised).not.toContain('npm_anotherSECRETtoken');
  });

  it('parses ~/.pypirc index-servers + repository URLs', async () => {
    await seed(
      '.pypirc',
      `[distutils]
index-servers =
    pypi
    private

[pypi]
username = __token__
password = pypi-SECRETtokenABCDEFG1234567890xyz

[private]
repository = https://pypi.private.example.com/simple/
username = ci
password = ANOTHERsecretPyPIvalue
`,
    );
    const out = await readOsCredentials({ home });
    const p = out.findings.find((f) => f.kind === 'pypirc')!;
    expect(p.tokens).toContain('section:distutils');
    expect(p.tokens).toContain('section:pypi');
    expect(p.tokens).toContain('section:private');
    expect(p.tokens).toContain('repository:private=pypi.private.example.com');

    const serialised = JSON.stringify(out);
    expect(serialised).not.toContain('pypi-SECRETtokenABCDEFG');
    expect(serialised).not.toContain('ANOTHERsecretPyPIvalue');
  });

  it('parses ~/.netrc machine names ONLY, NEVER password lines', async () => {
    await seed(
      '.netrc',
      `machine api.github.com
  login heron-bot
  password ghpFAKE_NETRCsecretSHOULDnotLEAK1234567

machine api.example.com login bot password SUPERsecretNETRCvalueXYZ

default login anonymous password noreply@example.com
`,
    );
    const out = await readOsCredentials({ home });
    const n = out.findings.find((f) => f.kind === 'netrc')!;
    expect(n.tokens).toContain('machine:api.github.com');
    expect(n.tokens).toContain('machine:api.example.com');
    expect(n.tokens).toContain('machine:default');

    const serialised = JSON.stringify(out);
    // Critical: neither the value NOR the bare word `password` as a name
    // ever appears in tokens. The bare word can appear as a label inside
    // the secretlint replacement string, so we only assert against the
    // secret values themselves.
    expect(serialised).not.toContain('ghpFAKE_NETRCsecret');
    expect(serialised).not.toContain('SUPERsecretNETRCvalueXYZ');
    // login names ARE dropped too (defense in depth — they often contain
    // PII / org identifiers).
    expect(serialised).not.toContain('heron-bot');
  });

  it('parses ~/.gitconfig [credential] helpers', async () => {
    await seed(
      '.gitconfig',
      `[user]
  name = Heron Test
  email = test@example.com
[credential]
  helper = osxkeychain
[credential "https://github.com"]
  helper = !gh auth git-credential
[core]
  editor = vim
`,
    );
    const out = await readOsCredentials({ home });
    const g = out.findings.find((f) => f.kind === 'gitconfig')!;
    expect(g.tokens).toContain('credential-default');
    expect(g.tokens).toContain('credential-for:https://github.com');
    expect(g.tokens).toContain('helper:osxkeychain');
    expect(g.tokens).toContain('helper:!gh auth git-credential');
  });

  it('parses ~/.ssh/config Host blocks + IdentityFile paths', async () => {
    await seed(
      '.ssh/config',
      `# Personal hosts
Host github.com gh
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_ed25519_personal

Host prod-bastion
  HostName bastion.prod.example.com
  User admin
  IdentityFile ~/.ssh/id_rsa_prod
  ProxyCommand ssh -W %h:%p jump
`,
    );
    const out = await readOsCredentials({ home });
    const s = out.findings.find((f) => f.kind === 'ssh-config')!;
    expect(s.tokens).toContain('host:github.com');
    expect(s.tokens).toContain('host:gh');
    expect(s.tokens).toContain('host:prod-bastion');
    expect(s.tokens).toContain('identity-file:~/.ssh/id_ed25519_personal');
    expect(s.tokens).toContain('identity-file:~/.ssh/id_rsa_prod');
  });

  it('handles malformed JSON/YAML gracefully (returns finding with empty tokens)', async () => {
    await seed('.docker/config.json', '{ not valid json');
    await seed('.gcloud/application_default_credentials.json', 'not json at all }');
    const out = await readOsCredentials({ home });
    const d = out.findings.find((f) => f.kind === 'docker-config')!;
    expect(d.tokens).toEqual([]);
    const g = out.findings.find((f) => f.kind === 'gcloud-adc')!;
    expect(g.tokens).toEqual([]);
  });

  it('deep-grep: NO known fixture secret pattern ever survives in the serialized output', async () => {
    // Belt-and-braces test: seed multiple files with every secret shape
    // we care about, then assert none of them appear in the serialised
    // findings. This is the load-bearing invariant of the entire L4.
    await seed(
      '.aws/credentials',
      `[default]
aws_access_key_id = AKHRN00000000DEEPGREP
aws_secret_access_key = deepgrep/SECRET/value/should/never/leak/EXAMPLE
`,
    );
    await seed(
      '.netrc',
      `machine api.deepgrep.example.com login bot password DEEPGREPnetrcSECRET\n`,
    );
    await seed(
      '.npmrc',
      `//npm.deepgrep.example.com/:_authToken=DEEPGREPnpmTOKEN999999999999\n`,
    );

    const out = await readOsCredentials({ home });
    const serialised = JSON.stringify(out);
    for (const needle of [
      'AKHRN00000000DEEPGREP',
      'deepgrep/SECRET/value/should/never/leak',
      'DEEPGREPnetrcSECRET',
      'DEEPGREPnpmTOKEN999999',
    ]) {
      expect(serialised).not.toContain(needle);
    }
  });
});
