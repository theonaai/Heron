<p align="center">
  <img src=".github/heron-logo.svg" alt="Heron" width="80" />
</p>

<h1 align="center">Heron</h1>

<p align="center">
  <strong>Open-source AI agent auditor</strong><br />
  Know what your AI agents actually access before they go to production.
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> &bull;
  <a href="#how-it-works">How It Works</a> &bull;
  <a href="#example-report">Example Report</a> &bull;
  <a href="#use-cases">Use Cases</a>
</p>

<p align="center">
  <img src=".github/heron-demo.gif" alt="Heron demo" width="800" />
</p>

<p align="center">
  <strong>Watch the full demo (2 min) &rarr;</strong> <a href="https://youtu.be/Gk2MP9qsCLY">YouTube</a>
</p>

---

## Why I built this

Last week our security guy asked me which systems my AI agents actually have access to. I didn't have a good answer. So I built Heron &mdash; now he can ask the agent himself.

The alternative to Heron is a Google Doc that nobody updates. The doc is wrong the day it's written, because the agent's permissions evolve and nobody goes back to fix the doc.

Heron interviews the agent directly. The agent answers about itself &mdash; what systems it touches, what data it handles, what permissions it has, what happens when something goes wrong. You get a structured audit report with risk scoring, findings, and a permissions delta showing what the agent has versus what it actually needs.

I tested it on a real content pipeline agent. Heron found **9 connected systems**, **1 critical issue** (an unauthenticated local HTTP worker), **4 high-severity findings**, and **2 scopes that can be safely revoked right now**. Total time: about 5 minutes from one command.

No SDK integration. No code changes to the agent. Works with any agent that speaks the OpenAI API.

Try it: `npx heron-ai`

```
┌──────────┐         ┌──────────────┐         ┌──────────────┐
│          │         │              │         │              │
│  Agent   │────────>│    Heron     │────────>│ Audit Report │
│          │         │              │         │              │
│          │<────────│  Structured  │         │  Findings    │
└──────────┘         │  Interview   │         │  Systems     │
                     │  (10 core +  │         │  Regulatory  │
                     │  follow-ups) │         │  Verdict     │
                     └──────────────┘         └──────────────┘
```

## Who this is for

**Security engineers approving agent deployments.** Your dev team wants to ship a new agent. You need to know what it touches before you sign off. Run `npx heron-ai`, get a structured report with findings, risk score, and a permissions delta. Faster than a Google Doc, harder to fake than a verbal walkthrough.

**Platform and DevOps leads inheriting agents from other teams.** You just got handed three agents from a team that left. You don't know what they do. Heron interviews them in about 5 minutes and tells you which production systems they touch and which OAuth scopes they hold. Map your blast radius before you have to defend it.

**Compliance and audit teams preparing evidence packages.** Heron generates regulator-ready reports with EU AI Act, GDPR, SOC 2, and UK GDPR mappings &mdash; based on what the agent actually does, not a generic checklist. Attach to your control evidence.

**Founders and tech leads asked "is this safe?" by a customer.** You're selling an AI feature into a regulated buyer. They ask for an access review. You don't have one. Heron gives you a structured artifact you can hand them in 5 minutes instead of writing one from scratch.

## Quick Start

Three ways to use Heron, depending on your setup.

### Option 1: Local CLI (open source)

One command. No install, no config, no env vars. The CLI prompts for your LLM API key on first run.

```bash
npx heron-ai
```

An interactive menu lets you choose between two modes:

```
  Heron — AI Agent Auditor

  > Start server    agents connect to you
    Scan an agent   you connect to an agent
```

#### Mode A: Server (`heron-ai serve`)

Heron runs locally and waits for agents to connect. Two ways to point your agent at it:

**1) Paste a prompt into your agent's chat** &mdash; works with any agent

```
I need you to complete a security access review for this project.
Make sequential API calls to the Heron endpoint until it says "Interview complete".

Step 1 — Start the interview:
POST http://localhost:3700/v1/chat/completions
Body: {"model":"any","messages":[{"role":"user","content":"Hi, I am ready to answer questions about this project."}]}

The response will contain a question and a session ID (in the "heron_session_id" JSON field).

Step 2 — Send each answer:
POST http://localhost:3700/v1/chat/completions
Body: {"model":"any","messages":[{"role":"user","content":"YOUR ANSWER HERE"}],"heron_session_id":"SESSION_ID_FROM_STEP_1"}

Step 3 — Repeat step 2 until the response says "Interview complete".

Important: answer about THIS specific project — what you actually do, what systems
you connect to, what data you handle. Not general capabilities. Never reveal actual
secret values — just describe credential types.
```

**2) Override `OPENAI_BASE_URL`** &mdash; zero code changes to the agent

```bash
OPENAI_BASE_URL=http://localhost:3700/v1 python your_agent.py
```

The agent thinks it's talking to GPT. Heron intercepts, runs the interview, generates the report.

#### Mode B: Scan (`heron-ai scan`)

Heron connects directly to your agent's chat API and runs the interview itself.

```bash
npx heron-ai scan --target http://your-agent/v1/chat/completions
```

#### Mode C: Scan an MCP server (`heron-ai scan --mcp`)

If your agent exposes its tools through an MCP server, Heron can connect to the server directly and emit a tool-inventory report — what the server declares it can do, with input schemas and behavior hints (`readOnlyHint`, `destructiveHint`, …) preserved verbatim. Useful as Source #1 for declared-vs-actual scope verification.

Three input shapes for the `--mcp` flag:

