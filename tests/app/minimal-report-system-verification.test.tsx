/**
 * AAP-126 (S10 of AAP-117) — the systems-table "Verified?" column must show ✓
 * ONLY for genuinely verified systems.
 *
 * THE BUG THIS REPLACES. The old `findingsTouchingSystem` glyph rendered ✓ for
 * ANY system with no VERIFIED finding whose title/description text mentioned the
 * system-id stem. Two dishonesties in a column titled "Verified?":
 *   (1) ✓ showed for systems that were NEVER introspected (gamma / telegram /
 *       wellkid had no OAuth verification yet read as "verified");
 *   (2) the short "google" stem matched findings for EVERY google-* system,
 *       incl. `google-gemini` (no OAuth scopes), so an unrelated finding could
 *       flip an unverified system to ⚠.
 *
 * THE FIX (`systemVerificationStatus`). Drive the glyph from REAL per-system
 * OAuth introspection:
 *   - system maps to a connector (`connectorForSystemId`) AND its OWN declared
 *     scope(s) are all confirmed in that connector's `actualScopes` with no
 *     diff hit                                                  -> ✓ Verified.
 *   - a declared scope appears in the connector's `diffs`       -> ⚠ Discrepancy.
 *   - no declared OAuth scope, or connector not introspected,
 *     or a declared scope is neither confirmed nor flagged      -> "—" Not verified.
 *
 * The matching keys off the SAME shared `canonicalizeScopeToken` the differ /
 * declared baseline use, so a full Google scope URL on the declared side matches
 * the short tokeninfo name on the actual side.
 *
 * TEST INFRA NOTE: this project's vitest setup has no DOM (`renderToStaticMarkup`
 * only). The pure helper is unit-tested directly for every branch; the JSX
 * wiring + legend are pinned with a static-markup render.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';

import MinimalReportView, {
  systemVerificationStatus,
  systemMatchesEnvCredential,
} from '@/components/heron-v1/dashboard/MinimalReportView';

// A minimal system row (only the two fields the helper reads).
function sys(systemId: string, scopesRequested: string[] = []) {
  return { systemId, scopesRequested };
}

describe('systemVerificationStatus (AAP-126)', () => {
  // (a) system whose declared scope is in actualScopes -> ✓
  it('(a) declared scope confirmed in actualScopes -> ✓ Verified', () => {
    const r = systemVerificationStatus(
      sys('google-sheets', ['https://www.googleapis.com/auth/spreadsheets']),
      {
        sources: [
          {
            connector: 'google-workspace',
            verdict: 'verified',
            actualScopes: [{ service: 'google-workspace', scope: 'spreadsheets' }],
            diffs: [],
          },
        ],
      },
    );
    expect(r.state).toBe('verified');
    expect(r.glyph).toBe('✓');
    expect(r.color).toBe('#15803d');
    expect(r.title.toLowerCase()).toContain('verified against oauth introspection');
  });

  it('(a2) ✓ requires EVERY declared scope confirmed — one unconfirmed -> "—"', () => {
    const r = systemVerificationStatus(
      sys('google-sheets', ['spreadsheets', 'drive']),
      {
        sources: [
          {
            connector: 'google-workspace',
            verdict: 'verified',
            // only `spreadsheets` confirmed; `drive` neither confirmed nor flagged.
            actualScopes: [{ service: 'google-workspace', scope: 'spreadsheets' }],
            diffs: [],
          },
        ],
      },
    );
    expect(r.state).toBe('unverified');
    expect(r.glyph).toBe('—');
  });

  // (b) system whose declared scope is in diffs -> ⚠
  it('(b) declared scope appears in diffs (missing) -> ⚠ Discrepancy', () => {
    const r = systemVerificationStatus(
      sys('google-sheets', ['spreadsheets']),
      {
        sources: [
          {
            connector: 'google-workspace',
            verdict: 'discrepancy',
            actualScopes: [],
            diffs: [{ kind: 'missing', service: 'google-workspace', scope: 'spreadsheets' }],
          },
        ],
      },
    );
    expect(r.state).toBe('discrepancy');
    expect(r.glyph).toBe('⚠');
    expect(r.color).toBe('#c2410c');
    expect(r.title.toLowerCase()).toContain('discrepancy');
  });

  it('(b2) declared scope appears in diffs as an EXTRA (stored-blob shape) -> ⚠', () => {
    // On the stored session blob the declared baseline was [], so every grant is
    // an `extra`. A google-sheets system that declares `spreadsheets` matches the
    // `extra` -> ⚠ (this is the documented behavior on the baked report.json).
    const r = systemVerificationStatus(
      sys('google-sheets', ['https://www.googleapis.com/auth/spreadsheets']),
      {
        sources: [
          {
            connector: 'google-workspace',
            verdict: 'discrepancy',
            actualScopes: [{ service: 'google-workspace', scope: 'spreadsheets' }],
            diffs: [{ kind: 'extra', service: 'google-workspace', scope: 'spreadsheets' }],
          },
        ],
      },
    );
    expect(r.glyph).toBe('⚠');
  });

  // (c) system with no scopes -> "—"
  it('(c) system with NO declared scopes -> "—" Not verified (not ✓)', () => {
    const r = systemVerificationStatus(sys('greenhouse', []), {
      sources: [
        {
          connector: 'greenhouse',
          verdict: 'verified',
          actualScopes: [{ service: 'greenhouse', scope: 'candidates:read' }],
          diffs: [],
        },
      ],
    });
    expect(r.state).toBe('unverified');
    expect(r.glyph).toBe('—');
    expect(r.color).toBe('#a1a1aa');
  });

  // (d) a google-* system with NO scopes (gemini-shaped) -> "—", NOT ✓
  it('(d) google-gemini (google-* stem) with NO scopes -> "—", NOT ✓', () => {
    const r = systemVerificationStatus(sys('google-gemini', []), {
      sources: [
        {
          connector: 'google-workspace',
          verdict: 'verified',
          actualScopes: [{ service: 'google-workspace', scope: 'spreadsheets' }],
          diffs: [],
        },
      ],
    });
    expect(r.state).toBe('unverified');
    expect(r.glyph).toBe('—');
    // The old finding-text overmatch would have flipped this to ✓ (no finding)
    // or ⚠ (any "google" finding). Both are wrong; it must be "—".
    expect(r.glyph).not.toBe('✓');
    expect(r.glyph).not.toBe('⚠');
  });

  it('non-OAuth system (no connector) -> "—" even with scopes declared', () => {
    const r = systemVerificationStatus(sys('telegram-bot', ['send_message']), {
      sources: [
        { connector: 'google-workspace', verdict: 'verified', actualScopes: [], diffs: [] },
      ],
    });
    expect(r.glyph).toBe('—');
  });

  it('connector present but NOT introspected (no matching source) -> "—"', () => {
    const r = systemVerificationStatus(sys('greenhouse', ['candidates:read']), {
      // only google-workspace was introspected; greenhouse was not.
      sources: [
        { connector: 'google-workspace', verdict: 'verified', actualScopes: [], diffs: [] },
      ],
    });
    expect(r.glyph).toBe('—');
  });

  it('no oauthScopeVerification at all -> "—"', () => {
    expect(systemVerificationStatus(sys('google-sheets', ['spreadsheets']), undefined).glyph).toBe(
      '—',
    );
    expect(
      systemVerificationStatus(sys('google-sheets', ['spreadsheets']), { sources: [] }).glyph,
    ).toBe('—');
  });

  it('discrepancy takes precedence over a confirmed scope on the same system', () => {
    // System declares two scopes: one confirmed, one flagged as a diff. The diff
    // hit wins -> ⚠ (we surface the problem, not a partial ✓).
    const r = systemVerificationStatus(sys('google-sheets', ['spreadsheets', 'drive']), {
      sources: [
        {
          connector: 'google-workspace',
          verdict: 'discrepancy',
          actualScopes: [{ service: 'google-workspace', scope: 'spreadsheets' }],
          diffs: [{ kind: 'extra', service: 'google-workspace', scope: 'drive' }],
        },
      ],
    });
    expect(r.glyph).toBe('⚠');
  });
});

// ── T3 (D3): 🔑 "Found in .env" — env-credential brand-stem matcher ───────
//
// Systems whose credential lives in `.env` (API key / bot token, no OAuth scope
// to introspect) deserve better than a bare "—". `systemMatchesEnvCredential`
// is the deterministic, conservative brand-stem matcher that links a systemId to
// an env VARIABLE NAME (e.g. `openai` ↔ `OPENAI_API_KEY`). It tokenizes the
// systemId on `-`/`_` and checks whether any env key name contains a matching
// brand token (case-insensitive), mirroring `connectorForSystemId`'s discipline.

describe('systemMatchesEnvCredential (T3) — brand-stem matcher', () => {
  const keys = [
    'OPENAI_API_KEY',
    'OPENAI_MODEL',
    'GOOGLE_API_KEY',
    'GEMINI_MODEL',
    'GAMMA_API_KEY',
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_CHAT_ID',
    'LMS_API_KEY',
  ];

  it('openai ↔ OPENAI_API_KEY', () => {
    expect(systemMatchesEnvCredential('openai', keys)).toBe(true);
  });

  it('telegram-bot ↔ TELEGRAM_BOT_TOKEN (token-split systemId)', () => {
    expect(systemMatchesEnvCredential('telegram-bot', keys)).toBe(true);
  });

  it('gamma ↔ GAMMA_API_KEY', () => {
    expect(systemMatchesEnvCredential('gamma', keys)).toBe(true);
  });

  it('google-gemini ↔ GOOGLE_API_KEY (google token matches)', () => {
    expect(systemMatchesEnvCredential('google-gemini', keys)).toBe(true);
  });

  it('google-gemini ↔ GEMINI_MODEL (gemini token matches even without google key)', () => {
    expect(systemMatchesEnvCredential('google-gemini', ['GEMINI_MODEL'])).toBe(true);
  });

  it('DOCUMENTED MISS: wellkid is backed by LMS_API_KEY — env name carries no brand, so no match', () => {
    // Best-effort behavior: the matcher cannot link `wellkid` to `LMS_API_KEY`
    // because the env name carries no "wellkid" brand token. `wellkid` stays "—".
    expect(systemMatchesEnvCredential('wellkid', keys)).toBe(false);
  });

  it('conservative: no random-substring matches', () => {
    // A short stem must be a real TOKEN match, not a substring of a larger word.
    // `gem` must not match `GEMINI_MODEL`; `lms` is a real token in `LMS_API_KEY`.
    expect(systemMatchesEnvCredential('gem', keys)).toBe(false);
    expect(systemMatchesEnvCredential('open', keys)).toBe(false);
    // very short tokens (<= 2 chars) never match — too generic to be a brand.
    expect(systemMatchesEnvCredential('ai', keys)).toBe(false);
  });

  it('empty / blank systemId and empty keys -> false', () => {
    expect(systemMatchesEnvCredential('', keys)).toBe(false);
    expect(systemMatchesEnvCredential('   ', keys)).toBe(false);
    expect(systemMatchesEnvCredential('openai', [])).toBe(false);
  });
});

// ── T3 (D3): gated 🔑 in systemVerificationStatus ─────────────────────────
//
// 🔑 shows ONLY when ALL of: (a) the system is NOT OAuth-verifiable (no
// connector, OR maps to a connector but declares no OAuth scope), and (b) a
// `.env` key matches per the matcher. A real OAuth verdict (✓/⚠) always wins.

describe('systemVerificationStatus 🔑 env-credential branch (T3)', () => {
  const envKeys = ['OPENAI_API_KEY', 'GAMMA_API_KEY', 'TELEGRAM_BOT_TOKEN', 'GOOGLE_API_KEY', 'GEMINI_MODEL', 'LMS_API_KEY'];

  it('telegram-bot (no connector) + TELEGRAM_BOT_TOKEN -> 🔑', () => {
    const r = systemVerificationStatus(sys('telegram-bot', ['getMe', 'sendMessage']), undefined, envKeys);
    expect(r.state).toBe('env-credential');
    expect(r.glyph).toBe('🔑');
    expect(r.color).toBe('#2563eb');
    expect(r.title.toLowerCase()).toContain('found in .env');
  });

  it('gamma (no connector) + GAMMA_API_KEY -> 🔑', () => {
    const r = systemVerificationStatus(sys('gamma', []), undefined, envKeys);
    expect(r.glyph).toBe('🔑');
  });

  it('google-gemini (maps to google-workspace by prefix BUT empty scopesRequested) + GOOGLE_API_KEY -> 🔑', () => {
    // google-gemini is the deliberate include: it maps to the google-workspace
    // connector by prefix yet declares NO OAuth scope, so it is not introspectable
    // and falls through to the env-credential path.
    const r = systemVerificationStatus(sys('google-gemini', []), {
      sources: [
        { connector: 'google-workspace', verdict: 'discrepancy', actualScopes: [{ service: 'google-workspace', scope: 'spreadsheets' }], diffs: [] },
      ],
    }, envKeys);
    expect(r.glyph).toBe('🔑');
  });

  it('google-sheets WITH declared scopes is an OAuth system — NEVER 🔑 even if a google env key exists', () => {
    // (a) excludes google-sheets: it maps to google-workspace AND declares a real
    // scope. A failed/partial introspection keeps it "—", never 🔑.
    const r = systemVerificationStatus(
      sys('google-sheets', ['https://www.googleapis.com/auth/spreadsheets']),
      { sources: [{ connector: 'google-workspace', verdict: 'verified', actualScopes: [], diffs: [] }] },
      envKeys,
    );
    expect(r.glyph).toBe('—');
    expect(r.glyph).not.toBe('🔑');
  });

  it('a real OAuth ✓ is never overridden by 🔑', () => {
    // google-sheets confirmed by introspection -> ✓ stays ✓ (OAuth path wins).
    const r = systemVerificationStatus(
      sys('google-sheets', ['https://www.googleapis.com/auth/spreadsheets']),
      { sources: [{ connector: 'google-workspace', verdict: 'verified', actualScopes: [{ service: 'google-workspace', scope: 'spreadsheets' }], diffs: [] }] },
      envKeys,
    );
    expect(r.glyph).toBe('✓');
  });

  it('a real OAuth ⚠ is never overridden by 🔑', () => {
    const r = systemVerificationStatus(
      sys('google-sheets', ['spreadsheets']),
      { sources: [{ connector: 'google-workspace', verdict: 'discrepancy', actualScopes: [], diffs: [{ kind: 'missing', service: 'google-workspace', scope: 'spreadsheets' }] }] },
      envKeys,
    );
    expect(r.glyph).toBe('⚠');
  });

  it('DOCUMENTED MISS: wellkid (no connector, empty scopes) + LMS_API_KEY -> stays "—" (matcher cannot link)', () => {
    const r = systemVerificationStatus(sys('wellkid', []), undefined, envKeys);
    expect(r.glyph).toBe('—');
  });

  it('no env keys passed -> behaves exactly as before (telegram-bot -> "—")', () => {
    expect(systemVerificationStatus(sys('telegram-bot', ['sendMessage']), undefined).glyph).toBe('—');
    expect(systemVerificationStatus(sys('telegram-bot', ['sendMessage']), undefined, []).glyph).toBe('—');
  });

  it('env key present but no brand match -> "—" (no row, no false 🔑)', () => {
    // a non-OAuth system with no matching env key stays "—".
    const r = systemVerificationStatus(sys('notion', []), undefined, envKeys);
    expect(r.glyph).toBe('—');
  });
});

// ── Integration: rendered systems table + legend (static markup) ─────────
//
// A google-sheets system that declares `spreadsheets`, plus a gemini-shaped
// `google-gemini` with no scopes, against a discrepancy introspection result
// (the stored-blob shape). The sheets row must render ⚠, gemini "—", and the
// legend must explain all three glyphs.

const report = {
  agentPurpose: 'Pipeline.',
  summary: 'Demo.',
  verification: { status: 'partially-verified' as const },
  systems: [
    {
      systemId: 'google-sheets-api',
      scopesRequested: ['https://www.googleapis.com/auth/spreadsheets'],
      scopesNeeded: [],
      scopesDelta: [],
      dataSensitivity: 'Names.',
      blastRadius: 'org-wide',
      frequencyAndVolume: '',
      writeOperations: [],
    },
    {
      systemId: 'google-gemini',
      scopesRequested: [],
      scopesNeeded: [],
      scopesDelta: [],
      dataSensitivity: 'None.',
      blastRadius: 'single-user',
      frequencyAndVolume: '',
      writeOperations: [],
    },
    {
      systemId: 'telegram-bot',
      scopesRequested: ['getMe', 'sendMessage'],
      scopesNeeded: [],
      scopesDelta: [],
      dataSensitivity: 'None.',
      blastRadius: 'single-user',
      frequencyAndVolume: '',
      writeOperations: [],
    },
  ],
  // T3: env-credential evidence — telegram-bot's bot token lives in `.env`, so it
  // resolves to 🔑 ("Found in .env"); google-gemini matches GOOGLE_API_KEY too.
  localAgentDiscovery: {
    agents: [],
    findings: [],
    scannedAt: '2026-06-02T00:00:00.000Z',
    scannedPaths: ['/ws'],
    workspaceEnv: [
      {
        path: '/ws/.env',
        workspace: '/ws',
        keys: ['GOOGLE_API_KEY', 'GEMINI_MODEL', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'],
      },
    ],
  },
  oauthScopeVerification: {
    capturedAt: '2026-06-02T00:00:00.000Z',
    sources: [
      {
        connector: 'google-workspace',
        verdict: 'discrepancy',
        actualScopes: [{ service: 'google-workspace', scope: 'spreadsheets' }],
        diffs: [{ kind: 'extra' as const, service: 'google-workspace', scope: 'spreadsheets', severity: 'medium' as const }],
      },
    ],
  },
  verdict: {
    status: 'partial' as const,
    posture: 4,
    postureBand: 'low' as const,
    findings: [],
    hostCapabilities: [],
  },
};

function render(reportJson: unknown): string {
  return renderToStaticMarkup(
    <MinimalReportView
      reportJson={reportJson as Parameters<typeof MinimalReportView>[0]['reportJson']}
      runtimeAgentName="Demo"
    />,
  );
}

describe('MinimalReportView "Verified?" wiring + legend (AAP-126)', () => {
  it('renders both glyphs and the three-state legend', () => {
    const html = render(report);
    // Both glyphs present in the rendered table.
    expect(html).toContain('⚠');
    expect(html).toContain('—');
    // Legend explains each state.
    expect(html).toContain('Verified against OAuth introspection');
    expect(html).toContain('Scope discrepancy');
    expect(html).toContain('No deterministic verification');
  });

  it('T3: renders 🔑 for the telegram-bot row (token found in .env) and the legend entry', () => {
    const html = render(report);
    // telegram-bot's bot token is in workspaceEnv.keys -> 🔑.
    expect(html).toContain('🔑');
    // Legend explains the new state.
    expect(html).toContain('Found in .env');
  });

  it('does not render the old finding-touch tooltip copy', () => {
    const html = render(report);
    expect(html).not.toContain('verified finding(s) touch this system');
    expect(html).not.toContain('No verified discrepancies for this system');
  });
});

// ── (e) guard: no remaining `findingsTouchingSystem` references in source ──
//
// The old token-overmatch helper (and its `escapeRegex` companion) are deleted.
// This guard reads the component source and asserts neither name survives in
// CODE — a defensive net so a future edit cannot silently reintroduce the
// dishonest glyph path. (The string appears once in an explanatory comment;
// we assert there is no `function findingsTouchingSystem` / `escapeRegex`.)

describe('AAP-126 (e): findingsTouchingSystem / escapeRegex are gone', () => {
  it('no function definition or call survives in MinimalReportView source', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../components/heron-v1/dashboard/MinimalReportView.tsx', import.meta.url)),
      'utf8',
    );
    expect(src).not.toContain('function findingsTouchingSystem');
    expect(src).not.toContain('findingsTouchingSystem(');
    expect(src).not.toContain('function escapeRegex');
    expect(src).not.toContain('escapeRegex(');
  });
});
