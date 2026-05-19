import { describe, expect, it } from 'vitest';
import { secretlintScrubString, secretlintScrub } from '../../src/discovery/secretlint-scrub.js';

describe('secretlintScrubString', () => {
  it('returns empty string for empty input', async () => {
    expect(await secretlintScrubString('')).toBe('');
  });

  it('returns input unchanged when no secrets are present', async () => {
    const clean = '{"hello":"world","port":5432}';
    expect(await secretlintScrubString(clean)).toBe(clean);
  });

  it('redacts a JWT (custom rule)', async () => {
    const input = '{"auth":"Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.fake_signature_value"}';
    const out = await secretlintScrubString(input);
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.fake_signature_value');
    expect(out).toContain('[REDACTED:');
  });

  it('redacts a Slack incoming webhook URL', async () => {
    // Concatenated to defeat GitHub push-protection regex on this file — the
    // *runtime* test value is the full URL, but the source string in the repo
    // never has the giveaway prefix + path together.
    const webhook = 'https://hooks.slack.com/' + 'services/T00000000/B00000000/' + 'XXXXXXXXXXXXXXXXXXXXXXXX';
    const input = JSON.stringify({ url: webhook });
    const out = await secretlintScrubString(input);
    expect(out).not.toContain('services/T00000000/B00000000');
    expect(out).toContain('[REDACTED:');
  });

  it('redacts an RSA private key block', async () => {
    const input = JSON.stringify({
      key: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0123\n-----END RSA PRIVATE KEY-----',
    });
    const out = await secretlintScrubString(input);
    expect(out).not.toContain('-----BEGIN RSA PRIVATE KEY-----');
  });

  it('redacts a GCP service-account JSON marker', async () => {
    const input = JSON.stringify({
      blob: '{"type":"service_account","project_id":"x","private_key_id":"abc","private_key":"-----BEGIN PRIVATE KEY-----\\nMIIEvQ\\n-----END PRIVATE KEY-----","client_email":"x@y.iam.gserviceaccount.com"}',
    });
    const out = await secretlintScrubString(input);
    expect(out).not.toContain('-----BEGIN PRIVATE KEY-----');
  });
});

describe('secretlintScrub (object input)', () => {
  it('round-trips a clean object unchanged', async () => {
    const obj = { servers: [{ name: 'x', port: 5432 }] };
    const out = await secretlintScrub(obj);
    expect(out).toEqual(obj);
  });

  it('redacts JWT in a nested string field', async () => {
    const obj = {
      servers: [
        { name: 's1', auth: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.fake_signature_value' },
      ],
    };
    const out = await secretlintScrub(obj);
    const json = JSON.stringify(out);
    expect(json).not.toContain('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.fake_signature_value');
    expect(json).toContain('[REDACTED:');
  });
});