```bash
# 1) HTTP(s) MCP server. Bearer token (optional) from HERON_MCP_BEARER env var.
heron-ai scan --mcp https://example.com/mcp

# 2) Stdio server, shorthand. Command and args after stdio:
heron-ai scan --mcp 'stdio:node ./my-mcp-server.js'

# 3) Full JSON config — supports env vars, cwd, explicit bearer tokens.
heron-ai scan --mcp '{"kind":"stdio","command":"node","args":["server.js"]}'
heron-ai scan --mcp '{"kind":"http","url":"https://example.com/mcp","bearerToken":"sk-..."}'
```

The report is written to `./reports/mcp-scan_<id>.md` (Markdown, default), or `.json` with `-f json`, or `.html` with `-f html`.

The `-f html` output is a self-contained, SOC-style HTML document — cover with PASSED/PARTIAL/FAILED verdict + compliance score, numbered table of contents, executive summary, agent specification, verification results with score bar, framework mapping grouped by AIUC-1 / EU AI Act / GDPR / NIST AI RMF, optional HR vertical signals section, optional approval audit trail, conclusion, and appendix tool/scope inventory. CSS and favicon are inlined so the file works opened directly from disk (e.g. as a DPO email attachment); the only external resource is the Google Fonts stylesheet for the typography stack, which degrades gracefully to a system stack when unreachable. The same renderer powers `/scans/:id` when you run `heron-ai serve`.

The MCP transport config shape (`MCPTransportConfig`) is locked in `src/connectors/mcp-types.ts` — both this client and the `heron mcp-serve` mode (below) consume the same types so the verification engine downstream sees one shape.

##### Verification: declared vs actual (`--verify`)

Add `--verify=mcp-tools` to compare the tools the MCP server actually exposes against a declared inventory you supply (typically extracted from an interrogation transcript). The Markdown report grows a **Verification** section listing extra, missing, or mismatched tools with default severity (extras `HIGH`, missing `MEDIUM`, mismatches `HIGH`).

```bash
heron-ai scan \
  --mcp '{"kind":"stdio","command":"node","args":["my-server.js"]}' \
  --verify mcp-tools \
  --declared-tools 'lookup_candidate,send_reply,schedule_meeting' \
  --agent-label 'hr-agent-pilot' \
  --report-dir ./reports
```

The per-source verdict is one of three states — always be explicit which one fired:

| Verdict | Meaning |
| --- | --- |
| **Verified** | The source read succeeded and the declared inventory matches the actual inventory exactly. |
| **Discrepancy** | The source read succeeded but at least one diff surfaced (extra capability, missing capability, or mismatched details). |
| **Unverified** | The source could not be read (auth failure, unreachable, timeout, malformed config). We cannot make a claim either way — the report says so. |

Each verification report also grows a **Compliance Framework Mapping** section that translates the diff + approval-chain signals into per-control verdicts against AIUC-1 (A003, B006, D003, E004, E015), EU AI Act (Annex III §4, Article 14, Article 12), GDPR (Article 22, Article 5(1)(c)), and NIST AI RMF (MEASURE, MANAGE). Detectors are pure functions over the verification signals — no live regulatory data ingest, no LLM. Set `HERON_FRAMEWORK_MAPPING_DISABLED=true` to opt out.

##### Declared source: structured config (`--declared-source`)

For pilots the declared baseline outgrows a comma-separated CLI flag pretty quickly — you want declared tools AND scopes in one place, plus agent metadata (name, purpose, owner). Use `--declared-source` to point at a JSON config file:

```bash
heron-ai scan \
  --mcp '{"kind":"stdio","command":"node","args":["my-server.js"]}' \
  --verify mcp-tools,oauth-scopes:greenhouse \
  --declared-source file:./heron-declared.json \
  --agent-label 'hr-agent-pilot' \
  --report-dir ./reports
```

Expected file shape (JSON):

```json
{
  "agent": {
    "name": "Recruiter Outreach Agent",
    "purpose": "Sources candidates, schedules interviews, sends offers.",
    "owner": "Talent Acquisition Team",
    "version": "1.0.0"
  },
  "declared": {
    "tools": [
      { "name": "list_candidates", "description": "Read candidate pipeline" },
      { "name": "send_email" }
    ],
    "scopes": [
      { "service": "google-workspace", "scope": "gmail.send" },
      { "service": "greenhouse", "scope": "candidates:read" }
    ]
  }
}
```

Notes:

- v1 is **JSON-only**. YAML support is intentionally deferred — adding a YAML parser brings a parser surface with historical CVEs and we want to keep the dependency footprint flat.
- File size capped at **1 MiB**; tools / scopes arrays capped at **256 each**.
- Path is resolved to absolute form; raw input with `..` segments is rejected.
- Set `HERON_DECLARED_SOURCE_CWD_ONLY=true` in hosted / sandbox deployments to restrict reads to subpaths of the current working directory.
- All owner-supplied strings pass through the same control-char strip (`stripControlChars`) as the actual side — a hostile declaration file cannot break the rendered Markdown.

A second backend, **`theona-mcp:<agentId>`**, is scaffolded to read declared scope from Theona's platform. v1 of this backend is an **honest stub**: it validates the config (agent ID shape, optional bearer-token length / hygiene, optional `theonaApiBaseUrl` via the same SSRF guard the rest of Heron uses) and returns `not_implemented` cleanly. It deliberately does NOT return an empty inventory — a phantom-clean "Verified" report against a missing declared baseline would be worse than no verification at all. When the Theona agent-metadata endpoint is published, the v2 fetch swap is local to `src/verification/sources/agent-declaration/theona-mcp.ts`; the config surface, the security defences, and the error vocabulary stay the same.

