import { describe, expect, it } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import {
  buildMcpServer,
  parseMcpToolProfile,
  SERVER_INSTRUCTIONS,
  serverInstructionsForProfile,
  type McpToolProfile,
} from '../../../src/mcp/server.js';
import { buildTestService } from '../../helpers/testContext.js';

const REQUESTER_TOOLS = [
  'qlik_apply_visualization',
  'qlik_plan_sheet',
  'qlik_preview_sheet',
  'qlik_apply_sheet',
  'qlik_verify_sheet',
  'qlik_get_app_catalog',
  'qlik_get_operation',
  'qlik_get_readiness',
  'qlik_get_visualization_approval',
  'qlik_list_apps',
  'qlik_list_sheet_objects',
  'qlik_plan_visualization',
  'qlik_preview_visualization',
  'qlik_request_visualization_approval',
].sort();

const REVIEWER_TOOLS = [
  'qlik_approve_visualization_request',
  'qlik_get_visualization_approval',
  'qlik_reject_visualization_request',
].sort();

async function listToolNames(profile?: McpToolProfile): Promise<string[]> {
  const server = buildMcpServer(buildTestService().service, profile);
  const client = new Client({ name: `profile-${profile ?? 'default'}`, version: '1' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return (await client.listTools()).tools.map((tool) => tool.name).sort();
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
}

describe('MCP facade profiles', () => {
  it('keeps the default and explicit all profiles on the canonical 16 tools', async () => {
    const defaults = await listToolNames();
    const all = await listToolNames('all');
    expect(defaults).toHaveLength(16);
    expect(all).toEqual(defaults);
  });

  it('exposes the 14 requester tools without reviewer decision actions', async () => {
    expect(await listToolNames('requester')).toEqual(REQUESTER_TOOLS);
  });

  it('exposes only approval lookup and decision tools to a reviewer', async () => {
    expect(await listToolNames('reviewer')).toEqual(REVIEWER_TOOLS);
  });

  it('exposes only approval lookup to a verifier', async () => {
    expect(await listToolNames('verifier')).toEqual(['qlik_get_visualization_approval']);
  });

  it('defaults an omitted role to all and rejects unknown roles', () => {
    expect(parseMcpToolProfile(undefined)).toBe('all');
    expect(parseMcpToolProfile('')).toBe('all');
    expect(parseMcpToolProfile(' requester ')).toBe('requester');
    expect(() => parseMcpToolProfile('administrator')).toThrow(
      'QLIK_HARNESS_MCP_ROLE must be one of',
    );
  });

  it('publishes a concise, self-contained fail-closed workflow instruction', () => {
    expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(512);
    expect(SERVER_INSTRUCTIONS).toContain('call qlik_get_readiness');
    expect(SERVER_INSTRUCTIONS).toContain('separately authenticated reviewer');
    expect(SERVER_INSTRUCTIONS).toContain('apply only the unchanged approved plan');
    expect(SERVER_INSTRUCTIONS).toContain('Fail closed');
    for (const profile of ['all', 'requester', 'reviewer', 'verifier'] as const) {
      expect(serverInstructionsForProfile(profile).length).toBeLessThanOrEqual(512);
    }
    expect(serverInstructionsForProfile('requester')).toContain('then stop');
    expect(serverInstructionsForProfile('reviewer')).not.toContain('qlik_get_readiness');
    expect(serverInstructionsForProfile('verifier')).not.toContain('apply only');
  });
});
