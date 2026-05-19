import type { TargetConfig } from '../config/schema.js';
import type { AgentConnector } from './types.js';
import { InteractiveConnector } from './interactive-connector.js';

// AAP-52: HttpConnector was removed alongside the audit_agent MCP tool.
// The MCP-sampling path (`start_audit_session`) uses SamplingConnector
// instead — instantiated directly inside the tool handler, not via
// this factory. The interactive connector stays for the legacy CLI
// "manual relay" flow.

export function createConnector(config: TargetConfig): AgentConnector {
  switch (config.type) {
    case 'interactive':
      return new InteractiveConnector();
    default:
      throw new Error(`Unknown connector type: ${config.type}`);
  }
}

export type { AgentConnector, AgentMetadata } from './types.js';
