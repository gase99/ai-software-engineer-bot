/**
 * Minimal SQL access layer.
 *
 * The same repository code runs on:
 *  - Cloudflare D1 (`d1Sql`) - production, Mode A
 *  - node:sqlite (`sqliteSql`) - tests and local scripts (Mode B/C)
 * Both speak plain SQLite, so there is exactly one query implementation.
 */

export interface D1Meta {
  changes?: number;
  last_row_id?: number;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = unknown>(): Promise<{ results: T[]; success: boolean; meta?: D1Meta }>;
  first<T = unknown>(column?: string): Promise<T | null>;
  run(): Promise<{ success: boolean; meta?: D1Meta }>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  exec(query: string): Promise<{ count: number }>;
}

export interface SqlRunResult {
  changes: number;
  lastInsertRowid?: number;
}

export interface Sql {
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;
  run(sql: string, params?: unknown[]): Promise<SqlRunResult>;
  exec(sql: string): Promise<void>;
}

function normalizeParams(params?: unknown[]): unknown[] {
  return (params ?? []).map((value) => (typeof value === 'boolean' ? (value ? 1 : 0) : value));
}

export function d1Sql(db: D1Database): Sql {
  return {
    async all<T>(sql: string, params?: unknown[]): Promise<T[]> {
      const prepared = db.prepare(sql);
      const result = await prepared.bind(...normalizeParams(params)).all<T>();
      return result.results ?? [];
    },
    async get<T>(sql: string, params?: unknown[]): Promise<T | null> {
      const prepared = db.prepare(sql);
      return (await prepared.bind(...normalizeParams(params)).first<T>()) ?? null;
    },
    async run(sql: string, params?: unknown[]): Promise<SqlRunResult> {
      const prepared = db.prepare(sql);
      const result = await prepared.bind(...normalizeParams(params)).run();
      return { changes: result.meta?.changes ?? 0, lastInsertRowid: result.meta?.last_row_id };
    },
    async exec(sql: string): Promise<void> {
      await db.exec(sql);
    },
  };
}

/** SQLite implementation used by tests and local tooling (Node >= 20). */
export async function sqliteSql(path = ':memory:'): Promise<Sql> {
  const { DatabaseSync } = (await import('node:sqlite')) as {
    DatabaseSync: new (location: string) => {
      exec(sql: string): void;
      prepare(sql: string): {
        all(...params: unknown[]): unknown[];
        run(...params: unknown[]): { changes: unknown; lastInsertRowid: unknown };
        get(...params: unknown[]): unknown;
      };
      close(): void;
    };
  };
  const db = new DatabaseSync(path);
  return {
    async all<T>(sql: string, params?: unknown[]): Promise<T[]> {
      const stmt = db.prepare(sql);
      const rows = params && params.length ? stmt.all(...normalizeParams(params)) : stmt.all();
      return rows as T[];
    },
    async get<T>(sql: string, params?: unknown[]): Promise<T | null> {
      const stmt = db.prepare(sql);
      const row = params && params.length ? stmt.get(...normalizeParams(params)) : stmt.get();
      return (row as T | undefined) ?? null;
    },
    async run(sql: string, params?: unknown[]): Promise<SqlRunResult> {
      const stmt = db.prepare(sql);
      const result = params && params.length ? stmt.run(...normalizeParams(params)) : stmt.run();
      return {
        changes: Number(result.changes ?? 0),
        lastInsertRowid: result.lastInsertRowid === undefined ? undefined : Number(result.lastInsertRowid),
      };
    },
    async exec(sql: string): Promise<void> {
      db.exec(sql);
    },
  };
}
