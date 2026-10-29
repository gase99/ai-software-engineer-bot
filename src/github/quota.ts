import type { Store } from '../db/store.js';

export type QuotaLevel = 'ok' | 'warn' | 'blocked';

export interface ActionsQuota {
  usedMinutes: number;
  limitMinutes: number;
  remainingMinutes: number;
  level: QuotaLevel;
}

const WARN_RATIO = 0.85;
export const DEFAULT_ACTIONS_MINUTE_LIMIT = 100;
/** 15-minute sandbox timeout plus one conservative callback/report minute. */
export const RUN_RESERVATION_MINUTES = 16;

/**
 * GitHub Actions minutes are a scarce resource. The bot starts with a
 * conservative local budget of 100 minutes/month, independently of whatever
 * larger allowance an account may have. GitHub does not expose one universal
 * remaining-minutes REST value here, so reservations and real run timings are
 * metered in D1 and dispatch is refused when the configured budget is exhausted.
 */
export async function checkActionsQuota(store: Store, limitMinutes: number, reserveMinutes = 0): Promise<ActionsQuota> {
  const usedMinutes = await store.actionsMinutesThisMonth();
  const safeLimit = Number.isFinite(limitMinutes) && limitMinutes > 0 ? limitMinutes : 0;
  const reserve = Number.isFinite(reserveMinutes) && reserveMinutes > 0 ? Math.ceil(reserveMinutes) : 0;
  if (reserve > 0) {
    const reserved = await store.reserveActionsMinutes(reserve, safeLimit);
    if (!reserved) {
      const current = await store.actionsMinutesThisMonth();
      return { usedMinutes: current, limitMinutes: safeLimit, remainingMinutes: Math.max(0, safeLimit - current), level: 'blocked' };
    }
  }
  const accounted = usedMinutes + reserve;
  const ratio = safeLimit > 0 ? accounted / safeLimit : 1;
  const exhausted = reserve > 0 ? ratio > 1 : ratio >= 1;
  const level: QuotaLevel = exhausted || safeLimit <= 0 ? 'blocked' : ratio >= WARN_RATIO ? 'warn' : 'ok';
  return {
    usedMinutes: accounted,
    limitMinutes: safeLimit,
    remainingMinutes: Math.max(0, safeLimit - accounted),
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

export async function recordRunMinutes(
  store: Store,
  startedAt: string | undefined,
  endedAt: string | undefined,
  runId?: number,
): Promise<number> {
  const minutes = billableMinutes(startedAt, endedAt);
  if (runId !== undefined) {
    const key = `actions_metered:${runId}`;
    if (!(await store.claimOnce(key))) return minutes;
    const reservationKey = `actions_reservation:run:${runId}`;
    const reservedRaw = await store.getSetting(reservationKey);
    const reserved = reservedRaw === null ? 0 : Math.max(0, Number(reservedRaw) || 0);
    // Dispatch already reserved an estimate; settle only the difference.
    await store.addActionsMinutes(minutes - reserved);
    await store.deleteSetting(reservationKey);
    return minutes;
  }
  await store.addActionsMinutes(minutes);
  return minutes;
}

export async function releaseActionsReservation(store: Store, minutes = RUN_RESERVATION_MINUTES): Promise<void> {
  if (Number.isFinite(minutes) && minutes > 0) await store.addActionsMinutes(-Math.ceil(minutes));
}

export function estimateRunMinutes(previousMinutes: number[]): number {
  if (!previousMinutes.length) return 3;
  const sum = previousMinutes.reduce((acc, value) => acc + value, 0);
  return Math.max(1, Math.round((sum / previousMinutes.length) * 1.2));
}
