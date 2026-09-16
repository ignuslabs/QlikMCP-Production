import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { OperationService } from '../../server/operationService.js';
import { runTool } from '../toolHandler.js';

const inputSchema = z.object({}).strict();

const adapterSchema = z
  .object({
    connection: z.string(),
    platform: z.enum(['fixture', 'cloud', 'windows']),
    configured: z.boolean(),
    canRead: z.boolean(),
    canPreview: z.boolean(),
    canWriteDesignatedSheet: z.boolean(),
    cleanupVerified: z.boolean(),
    reason: z.string(),
  })
  .strict();

const outputSchema = z
  .object({
    status: z.enum(['ready', 'degraded']),
    service: z.object({ ready: z.literal(true), adapterCount: z.number().int().min(0) }).strict(),
    adapters: z.array(adapterSchema),
  })
  .strict();

export function registerGetReadiness(server: McpServer, service: OperationService): void {
  server.registerTool(
    'qlik_get_readiness',
    {
      title: 'Get harness readiness',
      description:
        'Reports sanitized service and adapter readiness for allowlisted connections. Performs no live target calls and exposes no credentials or secret configuration.',
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () =>
      runTool(
        () => service.getReadiness(),
        (result) => `Qlik AI Harness readiness is ${result.status}.`,
      ),
  );
}
