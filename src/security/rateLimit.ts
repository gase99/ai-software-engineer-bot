import type { Sql } from '../db/sql.js';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Sliding-window rate limiter backed by the database, so the limit survives
 * Worker restarts and works with a single free D1 database.
 */
export async function checkRateLimit(
  sql: Sql,
  key: string,
  limit: number,
  windowMs: number,
): Promise<RateLimitResult> {
  const now = Date.now();
  const row = await sql.get<{ window_start: number; count: number }>(
    'SELECT window_start, count FROM rate_counters WHERE id = ?',
    [key],
  );

  if (!row || now - row.window_start >= windowMs) {
    await sql.run(
      'INSERT INTO rate_counters (id, window_start, count) VALUES (?, ?, 1) ' +
        'ON CONFLICT(id) DO UPDATE SET window_start = excluded.window_start, count = 1',
      [key, now],
    );
    return { allowed: true, remaining: limit - 1, retryAfterSeconds: 0 };
  }

  if (row.count >= limit) {
    const retryAfterSeconds = Math.ceil((windowMs - (now - row.window_start)) / 1000);
    return { allowed: false, remaining: 0, retryAfterSeconds };
  }

  await sql.run('UPDATE rate_counters SET count = count + 1 WHERE id = ?', [key]);
  return { allowed: true, remaining: limit - row.count - 1, retryAfterSeconds: 0 };
}
