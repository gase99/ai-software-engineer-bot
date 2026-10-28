import { describe, expect, it } from 'vitest';
import { createTestBot } from './helpers.js';
import { JobRunner } from '../src/jobs/dispatcher.js';

describe('job queue (idempotent, retrying, survives restarts)', () => {
  it('claims a job once and completes it', async () => {
    const { store } = await createTestBot();
    const job = await store.enqueue({ kind: 'tests', payload: { commands: ['npm test'] } });

    const claimed = await store.claimNextJob();
    expect(claimed?.id).toBe(job.id);
    expect(await store.claimNextJob()).toBeNull();

    await store.completeJob(job.id, { conclusion: 'success' });
    expect((await store.getJob(job.id))?.status).toBe('succeeded');
  });

  it('retries with backoff and then moves to dead-letter', async () => {
    const { store } = await createTestBot();
    const job = await store.enqueue({ kind: 'tests', payload: {}, maxAttempts: 2 });

    await store.claimNextJob();
    await store.failJob(job.id, 'boom', 60_000);
    let row = (await store.getJob(job.id))!;
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(1);
    expect(new Date(row.run_after!).getTime()).toBeGreaterThan(Date.now());

    await store.sql.run('UPDATE jobs SET run_after = ? WHERE id = ?', [new Date(Date.now() - 1000).toISOString(), job.id]);
    await store.claimNextJob();
    await store.failJob(job.id, 'boom again', 60_000);
    row = (await store.getJob(job.id))!;
    expect(row.status).toBe('dead');
    expect(await store.claimNextJob()).toBeNull();
  });

  it('re-queues a job whose lease expired (worker died mid-job)', async () => {
    const { store } = await createTestBot();
    const job = await store.enqueue({ kind: 'execute', payload: {} });
    await store.claimNextJob(1_000);
    expect((await store.getJob(job.id))?.status).toBe('running');

    await store.sql.run('UPDATE jobs SET lease_until = ? WHERE id = ?', [new Date(Date.now() - 5_000).toISOString(), job.id]);
    const requeued = await store.requeueStaleJobs(1_000);
    expect(requeued).toBe(1);
    expect((await store.getJob(job.id))?.status).toBe('queued');
  });

  it('the cron tick drains the queue and records failures', async () => {
    const { bot, store } = await createTestBot();
    await store.enqueue({ kind: 'tests', payload: { commands: [] } });

    const result = await new JobRunner(bot).tick();
    expect(result.processed + result.failed).toBe(1);
    expect(result.failed).toBe(1);
    const job = (await store.listJobs())[0]!;
    expect(['failed', 'dead']).toContain(job.status);
    expect((await store.getJobLogs(job.id)).length).toBeGreaterThan(0);
  });

  it('keeps job logs for a reportable audit trail', async () => {
    const { store } = await createTestBot();
    const job = await store.enqueue({ kind: 'analyze', payload: {} });
    await store.addJobLog(job.id, 'info', 'شروع تحلیل', { files: 3 });
    await store.addJobLog(job.id, 'error', 'خطا در تماس با مدل');
    const logs = await store.getJobLogs(job.id);
    expect(logs.map((entry) => entry.level)).toEqual(['info', 'error']);
    expect(logs[0]?.meta_json).toContain('files');
  });
});
