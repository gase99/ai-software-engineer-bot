import type { Env } from '../env.js';
import type { Store } from '../db/store.js';
import type { ProviderManager } from '../ai/registry.js';
import { NoProviderAvailableError, type AiMessage, type AiToolCall } from '../ai/types.js';
import type { GithubClient } from '../github/client.js';
import { logger } from '../util/log.js';
import { toPersianDigits } from '../util/text.js';
import { ChatMemory } from './memory.js';
import { ToolRegistry } from './registry.js';
import { EMPTY_REPLY, NO_PROVIDER_REPLY, buildSystemPrompt } from './prompt.js';
import type { AgentContext, AgentTool } from './types.js';

export interface AgentDeps {
  env: Env;
  store: Store;
  providers: ProviderManager;
  tools: ToolRegistry;
  github: () => Promise<GithubClient>;
  fetchImpl: typeof fetch;
  memory?: ChatMemory;
  /** Hard cap on model round-trips per Telegram message. */
  maxSteps?: number;
  approvalTtlMs?: number;
}

export type AgentResult =
  | { kind: 'message'; text: string }
  | { kind: 'approval'; text: string; actionId: string; summary: string };

/**
 * The conversational agent: one free-text Telegram message in, one natural
 * language answer (or one approval question) out.
 *
 * The loop is deliberately boring:
 *   1. send the whole conversation + the tool catalogue to the model
 *   2. text back  -> done
 *   3. tool calls -> execute (or park them behind an owner approval) and repeat
 *
 * All state lives in D1, so a Workers invocation can stop at any point without
 * losing the conversation.
 */
export class ConversationalAgent {
  private readonly memory: ChatMemory;
  private readonly maxSteps: number;
  private readonly approvalTtlMs: number;

  constructor(private readonly deps: AgentDeps) {
    this.memory = deps.memory ?? new ChatMemory(deps.store);
    this.maxSteps = deps.maxSteps ?? 5;
    this.approvalTtlMs = deps.approvalTtlMs ?? 30 * 60_000;
  }

  get chatMemory(): ChatMemory {
    return this.memory;
  }

  // ------------------------------------------------------------------ entry
  async respond(input: { userId: number; chatId: number; text: string }): Promise<AgentResult> {
    const pending = await this.deps.store.latestPendingAction(input.userId);
    await this.memory.append(input.userId, input.chatId, { role: 'user', content: input.text });
    const messages = await this.buildMessages(input.userId, pending?.summary ?? null);
    return this.loop({ userId: input.userId, chatId: input.chatId, messages });
  }

  /** Owner answered a pending action ("بله"/"خیر" or the inline buttons). */
  async decide(input: { userId: number; chatId: number; actionId: string; approved: boolean }): Promise<AgentResult> {
    const action = await this.deps.store.getPendingAction(input.actionId);
    if (!action || action.telegram_user_id !== String(input.userId)) {
      return { kind: 'message', text: 'این درخواست تأیید پیدا نشد. اگر لازم است، کار را دوباره از اول بخواه.' };
    }
    let calls: AiToolCall[];
    try {
      calls = JSON.parse(action.calls_json) as AiToolCall[];
    } catch {
      await this.deps.store.decidePendingAction(action.id, 'expired');
      return { kind: 'message', text: 'اطلاعات این درخواست خراب شده بود؛ لطفاً دوباره درخواستت را بگو.' };
    }

    if (action.status !== 'pending') {
      return { kind: 'message', text: 'این درخواست قبلاً پاسخ داده شده و دوباره اجرا نمی‌شود.' };
    }

    const expired = Date.parse(action.expires_at) <= Date.now();
    if (expired) {
      await this.deps.store.decidePendingAction(action.id, 'expired');
      await this.appendToolResults(input, calls, 'این درخواست منقضی شد و اجرا نشد.');
      return { kind: 'message', text: '⏳ زمان این تأیید تمام شد و هیچ کاری انجام نشد; اگر هنوز می‌خواهی، دوباره بگو.' };
    }

    if (!(await this.deps.store.decidePendingAction(action.id, input.approved ? 'approved' : 'rejected'))) {
      return { kind: 'message', text: 'این درخواست همین الان پاسخ داده شد و دوباره اجرا نمی‌شود.' };
    }

    await this.deps.store.audit(
      String(input.userId),
      input.approved ? 'agent.approval.approved' : 'agent.approval.rejected',
      action.id,
    );

    const messages = await this.buildMessages(input.userId, null);
    if (!input.approved) {
      const results = await this.appendToolResults(input, calls, 'مالک با انجام این عملیات موافقت نکرد؛ آن را انجام نده.');
      messages.push(...results);
      return this.loop({ userId: input.userId, chatId: input.chatId, messages });
    }

    const results: AiMessage[] = [];
    for (const call of calls) {
      const message = await this.execute(call, this.context(input.userId, input.chatId));
      await this.memory.append(input.userId, input.chatId, message);
      results.push(message);
    }
    messages.push(...results);
    return this.loop({ userId: input.userId, chatId: input.chatId, messages });
  }

