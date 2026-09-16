import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('MCP 2026 STDIO compatibility', () => {
  it('negotiates modern discovery and preserves a plan between requests', async () => {
    const client = new Client(
      { name: 'modern-stdio-conformance', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(root, 'node_modules/tsx/dist/cli.mjs'), path.join(root, 'src/index.ts')],
      cwd: root,
      env: {
        PATH: process.env.PATH ?? '',
        QLIK_HARNESS_TARGET_MODE: 'fixture',
        QLIK_HARNESS_MCP_ROLE: 'requester',
        QLIK_HARNESS_ACTOR: 'local-dev-actor',
      },
      stderr: 'pipe',
    });
    try {
      await client.connect(transport);
      expect(client.getProtocolEra()).toBe('modern');
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain('qlik_plan_sheet');
      expect(tools.tools.map((tool) => tool.name)).not.toContain(
        'qlik_approve_visualization_request',
      );
      const planned = await client.callTool({
        name: 'qlik_plan_visualization',
        arguments: {
          connection: 'cloud-dev',
          appId: 'app-sales-cloud-dev',
          sheetId: 'sheet-sales-overview-cloud-dev',
          intent: {
            analysis: { dimensions: ['Region'], measures: ['Revenue'] },
            presentation: { preferredChartType: 'bar', title: 'Protocol verification', topN: 5 },
          },
        },
      });
      expect(planned.isError).not.toBe(true);
      const plan = planned.structuredContent as { planHash: string };
      const previewed = await client.callTool({
        name: 'qlik_preview_visualization',
        arguments: { planHash: plan.planHash },
      });
      expect(previewed.isError).not.toBe(true);
      expect((previewed.structuredContent as { status: string }).status).toBe('previewed');
    } finally {
      await client.close();
    }
  });
});