When both `--declared-source` and `--declared-tools` are set, `--declared-source` wins and the legacy flag is dropped with a warning printed to the operator.

##### Verification: OAuth scopes (Greenhouse)

The `oauth-scopes:greenhouse` source determines what an agent's Greenhouse Harvest API key can actually read by probing a small set of read-only endpoints (`users/me`, `jobs`, `candidates`, `applications`). Each probe that returns 2xx becomes one `{service: greenhouse, scope: <name>:read}` entry; 401/403 means the key does not have that scope. The Verification section then diffs the observed scope set against the scopes you declared.

```bash
# REQUIRED — pass the API key via env, never CLI args.
export HERON_GREENHOUSE_API_KEY="<your-harvest-api-key>"

heron-ai scan \
  --mcp '{"kind":"stdio","command":"node","args":["my-server.js"]}' \
  --verify oauth-scopes:greenhouse \
  --agent-label 'hr-agent-pilot' \
  --report-dir ./reports
```

Combine with `mcp-tools` to verify tools and scopes in one pass:

```bash
heron-ai scan \
  --mcp '{"kind":"stdio","command":"node","args":["my-server.js"]}' \
  --verify mcp-tools,oauth-scopes:greenhouse \
  --declared-tools 'lookup_candidate,send_reply' \
  --agent-label 'hr-agent-pilot'
```

**Credentials handling — read this before you run it against production.**

- The Greenhouse API key is read from `HERON_GREENHOUSE_API_KEY` only. There is intentionally no CLI flag — argv is visible to other processes on the same host via `ps`, and shell history persists it to disk. Set the env var inline for a single invocation, or source it from a secrets manager.
- The connector NEVER logs, echoes, or surfaces the key. Error messages, partial-read warnings, and the rendered Markdown report are scrubbed of both the raw key and its base64-encoded Basic-Auth form.
- Only READ probes are issued. The connector never writes to a Greenhouse tenant. A future opt-in `--probe-writes` flag is tracked for staging-only use.
- Default base URL is hardcoded to `https://harvest.greenhouse.io/v1/`. The `HERON_GREENHOUSE_BASE_URL` env var lets you point the connector at a local proxy for testing — that path is gated by the same SSRF check (`validateTargetEndpoint`) that protects the audit-agent target endpoint, so it cannot be abused to hit cloud-metadata or RFC1918 hosts.

**What the probes cover today.**

| Scope emitted | Probe endpoint | Notes |
| --- | --- | --- |
| `me:read` | `GET /v1/users/me` | Baseline auth check. 401 here → whole read is `unauthorized`. |
| `jobs:read` | `GET /v1/jobs?per_page=1` | |
| `candidates:read` | `GET /v1/candidates?per_page=1` | |
| `applications:read` | `GET /v1/applications?per_page=1` | |

A probe that returns 5xx or times out leaves its scope absent and surfaces a warning so the auditor knows the read was partial — better than silently claiming a scope is missing.

Out of scope for this PR (follow-ups): the `agent-declaration` source (git + Theona MCP backends). Workday and Lever connectors are deferred to v1.1.

##### Verification: OAuth scopes (BambooHR)

The `oauth-scopes:bamboohr` source mirrors the Greenhouse model for the HR vertical: it probes a small set of read-only BambooHR v1 API endpoints to discover which scopes a given API key actually has, then diffs the observed set against the scopes you declared. BambooHR has no scope-introspection endpoint, so grants are inferred by probe response: 2xx → granted, 401/403 → not granted, 5xx / timeout / 3xx → omitted with a partial-read warning.

BambooHR is multi-tenant — every URL contains your customer subdomain, e.g. `https://api.bamboohr.com/api/gateway.php/<subdomain>/v1/...`. Both the API key and the subdomain are required.

```bash
# REQUIRED — pass credentials via env, never CLI args.
export HERON_BAMBOOHR_API_KEY="<your-bamboohr-api-key>"
export HERON_BAMBOOHR_SUBDOMAIN="<your-bamboohr-subdomain>"   # e.g. "acme" for acme.bamboohr.com

heron-ai scan \
  --mcp '{"kind":"stdio","command":"node","args":["my-server.js"]}' \
  --verify oauth-scopes:bamboohr \
  --agent-label 'hr-agent-bamboohr-pilot' \
  --report-dir ./reports
```

Combine with `mcp-tools` (and other OAuth connectors) in one pass:

```bash
heron-ai scan \
  --mcp '{"kind":"stdio","command":"node","args":["my-server.js"]}' \
  --verify mcp-tools,oauth-scopes:bamboohr \
  --declared-tools 'lookup_employee,send_reply' \
  --agent-label 'hr-agent-bamboohr-pilot'
```

**Credentials handling — read this before you run it against production.**

- Both `HERON_BAMBOOHR_API_KEY` and `HERON_BAMBOOHR_SUBDOMAIN` come from the environment only. There is intentionally no CLI flag for either — argv is visible to other processes via `ps`, and shell history persists.
- The connector NEVER logs, echoes, or surfaces the API key. Error messages, partial-read warnings, and the rendered report are scrubbed for both the raw key and its base64-encoded Basic-Auth form (BambooHR uses `<apiKey>:x` — the literal `'x'` is the documented "no password" stand-in).
- The subdomain is validated for DNS-label shape (letters / digits / hyphens, ≤63 chars) BEFORE any HTTP call — a stray `/` cannot smuggle extra path segments into the base URL.
- Only READ probes are issued. The connector never writes to a BambooHR tenant.
- Default base URL is hardcoded to `https://api.bamboohr.com/api/gateway.php`. The `HERON_BAMBOOHR_BASE_URL` env var lets you point the connector at a local proxy for testing — that path is gated by the same SSRF check (`validateTargetEndpoint`) that protects the audit-agent target endpoint, so it cannot be abused to hit cloud-metadata or RFC1918 hosts.

