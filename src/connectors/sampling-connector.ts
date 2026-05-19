import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type {
  CreateMessageRequestParamsBase,
  CreateMessageResult,
  SamplingMessage,
} from '@modelcontextprotocol/sdk/types.js';

import type { AgentConnector, AgentMetadata } from './types.js';

/**
 * MCP sampling–driven connector.
 *
 * Heron has historically pulled answers out of the audited agent over an
 * OpenAI-compatible HTTP endpoint (`HttpConnector`). Under AAP-52 that
 * endpoint disappears: the audited agent IS the MCP client that just
 * called `start_audit_session`. We get answers back over the sampling
 * channel — `server.createMessage()` rides the same JSON-RPC session and
 * asks the *client* (the agent's host runtime) to run its own LLM and
 * return the result.
 *
 * The connector exists so the existing `runInterview()` loop keeps
 * working unchanged. It implements the `AgentConnector` interface and
 * holds the running message history (so each follow-up sees the prior
 * Q/A pairs).
 *
 * The wrapped `server` is the SDK's low-level `Server` object — reachable
 * from `McpServer.server` — not an `McpServer`. `McpServer` does not
 * expose `createMessage` directly. The test stub mirrors the same shape.
 */
export interface SamplingConnectorOptions {
  /** SDK `Server` instance — typically `mcpServer.server`. */
  server: Pick<Server, 'createMessage'>;
  /** Optional max-tokens budget per sampling call. Defaults to 1024. */
  maxTokens?: number;
  /** Optional system prompt to attach to every sampling call. */
  systemPrompt?: string;
  /**
   * Per-question request timeout in milliseconds. AAP-53.3 bug fix:
   * the MCP SDK default is 60s, which is too short for real-world
   * client LLM calls. Codex with GPT-5.5 routinely takes 30–90s per
   * question; if the client throttles or batches, individual sampling
   * round-trips can exceed 2 minutes. Heron raises the cap to 5
   * minutes by default and resets the timer on every progress
   * notification the client emits.
   */
  requestTimeoutMs?: number;
}

const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export class SamplingConnector implements AgentConnector {
  private readonly server: Pick<Server, 'createMessage'>;
  private readonly maxTokens: number;
  private readonly systemPrompt: string | undefined;
  private readonly requestTimeoutMs: number;
  private readonly history: SamplingMessage[] = [];
  private closed = false;

  constructor(opts: SamplingConnectorOptions) {
    this.server = opts.server;
    this.maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.systemPrompt = opts.systemPrompt;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  async sendMessage(message: string): Promise<string> {
    this.history.push({
      role: 'user',
      content: { type: 'text', text: message },
    });

    const params: CreateMessageRequestParamsBase = {
      messages: [...this.history],
      maxTokens: this.maxTokens,
      ...(this.systemPrompt !== undefined ? { systemPrompt: this.systemPrompt } : {}),
    };

    let result: CreateMessageResult;
    try {
      // SDK exposes overloads; we use the no-tools variant. Cast through
      // unknown so the test stub (a minimal Pick<Server, 'createMessage'>)
      // satisfies the call site without dragging in the full SDK type.
      // Pass an explicit request-timeout that survives slow client LLMs.
      result = (await this.server.createMessage(params, {
        timeout: this.requestTimeoutMs,
        resetTimeoutOnProgress: true,
      } as unknown as Parameters<typeof this.server.createMessage>[1])) as CreateMessageResult;
    } catch (err) {
      // Pull off the bookkeeping turn so a retried sendMessage doesn't
      // see a dangling user turn with no assistant reply.
      this.history.pop();
      throw new Error(
        `SamplingConnector: createMessage failed — ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const text = extractText(result);
    this.history.push({
      role: 'assistant',
      content: { type: 'text', text },
    });
    return text;
  }

  async getMetadata(): Promise<AgentMetadata> {
    return {
      provider: 'mcp-sampling',
      description: 'Audited agent answers via MCP sampling/createMessage',
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.history.length = 0;
  }
}

/**
 * Pull the assistant's text out of a CreateMessageResult. The SDK union
 * allows a single content block (text/image/audio/tool-use) or an array
 * of blocks. We concatenate text blocks and silently drop non-text.
 */
function extractText(result: CreateMessageResult): string {
  const c = result.content as unknown;
  if (Array.isArray(c)) {
    return c
      .map((block) => {
        if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
          return String((block as { text?: unknown }).text ?? '');
        }
        return '';
      })
      .join('');
  }
  if (c && typeof c === 'object' && (c as { type?: string }).type === 'text') {
    return String((c as { text?: unknown }).text ?? '');
  }
  return '';
}
