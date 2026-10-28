import type { PlanContent } from '../types.js';
import { escHtml, truncate } from '../util/text.js';

export interface ReportMeta {
  projectName: string;
  repo: string;
  branch: string;
  provider?: string | null;
  model?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  requestId: string;
  planVersion: number;
}
const bullet = (items: string[] | undefined, empty = '—'): string =>
  items && items.length ? items.map((item) => `• ${escHtml(item)}`).join('\n') : empty;

/** Persian, plain-language report the owner reads before approving. */
export function renderPlanReport(plan: PlanContent, meta: ReportMeta): string {
  const impact = [
    `دیتابیس: ${escHtml(plan.impact?.database ?? 'ندارد')}`,
    `API: ${escHtml(plan.impact?.api ?? 'ندارد')}`,
    `رابط کاربر: ${escHtml(plan.impact?.ui ?? 'ندارد')}`,
  ].join('\n');

  return [
    '📋 <b>گزارش تحلیل و طرح اجرا</b>',
    '',
    `پروژه: <b>${escHtml(meta.projectName)}</b> (<code>${escHtml(meta.repo)}</code>@${escHtml(meta.branch)})`,
    `شناسه درخواست: <code>${escHtml(meta.requestId)}</code> · نسخه طرح: <b>${meta.planVersion}</b>`,
    '',
    '۱) برداشت من از درخواست:',
    escHtml(truncate(plan.understanding, 700)),
    '',
    '۲) نتیجه نهایی:',
    escHtml(truncate(plan.outcome, 700)),
    '',
    '۳) فایل‌های احتمالی تغییر:',
    bullet(plan.files),
    '',
    '۴) روش فنی:',
    escHtml(truncate(plan.approach, 1200)),
    '',
    '۵) اثر روی دیتابیس / API / رابط کاربر:',
    impact,
    '',
    '۶) تست‌های لازم:',
    bullet(plan.tests),
    '',
    '۷) ریسک‌ها:',
    bullet(plan.risks),
    '',
    '۸) موارد نامشخص:',
    bullet(plan.unknowns),
    '',
    `۹) حجم کار: <b>${escHtml(plan.effort ?? 'S')}</b> · هزینه تقریبی API: <b>${Number(plan.estimatedApiCostUsd ?? 0).toFixed(4)} دلار</b>`,
    meta.provider ? `مدل استفاده‌شده: <code>${escHtml(meta.provider)} / ${escHtml(meta.model ?? '')}</code>` : '',
    '',
    'بدون تأیید شما هیچ تغییری در مخزن ایجاد نمی‌شود.',
  ]
    .filter(Boolean)
    .join('\n');
}

export function renderShortStatus(rows: Array<{ label: string; value: string }>): string {
  return rows.map((row) => `${row.label}: ${escHtml(row.value)}`).join('\n');
}
