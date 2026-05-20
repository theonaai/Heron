import { describe, it, expect } from 'vitest';
import {
  analysisResultSchema,
  systemAssessmentSchema,
  auditReportSchema,
  severitySchema,
  blastRadiusSchema,
  qaPairSchema,
  writeOperationSchema,
  riskSchema,
} from '../../src/report/types.js';

describe('Zod schemas', () => {
  describe('severitySchema', () => {
    it('accepts valid severity levels', () => {
      expect(severitySchema.parse('low')).toBe('low');
      expect(severitySchema.parse('medium')).toBe('medium');
      expect(severitySchema.parse('high')).toBe('high');
      expect(severitySchema.parse('critical')).toBe('critical');
    });

    it('normalizes unknown severity to medium', () => {
      expect(severitySchema.parse('extreme')).toBe('medium');
      expect(severitySchema.parse('info')).toBe('low');
      expect(severitySchema.parse('none')).toBe('low');
    });
  });

  describe('blastRadiusSchema', () => {
    it('accepts valid blast radius levels', () => {
      expect(blastRadiusSchema.parse('single-record')).toBe('single-record');
      expect(blastRadiusSchema.parse('single-user')).toBe('single-user');
      expect(blastRadiusSchema.parse('team-scope')).toBe('team-scope');
      expect(blastRadiusSchema.parse('org-wide')).toBe('org-wide');
      expect(blastRadiusSchema.parse('cross-tenant')).toBe('cross-tenant');
    });

    it('rejects invalid blast radius', () => {
      expect(() => blastRadiusSchema.parse('global')).toThrow();
    });
  });

  describe('qaPairSchema', () => {
    it('validates a valid QA pair', () => {
      const result = qaPairSchema.parse({
        question: 'What do you do?',
        answer: 'Process invoices',
        category: 'purpose',
      });
      expect(result.category).toBe('purpose');
    });

    it('rejects invalid category', () => {
      expect(() => qaPairSchema.parse({
        question: 'Q',
        answer: 'A',
        category: 'invalid',
      })).toThrow();
    });
  });

  describe('writeOperationSchema', () => {
    it('validates a complete write operation', () => {
      const result = writeOperationSchema.parse({
        operation: 'Update status',
        target: 'Invoice records',
        reversible: true,
        approvalRequired: false,
        volumePerDay: '150/day',
      });
      expect(result.reversible).toBe(true);
    });

    it('rejects missing required fields', () => {
      expect(() => writeOperationSchema.parse({
        operation: 'Update',
      })).toThrow();
    });
  });

  describe('systemAssessmentSchema', () => {
    it('validates a complete system assessment', () => {
      const result = systemAssessmentSchema.parse({
        // AAP-65: kebab-case short identifier required by tightened schema.
        systemId: 'gmail-api',
        systemDescription: 'Gmail API via OAuth2',
        scopesRequested: ['gmail.readonly', 'gmail.send'],
        scopesNeeded: ['gmail.readonly'],
        scopesDelta: ['gmail.send'],
        dataSensitivity: 'PII — email subjects and sender addresses',
        blastRadius: 'single-user',
        frequencyAndVolume: '15 times/day, batch of 1',
        writeOperations: [{
          operation: 'Create draft',
          target: 'User mailbox',
          reversible: true,
          approvalRequired: false,
          volumePerDay: '10',
        }],
      });
      expect(result.systemId).toBe('gmail-api');
      expect(result.systemDescription).toContain('Gmail');
      expect(result.scopesDelta).toEqual(['gmail.send']);
    });

    it('accepts empty arrays', () => {
      const result = systemAssessmentSchema.parse({
        systemId: 'read-only-api',
        scopesRequested: [],
        scopesNeeded: [],
        scopesDelta: [],
        dataSensitivity: 'None',
        blastRadius: 'single-record',
        frequencyAndVolume: 'Rarely',
        writeOperations: [],
      });
      expect(result.writeOperations).toEqual([]);
    });

    it('rejects missing systemId', () => {
      expect(() => systemAssessmentSchema.parse({
        scopesRequested: [],
        scopesNeeded: [],
        scopesDelta: [],
        dataSensitivity: 'None',
        blastRadius: 'single-record',
        frequencyAndVolume: 'Rarely',
        writeOperations: [],
      })).toThrow();
    });

    // AAP-65: tightened systemId shape.
    it('rejects prose-shaped systemId (sentence)', () => {
      expect(() => systemAssessmentSchema.parse({
        systemId: 'Codex desktop app local agent session -> OpenAI-hosted backend; not visible (A3, A4).',
        scopesRequested: [],
        scopesNeeded: [],
        scopesDelta: [],
        dataSensitivity: '',
        blastRadius: 'single-user',
        frequencyAndVolume: '',
        writeOperations: [],
      })).toThrow();
    });

    it('rejects systemId with capital letters or spaces', () => {
      expect(() => systemAssessmentSchema.parse({
        systemId: 'Gmail API via OAuth2',
        scopesRequested: [],
        scopesNeeded: [],
        scopesDelta: [],
        dataSensitivity: '',
        blastRadius: 'single-user',
        frequencyAndVolume: '',
        writeOperations: [],
      })).toThrow();
    });

    it('accepts kebab-case systemId', () => {
      const result = systemAssessmentSchema.parse({
        systemId: 'openai-codex-backend',
        scopesRequested: [],
        scopesNeeded: [],
        scopesDelta: [],
        dataSensitivity: '',
        blastRadius: 'single-user',
        frequencyAndVolume: '',
        writeOperations: [],
      });
      expect(result.systemId).toBe('openai-codex-backend');
    });
  });

  describe('riskSchema', () => {
    it('validates risk with optional mitigation', () => {
      const result = riskSchema.parse({
        severity: 'high',
        title: 'Excessive access',
        description: 'Agent has more than needed',
      });
      expect(result.mitigation).toBeUndefined();
    });

    it('validates risk with mitigation', () => {
      const result = riskSchema.parse({
        severity: 'high',
        title: 'Excessive access',
        description: 'Agent has more than needed',
        mitigation: 'Restrict to read-only',
      });
      expect(result.mitigation).toBe('Restrict to read-only');
    });
  });

  describe('analysisResultSchema', () => {
    it('validates a complete analysis result', () => {
      const result = analysisResultSchema.parse({
        summary: 'Test summary',
        agentPurpose: 'Process invoices',
        systems: [{
          // AAP-65: kebab-case short identifier required.
          systemId: 'sap',
          scopesRequested: ['read'],
          scopesNeeded: ['read'],
          scopesDelta: [],
          dataSensitivity: 'Financial',
          blastRadius: 'team-scope',
          frequencyAndVolume: '50/day',
          writeOperations: [],
        }],
        risks: [],
        recommendations: ['Test recommendation'],
        overallRiskLevel: 'low',
      });
      expect(result.systems.length).toBe(1);
    });

    it('accepts optional fields', () => {
      const result = analysisResultSchema.parse({
        summary: 'Test',
        agentPurpose: 'Test',
        agentTrigger: 'Webhook',
        agentOwner: 'DevOps team',
        systems: [],
        risks: [],
        recommendations: [],
        recommendation: 'APPROVE',
        overallRiskLevel: 'low',
      });
      expect(result.agentTrigger).toBe('Webhook');
      expect(result.recommendation).toBe('APPROVE');
    });

    it('rejects missing required fields', () => {
      expect(() => analysisResultSchema.parse({
        summary: 'Test',
      })).toThrow();
    });
  });
});
