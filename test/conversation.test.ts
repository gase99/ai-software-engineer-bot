import { describe, expect, it } from 'vitest';
import { createTestBot, OWNER_ID, update } from './helpers.js';
import { coerceRoute, fallbackRoute } from '../src/core/conversation.js';

const text = (value: string, messageId = 1) =>
  update({ update_id: messageId, message: { message_id: messageId, date: 0, chat: { id: OWNER_ID, type: 'private' }, from: { id: OWNER_ID }, text: value } });

const route = (intent: string, reply = '', confidence = 0.9, args = '') =>
  JSON.stringify({ intent, args, reply, confidence });

/** Last user turn sent to the provider, as plain text. */
function lastUserPrompt(body: unknown): string {
  const contents = (body as { contents?: Array<{ role: string; parts: Array<{ text: string }> }> }).contents ?? [];
  const last = contents.filter((entry) => entry.role === 'user').at(-1);
  return (last?.parts ?? []).map((part) => part.text).join('\n');
}

describe('conversational mode: no slash command is required', () => {
  it('answers ordinary chat instead of creating a request', async () => {
    const { bot, store, telegram } = await createTestBot({
      aiReply: () => ({ text: route('chat', 'سلام! خوبم، مرسی. چه کاری برایت داریم؟') }),
    });

    await bot.handleUpdate(text('سلام، خوبی؟'));

    expect(telegram.messages.at(-1)!.text).toContain('خوبم');
    expect(await store.listJobs()).toHaveLength(0);
    expect(await store.listProjects()).toHaveLength(0);
  });

  it('routes a casual question to the matching capability (وضعیت چیه؟)', async () => {
    const { bot, store, telegram } = await createTestBot({
      aiReply: () => ({ text: route('status', 'الان وضعیت را برایت می‌گویم.') }),
    });
    const project = await store.createProject({ name: 'repo', owner: 'owner', repo: 'repo' });
    await store.setSetting('active_project_id', project.id);

    await bot.handleUpdate(text('چی خبر؟ همه چیز روبراهه؟'));

    const last = telegram.messages.at(-1)!.text;
    expect(last).toContain('ارائه‌دهنده فعال');
    expect(last).toContain('owner/repo');
    expect(await store.listJobs()).toHaveLength(0);
  });

  it('starts a request directly from plain speech, with no confirm button', async () => {
    const { bot, store, telegram } = await createTestBot({
      aiReply: () => ({ text: route('new_request', 'باشه، شروع می‌کنم.', 0.92) }),
    });
    const project = await store.createProject({ name: 'repo', owner: 'owner', repo: 'repo' });
    await store.setSetting('active_project_id', project.id);

    const message = 'این باگِ لاگین رو درست کن';
    await bot.handleUpdate(text(message));

    const request = (await store.latestRequestForProject(project.id))!;
    expect(request.raw_text).toBe(message);
    expect(request.status).toBe('queued');
    expect(await store.listJobs()).toHaveLength(1);
    expect(telegram.messages.at(-1)!.text).toContain('در صف تحلیل');
    expect(telegram.messages.some((entry) => entry.text.includes('باشه، شروع می‌کنم'))).toBe(true);
    // No inline confirmation was rendered.
    expect(telegram.messages.some((entry) => entry.replyMarkup)).toBe(false);
  });

  it('asks for one tap when the intent is only a guess', async () => {
    const { bot, store, telegram } = await createTestBot({
      aiReply: () => ({ text: route('new_request', 'شاید منظورت تغییر لاگ‌هاست؟', 0.3) }),
    });
    const project = await store.createProject({ name: 'repo', owner: 'owner', repo: 'repo' });
    await store.setSetting('active_project_id', project.id);

    await bot.handleUpdate(text('یه چیزی درباره لاگ‌ها'));

    const message = telegram.messages.at(-1)!;
    expect(message.text).toContain('درخواست جدید ثبت کنم');
    expect(message.replyMarkup).toBeTruthy();
    expect(await store.listJobs()).toHaveLength(0);
    expect(await store.latestRequestForProject(project.id)).toBeNull();
  });

  it('honours AUTO_START_REQUESTS=0 and keeps the confirmation step', async () => {
    const { bot, store, telegram } = await createTestBot({
      env: { AUTO_START_REQUESTS: '0' },
      aiReply: () => ({ text: route('new_request', 'می‌فهمم.', 0.99) }),
    });
    const project = await store.createProject({ name: 'repo', owner: 'owner', repo: 'repo' });
    await store.setSetting('active_project_id', project.id);

    await bot.handleUpdate(text('یک تابع تفریق اضافه کن'));

    expect(telegram.messages.at(-1)!.replyMarkup).toBeTruthy();
    expect(await store.listJobs()).toHaveLength(0);
  });

  it('never executes work when the owner only says "تأیید" in chat', async () => {
    const { bot, store, telegram } = await createTestBot({
      aiReply: () => ({ text: route('approve', 'باشه!', 0.95) }),
    });
    const project = await store.createProject({ name: 'repo', owner: 'owner', repo: 'repo' });
    await store.setSetting('active_project_id', project.id);
    const request = await store.createRequest(project.id, OWNER_ID, 'یک ویژگی');
    await store.savePlan({
      requestId: request.id,
      version: 1,
      plan: {
        understanding: 'افزودن ویژگی',
        outcome: 'ویژگی کار کند',
        files: ['src/app.ts'],
        approach: 'کدنویسی',
        impact: { database: 'ندارد', api: 'ندارد', ui: 'ندارد' },
        tests: ['npm test'],
        risks: [],
        unknowns: [],
        effort: 'S',
        estimatedApiCostUsd: 0,
        commands: ['npm test'],
      },
      reportFa: 'گزارش',
      provider: 'gemini',
      model: 'gemini-1.5-flash',
      inputTokens: 10,
      outputTokens: 20,
    });
    await store.setRequestStatus(request.id, 'awaiting_approval', { currentPlanVersion: 1 });

    await bot.handleUpdate(text('باشه انجامش بده'));

    expect((await store.getRequest(request.id))!.status).toBe('awaiting_approval');
    expect(await store.listJobs()).toHaveLength(0);
    // The signed approval button is shown again instead.
    const markup = telegram.messages.at(-1)!.replyMarkup as { inline_keyboard: unknown[][] };
    expect(markup.inline_keyboard.flat()).not.toHaveLength(0);
  });

  it('understands a model change phrased in plain Persian', async () => {
    const { bot, telegram } = await createTestBot({
      aiReply: () => ({ text: route('set_model', 'چشم، مدل را عوض می‌کنم.', 0.9, 'gemini-1.5-flash') }),
    });

    await bot.handleUpdate(text('مدل رو بذار روی gemini-1.5-flash'));

    expect(telegram.messages.at(-1)!.text).toContain('gemini-1.5-flash');
    expect(telegram.messages.at(-1)!.text).toContain('تنظیم شد');
  });

  it('remembers the previous turns so follow-up sentences make sense', async () => {
    const prompts: string[] = [];
    const { bot } = await createTestBot({
      aiReply: (body) => {
        prompts.push(JSON.stringify(body));
        return { text: route('chat', prompts.length === 1 ? 'درباره لاگ‌هاست.' : 'باشه، همان را ادامه می‌دهیم.') };
      },
    });

    await bot.handleUpdate(text('درباره لاگ‌ها چی؟'));
    await bot.handleUpdate(text('همون قبلی رو ادامه بده', 2));

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('درباره لاگ‌ها چی');
    expect(prompts[1]).toContain('درباره لاگ‌هاست.');
  });

  it('carries the recent conversation into a follow-up request', async () => {
    let turn = 0;
    const { bot, store } = await createTestBot({
      aiReply: () => {
        turn += 1;
        return { text: turn === 1 ? route('chat', 'می‌خواهی لاگ‌ها را ذخیره کنم؟') : route('new_request', 'باشه.', 0.9) };
      },
    });
    const project = await store.createProject({ name: 'repo', owner: 'owner', repo: 'repo' });
    await store.setSetting('active_project_id', project.id);

    await bot.handleUpdate(text('درباره لاگ‌ها چی؟'));
    await bot.handleUpdate(text('آره همون رو انجام بده', 2));

    const request = (await store.latestRequestForProject(project.id))!;
    expect(request.raw_text).toContain('آره همون رو انجام بده');
    expect(request.raw_text).toContain('زمینهٔ گفت‌وگو');
    expect(request.raw_text).toContain('درباره لاگ‌ها چی');
  });

  it('selects an existing project by its spoken name', async () => {
    const { bot, store, telegram } = await createTestBot({
      aiReply: () => ({ text: route('select_project', 'باشه، همان را فعال می‌کنم.', 0.9, 'فروشگاه') }),
    });
    await store.createProject({ name: 'فروشگاه', owner: 'owner', repo: 'shop' });
    await store.createProject({ name: 'repo', owner: 'owner', repo: 'repo' });

    await bot.handleUpdate(text('پروژه فروشگاه رو انتخاب کن'));

    expect(telegram.messages.some((entry) => entry.text.includes('owner/shop'))).toBe(true);
  });

  it('keeps working from the rules router when no AI provider is reachable', async () => {
    // No aiReply mock: every provider call fails.
    const { bot, store, telegram } = await createTestBot();

    await bot.handleUpdate(text('سلام'));

    expect(telegram.messages.at(-1)!.text).toContain('سلام');
    expect(await store.listJobs()).toHaveLength(0);
  });

  it('never guesses silently in rules mode: an unclear change request asks first', async () => {
    const { bot, store, telegram } = await createTestBot();
    const project = await store.createProject({ name: 'repo', owner: 'owner', repo: 'repo' });
    await store.setSetting('active_project_id', project.id);

    await bot.handleUpdate(text('یه بخش لاگ اضافه کن که خطاها ذخیره بشن'));

    expect(telegram.messages.at(-1)!.text).toContain('درخواست جدید ثبت کنم');
    expect(await store.listJobs()).toHaveLength(0);
  });
});

describe('conversation router validation', () => {
  it('rejects unknown intents and keeps a natural reply', () => {
    const parsed = coerceRoute({ intent: 'sudo-rm-rf', reply: 'سلام', confidence: 4 }, 'سلام');
    expect(parsed.intent).toBe('chat');
    expect(parsed.confidence).toBe(1);
  });

  it('falls back to the rules router for an empty chat answer', () => {
    const parsed = coerceRoute({ intent: 'chat', reply: '', confidence: 0.9 }, 'سلام');
    expect(parsed.source).toBe('rules');
    expect(parsed.reply).toContain('سلام');
  });

  it('never treats greetings or questions as a change request', () => {
    for (const message of ['سلام', 'مرسی', 'خوبی؟', 'این پروژه چیه؟', 'ممنون دستت درد نکنه']) {
      expect(fallbackRoute(message).intent, message).not.toBe('new_request');
    }
  });

  it('recognises a repo reference as adding a project', () => {
    const parsed = fallbackRoute('پروژه گیت‌هابم رو وصل کن gase99/demo');
    expect(parsed.intent).toBe('add_project');
    expect(parsed.args).toBe('gase99/demo');
  });
});
