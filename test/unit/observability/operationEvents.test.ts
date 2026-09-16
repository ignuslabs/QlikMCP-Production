import { describe, expect, it } from 'vitest';
import { operationEventFromRecord } from '../../../src/observability/operationEvents.js';
import type { OperationRecord } from '../../../src/domain/types.js';

function record(overrides: Partial<OperationRecord> = {}): OperationRecord {
  return {
    recordVersion: '1.0.0',
    recordType: 'sanitized-operation-audit',
    operationId: 'op-fixture',
    timestamp: '2026-08-06T00:00:00.000Z',
    correlationId: 'corr-fixture',
    requestingPrincipal: 'fixture-actor',
    hostClientId: 'fixture-host',
    connectionAlias: 'cloud-dev',
    platform: 'cloud',
    target: { appId: 'app-fixture', sheetId: 'sheet-fixture' },
    effectiveQlikIdentityClass: 'cloud-development-workload',
    intentVersion: '1.0.0',
    compilerVersion: '1.0.0',
    policyResult: 'allowed',
    approvalState: 'consumed',
    typedOutcome: { status: 'verified' },
    retryCount: 0,
    durationMilliseconds: 12,
    cleanupAttempted: false,
    cleanupOutcome: 'not-required',
    createdObjectId: 'object-fixture',
    traceReference: 'trace-fixture',
    redaction: {
      rawPayloadsRemoved: true,
      sensitiveValuesRemoved: true,
      credentialMaterialPresent: false,
    },
    ...overrides,
  };
}

describe('OpenTelemetry-compatible operation events', () => {
  it('maps successful audit records to low-cardinality INFO attributes', () => {
    const event = operationEventFromRecord(record());
    expect(event.severityText).toBe('INFO');
    expect(event.attributes).toMatchObject({
      'service.name': 'qlik-ai-harness',
      'event.name': 'qlik.harness.operation',
      'qlik.operation.status': 'verified',
      'qlik.redaction.credential_material_present': false,
    });
    expect(JSON.stringify(event)).not.toContain('object-fixture');
  });

  it('marks capacity failures as WARN and security failures as ERROR', () => {
    const capacity = operationEventFromRecord(
      record({
        typedOutcome: { status: 'failed', category: 'capacity', code: 'CAPACITY_EXHAUSTED' },
      }),
    );
    const security = operationEventFromRecord(
      record({
        typedOutcome: { status: 'failed', category: 'authorization', code: 'PERMISSION_DENIED' },
      }),
    );
    expect(capacity.severityText).toBe('WARN');
    expect(security.severityText).toBe('ERROR');
  });
});
