import type { TelegramUpdate } from './api.js';

/**
 * Update routing.
 *
 * There is no menu and no bot-side conversation state machine any more: free
 * text (and any unlisted `/command`) is forwarded to the conversational agent.
 * Only `/start` and `/cancel` are first-class commands; everything else is an
 * optional shortcut handled by `Bot.runCommand`.
 */
export type Route =
  | { kind: 'command'; command: string; args: string; text: string }
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

  const rawText = message.text ?? message.caption ?? '';
  // Trim is a routing concern only. Free-text requests may contain fenced
  // code or significant whitespace and must reach the agent verbatim.
  const text = rawText.trim();
  if (!text) return { kind: 'unknown' };

  if (text.startsWith('/')) {
    const [rawCommand, ...rest] = text.split(/\s+/);
    const command = (rawCommand ?? '').replace(/@[\w_]+$/, '').toLowerCase();
    return { kind: 'command', command, args: rest.join(' ').trim(), text };
  }

  return { kind: 'text', text: rawText };
}
