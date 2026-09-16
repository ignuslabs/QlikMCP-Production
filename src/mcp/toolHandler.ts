import { toSafeUnexpectedError } from '../domain/errors.js';
import type { CallToolResult } from '@modelcontextprotocol/server';

/**
 * Wraps a core-service call as a strict MCP `CallToolResult`. On success it
 * returns both a concise text summary and `structuredContent` validated
 * against the tool's output schema (see docs/08-mcp-server-contract.md,
 * "Return structured output plus concise text"). On any thrown error it
 * returns a sanitized typed-error envelope as `isError: true` text content
 * and omits `structuredContent` entirely, so the tool's strict output schema
 * is never asked to validate an error shape.
 */
export async function runTool<T extends object>(
  fn: () => Promise<T>,
  toText: (result: T) => string,
): Promise<CallToolResult> {
  try {
    const result = await fn();
    return {
      content: [{ type: 'text', text: toText(result) }],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  } catch (error) {
    const safe = toSafeUnexpectedError(error);
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify(safe.toEnvelope()) }],
    };
  }
}
