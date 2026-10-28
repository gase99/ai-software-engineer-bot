import { redact, registerSecret } from '../security/redact.js';

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
  language_code?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  reply_to_message?: TelegramMessage;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  data?: string;
  message?: TelegramMessage;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
  document?: TelegramMessage & { from?: TelegramUser };
}

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
}

export interface SendMessageOptions {
  parseMode?: 'HTML' | 'MarkdownV2';
  replyMarkup?: unknown;
  replyToMessageId?: number;
  disableWebPagePreview?: boolean;
}

export class TelegramError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly method?: string,
  ) {
    super(redact(message));
    this.name = 'TelegramError';
  }
}

const API_BASE = 'https://api.telegram.org';

/**
 * Thin Telegram Bot API client. Uses the platform `fetch` (Workers) and never
 * logs the bot token - every error message is passed through `redact()`.
 */
export class TelegramClient {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {
    if (token) registerSecret(token);
  }

  private async call<T>(method: string, payload: Record<string, unknown>): Promise<T> {
    const response = await this.fetchImpl(`${API_BASE}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = (await response.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string; error_code?: number };
    if (!response.ok || body.ok === false) {
      throw new TelegramError(body.description ?? `telegram ${method} failed (${response.status})`, body.error_code ?? response.status, method);
    }
    return body.result as T;
  }

  getMe(): Promise<TelegramUser> {
    return this.call<TelegramUser>('getMe', {});
  }

  sendMessage(chatId: number | string, text: string, options: SendMessageOptions = {}): Promise<TelegramMessage> {
    return this.call<TelegramMessage>('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: options.parseMode,
      reply_markup: options.replyMarkup,
      reply_to_message_id: options.replyToMessageId,
      disable_web_page_preview: options.disableWebPagePreview ?? true,
    });
  }

  editMessageText(chatId: number | string, messageId: number, text: string, replyMarkup?: unknown): Promise<TelegramMessage> {
    return this.call<TelegramMessage>('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      reply_markup: replyMarkup,
    });
  }

  answerCallbackQuery(callbackQueryId: string, text?: string, showAlert = false): Promise<boolean> {
    return this.call<boolean>('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text,
      show_alert: showAlert,
    });
  }

  sendChatAction(chatId: number | string, action = 'typing'): Promise<boolean> {
    return this.call<boolean>('sendChatAction', { chat_id: chatId, action });
  }

  setWebhook(url: string, secretToken?: string): Promise<boolean> {
    return this.call<boolean>('setWebhook', { url, secret_token: secretToken, drop_pending_updates: false });
  }

  deleteWebhook(): Promise<boolean> {
    return this.call<boolean>('deleteWebhook', { drop_pending_updates: false });
  }

  getFile(fileId: string): Promise<{ file_id: string; file_path?: string; file_size?: number }> {
    return this.call('getFile', { file_id: fileId });
  }

  setMyCommands(commands: Array<{ command: string; description: string }>): Promise<boolean> {
    return this.call<boolean>('setMyCommands', { commands });
  }
}
