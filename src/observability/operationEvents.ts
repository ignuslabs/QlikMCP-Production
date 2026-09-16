import type { OperationRecord } from '../domain/types.js';
import type { Logger } from '../logging/logger.js';
import { rootLogger } from '../logging/logger.js';

/**
 * A vendor-neutral event envelope that can be mapped directly to an
 * OpenTelemetry LogRecord. Attribute names follow OTel naming conventions;
 * the operation/audit record remains the system of record.
 */
export interface OperationEvent {
  readonly eventName: 'qlik.harness.operation';
  readonly timestamp: string;
  readonly severityText: 'INFO' | 'WARN' | 'ERROR';
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
}

export interface OperationEventSink {
  emit(event: OperationEvent): void | Promise<void>;
}

export function operationEventFromRecord(record: OperationRecord): OperationEvent {
  const failed =
    record.typedOutcome.status === 'failed' || record.typedOutcome.status === 'cleanup-required';
  const category = record.typedOutcome.category ?? 'none';
  const severityText = failed
    ? category === 'capacity' || category === 'rate-limit'
      ? 'WARN'
      : 'ERROR'
    : 'INFO';

  return {
    eventName: 'qlik.harness.operation',
    timestamp: record.timestamp,
    severityText,
    attributes: {
      'service.name': 'qlik-ai-harness',
      'event.name': 'qlik.harness.operation',
      'qlik.operation.id': record.operationId,
      'qlik.correlation.id': record.correlationId,
      'qlik.connection.alias': record.connectionAlias,
      'qlik.platform': record.platform,
      'qlik.operation.status': record.typedOutcome.status,
      'qlik.error.category': category,
      'qlik.error.code': record.typedOutcome.code ?? 'none',
      'qlik.policy.result': record.policyResult,
      'qlik.approval.state': record.approvalState,
      'qlik.retry.count': record.retryCount,
      'qlik.duration.ms': record.durationMilliseconds,
      'qlik.cleanup.required': record.typedOutcome.cleanupRequired ?? false,
      'qlik.redaction.credential_material_present': record.redaction.credentialMaterialPresent,
    },
  };
}

export class LoggerOperationEventSink implements OperationEventSink {
  constructor(private readonly logger: Logger = rootLogger) {}

  emit(event: OperationEvent): void {
    const context = { severityText: event.severityText, ...event.attributes };
    if (event.severityText === 'ERROR') this.logger.error(event.eventName, context);
    else if (event.severityText === 'WARN') this.logger.warn(event.eventName, context);
    else this.logger.info(event.eventName, context);
  }
}
