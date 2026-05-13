#!/usr/bin/env node
// Minimal MCP server used by tests/connectors/mcp-client.integration.test.ts.
// Speaks MCP over stdio and exposes three trivial tools, one of which carries
// a destructive-hint annotation so the client integration test can assert
// annotations round-trip end-to-end.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'stdio-test-server', version: '0.0.1' });

server.registerTool(
  'echo',
  {
    description: 'Echo the input string back.',
    inputSchema: { message: z.string() },
  },
  async ({ message }) => ({ content: [{ type: 'text', text: message }] }),
);

server.registerTool(
  'list_files',
  {
    description: 'List filenames in a fake directory listing.',
    inputSchema: { dir: z.string() },
    annotations: { readOnlyHint: true },
  },
  async ({ dir }) => ({ content: [{ type: 'text', text: `files in ${dir}` }] }),
);

server.registerTool(
  'fake_delete',
  {
    description: 'Pretend to delete something — for destructive-hint testing.',
    inputSchema: { target: z.string() },
    annotations: { destructiveHint: true, idempotentHint: false },
  },
  async ({ target }) => ({ content: [{ type: 'text', text: `deleted ${target}` }] }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
