import type { TelegramUpdate } from './api.js';
import { normalizeFa } from '../util/text.js';
import { MAIN_MENU } from './keyboard.js';

export type Route =
  | { kind: 'command'; command: string; args: string; text: string }
  | { kind: 'menu'; label: string }
  | { kind: 'callback'; data: string }
  | { kind: 'document'; fileId: string; fileName: string; fileSize: number; caption?: string }
  | { kind: 'text'; text: string }
  | { kind: 'unknown' };

export function routeUpdate(update: TelegramUpdate): Route {
  if (update.callback_query?.data) return { kind: 'callback', data: update.callback_query.data };

  const message = update.message ?? update.edited_message;
  if (!message) return { kind: 'unknown' };

  if (message.document) {
    return {
      kind: 'document',
      fileId: message.document.file_id,
      fileName: message.document.file_name ?? 'file.txt',
      fileSize: message.document.file_size ?? 0,
      caption: message.caption,
    };
  }

  const text = (message.text ?? message.caption ?? '').trim();
  if (!text) return { kind: 'unknown' };

  if (text.startsWith('/')) {
    const [rawCommand, ...rest] = text.split(/\s+/);
    const command = (rawCommand ?? '').replace(/@[\w_]+$/, '').toLowerCase();
    return { kind: 'command', command, args: rest.join(' ').trim(), text };
  }

  const normalized = normalizeFa(text);
  for (const row of MAIN_MENU) {
    for (const label of row) {
      if (normalizeFa(label) === normalized) return { kind: 'menu', label };
    }
  }

  return { kind: 'text', text };
}
