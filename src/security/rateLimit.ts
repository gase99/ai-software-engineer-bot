import type { Sql } from '../db/sql.js';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Atomic fixed-window rate limiter backed by D1/SQLite. Admission is decided
 * by one conditional UPSERT, so concurrent Worker invocations cannot all pass
 * after reading the same old counter.
 */
export async function checkRateLimit(
  sql: Sql,
  key: string,
  limit: number,
  windowMs: number,
): Promise<RateLimitResult> {
  const now = Date.now();
  const cap = Math.floor(limit);
  if (!Number.isFinite(cap) || cap <= 0 || !Number.isFinite(windowMs) || windowMs <= 0) {
    return { allowed: false, remaining: 0, retryAfterSeconds: 60 };
  }

  const result = await sql.run(
    `INSERT INTO rate_counters (id, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT(id) DO UPDATE SET
       count = CASE
         WHEN excluded.window_start - rate_counters.window_start >= ? THEN 1
         ELSE rate_counters.count + 1
       END,
       window_start = CASE
         WHEN excluded.window_start - rate_counters.window_start >= ? THEN excluded.window_start
         ELSE rate_counters.window_start
       END
     WHERE excluded.window_start - rate_counters.window_start >= ?
        OR rate_counters.count < ?`,
    [key, now, windowMs, windowMs, windowMs, cap],
  );

  const row = await sql.get<{ window_start: number; count: number }>(
    'SELECT window_start, count FROM rate_counters WHERE id = ?',
    [key],
  );
  if (result.changes === 0 || !row) {
    const elapsed = row ? now - row.window_start : 0;
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((windowMs - elapsed) / 1000)),
    };
  }
  return {
    allowed: true,
    remaining: Math.max(0, cap - row.count),
    retryAfterSeconds: 0,
  };
}
