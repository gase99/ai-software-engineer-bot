import { normalizeFa } from '../util/text.js';

/**
 * Natural-language approval detection.
 *
 * The owner answers a pending action in plain language ("بله"، "آره انجام بده"،
 * "نه لغو کن"). Greetings and unrelated statements must never approve anything,
 * so the match is anchored on whole words instead of `includes()`.
 */
export type ApprovalIntent = 'approve' | 'reject' | 'unclear';

/**
 * Only unambiguous "do it" words are here. Pure acknowledgements ("باشه"،
 * "اوکی"، "ok") are deliberately excluded: they acknowledge a message, they do
 * not authorise a repository write.
 */
const APPROVE = [
  'بله', 'بلی', 'آره', 'اره', 'قبول', 'موافقم', 'موافق هستم', 'تایید', 'تأیید',
  'تایید می کنم', 'تأیید می‌کنم', 'انجام بده', 'اجرا کن', 'شروع کن', 'درسته', 'بریم',
  'بزن بریم', 'حله', 'yes', 'yep', 'yeah', 'sure', 'approve', 'approved', 'go ahead',
  'do it', 'confirm', 'confirmed',
];

const REJECT = [
  'نه', 'خیر', 'نخیر', 'لغو', 'لغوش کن', 'کنسل', 'انصراف', 'نکن', 'نمی‌خواهم', 'نمیخوام',
  'متوقف', 'توقف', 'رد', 'موافق نیستم', 'no', 'nope', 'cancel', 'stop', 'reject',
  'abort', 'decline',
];

/** Whole-word (or whole-phrase) containment, tolerant of Persian spacing. */
function containsPhrase(normalized: string, phrase: string): boolean {
  const target = normalizeFa(phrase).toLowerCase();
  if (!target) return false;
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[\\s،,.;:!؟?"'()\\-])${escaped}($|[\\s،,.;:!؟?"'()\\-])`).test(normalized);
}

export function classifyApprovalReply(text: string): ApprovalIntent {
  const normalized = ` ${normalizeFa(text).toLowerCase()} `;
  if (!normalized.trim()) return 'unclear';

  // Rejection wins over approval: "نه، انجام نده" contains both families and the
  // safe interpretation is "do not run anything".
  const rejects = REJECT.some((phrase) => containsPhrase(normalized, phrase));
  const approves = APPROVE.some((phrase) => containsPhrase(normalized, phrase));
  if (rejects) return 'reject';
  if (approves) return 'approve';
  return 'unclear';
}