**What the probes cover today.**

| Scope emitted | Probe endpoint | Notes |
| --- | --- | --- |
| `directory:read` | `GET /v1/employees/directory` | Baseline auth check. 401/403 here → whole read is `unauthorized`. |
| `employees:read` | `GET /v1/employees/1?fields=firstName,lastName` | Probes per-employee read scope; minimal field set keeps response tiny. |
| `reports:read` | `GET /v1/reports?format=json` | |
| `admin:users:read` | `GET /v1/meta/users` | Surfaces whether the key is an account-administrator key. |
| `meta:fields:read` | `GET /v1/meta/fields` | Requires field-edit access. |

A probe that returns 5xx, times out, or returns 3xx (the redirect-handling guard treats 3xx as a probe failure to prevent credential leakage via redirect chains) surfaces a warning, leaving its scope absent — better than silently claiming the scope is missing.

##### Verification: OAuth scopes (Google Workspace)

The `oauth-scopes:google-workspace` source differs from Greenhouse / BambooHR: Google OAuth 2.0 exposes a real scope-introspection endpoint at `https://oauth2.googleapis.com/tokeninfo`, so the connector calls it directly instead of probing per-service endpoints. One HTTP call returns the full granted scope list — no inference, no partial-read warnings.

Two auth modes, selected automatically from environment:

- **Mode A — access_token.** Set `HERON_GOOGLE_ACCESS_TOKEN` to a fresh OAuth 2.0 access token. The connector calls `tokeninfo` directly. Simpler, but requires you to mint a fresh token (Google access tokens expire in ~1 hour).
- **Mode B — refresh_token + client credentials.** Set `HERON_GOOGLE_REFRESH_TOKEN`, `HERON_GOOGLE_CLIENT_ID`, and `HERON_GOOGLE_CLIENT_SECRET`. The connector exchanges the refresh token for a fresh access token at `oauth2.googleapis.com/token` first, then calls `tokeninfo`. Pairs well with long-lived audit cron jobs.

If both env sets are present, Mode A is preferred (simpler path) and Mode B config is ignored — surfaced in the CLI output as a notice.

```bash
# Mode A: access_token
export HERON_GOOGLE_ACCESS_TOKEN="<fresh-oauth-access-token>"

heron-ai scan \
  --mcp '{"kind":"stdio","command":"node","args":["my-server.js"]}' \
  --verify oauth-scopes:google-workspace \
  --agent-label 'hr-agent-google-pilot' \
  --report-dir ./reports

# Mode B: refresh_token + client credentials
export HERON_GOOGLE_REFRESH_TOKEN="<long-lived-refresh-token>"
export HERON_GOOGLE_CLIENT_ID="<oauth-client-id>.apps.googleusercontent.com"
export HERON_GOOGLE_CLIENT_SECRET="<oauth-client-secret>"

heron-ai scan \
  --mcp '{"kind":"stdio","command":"node","args":["my-server.js"]}' \
  --verify oauth-scopes:google-workspace \
  --agent-label 'hr-agent-google-pilot' \
  --report-dir ./reports
```

Combine with `mcp-tools` (and other OAuth connectors) in one pass:

```bash
heron-ai scan \
  --mcp '{"kind":"stdio","command":"node","args":["my-server.js"]}' \
  --verify mcp-tools,oauth-scopes:google-workspace \
  --declared-tools 'send_email,schedule_interview' \
  --agent-label 'hr-agent-google-pilot'
```

**Credentials handling — read this before you run it against production.**

- All three secret values (`access_token`, `refresh_token`, `client_secret`) come from the environment only. There is intentionally no CLI flag for any of them — argv is visible to other processes via `ps`, and shell history persists. `client_id` is also taken from env for consistency, though it is not a secret.
- The connector NEVER logs, echoes, or surfaces any secret. Error messages, parse failures, and the rendered report are scrubbed for every secret value (raw forms). The freshly-minted access token from a Mode B exchange is also added to the scrub set before tokeninfo is called.
- Default base URL is hardcoded to `https://oauth2.googleapis.com`. The `HERON_GOOGLE_OAUTH_BASE_URL` env var lets you point the connector at a local proxy for testing — that path is gated by the same SSRF check (`validateTargetEndpoint`) that protects the audit-agent target endpoint, so it cannot be abused to hit cloud-metadata or RFC1918 hosts.
- Only READ calls are issued (`GET /tokeninfo`, `POST /token` for refresh exchange). The connector never makes user-facing API calls (Gmail / Calendar / Drive / Directory).
- Response bodies are bounded at 64 KiB — sufficient for any well-formed tokeninfo response (typically ~500 B), tight enough that an adversarial response cannot stream arbitrarily.

**Scope canonicalization.** Google scope strings are full URIs. The connector strips the canonical prefix and emits the short form so the scope vocabulary matches the other connectors:

