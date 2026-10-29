import type { Store } from '../db/store.js';
import type { ProviderRow } from '../types.js';
import { catalogEntry } from './defaults.js';

export type LimitLevel = 'ok' | 'warn' | 'blocked';

export interface LimitCheck {
  level: LimitLevel;
  ok: boolean;
  usedDay: number;
  limitDay: number;
  usedMonth: number;
  limitMonth: number;
  usedRequestsDay: number;
  requestLimitDay: number;
  reason?: string;
}

const WARN_RATIO = 0.8;
export const DEFAULT_DAILY_AI_REQUEST_LIMIT = 50;

/**
 * Conservative local guard. It cannot observe billing or calls made outside
 * this bot. One D1 counter is atomically incremented for every AI attempt and
 * shared by all providers, preventing round-robin from multiplying the cap.
 * Counting starts when this version is deployed; it is not a lifetime backfill.
 */
export async function checkLimits(
  store: Store,
  provider: ProviderRow,
  estimatedTokens = 0,
  requestLimit = DEFAULT_DAILY_AI_REQUEST_LIMIT,
  reserveRequest = true,
): Promise<LimitCheck> {
  const usedDay = await store.usageForDay(provider.name);
  const usedMonth = await store.usageForMonth(provider.name);
  const limitDay = provider.daily_limit;
  const limitMonth = provider.monthly_limit;
  const usedRequestsDay = await store.dailyAiRequestCount();
  const requestLimitDay = Number.isFinite(requestLimit) && requestLimit > 0 ? Math.floor(requestLimit) : 0;

  const base = { usedDay, limitDay, usedMonth, limitMonth, usedRequestsDay, requestLimitDay };
  if (requestLimitDay <= 0) {
    return { level: 'blocked', ok: false, ...base, reason: 'سقف درخواست روزانه نامعتبر است' };
  }
  if (usedRequestsDay >= requestLimitDay) {
    return { level: 'blocked', ok: false, ...base, reason: 'سقف ۵۰ درخواست AI روزانه (یا سقف تنظیم‌شدهٔ کمتر) پر شده' };
  }

  const dayRatio = limitDay > 0 ? (usedDay + estimatedTokens) / limitDay : 0;
  const monthRatio = limitMonth > 0 ? (usedMonth + estimatedTokens) / limitMonth : 0;
  if (limitDay > 0 && usedDay + estimatedTokens >= limitDay) {
    return { level: 'blocked', ok: false, ...base, reason: 'سقف توکن روزانه این ارائه‌دهنده پر شده' };
  }
  if (limitMonth > 0 && usedMonth + estimatedTokens >= limitMonth) {
    return { level: 'blocked', ok: false, ...base, reason: 'سقف توکن ماهانه این ارائه‌دهنده پر شده' };
  }

  // Reservation is the actual enforcement point. The checks above are only an
  // optimisation/user message and must never replace this conditional write.
  if (reserveRequest && !(await store.reserveDailyAiRequest(requestLimitDay))) {
    return {
      level: 'blocked',
      ok: false,
      ...base,
      usedRequestsDay: await store.dailyAiRequestCount(),
      reason: 'سقف درخواست AI روزانه هم‌اکنون پر شد',
    };
  }

  const requestRatio = (usedRequestsDay + (reserveRequest ? 1 : 0)) / requestLimitDay;
  const level: LimitLevel = dayRatio >= WARN_RATIO || monthRatio >= WARN_RATIO || requestRatio >= WARN_RATIO ? 'warn' : 'ok';
  return {
    level,
    ok: true,
    ...base,
    usedRequestsDay: usedRequestsDay + (reserveRequest ? 1 : 0),
    reason: level === 'warn' ? 'نزدیک به سقف محلی رایگان' : undefined,
  };
}

export function estimateCostUsd(providerName: string, inputTokens: number, outputTokens: number): number {
  const definition = catalogEntry(providerName);
  const price = definition?.usdPerMillionTokens;
  if (!price) return 0;
  return (inputTokens / 1_000_000) * price.input + (outputTokens / 1_000_000) * price.output;
}

export function usageLine(check: LimitCheck): string {
  const pct = check.limitDay > 0 ? Math.round((check.usedDay / check.limitDay) * 100) : 0;
  return `مصرف امروز: ${check.usedDay.toLocaleString('en-US')} توکن از ${check.limitDay.toLocaleString('en-US')} (${pct}٪)؛ درخواست AI: ${check.usedRequestsDay}/${check.requestLimitDay}`;
}
