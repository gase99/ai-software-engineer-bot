import type { Store } from '../db/store.js';

export type QuotaLevel = 'ok' | 'warn' | 'blocked';

export interface ActionsQuota {
  usedMinutes: number;
  limitMinutes: number;
  remainingMinutes: number;
  level: QuotaLevel;
}

const WARN_RATIO = 0.85;

/**
 * GitHub Actions minutes are the scarce resource on the free plan
 * (public repos: unlimited within fair use, private repos: 2000 min/month).
 * GitHub does not expose remaining minutes through a public REST endpoint, so
 * the bot meters them itself from real run timings and refuses to dispatch when
 * the configured budget is exhausted.
 */
export async function checkActionsQuota(store: Store, limitMinutes: number): Promise<ActionsQuota> {
  const usedMinutes = await store.actionsMinutesThisMonth();
  const ratio = limitMinutes > 0 ? usedMinutes / limitMinutes : 0;
  const level: QuotaLevel = ratio >= 1 ? 'blocked' : ratio >= WARN_RATIO ? 'warn' : 'ok';
  return {
    usedMinutes,
    limitMinutes,
    remainingMinutes: Math.max(0, limitMinutes - usedMinutes),
    level,
  };
}

/** GitHub bills whole minutes per job, minimum one minute. */
export function billableMinutes(startedAt: string | undefined, endedAt: string | undefined): number {
  if (!startedAt || !endedAt) return 1;
  const seconds = (new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 1000;
  if (!Number.isFinite(seconds) || seconds <= 0) return 1;
  return Math.max(1, Math.ceil(seconds / 60));
}

export async function recordRunMinutes(store: Store, startedAt: string | undefined, endedAt: string | undefined): Promise<number> {
  const minutes = billableMinutes(startedAt, endedAt);
  await store.addActionsMinutes(minutes);
  return minutes;
}

export function estimateRunMinutes(previousMinutes: number[]): number {
  if (!previousMinutes.length) return 3;
  const sum = previousMinutes.reduce((acc, value) => acc + value, 0);
  return Math.max(1, Math.round((sum / previousMinutes.length) * 1.2));
}
