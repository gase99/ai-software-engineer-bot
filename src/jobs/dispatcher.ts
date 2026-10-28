import type { Bot } from '../bot.js';
import { logger } from '../util/log.js';

/**
 * Job runner.
 *
 * In Mode A the Worker is short lived: the webhook enqueues work and answers
 * immediately, then either the same invocation (waitUntil) or the Workers Cron
 * trigger (every 5 minutes, free plan) drains the queue. Every job is
 * idempotent through its job_id, so a restart is safe.
 */
export class JobRunner {
  constructor(private readonly bot: Bot) {}

  async tick(maxJobs = 5): Promise<{ processed: number; failed: number }> {
    await this.bot.store.requeueStaleJobs(120_000);
    let processed = 0;
    let failed = 0;

    for (let i = 0; i < maxJobs; i++) {
      const job = await this.bot.store.claimNextJob(90_000);
      if (!job) break;
      try {
        await this.bot.runJob(job.id, job.kind);
        processed++;
      } catch (error) {
        failed++;
        const message = (error as Error).message;
        await this.bot.store.failJob(job.id, message, 120_000);
        await this.bot.store.addJobLog(job.id, 'error', message);
        logger.error('job.failed', { jobId: job.id, kind: job.kind, error: message });
      }
    }

    return { processed, failed };
  }
}