  // ------------------------------------------------------------------- loop
  private context(userId: number, chatId: number): AgentContext {
    return {
      env: this.deps.env,
      store: this.deps.store,
      userId,
      chatId,
      github: this.deps.github,
      fetchImpl: this.deps.fetchImpl,
      tools: this.deps.tools.list(),
    };
  }

  private async buildMessages(userId: number, pendingSummary: string | null): Promise<AiMessage[]> {
    const [history, repos, projects, activeId] = await Promise.all([
      this.memory.history(userId),
      this.deps.store.listRepos(),
      this.deps.store.listProjects(),
      this.deps.store.getActiveProjectId(),
    ]);
    const active = projects.find((project) => project.id === activeId) ?? projects[0];
    const system = buildSystemPrompt({
      repos: repos.map((repo) => repo.full_name),
      activeProject: active ? `${active.repo_owner}/${active.repo_name}@${active.default_branch}` : null,
      pendingSummary,
      tools: this.deps.tools.list(),
    });
    return [{ role: 'system', content: system }, ...this.normalizeHistory(history)];
  }

  /**
   * Both Gemini and OpenAI refuse a transcript where an assistant tool call has
   * no result. That happens when an approval question is left unanswered and
   * the owner changes the subject, so unanswered calls get an explicit placeholder.
   */
  private normalizeHistory(history: AiMessage[]): AiMessage[] {
    const output: AiMessage[] = [];
    let unresolved: AiToolCall[] = [];

    const flush = () => {
      for (const call of unresolved) {
        output.push({
          role: 'tool',
          toolCallId: call.id,
          toolName: call.name,
          toolError: true,
          content: 'این ابزار اجرا نشد (در انتظار تصمیم مالک بود و تصمیمی گرفته نشد).',
        });
      }
      unresolved = [];
    };

    for (const message of history) {
      if (message.role === 'assistant' && message.toolCalls?.length) {
        flush();
        unresolved = [...message.toolCalls];
        output.push(message);
        continue;
      }
      if (message.role === 'tool' && message.toolCallId) {
        const index = unresolved.findIndex((call) => call.id === message.toolCallId);
        if (index >= 0) unresolved.splice(index, 1);
        output.push(message);
        continue;
      }
      flush();
      output.push(message);
    }
    flush();
    return output;
  }

  private async loop(input: { userId: number; chatId: number; messages: AiMessage[] }): Promise<AgentResult> {
    const { userId, chatId, messages } = input;
    const ctx = this.context(userId, chatId);

    for (let step = 0; step < this.maxSteps; step++) {
      let completion;
      try {
        completion = await this.deps.providers.complete({
          messages,
          tools: this.deps.tools.specs(),
          temperature: 0.4,
          maxOutputTokens: 1600,
          timeoutMs: 60_000,
        });
      } catch (error) {
        if (error instanceof NoProviderAvailableError) {
          logger.warn('agent.no_provider', { reasons: error.reasons });
          return { kind: 'message', text: NO_PROVIDER_REPLY };
        }
        throw error;
      }

      const calls = completion.toolCalls ?? [];
      const assistant: AiMessage = {
        role: 'assistant',
        content: completion.text ?? '',
        ...(calls.length ? { toolCalls: calls } : {}),
      };
      await this.memory.append(userId, chatId, assistant);
      messages.push(assistant);

      if (!calls.length) {
        return { kind: 'message', text: (completion.text || EMPTY_REPLY).trim() };
      }

      const gated = await this.requiresApproval(calls, ctx);
      if (gated.length) {
        const summary = gated.map((call) => this.describe(call)).join('\n');
        const action = await this.deps.store.createPendingAction({
          telegramUserId: userId,
          chatId,
          summary,
          callsJson: JSON.stringify(calls),
          expiresAt: new Date(Date.now() + this.approvalTtlMs).toISOString(),
        });
        await this.deps.store.audit(String(userId), 'agent.approval.requested', action.id, {
          tools: gated.map((call) => call.name),
        });
        return {
          kind: 'approval',
          text: this.approvalText(gated, completion.text),
          summary,
          actionId: action.id,
        };
      }

      for (const call of calls) {
        const message = await this.execute(call, ctx);
        await this.memory.append(userId, chatId, message);
        messages.push(message);
      }
    }

    logger.warn('agent.step_limit', { userId });
    return {
      kind: 'message',
      text: 'این کار به چند مرحله بیشتر نیاز دارد و در یک پیام جا نشد. بخشی که انجام شد را گفتم؛ لطفاً ادامه‌اش را جداگانه بخواه.',
    };
  }

