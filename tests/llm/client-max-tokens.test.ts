/**
 * AAP-81: per-provider `max_tokens` caps for analyzer LLM calls.
 *
 * Validates:
 * 1. The `maxOutputTokensFor` resolver returns the right cap per provider+model.
 * 2. Each provider client sends the correct cap in its request payload.
 * 3. Truncation warnings fire when a provider returns its max-tokens
 *    stop reason (`max_tokens` / `length` / `MAX_TOKENS`).
 *
 * Provider SDKs are mocked so tests don't touch the network. Each test
 * resets the mocks and module cache to keep cases isolated.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---- SDK mocks ------------------------------------------------------------
// Captures the request payload + lets each test supply a synthetic response.

interface CapturedAnthropicCall {
  payload: Record<string, unknown>;
}
interface CapturedOpenAICall {
  payload: Record<string, unknown>;
}

const anthropicState: {
  calls: CapturedAnthropicCall[];
  response: unknown;
} = { calls: [], response: undefined };

const openaiState: {
  calls: CapturedOpenAICall[];
  response: unknown;
  constructorOpts: unknown;
} = { calls: [], response: undefined, constructorOpts: undefined };

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class MockAnthropic {
      messages = {
        create: vi.fn(async (payload: Record<string, unknown>) => {
          anthropicState.calls.push({ payload });
          return anthropicState.response;
        }),
      };
    },
  };
});

vi.mock('openai', () => {
  return {
    default: class MockOpenAI {
      chat = {
        completions: {
          create: vi.fn(async (payload: Record<string, unknown>) => {
            openaiState.calls.push({ payload });
            return openaiState.response;
          }),
        },
      };
      constructor(opts: unknown) {
        openaiState.constructorOpts = opts;
      }
    },
  };
});

// ---- fetch mock for Gemini ------------------------------------------------

interface CapturedGeminiCall {
  url: string;
  body: Record<string, unknown>;
}

const geminiState: {
  calls: CapturedGeminiCall[];
  response: unknown;
} = { calls: [], response: undefined };

const originalFetch = global.fetch;

beforeEach(() => {
  anthropicState.calls = [];
  anthropicState.response = undefined;
  openaiState.calls = [];
  openaiState.response = undefined;
  openaiState.constructorOpts = undefined;
  geminiState.calls = [];
  geminiState.response = undefined;
  vi.resetModules();

  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = init?.body ? JSON.parse(init.body as string) : {};
    geminiState.calls.push({ url, body });
    return {
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => geminiState.response,
    } as Response;
  }) as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

// ---- 1. Resolver ----------------------------------------------------------

describe('maxOutputTokensFor', () => {
  it('returns per-provider default for current-flagship models', async () => {
    const { maxOutputTokensFor, DEFAULT_MAX_OUTPUT_TOKENS_BY_PROVIDER } = await import(
      '../../src/llm/client.js'
    );
    expect(maxOutputTokensFor('anthropic', 'claude-opus-4-7')).toBe(
      DEFAULT_MAX_OUTPUT_TOKENS_BY_PROVIDER.anthropic,
    );
    expect(maxOutputTokensFor('openai', 'gpt-5.5')).toBe(
      DEFAULT_MAX_OUTPUT_TOKENS_BY_PROVIDER.openai,
    );
    expect(maxOutputTokensFor('gemini', 'gemini-2.5-pro')).toBe(
      DEFAULT_MAX_OUTPUT_TOKENS_BY_PROVIDER.gemini,
    );
  });

  it('locks default caps to the spec values (anthropic 128K, openai 128K, gemini 65K)', async () => {
    const { DEFAULT_MAX_OUTPUT_TOKENS_BY_PROVIDER } = await import('../../src/llm/client.js');
    expect(DEFAULT_MAX_OUTPUT_TOKENS_BY_PROVIDER.anthropic).toBe(128_000);
    expect(DEFAULT_MAX_OUTPUT_TOKENS_BY_PROVIDER.openai).toBe(128_000);
    expect(DEFAULT_MAX_OUTPUT_TOKENS_BY_PROVIDER.gemini).toBe(65_536);
  });

  it('clamps to lower physical cap for known older OpenAI models', async () => {
    const { maxOutputTokensFor } = await import('../../src/llm/client.js');
    expect(maxOutputTokensFor('openai', 'gpt-4o')).toBe(16_384);
    expect(maxOutputTokensFor('openai', 'gpt-4o-2024-08-06')).toBe(16_384);
    expect(maxOutputTokensFor('openai', 'gpt-4-turbo')).toBe(4_096);
    expect(maxOutputTokensFor('openai', 'gpt-3.5-turbo')).toBe(4_096);
  });

  it('clamps to lower physical cap for known older Anthropic models', async () => {
    const { maxOutputTokensFor } = await import('../../src/llm/client.js');
    expect(maxOutputTokensFor('anthropic', 'claude-3-sonnet-20240229')).toBe(8_192);
    expect(maxOutputTokensFor('anthropic', 'claude-3-opus-20240229')).toBe(4_096);
    expect(maxOutputTokensFor('anthropic', 'claude-3-haiku-20240307')).toBe(4_096);
  });

  it('clamps to lower physical cap for known older Gemini models', async () => {
    const { maxOutputTokensFor } = await import('../../src/llm/client.js');
    expect(maxOutputTokensFor('gemini', 'gemini-1.5-pro-latest')).toBe(8_192);
    expect(maxOutputTokensFor('gemini', 'gemini-1.5-flash')).toBe(8_192);
  });

  it('lookup is case-insensitive', async () => {
    const { maxOutputTokensFor } = await import('../../src/llm/client.js');
    expect(maxOutputTokensFor('openai', 'GPT-4O')).toBe(16_384);
  });
});

// ---- 2. Per-client request payload ---------------------------------------
//
// We exercise the private clients via `createLLMClient`, which is the public
// factory. Each test stubs the matching provider's "happy path" response and
// asserts the captured request payload carries the expected cap value.

describe('AnthropicLLMClient sends correct max_tokens', () => {
  it('uses 128K (current flagship default) for claude-opus-4-7', async () => {
    anthropicState.response = {
      content: [{ type: 'text', text: '{}' }],
      stop_reason: 'end_turn',
      usage: { output_tokens: 100 },
    };
    process.env.HERON_LLM_API_KEY = 'sk-ant-test';
    process.env.HERON_LLM_PROVIDER = 'anthropic';
    process.env.HERON_LLM_MODEL = 'claude-opus-4-7';

    const { createLLMClient } = await import('../../src/llm/client.js');
    const client = await createLLMClient({});
    await client.chat('sys', 'msg');

    expect(anthropicState.calls).toHaveLength(1);
    expect(anthropicState.calls[0].payload.max_tokens).toBe(128_000);
  });

  it('falls back to lower per-model cap for legacy claude-3-sonnet', async () => {
    anthropicState.response = {
      content: [{ type: 'text', text: '{}' }],
      stop_reason: 'end_turn',
      usage: { output_tokens: 100 },
    };
    process.env.HERON_LLM_API_KEY = 'sk-ant-test';
    process.env.HERON_LLM_PROVIDER = 'anthropic';
    process.env.HERON_LLM_MODEL = 'claude-3-sonnet-20240229';

    const { createLLMClient } = await import('../../src/llm/client.js');
    const client = await createLLMClient({});
    await client.chat('sys', 'msg');

    expect(anthropicState.calls[0].payload.max_tokens).toBe(8_192);
  });
});

describe('OpenAILLMClient sends correct max_tokens', () => {
  it('uses 128K for gpt-5.5', async () => {
    openaiState.response = {
      choices: [{ message: { content: '{}' }, finish_reason: 'stop' }],
      usage: { completion_tokens: 100 },
    };
    process.env.HERON_LLM_API_KEY = 'sk-openai-test';
    process.env.HERON_LLM_PROVIDER = 'openai';
    process.env.HERON_LLM_MODEL = 'gpt-5.5';

    const { createLLMClient } = await import('../../src/llm/client.js');
    const client = await createLLMClient({});
    await client.chat('sys', 'msg');

    expect(openaiState.calls).toHaveLength(1);
    expect(openaiState.calls[0].payload.max_tokens).toBe(128_000);
  });

  it('falls back to 16K for legacy gpt-4o', async () => {
    openaiState.response = {
      choices: [{ message: { content: '{}' }, finish_reason: 'stop' }],
      usage: { completion_tokens: 100 },
    };
    process.env.HERON_LLM_API_KEY = 'sk-openai-test';
    process.env.HERON_LLM_PROVIDER = 'openai';
    process.env.HERON_LLM_MODEL = 'gpt-4o';

    const { createLLMClient } = await import('../../src/llm/client.js');
    const client = await createLLMClient({});
    await client.chat('sys', 'msg');

    expect(openaiState.calls[0].payload.max_tokens).toBe(16_384);
  });

  it('OpenAI client constructor uses 180s analyzer timeout', async () => {
    openaiState.response = {
      choices: [{ message: { content: '{}' }, finish_reason: 'stop' }],
      usage: { completion_tokens: 100 },
    };
    process.env.HERON_LLM_API_KEY = 'sk-openai-test';
    process.env.HERON_LLM_PROVIDER = 'openai';
    process.env.HERON_LLM_MODEL = 'gpt-5.5';

    const { createLLMClient } = await import('../../src/llm/client.js');
    await createLLMClient({});

    expect(openaiState.constructorOpts).toMatchObject({ timeout: 180_000 });
  });
});

describe('GeminiLLMClient sends correct maxOutputTokens', () => {
  it('uses 65K for gemini-2.5-pro', async () => {
    geminiState.response = {
      candidates: [
        { content: { parts: [{ text: '{}' }] }, finishReason: 'STOP' },
      ],
      usageMetadata: { candidatesTokenCount: 100 },
    };
    process.env.HERON_LLM_API_KEY = 'AIzaTest';
    process.env.HERON_LLM_PROVIDER = 'gemini';
    process.env.HERON_LLM_MODEL = 'gemini-2.5-pro';

    const { createLLMClient } = await import('../../src/llm/client.js');
    const client = await createLLMClient({});
    await client.chat('sys', 'msg');

    expect(geminiState.calls).toHaveLength(1);
    expect(geminiState.calls[0].body.generationConfig).toMatchObject({
      maxOutputTokens: 65_536,
    });
  });

  it('falls back to 8K for legacy gemini-1.5-pro', async () => {
    geminiState.response = {
      candidates: [
        { content: { parts: [{ text: '{}' }] }, finishReason: 'STOP' },
      ],
      usageMetadata: { candidatesTokenCount: 100 },
    };
    process.env.HERON_LLM_API_KEY = 'AIzaTest';
    process.env.HERON_LLM_PROVIDER = 'gemini';
    process.env.HERON_LLM_MODEL = 'gemini-1.5-pro-latest';

    const { createLLMClient } = await import('../../src/llm/client.js');
    const client = await createLLMClient({});
    await client.chat('sys', 'msg');

    expect(geminiState.calls[0].body.generationConfig).toMatchObject({
      maxOutputTokens: 8_192,
    });
  });

  it('always passes maxOutputTokens explicitly (Gemini SDK default would be 8192)', async () => {
    geminiState.response = {
      candidates: [
        { content: { parts: [{ text: '{}' }] }, finishReason: 'STOP' },
      ],
      usageMetadata: { candidatesTokenCount: 100 },
    };
    process.env.HERON_LLM_API_KEY = 'AIzaTest';
    process.env.HERON_LLM_PROVIDER = 'gemini';
    process.env.HERON_LLM_MODEL = 'gemini-2.5-pro';

    const { createLLMClient } = await import('../../src/llm/client.js');
    const client = await createLLMClient({});
    await client.chat('sys', 'msg');

    const generationConfig = geminiState.calls[0].body.generationConfig as Record<
      string,
      unknown
    >;
    expect(generationConfig.maxOutputTokens).toBeDefined();
    expect(generationConfig.maxOutputTokens).not.toBe(8192);
  });
});

// ---- 3. Truncation warning logging ---------------------------------------

describe('truncation warnings', () => {
  it('logs a warning when Anthropic returns stop_reason: max_tokens', async () => {
    anthropicState.response = {
      content: [{ type: 'text', text: '{"partial":' }],
      stop_reason: 'max_tokens',
      usage: { output_tokens: 128_000 },
    };
    process.env.HERON_LLM_API_KEY = 'sk-ant-test';
    process.env.HERON_LLM_PROVIDER = 'anthropic';
    process.env.HERON_LLM_MODEL = 'claude-opus-4-7';

    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { createLLMClient } = await import('../../src/llm/client.js');
    const client = await createLLMClient({});
    await client.chat('sys', 'msg');

    const warningCalls = stderrSpy.mock.calls.filter((call) =>
      String(call[0]).includes('truncation warning'),
    );
    expect(warningCalls).toHaveLength(1);
    expect(warningCalls[0][0]).toContain('anthropic');
    expect(warningCalls[0][0]).toContain('claude-opus-4-7');
    expect(warningCalls[0][0]).toContain('128000');
  });

  it('does NOT log a warning when Anthropic returns stop_reason: end_turn', async () => {
    anthropicState.response = {
      content: [{ type: 'text', text: '{}' }],
      stop_reason: 'end_turn',
      usage: { output_tokens: 100 },
    };
    process.env.HERON_LLM_API_KEY = 'sk-ant-test';
    process.env.HERON_LLM_PROVIDER = 'anthropic';
    process.env.HERON_LLM_MODEL = 'claude-opus-4-7';

    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { createLLMClient } = await import('../../src/llm/client.js');
    const client = await createLLMClient({});
    await client.chat('sys', 'msg');

    const warningCalls = stderrSpy.mock.calls.filter((call) =>
      String(call[0]).includes('truncation warning'),
    );
    expect(warningCalls).toHaveLength(0);
  });

  it('logs a warning when OpenAI returns finish_reason: length (jsonMode path)', async () => {
    openaiState.response = {
      choices: [{ message: { content: '{"partial":' }, finish_reason: 'length' }],
      usage: { completion_tokens: 128_000 },
    };
    process.env.HERON_LLM_API_KEY = 'sk-openai-test';
    process.env.HERON_LLM_PROVIDER = 'openai';
    process.env.HERON_LLM_MODEL = 'gpt-5.5';

    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { createLLMClient } = await import('../../src/llm/client.js');
    const client = await createLLMClient({});
    await client.chat('sys', 'msg with json', { jsonMode: true });

    const warningCalls = stderrSpy.mock.calls.filter((call) =>
      String(call[0]).includes('truncation warning'),
    );
    expect(warningCalls).toHaveLength(1);
    expect(warningCalls[0][0]).toContain('openai');
    expect(warningCalls[0][0]).toContain('gpt-5.5');
    expect(warningCalls[0][0]).toContain('128000');
  });

  it('logs a warning when OpenAI returns finish_reason: length (non-JSON path)', async () => {
    openaiState.response = {
      choices: [{ message: { content: 'truncated text' }, finish_reason: 'length' }],
      usage: { completion_tokens: 128_000 },
    };
    process.env.HERON_LLM_API_KEY = 'sk-openai-test';
    process.env.HERON_LLM_PROVIDER = 'openai';
    process.env.HERON_LLM_MODEL = 'gpt-5.5';

    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { createLLMClient } = await import('../../src/llm/client.js');
    const client = await createLLMClient({});
    await client.chat('sys', 'msg');

    const warningCalls = stderrSpy.mock.calls.filter((call) =>
      String(call[0]).includes('truncation warning'),
    );
    expect(warningCalls).toHaveLength(1);
  });

  it('does NOT log a warning when OpenAI returns finish_reason: stop', async () => {
    openaiState.response = {
      choices: [{ message: { content: '{}' }, finish_reason: 'stop' }],
      usage: { completion_tokens: 100 },
    };
    process.env.HERON_LLM_API_KEY = 'sk-openai-test';
    process.env.HERON_LLM_PROVIDER = 'openai';
    process.env.HERON_LLM_MODEL = 'gpt-5.5';

    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { createLLMClient } = await import('../../src/llm/client.js');
    const client = await createLLMClient({});
    await client.chat('sys', 'msg');

    const warningCalls = stderrSpy.mock.calls.filter((call) =>
      String(call[0]).includes('truncation warning'),
    );
    expect(warningCalls).toHaveLength(0);
  });

  it('logs a warning when Gemini returns finishReason: MAX_TOKENS', async () => {
    geminiState.response = {
      candidates: [
        { content: { parts: [{ text: '{"partial":' }] }, finishReason: 'MAX_TOKENS' },
      ],
      usageMetadata: { candidatesTokenCount: 65_536 },
    };
    process.env.HERON_LLM_API_KEY = 'AIzaTest';
    process.env.HERON_LLM_PROVIDER = 'gemini';
    process.env.HERON_LLM_MODEL = 'gemini-2.5-pro';

    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { createLLMClient } = await import('../../src/llm/client.js');
    const client = await createLLMClient({});
    await client.chat('sys', 'msg');

    const warningCalls = stderrSpy.mock.calls.filter((call) =>
      String(call[0]).includes('truncation warning'),
    );
    expect(warningCalls).toHaveLength(1);
    expect(warningCalls[0][0]).toContain('gemini');
    expect(warningCalls[0][0]).toContain('gemini-2.5-pro');
    expect(warningCalls[0][0]).toContain('65536');
  });

  it('does NOT log a warning when Gemini returns finishReason: STOP', async () => {
    geminiState.response = {
      candidates: [
        { content: { parts: [{ text: '{}' }] }, finishReason: 'STOP' },
      ],
      usageMetadata: { candidatesTokenCount: 100 },
    };
    process.env.HERON_LLM_API_KEY = 'AIzaTest';
    process.env.HERON_LLM_PROVIDER = 'gemini';
    process.env.HERON_LLM_MODEL = 'gemini-2.5-pro';

    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { createLLMClient } = await import('../../src/llm/client.js');
    const client = await createLLMClient({});
    await client.chat('sys', 'msg');

    const warningCalls = stderrSpy.mock.calls.filter((call) =>
      String(call[0]).includes('truncation warning'),
    );
    expect(warningCalls).toHaveLength(0);
  });
});

// ---- env cleanup ----------------------------------------------------------

afterEach(() => {
  delete process.env.HERON_LLM_API_KEY;
  delete process.env.HERON_LLM_BASE_URL;
  delete process.env.HERON_LLM_PROVIDER;
  delete process.env.HERON_LLM_MODEL;
});
