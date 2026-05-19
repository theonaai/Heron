/**
 * Tests for the interactive provider-selection wizard (AAP-60).
 *
 * The wizard lives in `src/llm/onboarding.ts` and is invoked by
 * `createLLMClient` when no credentials are present anywhere AND
 * stdin is a TTY. Env vars / CLI flags must bypass it entirely so
 * CI and non-interactive callers are unaffected.
 *
 * `@clack/prompts` is mocked so the tests can simulate selections
 * deterministically without spinning up a real TTY.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---- @clack/prompts mock ---------------------------------------------------
// The mock returns whatever the tests stuff into these queues. Each test
// resets them so cases don't bleed into each other.
const clackResponses = {
  select: [] as unknown[],
  text: [] as unknown[],
  password: [] as unknown[],
};

const cancelSymbol = Symbol('clack:cancel');

vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  note: vi.fn(),
  cancel: vi.fn(),
  isCancel: (val: unknown) => val === cancelSymbol,
  select: vi.fn(async () => {
    if (clackResponses.select.length === 0) throw new Error('select queue empty');
    return clackResponses.select.shift();
  }),
  text: vi.fn(async () => {
    if (clackResponses.text.length === 0) throw new Error('text queue empty');
    return clackResponses.text.shift();
  }),
  password: vi.fn(async () => {
    if (clackResponses.password.length === 0) throw new Error('password queue empty');
    return clackResponses.password.shift();
  }),
}));

// Helper: queue the next answers each wizard step will receive.
function queueResponses(opts: {
  select?: unknown[];
  text?: unknown[];
  password?: unknown[];
}): void {
  clackResponses.select = opts.select ?? [];
  clackResponses.text = opts.text ?? [];
  clackResponses.password = opts.password ?? [];
}

beforeEach(() => {
  queueResponses({});
  vi.resetModules();
});

afterEach(() => {
  // Restore env between tests
  delete process.env.HERON_LLM_API_KEY;
  delete process.env.HERON_LLM_BASE_URL;
  delete process.env.HERON_LLM_PROVIDER;
  delete process.env.HERON_LLM_MODEL;
});

// ---- Direct wizard tests --------------------------------------------------
describe('runLLMOnboarding', () => {
  it('Anthropic path → asks only for API key, returns provider=anthropic, no baseURL', async () => {
    queueResponses({
      select: ['anthropic'],
      password: ['sk-ant-test-key'],
    });
    const { runLLMOnboarding } = await import('../../src/llm/onboarding.js');
    const result = await runLLMOnboarding({ ttyOverride: true });
    expect(result.provider).toBe('anthropic');
    expect(result.apiKey).toBe('sk-ant-test-key');
    expect(result.baseURL).toBeUndefined();
  });

  it('OpenAI path → asks only for API key, returns provider=openai, no baseURL', async () => {
    queueResponses({
      select: ['openai'],
      password: ['sk-test-openai'],
    });
    const { runLLMOnboarding } = await import('../../src/llm/onboarding.js');
    const result = await runLLMOnboarding({ ttyOverride: true });
    expect(result.provider).toBe('openai');
    expect(result.apiKey).toBe('sk-test-openai');
    expect(result.baseURL).toBeUndefined();
  });

  it('Google path → asks only for API key, returns provider=gemini', async () => {
    queueResponses({
      select: ['google'],
      password: ['AIzaTestKey'],
    });
    const { runLLMOnboarding } = await import('../../src/llm/onboarding.js');
    const result = await runLLMOnboarding({ ttyOverride: true });
    expect(result.provider).toBe('gemini');
    expect(result.apiKey).toBe('AIzaTestKey');
    expect(result.baseURL).toBeUndefined();
  });

  it('OpenRouter path → hardcodes openrouter base URL, provider=openai', async () => {
    queueResponses({
      select: ['openrouter'],
      password: ['sk-or-test'],
    });
    const { runLLMOnboarding } = await import('../../src/llm/onboarding.js');
    const result = await runLLMOnboarding({ ttyOverride: true });
    expect(result.provider).toBe('openai');
    expect(result.apiKey).toBe('sk-or-test');
    expect(result.baseURL).toBe('https://openrouter.ai/api/v1');
  });

  it('LiteLLM path → asks base URL first, then API key, provider=openai', async () => {
    queueResponses({
      select: ['litellm'],
      text: ['https://litellm.example.com'],
      password: ['sk-litellm-test'],
    });
    const { runLLMOnboarding } = await import('../../src/llm/onboarding.js');
    const result = await runLLMOnboarding({ ttyOverride: true });
    expect(result.provider).toBe('openai');
    expect(result.apiKey).toBe('sk-litellm-test');
    expect(result.baseURL).toBe('https://litellm.example.com');
  });

  it('LiteLLM path strips trailing slash on the base URL', async () => {
    queueResponses({
      select: ['litellm'],
      text: ['https://litellm.example.com/'],
      password: ['sk-x'],
    });
    const { runLLMOnboarding } = await import('../../src/llm/onboarding.js');
    const result = await runLLMOnboarding({ ttyOverride: true });
    expect(result.baseURL).toBe('https://litellm.example.com');
  });

  it('LiteLLM path rejects malformed URL — re-prompts until valid', async () => {
    queueResponses({
      select: ['litellm'],
      text: ['not-a-url', 'https://valid.example.com'],
      password: ['sk-x'],
    });
    const { runLLMOnboarding } = await import('../../src/llm/onboarding.js');
    const result = await runLLMOnboarding({ ttyOverride: true });
    expect(result.baseURL).toBe('https://valid.example.com');
  });

  it('Cancellation at provider step → throws OnboardingCancelled', async () => {
    queueResponses({ select: [cancelSymbol] });
    const { runLLMOnboarding, OnboardingCancelled } = await import('../../src/llm/onboarding.js');
    await expect(runLLMOnboarding({ ttyOverride: true })).rejects.toBeInstanceOf(OnboardingCancelled);
  });

  it('Cancellation at API key step → throws OnboardingCancelled', async () => {
    queueResponses({
      select: ['anthropic'],
      password: [cancelSymbol],
    });
    const { runLLMOnboarding, OnboardingCancelled } = await import('../../src/llm/onboarding.js');
    await expect(runLLMOnboarding({ ttyOverride: true })).rejects.toBeInstanceOf(OnboardingCancelled);
  });
});

// ---- Integration with createLLMClient -------------------------------------
describe('createLLMClient ↔ wizard handoff', () => {
  it('skips wizard when config.apiKey is provided (CLI --llm-key)', async () => {
    queueResponses({ select: [], password: [], text: [] });
    const { createLLMClient } = await import('../../src/llm/client.js');
    // Should NOT call the wizard (queues are empty — would throw if called).
    const client = await createLLMClient({
      provider: 'anthropic',
      apiKey: 'sk-ant-from-flag',
    });
    expect(client).toBeDefined();
  });

  it('skips wizard when HERON_LLM_API_KEY env var is set', async () => {
    process.env.HERON_LLM_API_KEY = 'sk-ant-from-env';
    process.env.HERON_LLM_PROVIDER = 'anthropic';
    queueResponses({ select: [], password: [], text: [] });
    const { createLLMClient } = await import('../../src/llm/client.js');
    const client = await createLLMClient({ provider: 'anthropic' });
    expect(client).toBeDefined();
  });

  it('honours --llm-base-url + --llm-key without invoking the wizard', async () => {
    queueResponses({ select: [], password: [], text: [] });
    const { createLLMClient } = await import('../../src/llm/client.js');
    const client = await createLLMClient({
      provider: 'openai',
      apiKey: 'sk-test',
      baseURL: 'https://litellm.example.com',
    });
    expect(client).toBeDefined();
  });

  it('non-TTY without env vars and without flags → throws "use one of" error', async () => {
    const { createLLMClient } = await import('../../src/llm/client.js');
    // Force non-TTY for this test
    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    try {
      // @ts-expect-error — intentionally minimal to trigger missing-key path
      await expect(createLLMClient({ provider: 'anthropic' })).rejects.toThrow(/use one of/i);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true });
    }
  });

  it('non-TTY error message mentions HERON_LLM_BASE_URL', async () => {
    const { createLLMClient } = await import('../../src/llm/client.js');
    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    try {
      // @ts-expect-error — provider only, no key anywhere
      await expect(createLLMClient({ provider: 'anthropic' })).rejects.toThrow(/HERON_LLM_BASE_URL/);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true });
    }
  });
});
