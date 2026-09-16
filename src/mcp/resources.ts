import { ResourceTemplate } from '@modelcontextprotocol/server';
import type { McpServer } from '@modelcontextprotocol/server';
import { toSafeUnexpectedError } from '../domain/errors.js';
import type { OperationService } from '../server/operationService.js';

/**
 * Bounded, read-only MCP resources (see docs/08-mcp-server-contract.md,
 * "Resources and Prompts"). None of these expose full hypercube data, load
 * scripts, connection secrets, security rules, or arbitrary files; they
 * return the same bounded DTOs as their corresponding read-only tool.
 */

function safeJsonContents(
  uriHref: string,
  payload: unknown,
): { contents: { uri: string; mimeType: string; text: string }[] } {
  return {
    contents: [
      { uri: uriHref, mimeType: 'application/json', text: JSON.stringify(payload, null, 2) },
    ],
  };
}

async function readSafely(uriHref: string, fn: () => Promise<unknown>) {
  try {
    return safeJsonContents(uriHref, await fn());
  } catch (error) {
    return safeJsonContents(uriHref, { error: toSafeUnexpectedError(error).toEnvelope() });
  }
}

export function registerResources(server: McpServer, service: OperationService): void {
  server.registerResource(
    'qlik-connections',
    'qlik://connections',
    {
      title: 'Configured Qlik connections',
      description: 'Connection aliases and environments configured in the server policy.',
      mimeType: 'application/json',
    },
    async (uri) => readSafely(uri.href, async () => ({ connections: service.listConnections() })),
  );

  server.registerResource(
    'qlik-connection-apps',
    new ResourceTemplate('qlik://connection/{connection}/apps', { list: undefined }),
    {
      title: 'Accessible apps for a connection',
      description: 'Policy-allowed, caller-authorized apps for a connection alias.',
      mimeType: 'application/json',
    },
    async (uri, variables) =>
      readSafely(uri.href, () => service.listApps(String(variables.connection))),
  );

  server.registerResource(
    'qlik-app-catalog',
    new ResourceTemplate('qlik://connection/{connection}/app/{appId}/catalog', { list: undefined }),
    {
      title: 'Bounded semantic catalog for an app',
      description:
        'Bounded fields, master items, sheets, and native chart-type support for an app.',
      mimeType: 'application/json',
    },
    async (uri, variables) =>
      readSafely(uri.href, () =>
        service.getAppCatalog(String(variables.connection), String(variables.appId)),
      ),
  );

  server.registerResource(
    'qlik-operation',
    new ResourceTemplate('qlik://operations/{operationId}', { list: undefined }),
    {
      title: 'Sanitized operation status',
      description:
        'The sanitized operation/audit record for an operation ID, visible only to its owning actor.',
      mimeType: 'application/json',
    },
    async (uri, variables) =>
      readSafely(uri.href, () => service.getOperation(String(variables.operationId))),
  );
}
