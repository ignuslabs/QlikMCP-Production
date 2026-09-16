import { describe, expect, it } from 'vitest';
import { nativeChartTypeSchema } from '../../../src/mcp/schemas.js';

describe('MCP output schemas', () => {
  it('accepts the native sn-table type returned by current table plans', () => {
    expect(nativeChartTypeSchema.parse('sn-table')).toBe('sn-table');
  });
});
