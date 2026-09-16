import { redact } from '../domain/redaction.js';

/**
 * STDIO-safe diagnostic logger.
 *
 * MCP STDIO transport reserves stdout exclusively for JSON-RPC messages.
 * Every log line this module produces is written to stderr, never stdout,
 * and every logged payload is passed through redaction before serialization.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

function currentMinLevel(): LogLevel {
  const configured = (process.env.QLIK_HARNESS_LOG_LEVEL ?? 'info').toLowerCase();
  return configured in LEVEL_ORDER ? (configured as LogLevel) : 'info';
}

function write(
  level: LogLevel,
  message: string,
  bindings: Record<string, unknown>,
  context?: Record<string, unknown>,
): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentMinLevel()]) {
    return;
  }
  const record = redact({
    timestamp: new Date().toISOString(),
    level,
    message,
    ...bindings,
    ...(context ?? {}),
  });
  // Diagnostics MUST go to stderr only; stdout is reserved for JSON-RPC.
  process.stderr.write(`${JSON.stringify(record)}\n`);
}

function createLogger(bindings: Record<string, unknown>): Logger {
  return {
    debug: (message, context) => write('debug', message, bindings, context),
    info: (message, context) => write('info', message, bindings, context),
    warn: (message, context) => write('warn', message, bindings, context),
    error: (message, context) => write('error', message, bindings, context),
    child: (childBindings) => createLogger({ ...bindings, ...childBindings }),
  };
}

export const rootLogger: Logger = createLogger({ component: 'qlik-ai-harness' });
