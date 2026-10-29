import type { InlineKeyboardButton } from './api.js';

export const MAIN_MENU = [
  ['پروژه‌های من', 'درخواست جدید'],
  ['ادامه قبلی', 'انتخاب مدل'],
  ['تنظیمات API', 'اتصال GitHub'],
  ['وضعیت وظایف', 'تاریخچه'],
  ['گزارش تست‌ها', 'تنظیمات امنیتی'],
  ['راهنما'],
];

export function mainMenuKeyboard() {
  return { keyboard: MAIN_MENU.map((row) => row.map((label) => ({ text: label }))), resize_keyboard: true, is_persistent: true };
}

export type PlanAction = 'approve' | 'revise' | 'explain' | 'cancel';

const PLAN_ACTION_CODES: Record<PlanAction, string> = {
  approve: 'a',
  revise: 'r',
  explain: 'e',
  cancel: 'c',
};
const PLAN_ACTION_NAMES: Record<string, PlanAction> = {
  a: 'approve',
  r: 'revise',
  e: 'explain',
  c: 'cancel',
};

export interface PlanActions {
  requestId: string;
  planVersion: number;
  token: string;
}

/** Compact callback: p|<request>|<version>|<action>|<token> (<= 64 bytes). */
export function planCallbackData(requestId: string, planVersion: number, action: PlanAction, token: string): string {
  const data = `p|${requestId}|${planVersion}|${PLAN_ACTION_CODES[action]}|${token}`;
  if (new TextEncoder().encode(data).length > 64) throw new Error('callback_data exceeds Telegram 64-byte limit');
  return data;
}

export function planApprovalKeyboard(actions: PlanActions): { inline_keyboard: InlineKeyboardButton[][] } {
  return {
    inline_keyboard: [
      [
        { text: '✅ تأیید و شروع', callback_data: planCallbackData(actions.requestId, actions.planVersion, 'approve', actions.token) },
        { text: '✏️ اصلاح طرح', callback_data: planCallbackData(actions.requestId, actions.planVersion, 'revise', actions.token) },
      ],
      [
        { text: '❓ توضیح بیشتر', callback_data: planCallbackData(actions.requestId, actions.planVersion, 'explain', actions.token) },
        { text: '❌ لغو', callback_data: planCallbackData(actions.requestId, actions.planVersion, 'cancel', actions.token) },
      ],
    ],
  };
}

export function confirmKeyboard(action: string, requestId: string, token: string): { inline_keyboard: InlineKeyboardButton[][] } {
  if (action !== 'newreq') throw new Error(`unsupported confirmation scope: ${action}`);
  const yes = `n|${requestId}|c|${token}`;
  const no = `n|${requestId}|x|${token}`;
  if ([yes, no].some((data) => new TextEncoder().encode(data).length > 64)) {
    throw new Error('callback_data exceeds Telegram 64-byte limit');
  }
  return {
    inline_keyboard: [
      [
        { text: '✅ بله، ادامه بده', callback_data: yes },
        { text: '🚫 خیر', callback_data: no },
      ],
    ],
  };
}

export function parseCallbackData(data: string): {
  scope: string;
  requestId: string;
  action: string;
  token: string;
  planVersion?: number;
} | null {
  const parts = data.split('|');

  // Current compact plan callback.
  if (parts[0] === 'p' && parts.length === 5) {
    const [, requestId, rawVersion, actionCode, token] = parts;
    const planVersion = Number(rawVersion);
    const action = actionCode ? PLAN_ACTION_NAMES[actionCode] : undefined;
    if (!requestId || !Number.isInteger(planVersion) || planVersion <= 0 || !action || !token) return null;
    return { scope: 'plan', requestId, planVersion, action, token };
  }

  // Current compact free-text confirmation callback.
  if (parts[0] === 'n' && parts.length === 4) {
    const [, requestId, actionCode, token] = parts;
    const action = actionCode === 'c' ? 'confirm' : actionCode === 'x' ? 'abort' : undefined;
    if (!requestId || !action || !token) return null;
    return { scope: 'newreq', requestId, action, token };
  }

  // Backward-compatible parsing for messages rendered by older Worker
  // versions. New messages never use these longer forms.
  if (parts[0] === 'plan' && parts.length === 5) {
    const [, requestId, version, action, token] = parts;
    const planVersion = Number(version);
    if (!requestId || !Number.isInteger(planVersion) || planVersion <= 0 || !action || !token) return null;
    return { scope: 'plan', requestId, planVersion, action, token };
  }
  if (parts.length === 4) {
    const [scope, requestId, action, token] = parts;
    if (!scope || !requestId || !action || !token) return null;
    return { scope, requestId, action, token };
  }
  return null;
}
