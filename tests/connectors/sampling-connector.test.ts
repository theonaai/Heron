import { describe, it, expect, vi } from 'vitest';

import { SamplingConnector } from '../../src/connectors/sampling-connector.js';

/**
 * Stubs the bits of the SDK Server we touch: `createMessage`.
 * Returns whatever the test supplies, otherwise a canned text response.
 */
function makeServerStub(replies: string[] | ((calls: number) => string)) {
  let i = 0;
  const calls: Array<{
    messages: unknown;
    maxTokens?: number;
    systemPrompt?: string;
  }> = [];
  return {
    server: {
      createMessage: vi.fn(async (params: {
        messages: unknown;
        maxTokens?: number;
        systemPrompt?: string;
      }) => {
        calls.push({
          messages: params.messages,
          maxTokens: params.maxTokens,
          systemPrompt: params.systemPrompt,
        });
        const text = typeof replies === 'function'
          ? replies(i++)
          : replies[Math.min(i++, replies.length - 1)];
        return {
          role: 'assistant',
          content: { type: 'text', text },
          model: 'stub-model',
          stopReason: 'endTurn',
        };
      }),
    },
    calls,
  };
}

describe('SamplingConnector', () => {
  it('returns the assistant text for a single question', async () => {
    const stub = makeServerStub(['I send PII to a Google Sheet.']);
    const conn = new SamplingConnector({ server: stub.server as never });

    const answer = await conn.sendMessage('Describe your data flow');

    expect(answer).toBe('I send PII to a Google Sheet.');
    expect(stub.server.createMessage).toHaveBeenCalledTimes(1);
  });

  it('accumulates conversation history across turns', async () => {
    const stub = makeServerStub(['First.', 'Second.']);
    const conn = new SamplingConnector({ server: stub.server as never });

    await conn.sendMessage('Q1');
    await conn.sendMessage('Q2');

    const params2 = stub.calls[1]!;
    const msgs = params2.messages as Array<{ role: string; content: { type: string; text: string } }>;
    // Q1, A1, Q2 must all appear in turn 2's history
    expect(msgs.length).toBeGreaterThanOrEqual(3);
    expect(msgs[0]!.role).toBe('user');
    expect(msgs[0]!.content.text).toBe('Q1');
    expect(msgs[1]!.role).toBe('assistant');
    expect(msgs[1]!.content.text).toBe('First.');
    expect(msgs[2]!.role).toBe('user');
    expect(msgs[2]!.content.text).toBe('Q2');
  });

  it('handles array-content responses by concatenating text blocks', async () => {
    const server = {
      createMessage: vi.fn(async () => ({
        role: 'assistant',
        content: [
          { type: 'text', text: 'Part one. ' },
          { type: 'text', text: 'Part two.' },
        ],
        model: 'stub-model',
        stopReason: 'endTurn',
      })),
    };
    const conn = new SamplingConnector({ server: server as never });

    const answer = await conn.sendMessage('Q');

    expect(answer).toBe('Part one. Part two.');
  });

  it('returns a metadata blob describing the sampling channel', async () => {
    const stub = makeServerStub(['ignored']);
    const conn = new SamplingConnector({ server: stub.server as never });

    const meta = await conn.getMetadata();

    expect(meta.provider).toBe('mcp-sampling');
  });

  it('close() is idempotent and does not throw', async () => {
    const stub = makeServerStub(['ignored']);
    const conn = new SamplingConnector({ server: stub.server as never });

    await expect(conn.close()).resolves.toBeUndefined();
    await expect(conn.close()).resolves.toBeUndefined();
  });

  it('passes a maxTokens budget to the sampling call', async () => {
    const stub = makeServerStub(['ok']);
    const conn = new SamplingConnector({ server: stub.server as never, maxTokens: 1234 });

    await conn.sendMessage('Q');

    expect(stub.calls[0]!.maxTokens).toBe(1234);
  });

  it('surfaces a useful error when createMessage rejects', async () => {
    const server = {
      createMessage: vi.fn(async () => {
        throw new Error('client refused sampling');
      }),
    };
    const conn = new SamplingConnector({ server: server as never });

    await expect(conn.sendMessage('Q')).rejects.toThrow(/client refused sampling/);
  });
});
