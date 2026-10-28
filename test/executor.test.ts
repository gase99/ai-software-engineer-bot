import { describe, expect, it } from 'vitest';
import { createTestBot, codeJson, planJson, OWNER_ID, update } from './helpers.js';

/** The analysis prompt and the coding prompt are answered differently. */
function smartReply(body: unknown): { text: string; inputTokens: number; outputTokens: number } {
  const raw = JSON.stringify(body ?? {});
  if (raw.includes('تغییرات را به‌صورت JSON')) return { text: codeJson(), inputTokens: 800, outputTokens: 400 };
  return { text: planJson(), inputTokens: 500, outputTokens: 300 };
}

async function approveData(markup: unknown): Promise<string> {
  const keyboard = markup as { inline_keyboard: Array<Array<{ callback_data: string }>> };
  const approve = keyboard.inline_keyboard.flat().find((button) => button.callback_data.includes('|approve|'));
  if (!approve) throw new Error('no approve button was rendered');
  return approve.callback_data;
}

async function runFullFlow() {
  const harness = await createTestBot({ aiReply: smartReply as never });
  const { bot, store, telegram, github, mock } = harness;

  await bot.handleUpdate(update({ message: { message_id: 1, date: 0, chat: { id: OWNER_ID, type: 'private' }, from: { id: OWNER_ID }, text: '/project owner/repo' } }));
  await bot.handleUpdate(update({ update_id: 2, message: { message_id: 2, date: 0, chat: { id: OWNER_ID, type: 'private' }, from: { id: OWNER_ID }, text: '/new یک تابع تفریق اضافه کن و تستش را بنویس' } }));

  const planMessage = telegram.messages.filter((message) => message.replyMarkup).pop()!;
  const data = await approveData(planMessage.replyMarkup);

  return { ...harness, data, planMessage, mock, github, store, bot, telegram };
}

