import { describe, expect, it } from 'vitest';
import { createTestBot, OWNER_ID, update } from './helpers.js';
import { parseCallbackData } from '../src/telegram/keyboard.js';
import { routeUpdate } from '../src/telegram/router.js';

const text = (value: string, messageId = 1) =>
  update({ update_id: messageId, message: { message_id: messageId, date: 0, chat: { id: OWNER_ID, type: 'private' }, from: { id: OWNER_ID }, text: value } });

describe('Telegram interface in Persian (phase 1-3 deliverables)', () => {
  it('/start greets the owner in Persian and ships no command menu', async () => {
    const { bot, telegram } = await createTestBot({ aiReply: { text: 'ok' } });
    await bot.handleUpdate(text('/start'));

    const message = telegram.messages.at(-1)!;
    expect(message.text).toContain('مهندس نرم‌افزار هوش مصنوعی');
    // The conversation is free text now: no reply keyboard / menu is attached.
    expect(message.replyMarkup).toBeUndefined();
  });

  it('/help lists the commands', async () => {
    const { bot, telegram } = await createTestBot({ aiReply: { text: 'ok' } });
    await bot.handleUpdate(text('/help'));
    const body = telegram.messages.at(-1)!.text;
    expect(body).toContain('/projects');
    expect(body).toContain('/test_api');
    expect(body).toContain('/github');
  });

  it('/project registers a repository and reads its metadata', async () => {
    const { bot, store, telegram } = await createTestBot({ aiReply: { text: 'ok' } });
    await bot.handleUpdate(text('/project owner/repo'));

    const projects = await store.listProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]!.repo_owner).toBe('owner');
    expect(projects[0]!.default_branch).toBe('main');
    expect(await store.getActiveProjectId()).toBe(projects[0]!.id);
    expect(telegram.messages.at(-1)!.text).toContain('پروژه فعال شد');
  });

  it('/projects lists the registered projects', async () => {
    const { bot, telegram } = await createTestBot({ aiReply: { text: 'ok' } });
    await bot.handleUpdate(text('/project owner/repo'));
    await bot.handleUpdate(text('/projects', 2));
    expect(telegram.messages.at(-1)!.text).toContain('owner/repo');
  });

  it('/github shows the connection type and repository state', async () => {
    const { bot, telegram } = await createTestBot({ aiReply: { text: 'ok' } });
    await bot.handleUpdate(text('/project owner/repo'));
    await bot.handleUpdate(text('/github', 2));

    const body = telegram.messages.at(-1)!.text;
    expect(body).toContain('اتصال گیت‌هاب');
    expect(body).toContain('Personal Access Token');
    expect(body).toContain('owner/repo');
  });

  it('/status and /usage report real numbers', async () => {
    const { bot, telegram } = await createTestBot({ aiReply: { text: 'ok' } });
    await bot.providers.complete({ messages: [{ role: 'user', content: 'x' }] });

    await bot.handleUpdate(text('/status'));
    const status = telegram.messages.at(-1)!.text;
    expect(status).toContain('ارائه‌دهنده فعال');
    expect(status).toContain('gemini');

    await bot.handleUpdate(text('/usage', 2));
    const usage = telegram.messages.at(-1)!.text;
    expect(usage).toContain('۳۰۰'); // 100 input + 200 output tokens, in Persian digits
    expect(usage).toContain('دقیقه Actions');
  });

  it('/settings shows configuration without any secret', async () => {
    const { bot, telegram } = await createTestBot({ aiReply: { text: 'ok' } });
    await bot.handleUpdate(text('/settings'));
    const body = telegram.messages.at(-1)!.text;
    expect(body).toContain('دستورهای مجاز');
    expect(body).not.toContain('AIza');
    expect(body).not.toContain('ghp_');
  });

  it('/tasks and /models respond in Persian', async () => {
    const { bot, telegram } = await createTestBot({ aiReply: { text: 'ok' } });
    await bot.handleUpdate(text('/tasks'));
    expect(telegram.messages.at(-1)!.text).toContain('هیچ وظیفه‌ای');

    await bot.handleUpdate(text('/models', 2));
    expect(telegram.messages.at(-1)!.text).toContain('ارائه‌دهنده‌ها');
  });

  it('an unknown slash command is forwarded to the agent instead of erroring', async () => {
    const { bot, telegram, mock } = await createTestBot({ aiReply: { text: 'این را به‌عنوان درخواست فهمیدم.' } });
    await bot.handleUpdate(text('/doesnotexist'));

    expect(telegram.messages.at(-1)!.text).toContain('درخواست فهمیدم');
    expect(JSON.stringify(mock.lastCallTo('generativelanguage')!.body)).toContain('/doesnotexist');
  });

  it('accepts a text file and rejects oversized or binary uploads', async () => {
    const { bot, telegram, store } = await createTestBot({ aiReply: { text: 'ok' } });

    await bot.handleUpdate({
      update_id: 10,
      message: { message_id: 10, date: 0, chat: { id: OWNER_ID, type: 'private' }, from: { id: OWNER_ID }, document: { file_id: 'f1', file_name: 'notes.md', file_size: 500 } },
    });
    expect(telegram.messages.at(-1)!.text).toContain('پذیرفته شد');
    expect(telegram.messages.at(-1)!.text).toContain('محتوای فایل خوانده نمی‌شود');

    await bot.handleUpdate({
      update_id: 11,
      message: { message_id: 11, date: 0, chat: { id: OWNER_ID, type: 'private' }, from: { id: OWNER_ID }, document: { file_id: 'f2', file_name: 'app.exe', file_size: 500 } },
    });
    expect(telegram.messages.at(-1)!.text).toContain('نوع فایل مجاز نیست');

    await bot.handleUpdate({
      update_id: 12,
      message: { message_id: 12, date: 0, chat: { id: OWNER_ID, type: 'private' }, from: { id: OWNER_ID }, document: { file_id: 'f3', file_name: 'big.txt', file_size: 999_999 } },
    });
    expect(telegram.messages.at(-1)!.text).toContain('حجم فایل');

    const audit = await store.recentAudit(5);
    expect(audit.some((entry) => entry.action === 'document.accepted')).toBe(true);
  });

  it('preserves fenced code and outer whitespace while trimming only command routing', () => {
    const raw = '  ```python\nif True:\n    print("ok")\n```  ';
    expect(routeUpdate(text(raw))).toEqual({ kind: 'text', text: raw });

    const command = routeUpdate(text('  /new   یک تست اضافه کن  '));
    // Router keeps the leading slash by contract; Bot.runCommand strips it.
    expect(command).toMatchObject({ kind: 'command', command: '/new', args: 'یک تست اضافه کن' });
  });

  it('sends free text straight to the conversational agent', async () => {
    const { bot, store, telegram, mock } = await createTestBot({ aiReply: { text: 'حتماً، انجامش می‌دهم.' } });
    const project = await store.createProject({ name: 'repo', owner: 'owner', repo: 'repo' });
    await store.setSetting('active_project_id', project.id);

    const original = `یه چیزی درست کن ${'با جزئیات کامل '.repeat(12)}`;
    await bot.handleUpdate(text(original));

    // No confirmation button and no legacy request row: the agent answers directly.
    const message = telegram.messages.at(-1)!;
    expect(message.text).toContain('انجامش می‌دهم');
    expect(message.replyMarkup).toBeUndefined();
    expect(await store.listJobs()).toHaveLength(0);
    const stored = await store.listChatMessages(OWNER_ID);
    expect(stored[0]!.content).toBe(original);
    // The active project is part of the runtime context handed to the model.
    expect(JSON.stringify(mock.lastCallTo('generativelanguage')!.body)).toContain('owner/repo');
  });
});
