import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

let temporaryFileCounter = 0;
const LOCK_WAIT_MILLISECONDS = 10;
const LOCK_TIMEOUT_MILLISECONDS = 5_000;
const STALE_LOCK_MILLISECONDS = 30_000;
const lockWaitArray = new Int32Array(new SharedArrayBuffer(4));

export function configuredStatePath(environmentName: string, fileName: string): string | undefined {
  const explicit = process.env[environmentName]?.trim();
  if (explicit) return path.resolve(explicit);
  const stateDirectory = process.env.QLIK_HARNESS_STATE_DIR?.trim();
  return stateDirectory ? path.resolve(stateDirectory, fileName) : undefined;
}

export interface JsonStateSnapshot {
  readonly raw: string | undefined;
  readonly value: unknown | undefined;
}

/** Reads the raw comparison token and parsed value from the same file read. */
export function readJsonStateSnapshot(filePath: string): JsonStateSnapshot {
  if (!existsSync(filePath)) return { raw: undefined, value: undefined };
  const raw = readFileSync(filePath, 'utf8');
  try {
    return { raw, value: JSON.parse(raw) as unknown };
  } catch {
    throw new Error(`Refusing to load corrupt durable state from ${filePath}.`);
  }
}

export function readJsonState(filePath: string): unknown | undefined {
  return readJsonStateSnapshot(filePath).value;
}

function alreadyExists(error: unknown): boolean {
  return Boolean(
    error && typeof error === 'object' && (error as { code?: unknown }).code === 'EEXIST',
  );
}

/**
 * Serializes each file's read-modify-replace transaction across processes.
 * File-backed development remains single-replica because this is a file lock,
 * not a distributed database transaction spanning the four workflow stores.
 * AgentCore deployment uses the DynamoDB repositories instead.
 */
export function withStateFileLockSync<T>(filePath: string, operation: () => T): T {
  const directory = path.dirname(filePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MILLISECONDS;
  let descriptor: number | undefined;

  while (descriptor === undefined) {
    try {
      descriptor = openSync(lockPath, 'wx', 0o600);
      writeFileSync(descriptor, `${process.pid}\n`, 'utf8');
      fsyncSync(descriptor);
    } catch (error) {
      if (!alreadyExists(error)) throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > STALE_LOCK_MILLISECONDS) {
          unlinkSync(lockPath);
          continue;
        }
      } catch (inspectionError) {
        if (!alreadyExists(inspectionError)) {
          // The lock disappeared between checks; retry acquisition.
        }
      }
      if (Date.now() >= deadline) {
        const timeoutError = new Error(`Timed out waiting for durable state lock ${lockPath}.`);
        Object.defineProperty(timeoutError, 'cause', {
          value: error,
          configurable: true,
          writable: true,
        });
        throw timeoutError;
      }
      Atomics.wait(lockWaitArray, 0, 0, LOCK_WAIT_MILLISECONDS);
    }
  }

  try {
    return operation();
  } finally {
    closeSync(descriptor);
    try {
      unlinkSync(lockPath);
    } catch {
      // Preserve the operation result. A stale lock is detected on the next acquisition.
    }
  }
}

/** Writes a complete state snapshot through a same-directory atomic rename. */
export function writeJsonStateAtomic(filePath: string, value: unknown): void {
  const directory = path.dirname(filePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  temporaryFileCounter += 1;
  const temporaryPath = `${filePath}.tmp-${process.pid}-${temporaryFileCounter}`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, filePath);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    throw error;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Durable state field ${key} must be a non-empty string.`);
  }
  return value;
}
