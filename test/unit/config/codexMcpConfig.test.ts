import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const launcher = readFileSync(path.join(repoRoot, 'scripts', 'mcp', 'start.mjs'), 'utf8');
const launcherLibrary = readFileSync(
  path.join(repoRoot, 'scripts', 'mcp', 'launcher-lib.mjs'),
  'utf8',
);
const exampleConfig = readFileSync(path.join(repoRoot, '.codex', 'config.example.toml'), 'utf8');
const gitignore = readFileSync(path.join(repoRoot, '.gitignore'), 'utf8');

const requesterTools = [
  'qlik_get_readiness',
  'qlik_list_apps',
  'qlik_get_app_catalog',
  'qlik_list_sheet_objects',
  'qlik_plan_visualization',
  'qlik_preview_visualization',
  'qlik_request_visualization_approval',
  'qlik_get_visualization_approval',
  'qlik_apply_visualization',
  'qlik_get_operation',
] as const;

const reviewerTools = [
  'qlik_get_visualization_approval',
  'qlik_approve_visualization_request',
  'qlik_reject_visualization_request',
] as const;

const verifierTools = ['qlik_get_visualization_approval'] as const;

function tableBody(tableName: string): string {
  const header = `[${tableName}]\n`;
  const start = exampleConfig.indexOf(header);
  if (start < 0) throw new Error(`Missing TOML table ${tableName}.`);
  const remainder = exampleConfig.slice(start + header.length);
  const nextTable = remainder.search(/^\[/m);
  return nextTable < 0 ? remainder : remainder.slice(0, nextTable);
}

function enabledTools(tableName: string): string[] {
  const body = tableBody(tableName);
  const match = body.match(/enabled_tools\s*=\s*\[([\s\S]*?)\]/);
  if (!match?.[1]) throw new Error(`Missing enabled_tools in ${tableName}.`);
  return [...match[1].matchAll(/"([^"]+)"/g)].flatMap((entry) =>
    entry[1] === undefined ? [] : [entry[1]],
  );
}

describe('Codex project MCP configuration', () => {
  it('keeps machine-specific configuration local and the tracked template secret-free', () => {
    expect(gitignore.split('\n')).toContain('.codex/config.toml');
    expect(exampleConfig).toContain('__REPOSITORY_ROOT__');
    expect(exampleConfig).toContain('__ABSOLUTE_NODE_BINARY__');
    expect(exampleConfig).toContain('__ABSOLUTE_STATE_DIRECTORY__');
    expect(exampleConfig).toContain('__KEYCHAIN_ACCOUNT__');
    expect(exampleConfig).toContain('__KEYCHAIN_SERVICE__');
    expect(exampleConfig).toContain('__REQUESTER_ACTOR__');
    expect(exampleConfig).toContain('__REVIEWER_ACTOR__');
    expect(exampleConfig).toContain('__POWERSHELL_SECRET_NAME__');
    expect(exampleConfig).toContain('__POWERSHELL_SECRET_VAULT__');
    expect(exampleConfig).not.toContain('/Users/');
    expect(exampleConfig).not.toContain('joecorella');
    expect(exampleConfig).not.toMatch(/QLIK_CLOUD_OAUTH_CLIENT_SECRET\s*=/);
  });

  it('defines separate least-privilege requester and reviewer tool allowlists', () => {
    expect(enabledTools('mcp_servers.qlik_requester')).toEqual(requesterTools);
    expect(enabledTools('mcp_servers.qlik_reviewer')).toEqual(reviewerTools);
    expect(enabledTools('mcp_servers.qlik_verifier')).toEqual(verifierTools);
    expect(tableBody('mcp_servers.qlik_requester')).toContain(
      'default_tools_approval_mode = "writes"',
    );
    expect(tableBody('mcp_servers.qlik_reviewer')).toContain(
      'default_tools_approval_mode = "prompt"',
    );
    expect(tableBody('mcp_servers.qlik_requester.env')).toContain(
      'QLIK_CODEX_MCP_ACTOR = "__REQUESTER_ACTOR__"',
    );
    expect(tableBody('mcp_servers.qlik_reviewer.env')).toContain(
      'QLIK_CODEX_MCP_ACTOR = "__REVIEWER_ACTOR__"',
    );
    expect(tableBody('mcp_servers.qlik_verifier.env')).toContain(
      'QLIK_CODEX_MCP_ACTOR = "__REQUESTER_ACTOR__"',
    );
    const requesterActor = tableBody('mcp_servers.qlik_requester.env').match(
      /QLIK_CODEX_MCP_ACTOR = "([^"]+)"/u,
    )?.[1];
    const verifierActor = tableBody('mcp_servers.qlik_verifier.env').match(
      /QLIK_CODEX_MCP_ACTOR = "([^"]+)"/u,
    )?.[1];
    expect(verifierActor).toBe(requesterActor);
    for (const tableName of [
      'mcp_servers.qlik_requester.env',
      'mcp_servers.qlik_reviewer.env',
      'mcp_servers.qlik_verifier.env',
    ]) {
      const body = tableBody(tableName);
      expect(body).toContain('QLIK_HARNESS_MUTATION_ACTORS = "__REQUESTER_ACTOR__"');
      expect(body).toContain('QLIK_HARNESS_REVIEWER_ACTORS = "__REVIEWER_ACTOR__"');
    }
    for (const tableName of [
      'mcp_servers.qlik_requester',
      'mcp_servers.qlik_reviewer',
      'mcp_servers.qlik_verifier',
    ]) {
      const body = tableBody(tableName);
      expect(body).toContain('command = "__ABSOLUTE_NODE_BINARY__"');
      expect(body).toContain('"--state-dir", "__ABSOLUTE_STATE_DIRECTORY__"');
      expect(body).toContain('/scripts/mcp/start.mjs');
    }
    expect(tableBody('mcp_servers.qlik_reviewer.tools.qlik_get_visualization_approval')).toContain(
      'approval_mode = "approve"',
    );
    expect(tableBody('mcp_servers.qlik_requester.tools.qlik_preview_visualization').trim()).toBe(
      'approval_mode = "approve"',
    );
    expect(
      tableBody('mcp_servers.qlik_requester.tools.qlik_request_visualization_approval').trim(),
    ).toBe('approval_mode = "approve"');
    expect(tableBody('mcp_servers.qlik_requester.tools.qlik_apply_visualization').trim()).toBe(
      'approval_mode = "approve"',
    );
    expect(exampleConfig).not.toContain(
      '[mcp_servers.qlik_reviewer.tools.qlik_approve_visualization_request]',
    );
    expect(exampleConfig).not.toContain(
      '[mcp_servers.qlik_reviewer.tools.qlik_reject_visualization_request]',
    );
  });

  it('uses the portable launcher to isolate credentials by role', () => {
    expect(launcher).toContain('configureRequesterSecret');
    expect(launcher).toContain('applyRoleEnvironment');
    expect(launcherLibrary).toContain("'/usr/bin/security'");
    expect(launcherLibrary).toContain("'find-generic-password'");
    expect(launcherLibrary).toContain("'powershell-secretmanagement'");
    expect(launcherLibrary).toContain('credentialEnvironmentNames');
    expect(launcherLibrary).not.toMatch(/security[^\n]*-g/u);
    expect(launcherLibrary).not.toMatch(/(?:echo|printf)[^\n]*OAuth/u);
  });
});
