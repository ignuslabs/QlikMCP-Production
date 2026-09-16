import { redactForAudit } from '../domain/redaction.js';
import type { OperationRecord } from '../domain/types.js';
import {
  configuredStatePath,
  isRecord,
  readJsonState,
  requireString,
  withStateFileLockSync,
  writeJsonStateAtomic,
} from './filePersistence.js';

export interface OperationStore {
  save(record: OperationRecord): Promise<void>;
  get(operationId: string): Promise<OperationRecord | undefined>;
  getForActor(operationId: string, actor: string): Promise<OperationRecord | undefined>;
  history(operationId?: string): Promise<readonly OperationRecord[]>;
}

export class InMemoryOperationStore implements OperationStore {
  protected records = new Map<string, OperationRecord>();
  protected events: OperationRecord[] = [];

  async save(record: OperationRecord): Promise<void> {
    const safe = redactForAudit(record);
    this.records.set(safe.operationId, safe);
    this.events.push(safe);
  }

  async get(operationId: string): Promise<OperationRecord | undefined> {
    return this.records.get(operationId);
  }

  async getForActor(operationId: string, actor: string): Promise<OperationRecord | undefined> {
    return [...this.events]
      .reverse()
      .find((record) => record.operationId === operationId && record.requestingPrincipal === actor);
  }

  async history(operationId?: string): Promise<readonly OperationRecord[]> {
    return operationId
      ? this.events.filter((record) => record.operationId === operationId)
      : [...this.events];
  }
}

interface OperationStateFile {
  readonly version: 1;
  readonly latest: Readonly<Record<string, OperationRecord>>;
  readonly history: readonly OperationRecord[];
}

const OPERATION_PHASES = new Set([
  'discovered',
  'planned',
  'previewed',
  'approval-requested',
  'approved',
  'applying',
  'verified',
  'failed',
  'cleanup-required',
  'expired',
  'replayed',
]);

export function validateOperationRecord(value: unknown): OperationRecord {
  if (!isRecord(value)) throw new Error('Durable operation entry must be an object.');
  for (const key of [
    'recordVersion',
    'recordType',
    'operationId',
    'timestamp',
    'correlationId',
    'requestingPrincipal',
    'hostClientId',
    'connectionAlias',
    'platform',
    'effectiveQlikIdentityClass',
    'intentVersion',
    'compilerVersion',
    'policyResult',
    'approvalState',
    'cleanupOutcome',
    'traceReference',
  ]) {
    requireString(value, key);
  }
  if (value.recordVersion !== '1.0.0' || value.recordType !== 'sanitized-operation-audit') {
    throw new Error('Durable operation entry has an unsupported record version or type.');
  }
  if (!isRecord(value.target) || !isRecord(value.typedOutcome) || !isRecord(value.redaction)) {
    throw new Error('Durable operation entry is missing structured audit fields.');
  }
  requireString(value.target, 'appId');
  if (value.target.sheetId !== undefined && typeof value.target.sheetId !== 'string') {
    throw new Error('Durable operation target sheetId must be a string when present.');
  }
  if (!OPERATION_PHASES.has(requireString(value.typedOutcome, 'status'))) {
    throw new Error('Durable operation entry has an invalid outcome status.');
  }
  if (
    typeof value.retryCount !== 'number' ||
    typeof value.durationMilliseconds !== 'number' ||
    typeof value.cleanupAttempted !== 'boolean'
  ) {
    throw new Error('Durable operation entry has invalid numeric or boolean fields.');
  }
  if (
    (value.createdObjectId !== null && typeof value.createdObjectId !== 'string') ||
    (value.sheetAttachmentId !== undefined &&
      value.sheetAttachmentId !== null &&
      typeof value.sheetAttachmentId !== 'string') ||
    value.redaction.rawPayloadsRemoved !== true ||
    value.redaction.sensitiveValuesRemoved !== true ||
    value.redaction.credentialMaterialPresent !== false
  ) {
    throw new Error('Durable operation entry violates the sanitized audit contract.');
  }
  return value as unknown as OperationRecord;
}

function validateState(value: unknown): OperationStateFile {
  if (!isRecord(value)) throw new Error('Durable operation state must be an object.');

  // Read the pre-history map format written by earlier development versions.
  if (value.version === undefined) {
    const legacyEntries = Object.entries(value).map(([operationId, record]) => {
      const validated = validateOperationRecord(record);
      if (validated.operationId !== operationId) {
        throw new Error('Legacy durable operation key does not match its operation ID.');
      }
      return validated;
    });
    return {
      version: 1,
      latest: Object.fromEntries(legacyEntries.map((record) => [record.operationId, record])),
      history: legacyEntries,
    };
  }

  if (value.version !== 1 || !isRecord(value.latest) || !Array.isArray(value.history)) {
    throw new Error('Durable operation state has an unsupported shape or version.');
  }
  const latestEntries = Object.entries(value.latest).map(([operationId, record]) => {
    const validated = validateOperationRecord(record);
    if (validated.operationId !== operationId) {
      throw new Error('Durable operation key does not match its operation ID.');
    }
    return [operationId, validated] as const;
  });
  const latest = Object.fromEntries(latestEntries);
  const history = value.history.map(validateOperationRecord);
  for (const [operationId, record] of Object.entries(latest)) {
    const lastHistoryRecord = [...history]
      .reverse()
      .find((entry) => entry.operationId === operationId);
    if (!lastHistoryRecord || JSON.stringify(lastHistoryRecord) !== JSON.stringify(record)) {
      throw new Error('Durable operation latest state does not match append-only history.');
    }
  }
  for (const record of history) {
    if (!(record.operationId in latest)) {
      throw new Error('Durable operation history is missing a latest-state entry.');
    }
  }
  return {
    version: 1,
    latest,
    history,
  };
}

export class FileOperationStore implements OperationStore {
  constructor(private readonly filePath: string) {
    this.readAll();
  }

  private readAll(): OperationStateFile {
    const raw = readJsonState(this.filePath);
    return raw === undefined ? { version: 1, latest: {}, history: [] } : validateState(raw);
  }

  async save(record: OperationRecord): Promise<void> {
    withStateFileLockSync(this.filePath, () => {
      const state = this.readAll();
      const safe = redactForAudit(record);
      validateOperationRecord(safe);
      const next: OperationStateFile = {
        version: 1,
        latest: { ...state.latest, [safe.operationId]: safe },
        history: [...state.history, safe],
      };
      writeJsonStateAtomic(this.filePath, next);
    });
  }

  async get(operationId: string): Promise<OperationRecord | undefined> {
    return this.readAll().latest[operationId];
  }

  async getForActor(operationId: string, actor: string): Promise<OperationRecord | undefined> {
    return [...this.readAll().history]
      .reverse()
      .find((record) => record.operationId === operationId && record.requestingPrincipal === actor);
  }

  async history(operationId?: string): Promise<readonly OperationRecord[]> {
    const history = this.readAll().history;
    return operationId ? history.filter((record) => record.operationId === operationId) : history;
  }
}

export function createDefaultOperationStore(): OperationStore {
  const filePath = configuredStatePath('QLIK_HARNESS_OPERATION_STORE_PATH', 'operations.json');
  return filePath ? new FileOperationStore(filePath) : new InMemoryOperationStore();
}