describe('end-to-end flow (acceptance tests 7, 8, 9, 10, 11)', () => {
  it('writes nothing before a valid approval exists', async () => {
    const { bot, store, github } = await runFullFlow();
    expect(github.commits).toHaveLength(0);

    const project = await store.getProject((await store.getActiveProjectId())!);
    const request = (await store.latestRequestForProject(project!.id))!;
    const { ExecutionEngine } = await import('../src/core/executor.js');
    const executor = new ExecutionEngine(store, await bot.github(), await bot.dispatcher(), bot.analysis, bot.approvals, {
      COMMAND_ALLOWLIST: 'npm test,pytest',
      ACTIONS_MONTHLY_MINUTE_LIMIT: '2000',
    });
    await expect(
      executor.execute({ request, project: project!, plan: { ...JSON.parse(planJson()) }, planVersion: 1 }, 'owner'),
    ).rejects.toThrow(/تأیید/);
    expect(github.commits).toHaveLength(0);
  });

  it('creates a branch, commits real code, opens a PR and runs tests after approval', async () => {
    const { bot, store, telegram, github, mock, data } = await runFullFlow();
    const beforeCommits = github.commits.length;

    await bot.handleUpdate({
      update_id: 3,
      callback_query: {
        id: 'cb-approve',
        from: { id: OWNER_ID },
        data,
        message: { message_id: 2, date: 0, chat: { id: OWNER_ID, type: 'private' }, from: { id: OWNER_ID } },
      },
    });

    // 7) separate working branch
    const branch = github.commits.at(-1)!.branch;
    expect(branch.startsWith('ai/')).toBe(true);
    expect(branch).not.toBe('main');

    // 8) real code change landed
    expect(github.commits.length).toBe(beforeCommits + 1);
    const commit = github.commits.at(-1)!;
    expect(commit.path).toBe('src/app.ts');
    expect(commit.content).toContain('export const subtract');

    // 11) pull request created against the default branch
    const prCall = mock.lastCallTo('/pulls');
    const prBody = prCall!.body as { head: string; base: string; title: string };
    expect(prBody.base).toBe('main');
    expect(prBody.head).toBe(branch);
    expect(prBody.title).toContain('feat(ai)');

    // 9) tests really dispatched to GitHub Actions
    expect(mock.callsTo('/actions/workflows/ai-exec.yml/dispatches')).toHaveLength(1);
    const dispatchBody = mock.lastCallTo('/actions/workflows/ai-exec.yml/dispatches')!.body as { inputs: { commands: string; job_id: string } };
    expect(dispatchBody.inputs.commands).toBe('npm test');

    // final report to the owner
    const report = telegram.messages.map((message) => message.text).join('\n');
    expect(report).toContain('اجرا تمام شد');
    expect(report).toContain('pull/42');
    expect(report).toContain('تست‌ها موفق بودند');

    // state after execution
    const project = await store.getProject((await store.getActiveProjectId())!);
    const request = (await store.latestRequestForProject(project!.id))!;
    expect(request.status).toBe('done');

    // audit trail + memory recorded
    const audit = await store.recentAudit(20);
    expect(audit.some((entry) => entry.action === 'pr.created')).toBe(true);
    expect(audit.some((entry) => entry.action === 'approval.rejected_invalid')).toBe(false);
    const memory = await store.listMemory(project!.id);
    expect(memory.some((entry) => entry.kind === 'decision')).toBe(true);
  });

  it('refuses a forged approval callback: no branch, no commit, no PR', async () => {
    const { bot, github, mock, data } = await runFullFlow();
    const [requestId, version, action, token] = data.replace('plan|', '').split('|') as [string, string, string, string];
    const forged = `plan|${requestId}|${version}|${action}|${token.slice(0, -3)}xyz`;

    await bot.handleUpdate({
      update_id: 4,
      callback_query: {
        id: 'cb-forged',
        from: { id: OWNER_ID },
        data: forged,
        message: { message_id: 2, date: 0, chat: { id: OWNER_ID, type: 'private' } },
      },
    });

    expect(github.commits).toHaveLength(0);
    expect(mock.callsTo('/pulls')).toHaveLength(0);
    expect(mock.callsTo('/git/refs')).toHaveLength(0);
  });

  it('cancels cleanly when the owner presses لغو', async () => {
    const { bot, store, telegram, github, data } = await runFullFlow();
    const cancel = data.replace('|approve|', '|cancel|');

    await bot.handleUpdate({
      update_id: 5,
      callback_query: { id: 'cb-cancel', from: { id: OWNER_ID }, data: cancel, message: { message_id: 2, date: 0, chat: { id: OWNER_ID, type: 'private' } } },
    });

    expect(github.commits).toHaveLength(0);
    expect(telegram.messages.map((message) => message.text).join('\n')).toContain('لغو شد');
    const project = await store.getProject((await store.getActiveProjectId())!);
    const request = (await store.latestRequestForProject(project!.id))!;
    expect(request.status).toBe('cancelled');
  });

  it('reports honestly when the repo has no execution workflow', async () => {
    const { bot, mock, telegram, github, data } = await runFullFlow();
    mock.prepend(/\/actions\/workflows\/ai-exec\.yml\/dispatches/, () => new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 }));

    await bot.handleUpdate({
      update_id: 6,
      callback_query: { id: 'cb-2', from: { id: OWNER_ID }, data, message: { message_id: 2, date: 0, chat: { id: OWNER_ID, type: 'private' } } },
    });

    // the code change and the PR still happen...
    expect(github.commits).toHaveLength(1);
    expect(mock.callsTo('/pulls')).toHaveLength(1);
    // ...but the bot says plainly that tests did NOT run
    const report = telegram.messages.map((message) => message.text).join('\n');
    expect(report).toContain('تستی اجرا نشد');
    expect(report).not.toContain('تست‌ها موفق بودند');
  });
});