| Google URI | Emitted scope |
| --- | --- |
| `https://www.googleapis.com/auth/gmail.readonly` | `gmail.readonly` |
| `https://www.googleapis.com/auth/calendar.events` | `calendar.events` |
| `https://www.googleapis.com/auth/drive.readonly` | `drive.readonly` |
| `https://www.googleapis.com/auth/admin.directory.user.readonly` | `admin.directory.user.readonly` |
| `openid` / `email` / `profile` | preserved as-is (OIDC standard scopes, not URI-form) |
| anything else | preserved as-is, warning surfaced (defence against future scope-URI scheme changes) |

The `service` field is always `google-workspace`; the sub-service identity (`gmail`, `calendar`, `drive`, `admin.directory`) is carried in the scope string itself.

**Runtime dependency.** Adds `google-auth-library` (Apache-2.0, official Google maintainer) for OAuth 2.0 type contracts. The full `googleapis` SDK is intentionally NOT used — it would pull hundreds of API-specific client sub-modules we do not need. The wire calls run through `globalThis.fetch` so the shared security discipline (SSRF guard, manual-redirect, AbortSignal.timeout, body-size cap) applies uniformly.

#### Mode D: Heron AS an MCP server (`heron mcp-serve`)

Run Heron as a local MCP server that any MCP host (Claude Desktop, Cursor, your own agent) can connect to. Exposes three tools:

- **`audit_agent`** — run a full Heron audit against a target agent endpoint. Input: `{target_endpoint: string, options?: object}`. Output: `{report_markdown, report_id, summary}`.
- **`get_report`** — fetch a previously-generated audit report by id. Input: `{report_id}`. Output: `{report_markdown, metadata}`.
- **`compare_reports`** — diff two audit reports. Input: `{report_id_a, report_id_b}`. Output: `{diff_markdown}`.

Default transport is stdio (drop-in for any MCP host that spawns the server as a subprocess). HTTP transport is available for advanced testing and for future hosted deployments — the same transport-agnostic wrapper backs both.

```bash
# Local stdio MCP server (default — for Claude Desktop / Cursor / etc.)
heron-ai mcp-serve

# HTTP transport on a custom port (advanced — for local hosted-mode testing)
heron-ai mcp-serve --port 7350

# Provide an LLM config file explicitly
heron-ai mcp-serve --audit-config ./heron.yaml --report-dir ./audit-reports
```

**Claude Desktop config** — add this snippet to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS; equivalent path on Windows / Linux):

```json
{
  "mcpServers": {
    "heron": {
      "command": "npx",
      "args": ["-y", "heron-ai", "mcp-serve"],
      "env": {
        "HERON_LLM_API_KEY": "sk-ant-..."
      }
    }
  }
}
```

Restart Claude Desktop and you can ask it to call `audit_agent`, `get_report`, or `compare_reports` from any chat.

