import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bot } from '../src/bot.js';
import { Store } from '../src/db/store.js';
import { sqliteSql } from '../src/db/sql.js';
import { OWNER_ID } from './helpers.js';
import type { Env } from '../src/env.js';

const env = {
  TELEGRAM_BOT_TOKEN: '123:token',
  OWNER_TELEGRAM_ID: String(OWNER_ID),
  APPROVAL_SECRET: 'secret',
  TELEGRAM_WEBHOOK_SECRET: 'wh',
  GEMINI_API_KEY: 'AIzaFakeGeminiKeyForPersistenceTests0',
} as Env;

describe('persistence across a restart (acceptance test 13)', () => {
  it('keeps projects, requests, plans, jobs and the audit log', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-bot-'));
    const file = join(dir, 'bot.sqlite');

    const first = await sqliteSql(file);
    const storeA = new Store(first);
    await storeA.init();
    const project = await storeA.createProject({ name: 'repo', owner: 'owner', repo: 'repo' });
    const request = await storeA.createRequest(project.id, OWNER_ID, 'یک ویژگی اضافه کن');
    await storeA.savePlan({
      requestId: request.id,
      version: 1,
      plan: {
        understanding: 'x',
        outcome: 'y',
        files: ['src/app.ts'],
        approach: 'z',
        impact: {},
        tests: ['npm test'],
        risks: [],
        unknowns: [],
        effort: 'S',
        commands: ['npm test'],
        estimatedApiCostUsd: 0,
      },
      reportFa: 'گزارش',
    });
    await storeA.enqueue({ requestId: request.id, kind: 'execute', payload: { requestId: request.id } });
    await storeA.audit('owner', 'test.event', request.id);
    await storeA.addMemory(project.id, 'decision', 'تصمیم تست', 'test');

    // simulate a restart: brand new Bot on the same database file
    const second = await sqliteSql(file);
    const bot = await Bot.create(env, second);
    const storeB = bot.store;

    expect(await storeB.getActiveProjectId()).toBeNull();
    expect((await storeB.listProjects()).map((row) => row.id)).toContain(project.id);
    expect((await storeB.getRequest(request.id))?.raw_text).toBe('یک ویژگی اضافه کن');
    expect((await storeB.latestPlan(request.id))?.report_fa).toBe('گزارش');
    expect((await storeB.listJobs()).length).toBe(1);
    expect((await storeB.recentAudit(5)).some((entry) => entry.action === 'test.event')).toBe(true);
    expect((await storeB.listMemory(project.id))[0]?.content).toBe('تصمیم تست');

    // a pending job survives and can be claimed again after the restart
    const job = (await storeB.listJobs())[0]!;
    expect(job.status).toBe('queued');
    const claimed = await storeB.claimNextJob();
    expect(claimed?.id).toBe(job.id);
  });
});
