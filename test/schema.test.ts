import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { SCHEMA_SQL } from '../src/db/schema.js';

const migrationsDir = new URL('../migrations/', import.meta.url);

/** The canonical schema is every D1 migration, in filename order. */
function appliedMigrations(): string {
  return readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => readFileSync(new URL(file, migrationsDir), 'utf8'))
    .join('\n');
}

const normalize = (value: string) => value.replace(/\s+/g, ' ').replace(/--[^\n]*/g, '').trim();

describe('database schema', () => {
  it('the D1 migrations match the schema used by the tests exactly', () => {
    expect(normalize(appliedMigrations())).toBe(normalize(SCHEMA_SQL));
  });

  it('creates every table required by the spec', async () => {
    const { sqliteSql } = await import('../src/db/sql.js');
    const sql = await sqliteSql(':memory:');
    await sql.exec(SCHEMA_SQL);
    const rows = await sql.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
    const names = rows.map((row) => row.name);
    for (const table of [
      'projects',
      'requests',
      'plans',
      'approvals',
      'jobs',
      'job_logs',
      'providers',
      'models_used',
      'api_usage',
      'github_repos',
      'github_actions_usage',
      'project_memory',
      'audit_log',
      'rate_counters',
      'settings',
      'chat_messages',
      'pending_actions',
    ]) {
      expect(names).toContain(table);
    }
  });
});
