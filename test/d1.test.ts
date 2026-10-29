import { describe, expect, it } from 'vitest';
import { Bot } from '../src/bot.js';
import type { D1Database, D1PreparedStatement } from '../src/db/sql.js';
import { sqliteSql } from '../src/db/sql.js';
import type { Env } from '../src/env.js';
import { FetchMock, mockTelegram, OWNER_ID, update } from './helpers.js';

interface D1Calls {
  prepared: string[];
  first: number;
  all: number;
  run: number;
  exec: number;
}

/**
 * A node:sqlite-backed test double that exposes ONLY the production D1 API.
 * In particular, the database object deliberately has no get/all/run methods.
 */
async function nodeBackedD1(): Promise<{ db: D1Database; calls: D1Calls }> {
  const sqlite = await sqliteSql(':memory:');
  const calls: D1Calls = { prepared: [], first: 0, all: 0, run: 0, exec: 0 };

  const db: D1Database = {
    prepare(query: string): D1PreparedStatement {
      calls.prepared.push(query);
      let params: unknown[] = [];
      const statement: D1PreparedStatement = {
        bind(...values: unknown[]): D1PreparedStatement {
          params = values;
          return statement;
        },
        async first<T = unknown>(): Promise<T | null> {
          calls.first += 1;
          return sqlite.get<T>(query, params);
        },
        async all<T = unknown>() {
          calls.all += 1;
          return { results: await sqlite.all<T>(query, params), success: true };
        },
        async run() {
          calls.run += 1;
          const result = await sqlite.run(query, params);
          return {
            success: true,
            meta: { changes: result.changes, last_row_id: result.lastInsertRowid },
          };
        },
      };
      return statement;
    },
    async exec(query: string) {
      calls.exec += 1;
      await sqlite.exec(query);
      return { count: 1 };
    },
  };

  return { db, calls };
}

describe('Cloudflare D1 compatibility', () => {
  it('boots and answers /start through a D1-only database binding', async () => {
    const { db, calls } = await nodeBackedD1();
    const mock = new FetchMock();
    const telegram = mockTelegram(mock);
    const env = {
      DB: db,
      TELEGRAM_BOT_TOKEN: '123:token',
      TELEGRAM_WEBHOOK_SECRET: 'webhook-secret',
      OWNER_TELEGRAM_ID: String(OWNER_ID),
      APPROVAL_SECRET: 'approval-secret',
    } as Env;

    // No Sql argument: this is the same production path used by src/index.ts.
    const bot = await Bot.create(env, undefined, mock.fetch);
    await bot.handleUpdate(update());

    expect(telegram.messages.some((message) => message.text.includes('مهندس نرم‌افزار'))).toBe(true);
    expect(calls.prepared.some((query) => query.includes('sqlite_master'))).toBe(true);
    expect(calls.exec).toBe(1);
    expect(calls.first).toBeGreaterThan(0);
    expect(calls.all).toBeGreaterThan(0);
    expect(calls.run).toBeGreaterThan(0);
  });
});