  // ------------------------------------------------------------------ tools
  private async requiresApproval(calls: AiToolCall[], ctx: AgentContext): Promise<AiToolCall[]> {
    const gated: AiToolCall[] = [];
    for (const call of calls) {
      const tool = this.deps.tools.get(call.name);
      if (!tool?.sensitive) continue;
      const availability = await tool.availability(ctx, call.arguments);
      // An unavailable tool is not worth asking about: the loop returns the
      // "no access" result and the model explains it in natural language.
      if (availability.available) gated.push(call);
    }
    return gated;
  }

  private describe(call: AiToolCall): string {
    const tool = this.deps.tools.get(call.name);
    if (!tool) return `اجرای عملیات ناشناخته «${call.name}»`;
    try {
      return tool.summarize(call.arguments ?? {});
    } catch {
      return `اجرای «${tool.name}»`;
    }
  }

  private approvalText(calls: AiToolCall[], modelText: string): string {
    const items = calls.map((call, index) => `${toPersianDigits(index + 1)}. ${this.describe(call)}`);
    const preamble = modelText?.trim() ? `${modelText.trim()}\n\n` : '';
    return [
      `${preamble}برای انجام این کارها اجازه لازم دارم:`,
      '',
      ...items,
      '',
      'اگر موافقی «بله» بنویس (یا دکمه تأیید را بزن)، وگرنه «خیر».',
    ].join('\n');
  }

  private async appendToolResults(
    input: { userId: number; chatId: number },
    calls: AiToolCall[],
    content: string,
  ): Promise<AiMessage[]> {
    const results: AiMessage[] = [];
    for (const call of calls) {
      const message: AiMessage = {
        role: 'tool',
        toolCallId: call.id,
        toolName: call.name,
        toolError: true,
        content,
      };
      await this.memory.append(input.userId, input.chatId, message);
      results.push(message);
    }
    return results;
  }

  private async execute(call: AiToolCall, ctx: AgentContext): Promise<AiMessage> {
    const base = { role: 'tool' as const, toolCallId: call.id, toolName: call.name };
    const tool: AgentTool | undefined = this.deps.tools.get(call.name);
    if (!tool) {
      return { ...base, toolError: true, content: `ابزاری با نام «${call.name}» وجود ندارد.` };
    }

    const availability = await tool.availability(ctx, call.arguments);
    if (!availability.available) {
      const reason = availability.reason ?? 'دلیل نامشخص';
      await this.deps.store.audit(String(ctx.userId), 'agent.tool.unavailable', tool.name);
      return {
        ...base,
        toolError: true,
        content: `این ابزار در دسترس نیست: ${reason} به مالک بگو که دسترسی به این مورد را نداری و از طرف خودت قول انجامش را نده.`,
      };
    }

    try {
      const outcome = await tool.run(call.arguments ?? {}, ctx);
      logger.info('agent.tool_ran', { tool: tool.name, ok: outcome.ok });
      return { ...base, content: outcome.content, ...(outcome.ok ? {} : { toolError: true }) };
    } catch (error) {
      const message = (error as Error).message;
      logger.error('agent.tool_failed', { tool: tool.name, error: message });
      await this.deps.store.audit(String(ctx.userId), 'agent.tool.failed', tool.name);
      return { ...base, toolError: true, content: `اجرای این ابزار ناموفق بود: ${message}` };
    }
  }
}
