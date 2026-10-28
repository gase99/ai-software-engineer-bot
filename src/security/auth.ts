import type { Env } from '../env.js';
import type { TelegramUpdate } from '../telegram/api.js';

/**
 * Owner authorization is always enforced server side (never in the UI layer).
 * Only the ids listed in OWNER_TELEGRAM_ID may talk to the bot.
 */
export interface Identity {
  telegramUserId: number;
  chatId: number;
  username?: string;
}

export function ownerIds(env: Env): Set<number> {
  const raw = env.OWNER_TELEGRAM_ID ?? '';
  return new Set(
    raw
      .split(/[,\s]+/)
      .map((v) => v.trim())
      .filter(Boolean)
      .map((v) => Number(v))
      .filter((v) => Number.isInteger(v)),
  );
}

export function identityFromUpdate(update: TelegramUpdate): Identity | null {
  const from =
    update.message?.from ??
    update.edited_message?.from ??
    update.callback_query?.from ??
    update.document?.from ??
    undefined;
  if (!from) return null;
  const chatId = update.message?.chat?.id ?? update.edited_message?.chat?.id ?? update.callback_query?.message?.chat?.id;
  return { telegramUserId: from.id, chatId: chatId ?? from.id, username: from.username };
}

export class UnauthorizedError extends Error {
  constructor(public readonly identity: Identity | null) {
    super('unauthorized');
    this.name = 'UnauthorizedError';
  }
}

export function assertOwner(env: Env, update: TelegramUpdate): Identity {
  const identity = identityFromUpdate(update);
  const owners = ownerIds(env);
  if (!identity || owners.size === 0 || !owners.has(identity.telegramUserId)) {
    throw new UnauthorizedError(identity);
  }
  return identity;
}

export function isOwner(env: Env, telegramUserId: number): boolean {
  return ownerIds(env).has(telegramUserId);
}
