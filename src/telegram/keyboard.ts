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

export interface PlanActions {
  requestId: string;
  planVersion: number;
  token: string;
}

export function planApprovalKeyboard(actions: PlanActions): { inline_keyboard: InlineKeyboardButton[][] } {
  const base = `plan|${actions.requestId}|${actions.planVersion}`;
  return {
    inline_keyboard: [
      [
        { text: '✅ تأیید و شروع', callback_data: `${base}|approve|${actions.token}` },
        { text: '✏️ اصلاح طرح', callback_data: `${base}|revise|${actions.token}` },
      ],
      [
        { text: '❓ توضیح بیشتر', callback_data: `${base}|explain|${actions.token}` },
        { text: '❌ لغو', callback_data: `${base}|cancel|${actions.token}` },
      ],
    ],
  };
}

export function confirmKeyboard(action: string, requestId: string, token: string): { inline_keyboard: InlineKeyboardButton[][] } {
  return {
    inline_keyboard: [
      [
        { text: '✅ بله، ادامه بده', callback_data: `${action}|${requestId}|confirm|${token}` },
        { text: '🚫 خیر', callback_data: `${action}|${requestId}|abort|${token}` },
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
  if (parts.length < 4) return null;
  if (parts[0] === 'plan') {
    const [, requestId, version, action, token] = parts;
    const parsedVersion = Number(version);
    if (!requestId || !Number.isInteger(parsedVersion) || !action || !token) return null;
    return { scope: 'plan', requestId, planVersion: parsedVersion, action, token };
  }
  const [scope, requestId, action, token] = parts;
  if (!scope || !requestId || !action || !token) return null;
  return { scope, requestId, action, token };
}
