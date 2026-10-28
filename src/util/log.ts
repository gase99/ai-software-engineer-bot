import { redact } from '../security/redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  requestId?: string;
  jobId?: string;
  chatId?: string;
  [key: string]: unknown;
}

/**
 * Structured JSON logger. Every value passes through `redact()` so a secret can
 * never reach the log stream through a nested object.
 */
export function log(level: LogLevel, event: string, context: LogContext = {}): void {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...(redactDeep(context) as Record<string, unknown>),
  };
  const line = JSON.stringify(entry);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[deep]';
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactDeep(val, depth + 1);
    }
    return out;
  }
  return value;
}

export const logger = {
  debug: (event: string, ctx?: LogContext) => log('debug', event, ctx),
  info: (event: string, ctx?: LogContext) => log('info', event, ctx),
  warn: (event: string, ctx?: LogContext) => log('warn', event, ctx),
  error: (event: string, ctx?: LogContext) => log('error', event, ctx),
};
