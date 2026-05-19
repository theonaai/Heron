/**
 * Interactive provider-selection wizard for first-time LLM setup
 * (AAP-60).
 *
 * Replaces the older readline-only prompt that auto-detected the
 * provider from the API-key prefix. That detection silently failed
 * for LiteLLM gateways (`sk-...` keys flagged as OpenAI proper →
 * 401 against api.openai.com), so we now ask the user up-front
 * which transport to use and only then collect the credential(s)
 * each transport needs.
 *
 * UX surface: `@clack/prompts` (arrow-key `select`, masked `password`,
 * plain `text`). All output is routed to `process.stderr` so stdout
 * stays clean for report payloads in piped workflows.
 *
 * Inputs flow only to (a) the HTTP client's auth header and (b) the
 * `fetch` URL — so the prompt-injection surface is zero. URLs are
 * validated with `new URL()` and constrained to http/https; loopback
 * is allowed since the user is configuring their own machine.
 */

import {
  cancel,
  intro,
  isCancel,
  note,
  outro,
  password,
  select,
  text,
} from '@clack/prompts';

/** Provider id passed downstream to `createLLMClient`. */
export type LLMProvider = 'anthropic' | 'openai' | 'gemini';

/** Result handed back to `createLLMClient`. */
export interface OnboardingResult {
  provider: LLMProvider;
  apiKey: string;
  /** Set when the user picked OpenRouter or LiteLLM. */
  baseURL?: string;
  /** Reserved for future per-provider model picker; unused for now. */
  model?: string;
}

export interface OnboardingOptions {
  /**
   * Force the wizard to run even when stdin is not a TTY. Used by
   * tests; production callers should leave this undefined and let
   * `createLLMClient` decide based on `process.stdin.isTTY`.
   */
  ttyOverride?: boolean;
}

/**
 * Thrown when the user cancels at any step (Ctrl+C or symbolic
 * cancel from @clack/prompts). Callers should `process.exit(0)` —
 * cancellation is a clean exit, not an error.
 */
export class OnboardingCancelled extends Error {
  constructor() {
    super('LLM setup cancelled by user.');
    this.name = 'OnboardingCancelled';
  }
}

type ProviderChoice = 'anthropic' | 'openai' | 'google' | 'openrouter' | 'litellm';

const PROVIDER_OPTIONS: Array<{ value: ProviderChoice; label: string }> = [
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'google', label: 'Google' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'litellm', label: 'LiteLLM' },
];

/** Normalise a user-entered base URL — trim and drop a single trailing slash. */
function normaliseBaseURL(input: string): string {
  let s = input.trim();
  while (s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

/**
 * Validate a base URL the user typed. We allow `http:` and `https:`
 * (loopback is fine — the user is configuring their own box) and
 * reject anything `new URL()` can't parse.
 */
function validateBaseURL(input: string | undefined): string | undefined {
  const trimmed = (input ?? '').trim();
  if (!trimmed) return 'Base URL is required.';
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return 'Enter a valid URL, e.g. https://litellm.example.com';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'URL must use http:// or https://';
  }
  return undefined;
}

/**
 * Run the wizard. Throws `OnboardingCancelled` if the user backs
 * out at any prompt.
 */
export async function runLLMOnboarding(
  _opts: OnboardingOptions = {},
): Promise<OnboardingResult> {
  intro('Heron — LLM setup');
  note(
    'Heron needs an LLM to analyse agent transcripts.\nPick how you want to connect.',
  );

  const choice = (await select({
    message: 'How do you want to connect Heron to an LLM?',
    options: PROVIDER_OPTIONS,
    initialValue: 'anthropic',
  })) as ProviderChoice | symbol;

  if (isCancel(choice)) {
    cancel('Setup aborted.');
    throw new OnboardingCancelled();
  }

  // Per-provider follow-up.
  switch (choice) {
    case 'anthropic':
      return collectKey('anthropic');
    case 'openai':
      return collectKey('openai');
    case 'google':
      return collectKey('gemini');
    case 'openrouter': {
      const apiKey = await promptApiKey('OpenRouter API key:');
      return {
        provider: 'openai',
        apiKey,
        baseURL: 'https://openrouter.ai/api/v1',
      };
    }
    case 'litellm': {
      const baseURL = await promptBaseURL();
      const apiKey = await promptApiKey('LiteLLM API key:');
      outro(`LiteLLM configured: ${baseURL}`);
      return { provider: 'openai', apiKey, baseURL };
    }
    default: {
      // Unreachable — the select() only emits the choices we
      // declared. Cast through `never` for an exhaustiveness check.
      const _exhaustive: never = choice;
      throw new Error(`Unknown provider choice: ${String(_exhaustive)}`);
    }
  }
}

async function collectKey(provider: LLMProvider): Promise<OnboardingResult> {
  const label = provider === 'anthropic'
    ? 'Anthropic API key:'
    : provider === 'openai'
      ? 'OpenAI API key:'
      : 'Google API key:';
  const apiKey = await promptApiKey(label);
  outro(`Configured for ${provider}.`);
  return { provider, apiKey };
}

async function promptApiKey(message: string): Promise<string> {
  const value = await password({
    message,
    validate: (v) => (v && v.trim().length > 0 ? undefined : 'API key is required.'),
  });
  if (isCancel(value)) {
    cancel('Setup aborted.');
    throw new OnboardingCancelled();
  }
  return String(value).trim();
}

async function promptBaseURL(): Promise<string> {
  // Loop until validate() passes. `@clack/prompts` text validate
  // re-prompts when we return an error string, but we keep an
  // explicit fallback loop so mocked test runs (which can't
  // round-trip through clack's internal validate) still work.
  for (;;) {
    const raw = await text({
      message: 'Base URL (e.g. https://litellm.example.com):',
      placeholder: 'https://litellm.example.com',
      validate: validateBaseURL,
    });
    if (isCancel(raw)) {
      cancel('Setup aborted.');
      throw new OnboardingCancelled();
    }
    const err = validateBaseURL(String(raw));
    if (err) {
      // Tests inject answers via a queue; surface the error to
      // stderr and try again from the next queued value.
      process.stderr.write(`  ${err}\n`);
      continue;
    }
    return normaliseBaseURL(String(raw));
  }
}
