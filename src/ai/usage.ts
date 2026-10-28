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
  reason?: string;
}

const WARN_RATIO = 0.8;

/**
 * Free-tier guard: before every call we check the provider's daily and monthly
 * token budget. `warn` still allows the call (and the bot tells the owner),
 * `blocked` makes the caller queue the job instead of spending more.
 */
export async function checkLimits(store: Store, provider: ProviderRow, estimatedTokens = 0): Promise<LimitCheck> {
  const usedDay = await store.usageForDay(provider.name);
  const usedMonth = await store.usageForMonth(provider.name);
  const limitDay = provider.daily_limit;
  const limitMonth = provider.monthly_limit;

  const dayRatio = limitDay > 0 ? (usedDay + estimatedTokens) / limitDay : 0;
  const monthRatio = limitMonth > 0 ? (usedMonth + estimatedTokens) / limitMonth : 0;

  if (dayRatio >= 1) {
    return { level: 'blocked', ok: false, usedDay, limitDay, usedMonth, limitMonth, reason: 'سقف روزانه این ارائه‌دهنده پر شده' };
  }
  if (monthRatio >= 1) {
    return { level: 'blocked', ok: false, usedDay, limitDay, usedMonth, limitMonth, reason: 'سقف ماهانه این ارائه‌دهنده پر شده' };
  }
  const level: LimitLevel = dayRatio >= WARN_RATIO || monthRatio >= WARN_RATIO ? 'warn' : 'ok';
  return { level, ok: true, usedDay, limitDay, usedMonth, limitMonth, reason: level === 'warn' ? 'نزدیک به سقف رایگان' : undefined };
}

export function estimateCostUsd(providerName: string, inputTokens: number, outputTokens: number): number {
  const definition = catalogEntry(providerName);
  const price = definition?.usdPerMillionTokens;
  if (!price) return 0; // free tier
  return (inputTokens / 1_000_000) * price.input + (outputTokens / 1_000_000) * price.output;
}

export function usageLine(check: LimitCheck): string {
  const pct = check.limitDay > 0 ? Math.round((check.usedDay / check.limitDay) * 100) : 0;
  return `مصرف امروز: ${check.usedDay.toLocaleString('en-US')} توکن از ${check.limitDay.toLocaleString('en-US')} (${pct}٪)`;
}