**Cursor config** — add to `~/.cursor/mcp.json` (or use Cursor's Settings → MCP Servers UI):

```json
{
  "mcpServers": {
    "heron": {
      "command": "npx",
      "args": ["-y", "heron-ai", "mcp-serve"],
      "env": {
        "HERON_LLM_API_KEY": "sk-ant-..."
      }
    }
  }
}
```

The wrapper is transport-agnostic — the same code powers stdio for local use and HTTP for the future hosted side. See `src/server/mcp-types.ts` for the locked interface contract (`RequestContext`, `MCPServerError`, `MCPServerResult<T>`).

##### Security knobs

`heron mcp-serve` ships with strict defaults. Every knob below loosens them; flip only when you know what you're doing.

| Env var | Default | What it does |
| --- | --- | --- |
| `HERON_ALLOW_PRIVATE_TARGETS` | unset | When `1`, the `audit_agent` SSRF guard is disabled. Without this, the tool rejects target endpoints that resolve to loopback, RFC1918, link-local (incl. cloud metadata `169.254.169.254`), or non-`http(s)` schemes. Enable only for local testing against an agent on a private network. |
| `HERON_MCP_HTTP_TIMEOUT_MS` | `30000` | Per-request socket timeout for HTTP mode. Lower in tests; keep >= 5 s in production. |
| `HERON_ALLOWED_HOSTS` | `127.0.0.1:<port>,localhost:<port>` | Comma-separated allow-list passed to `StreamableHTTPServerTransport` for DNS-rebinding protection. |
| `HERON_ALLOWED_ORIGINS` | `http://127.0.0.1[:port],http://localhost[:port]` | Same, for the `Origin` header. |
| `HERON_GREENHOUSE_API_KEY` | unset | Greenhouse Harvest API key for `--verify oauth-scopes:greenhouse`. Set via env (never via CLI flag — argv leaks to other processes via `ps`). Used only to build the HTTP Basic Auth header on probe requests; never logged or surfaced in the rendered report. |
| `HERON_GREENHOUSE_BASE_URL` | unset (defaults to `https://harvest.greenhouse.io/v1/`) | Override the Greenhouse Harvest base URL for local-proxy testing. Gated by `validateTargetEndpoint` — same SSRF policy that protects `audit_agent`, so a private-IP / cloud-metadata override is rejected with `invalid_config`. |
| `HERON_GREENHOUSE_PROBE_TIMEOUT_MS` | `10000` | Per-probe wall-clock timeout for Greenhouse scope discovery. Clamped to `(0, 600000]`; invalid values silently fall back to the default. |
| `HERON_BAMBOOHR_API_KEY` | unset | BambooHR API key for `--verify oauth-scopes:bamboohr`. Set via env (never via CLI flag — argv leaks to other processes via `ps`). Used only to build the HTTP Basic Auth header on probe requests (`<key>:x` — BambooHR's documented "no password" convention); never logged or surfaced in the rendered report. |
| `HERON_BAMBOOHR_SUBDOMAIN` | unset | BambooHR tenant subdomain (the per-tenant prefix from your BambooHR account URL — e.g. `acme` for `acme.bamboohr.com`). Validated for DNS-label shape (letters/digits/hyphens, ≤63 chars) before any HTTP call. |
| `HERON_BAMBOOHR_BASE_URL` | unset (defaults to `https://api.bamboohr.com/api/gateway.php`) | Override the BambooHR gateway prefix for local-proxy testing. Gated by `validateTargetEndpoint` — same SSRF policy that protects `audit_agent`. The subdomain is still appended after the override host, preserving per-tenant URL shape. |
| `HERON_BAMBOOHR_PROBE_TIMEOUT_MS` | `10000` | Per-probe wall-clock timeout for BambooHR scope discovery. Clamped to `(0, 600000]`; invalid values silently fall back to the default. |
| `HERON_GOOGLE_ACCESS_TOKEN` | unset | Google Workspace OAuth 2.0 access token for `--verify oauth-scopes:google-workspace` Mode A (direct tokeninfo introspection). Set via env (never via CLI flag — argv leaks to other processes via `ps`); never logged or surfaced in the rendered report. |
| `HERON_GOOGLE_REFRESH_TOKEN` | unset | Google Workspace OAuth 2.0 refresh token for Mode B (refresh-then-introspect). Required together with `HERON_GOOGLE_CLIENT_ID` and `HERON_GOOGLE_CLIENT_SECRET`. Never logged or surfaced in the rendered report. |
| `HERON_GOOGLE_CLIENT_ID` | unset | OAuth client identifier for Mode B token exchange. Real Google client IDs end in `.apps.googleusercontent.com`; the connector accepts any non-whitespace identifier so workforce-identity federations are not locked out. Not strictly a secret (appears in OAuth redirect URLs). |
| `HERON_GOOGLE_CLIENT_SECRET` | unset | OAuth client secret for Mode B token exchange. Never logged or surfaced in the rendered report. |
| `HERON_GOOGLE_OAUTH_BASE_URL` | unset (defaults to `https://oauth2.googleapis.com`) | Override the Google OAuth 2.0 base URL for local-proxy testing. Gated by `validateTargetEndpoint` — same SSRF policy that protects `audit_agent`, so a private-IP / cloud-metadata override is rejected with `invalid_config`. |
| `HERON_GOOGLE_PROBE_TIMEOUT_MS` | `10000` | Per-request wall-clock timeout for the Google Workspace tokeninfo / token-exchange calls. Clamped to `(0, 600000]`; invalid values silently fall back to the default. |
| `HERON_DECLARED_SOURCE_CWD_ONLY` | unset | When set to `true`, restrict `--declared-source file:<path>` reads to subpaths of `process.cwd()`. Default behaviour allows any readable path. Recommended for hosted / sandboxed deployments where the declared-source file should never resolve outside the workspace. |

The HTTP transport caps individual request bodies at **1 MiB** (oversize → `413 Payload Too Large`) and aborts stalled requests at the configured timeout (`408 Request Timeout`).

DNS-rebinding mitigation note: the `target_endpoint` policy resolves the host once and then `HttpConnector` connects by hostname. A TTL-0 DNS record could in principle flip between check and connect; this raises the bar substantially but does not fully eliminate the TOCTOU class. Tracked as a follow-up.

### Option 2: Hosted version (no setup)

Sign in at **https://heron.ing** and paste this into your AI agent's chat:

```
I need you to complete a security access review for this project.
Make sequential API calls to the Heron endpoint until it says "Interview complete".

Step 1 — Start the interview:
POST https://heron.ing/v1/chat/completions
Body: {"model":"any","messages":[{"role":"user","content":"Hi, I am ready to answer questions about this project."}]}

The response will contain a question and a session ID (in the "heron_session_id" JSON field).

Step 2 — Send each answer:
POST https://heron.ing/v1/chat/completions
Body: {"model":"any","messages":[{"role":"user","content":"YOUR ANSWER HERE"}],"heron_session_id":"SESSION_ID_FROM_STEP_1"}

Step 3 — Repeat step 2 until the response says "Interview complete".

Important: answer about THIS specific project — what you actually do, what systems
you connect to, what data you handle. Not general capabilities. Never reveal actual
secret values — just describe credential types.
```

Reports save to your dashboard automatically. Sign in with Google, no credit card, free.

### Option 3: Claude Code skill (zero setup)

If you use [Claude Code](https://claude.ai/code), install the `/heron-audit` skill:

```bash
bash Heron/skills/heron-audit/install.sh
```

Then in any project:

```
/heron-audit
```

Claude interviews itself about the current project and generates an audit report. No server, no API key, no setup.

## How It Works

<table>
<tr>
<td width="50%">

**Step 1 — Start Heron**

One command. Interactive menu or direct flags.

</td>
<td width="50%">

```bash
$ npx heron-ai

  Heron — AI Agent Auditor

  > Start server    agents connect to you
    Scan an agent   you connect to an agent
```

</td>
</tr>
<tr>
<td>

**Step 2 — Agent connects**

Heron speaks OpenAI-compatible API. No SDK, no code changes needed.

</td>
<td>

```bash
# Paste the prompt into agent's chat
# Or redirect the base URL:
OPENAI_BASE_URL=http://localhost:3700/v1 \
  your-agent start
```

</td>
</tr>
<tr>
<td>

**Step 3 — Structured interview**

10 core questions, each targeting a compliance field. Smart follow-ups probe vague answers. Format examples guide the agent to give concrete, structured responses.

</td>
<td>

```
Heron: "List every system you connect to.
       Format: Name → API type → Auth method
       Example: Google Sheets → REST API → OAuth2"

Agent: "HubSpot → REST API → OAuth2
        PostgreSQL → Direct TCP → Password
        Slack → Bot API → Bot token"
```

</td>
</tr>
<tr>
<td>

**Step 4 — Report generated**

Per-system access cards, findings with IDs, risk scoring, regulatory flags, and actionable recommendations.

</td>
<td>

```
  Audit complete: sess_abc123
  Risk:         MEDIUM
  Data quality: 100/100
  Verdict:      APPROVE WITH CONDITIONS
  Findings:     4
  Report:       ./reports/sess_abc123.md
  Dashboard:    http://localhost:3700/sessions/sess_abc123
```

</td>
</tr>
</table>

### Interview Protocol

10 structured questions targeting compliance fields, plus LLM-generated follow-ups:

| # | Question | Compliance Field |
|---|----------|-----------------|
| 1 | Deployment profile (project name, owner, trigger) | Agent identity |
| 2 | Permissions and scopes per system | Scopes requested |
| 3 | Systems enumeration (Name &rarr; API &rarr; Auth) | System inventory |
| 4 | Data sensitivity per system (PII/financial/confidential) | Data sensitivity |
| 5 | Detailed permissions | Access assessment |
| 6 | Data read operations and classification | Data inventory |
| 7 | Reversibility of operations | Reversibility |
| 8 | Write operations (Action &rarr; Target &rarr; Reversible? &rarr; Volume) | Write operations |
| 9 | Blast radius (records/users affected if write fails) | Blast radius |
| 10 | Frequency and volume (runs/week, API calls/run) | Frequency & volume |
| + | Unused permissions, worst-case failure, decision-making about people | Excess access, risk, regulatory |

Follow-ups are generated when answers are vague or compliance fields are missing (up to 6 per interview).

### Report Structure

1. **Executive Summary** &mdash; dashboard table (risk / systems / findings)
2. **Agent Profile** &mdash; purpose, trigger, owner, frequency
3. **Findings** &mdash; severity-ranked with IDs (HERON-001, ...), split description and recommendation
4. **Systems & Access** &mdash; per-system cards with risk rating, scopes, data, writes, blast radius
5. **What's Working Well** &mdash; positive findings
6. **Verdict & Recommendations** &mdash; APPROVE / APPROVE WITH CONDITIONS / DENY
7. **Regulatory Compliance** &mdash; EU (AI Act + GDPR), US (SOC 2 + state AI laws), UK (UK GDPR + ICO)
8. **Data Quality** &mdash; field-by-field coverage score, repeated answer warnings
9. **Interview Transcript** &mdash; full Q&A for manual review

## Example Report

**[View full example report &rarr;](examples/example-report.md)**

A real audit of an educational content pipeline agent &mdash; reads lessons from Google Sheets, generates Russian content with Gemini, creates Google Docs and slide decks, publishes to an LMS. The report covers 9 connected systems, 1 critical and 4 high-severity findings, per-system access cards, regulatory flags (GDPR, SOC 2, EU AI Act), and a verdict with actionable recommendations.

## Two Modes

| Mode | Command | Direction | Use Case |
|------|---------|-----------|----------|
| **Server** | `serve` | Agent &rarr; Heron | Deploy as a gate. Agents connect to Heron |
| **Scan** | `scan` | Heron &rarr; Agent | Connect to an agent's API and interrogate it |

## LLM Provider

First run with no env vars / flags drops you into an arrow-key wizard:

```
?  How do you want to connect Heron to an LLM?
   ●  Anthropic
   ○  OpenAI
   ○  Google
   ○  OpenRouter
   ○  LiteLLM
```

| Option | What it asks for | Notes |
|--------|------------------|-------|
| **Anthropic** | API key | Default model: `claude-opus-4-7-20260301` |
| **OpenAI** | API key | Default model: `gpt-5.5-mini` |
| **Google** | API key | Gemini — default model: `gemini-2.5-pro` |
| **OpenRouter** | API key | Base URL hardcoded to `https://openrouter.ai/api/v1`, OpenAI-compatible |
| **LiteLLM** | Base URL, then API key | OpenAI-compatible passthrough to any backend |

To skip the wizard (CI, scripts), use env vars or CLI flags:

```bash
export HERON_LLM_API_KEY=sk-...                      # required
export HERON_LLM_BASE_URL=https://litellm.example.com  # only for LiteLLM / OpenRouter / vLLM / Azure
export HERON_LLM_PROVIDER=openai                     # only when auto-detection from key prefix is wrong
export HERON_LLM_MODEL=claude-opus-4-7-20260301      # only to override the default
```

Same fields exist as CLI flags: `--llm-key`, `--llm-base-url`, `--llm-provider`, `--llm-model`.

## Reference

<details>
<summary>Server Mode &mdash; <code>heron serve</code></summary>

```bash
npx heron-ai serve [options]
```

| Flag | Description | Default |
|------|-------------|---------|
| `-p, --port <port>` | Port to listen on | `3700` |
| `-H, --host <host>` | Host to bind to. Loopback by default. Pass `0.0.0.0` to expose to the LAN — Heron OSS has **no authentication** and POST endpoints can spawn arbitrary processes via the MCP stdio transport. Never expose to the public Internet. | `127.0.0.1` |
| `--llm-key <key>` | LLM API key | `HERON_LLM_API_KEY` env |
| `--llm-base-url <url>` | LLM base URL for LiteLLM / OpenRouter / vLLM / Azure-OpenAI gateways | `HERON_LLM_BASE_URL` env |
| `--llm-provider <p>` | `anthropic`, `openai`, or `gemini` | auto-detect |
| `--llm-model <model>` | Analysis LLM model | auto per provider |
| `--max-followups <n>` | Max follow-up questions | `3` |
| `--report-dir <dir>` | Where to save reports | `./reports` |

**API Endpoints**

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/chat/completions` | POST | OpenAI-compatible &mdash; agents connect here |
| `/api/sessions` | GET | List all sessions (JSON) |
| `/api/sessions/:id` | GET | Session details + transcript |
| `/api/sessions/:id/report` | GET | Download audit report (markdown) |
| `/scans` | GET | Verification-scan dashboard (HTML) |
| `/scans/new` | GET | Browser form &mdash; trigger a new scan |
| `/api/scans` | POST | Submit the trigger form (303 redirect to scan detail) |
| `/approvals/:agentId` | GET | Approval chain for an agent (HTML) |
| `/approvals/:agentId/new` | GET | Browser form &mdash; append an approval entry |
| `/api/approvals/:agentId` | POST | Submit the approval entry (303 redirect) |
| `/declared` | GET | List of uploaded declared baselines |
| `/declared/upload` | GET | Browser form &mdash; upload a baseline JSON |
| `/api/declared` | POST | Submit the upload (multipart, 303 redirect) |
| `/` | GET | Dashboard |

**Browser write workflows** &mdash; the form-driven routes above let a DPO drive Heron without ever opening a CLI. Discipline:

- Every POST enforces a 1&nbsp;MiB body cap.
- Every POST checks `Origin` / `Referer` against the server host &mdash; cross-origin POSTs are rejected with a 403.
- Forms are server-rendered with no JavaScript. The flow is classic post-redirect-get: form POST &rarr; 303 to the detail page.
- **Scan execution is synchronous**: `POST /api/scans` blocks until the scan completes. Long scans (multiple verify sources, slow MCP servers) may take 30+ seconds. Async job queueing is out of scope for OSS v1.
- **Concurrency cap**: at most `HERON_MAX_CONCURRENT_SCANS` in-flight scans (default `3`). Excess requests get `429 Too Many Requests` with a `Retry-After: 30` header.
- **Per-request timeout**: a scan that runs longer than `HERON_SCAN_TIMEOUT_MS` (default `300000`, i.e. 5 minutes) is aborted with `504 Gateway Timeout`.
- **Host-header allow-list**: inbound requests whose `Host:` header is not in the allow-list are rejected with `421 Misdirected Request`. The allow-list starts with loopback + the bound host. To add more (e.g. when fronted by nginx / Caddy), set `HERON_ALLOWED_HOSTS=public.example.com,other.example.com` before starting `heron serve`. This defends against DNS-rebinding attacks where a hostile webpage in the user's browser issues writes to Heron's loopback port.
- Declared-baseline filenames are sanitised to `decl-[a-z0-9-]{1,64}\.json`.

</details>

<details>
<summary>Scan Mode &mdash; <code>heron scan</code></summary>

```bash
npx heron-ai scan [options]
```

| Flag | Description | Default |
|------|-------------|---------|
| `-t, --target <url>` | Agent's chat API URL | required |
| `--llm-key <key>` | LLM API key | `HERON_LLM_API_KEY` env |
| `--llm-base-url <url>` | LLM base URL for LiteLLM / OpenRouter / vLLM / Azure-OpenAI gateways | `HERON_LLM_BASE_URL` env |
| `--llm-provider <p>` | `anthropic`, `openai`, or `gemini` | auto-detect |
| `--llm-model <model>` | Analysis LLM model | auto per provider |
| `-o, --output <path>` | Save report to file | `./reports/scan_xxx.md` |
| `--max-followups <n>` | Max follow-up questions | `3` |
| `--report-dir <dir>` | Where to save reports | `./reports` |

</details>

## Architecture

```
bin/heron.ts              CLI entry point (interactive menu, scan, serve)
src/
  server/
    index.ts              HTTP server + dashboard + OpenAI-compatible endpoint
    sessions.ts           Session manager with follow-ups and async analysis
  interview/
    questions.ts          10 structured questions (one per compliance field)
    protocol.ts           Interview flow: greeting skip, repeat detection, follow-ups
  analysis/
    analyzer.ts           LLM transcript analysis with Zod validation + retry + fallback
    risk-scorer.ts        Rubric-driven risk scoring from structured per-system data
  report/
    generator.ts          Regulatory compliance flags (EU/US/UK) + report assembly
    templates.ts          Markdown report: per-system cards, findings, positive findings
    types.ts              Zod schemas for SystemAssessment, AuditReport, RegulatoryFlags
  llm/
    client.ts             Unified LLM client (Anthropic/OpenAI/Gemini, auto-detect)
    prompts.ts            Interview + analysis prompts with anti-hallucination rules
  connectors/             Agent connection (HTTP, interactive)
  config/                 YAML config loading + Zod validation
```

## Development

```bash
git clone https://github.com/theonaai/Heron.git
cd Heron && npm install

# Run locally
npx heron-ai serve

# Tests
npm test
```

## Contributing

Issues and PRs welcome.

## Contact

Questions, feedback, ideas? Reach out:

- **LinkedIn:** [Ilya Ivanov](https://www.linkedin.com/in/ilyaivanov0/)
- **Telegram:** [@Ilya_Ivanov0](https://t.me/Ilya_Ivanov0)

## License

[MIT](LICENSE)
