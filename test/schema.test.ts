import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { SCHEMA_SQL } from '../src/db/schema.js';

const normalize = (value: string) => value.replace(/\s+/g, ' ').replace(/--[^\n]*/g, '').trim();

describe('database schema', () => {
  it('the D1 migration matches the schema used by the tests exactly', () => {
    const migration = readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8');
    expect(normalize(migration)).toBe(normalize(SCHEMA_SQL));
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
    ]) {
      expect(names).toContain(table);
    }
  });
});
