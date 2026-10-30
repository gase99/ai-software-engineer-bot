import type { Store } from '../db/store.js';
import type { AiMessage } from '../ai/types.js';
import { logger } from '../util/log.js';

/**
 * Conversation memory backed by D1 (`chat_messages`).
 *
 * The agent is stateless per request (Workers), so everything it must remember
 * between two Telegram messages - including tool calls and their results - is
 * replayed from here. Keeping tool messages too is what lets a "بله" after an
 * approval question continue the exact same tool-call round-trip.
 */
export class ChatMemory {
  constructor(
    private readonly store: Store,
    private readonly options: { historyLimit?: number; keep?: number } = {},
  ) {}

  private get historyLimit(): number {
    return this.options.historyLimit ?? 30;
  }

  private get keep(): number {
    return this.options.keep ?? 200;
  }

  async append(userId: number | string, chatId: number | string, message: AiMessage): Promise<void> {
    await this.store.addChatMessage({
      telegramUserId: userId,
      chatId,
      role: message.role,
      content: message.content ?? '',
      messageJson: JSON.stringify(message),
    });
    // Trimming is amortised: only pay for it once the window is exceeded.
    if ((await this.store.countChatMessages(userId)) > this.keep) {
      await this.store.trimChatMessages(userId, this.keep);
    }
  }

  async appendMany(userId: number | string, chatId: number | string, messages: AiMessage[]): Promise<void> {
    for (const message of messages) await this.append(userId, chatId, message);
  }

  /** Oldest-first window of the conversation, without system messages. */
  async history(userId: number | string): Promise<AiMessage[]> {
    const rows = await this.store.listChatMessages(userId, this.historyLimit);
    const messages: AiMessage[] = [];
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.message_json) as AiMessage;
        if (!parsed || typeof parsed !== 'object' || !parsed.role) continue;
        messages.push({
          role: parsed.role,
          content: typeof parsed.content === 'string' ? parsed.content : '',
          ...(parsed.toolCalls?.length ? { toolCalls: parsed.toolCalls } : {}),
          ...(parsed.toolCallId ? { toolCallId: parsed.toolCallId } : {}),
          ...(parsed.toolName ? { toolName: parsed.toolName } : {}),
          ...(parsed.toolError ? { toolError: true } : {}),
        });
      } catch (error) {
        logger.warn('agent.memory_bad_row', { error: (error as Error).message });
      }
    }
    return messages;
  }

  async clear(userId: number | string): Promise<number> {
    return this.store.clearChatMessages(userId);
  }

  async size(userId: number | string): Promise<number> {
    return this.store.countChatMessages(userId);
  }
}
