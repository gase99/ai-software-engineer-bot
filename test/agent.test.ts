import { describe, expect, it } from 'vitest';
import { createTestBot, jsonResponse, mockGeminiTurns, OWNER_ID, update } from './helpers.js';
import { classifyApprovalReply } from '../src/agent/intent.js';
import { routeUpdate } from '../src/telegram/router.js';
import { parseCallbackData } from '../src/telegram/keyboard.js';

const text = (value: string, messageId = 1) =>
  update({
    update_id: messageId,
    message: { message_id: messageId, date: 0, chat: { id: OWNER_ID, type: 'private' }, from: { id: OWNER_ID }, text: value },
  });

/** A fake "POST /user/repos" so repo creation never touches the network. */
function mockRepoCreation(mock: import('./helpers.js').FetchMock, record: string[] = []) {
  mock.on(/api\.github\.com\/user\/repos$/, (_url, init) => {
    const body = JSON.parse(String(init.body)) as { name: string; private: boolean };
    record.push(`${body.name}:${body.private}`);
    return jsonResponse(
      {
        full_name: `owner/${body.name}`,
        html_url: `https://github.com/owner/${body.name}`,
        default_branch: 'main',
        private: body.private ?? true,
        language: null,
        description: null,
      },
      201,
    );
  });
  return record;
}

describe('conversational agent', () => {
  it('answers a free-text message with the model and stores the conversation', async () => {
    const { bot, telegram, store, mock } = await createTestBot({ aiReply: { text: 'سلام! در خدمتم.' } });

    await bot.handleUpdate(text('سلام، وقت بخیر'));

    expect(telegram.messages.at(-1)!.text).toContain('در خدمتم');
    const history = await store.listChatMessages(OWNER_ID);
    expect(history.map((row) => row.role)).toEqual(['user', 'assistant']);
    expect(history[0]!.content).toBe('سلام، وقت بخیر');
    // The tool catalogue travels with the very first request.
    const body = mock.lastCallTo('generativelanguage')!.body as Record<string, unknown>;
    const tools = body.tools as Array<{ functionDeclarations: Array<{ name: string }> }>;
    const names = tools[0]!.functionDeclarations.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(['create_github_repo', 'read_github_file', 'write_code_to_github', 'create_pull_request', 'get_bot_capabilities']));
  });

  it('remembers earlier messages across turns (D1 chat memory)', async () => {
    const { bot, store, mock } = await createTestBot({ aiReply: { text: 'ثبت شد' } });

    await bot.handleUpdate(text('اسم مخزن رو بذار test-app', 1));
    await bot.handleUpdate(text('حالا همان را بساز', 2));

    const secondCall = JSON.stringify(mock.lastCallTo('generativelanguage')!.body);
    expect(secondCall).toContain('test-app');
    expect(await store.countChatMessages(OWNER_ID)).toBe(4);
  });

  it('runs a read-only tool and feeds the result back to the model', async () => {
    const { bot, telegram, mock } = await createTestBot({
      registerMocks: (m) => {
        mockGeminiTurns(m, [
          { text: 'بگذار ببینم چه کارهایی می‌توانم بکنم.', toolCalls: [{ name: 'get_bot_capabilities' }] },
          { text: 'می‌توانم مخزن بسازم، فایل بخوانم و کامیت کنم.' },
        ]);
      },
    });

    await bot.handleUpdate(text('چه کارهایی می‌توانی بکنی؟'));

    expect(telegram.messages.at(-1)!.text).toContain('می‌توانم مخزن بسازم');
    const bodies = mock.callsTo('generativelanguage').map((call) => JSON.stringify(call.body));
    // The tool result was returned to the model as a functionResponse.
    expect(bodies[1]).toContain('functionResponse');
    expect(bodies[1]).toContain('get_bot_capabilities');
  });

  it('asks for approval in natural language and does nothing before "بله"', async () => {
    const created: string[] = [];
    const { bot, telegram, store, mock } = await createTestBot({
      registerMocks: (m) => {
        mockRepoCreation(m, created);
        mockGeminiTurns(m, [
          { text: 'مخزن را برایت می‌سازم.', toolCalls: [{ name: 'create_github_repo', args: { name: 'test-app', private: true } }] },
          { text: 'مخزن test-app ساخته شد ✅' },
        ]);
      },
    });

    await bot.handleUpdate(text('یک مخزن جدید به اسم test-app بساز'));

    const question = telegram.messages.at(-1)!;
    expect(question.text).toContain('اجازه لازم دارم');
    expect(question.text).toContain('test-app');
    expect(question.text).toContain('بله');
    const markup = question.replyMarkup as { inline_keyboard: Array<Array<{ callback_data: string }>> };
    expect(parseCallbackData(markup.inline_keyboard[0]![0]!.callback_data)).toMatchObject({ scope: 'agent', action: 'approve' });

    // Nothing was created and no approval row was decided yet.
    expect(created).toHaveLength(0);
    expect((await store.latestPendingAction(OWNER_ID))!.status).toBe('pending');

    await bot.handleUpdate(text('بله', 2));

    expect(created).toEqual(['test-app:true']);
    expect(telegram.messages.at(-1)!.text).toContain('ساخته شد');
    expect((await store.latestPendingAction(OWNER_ID))).toBeNull();
    const repos = await store.listRepos();
    expect(repos.map((repo) => repo.full_name)).toContain('owner/test-app');
  });

  it('does not execute anything when the owner says "خیر"', async () => {
    const created: string[] = [];
    const { bot, telegram, store } = await createTestBot({
      registerMocks: (m) => {
        mockRepoCreation(m, created);
        mockGeminiTurns(m, [
          { toolCalls: [{ name: 'create_github_repo', args: { name: 'nope-app' } }] },
          { text: 'باشه، انجام ندادم.' },
        ]);
      },
    });

    await bot.handleUpdate(text('یک مخزن بساز'));
    await bot.handleUpdate(text('خیر', 2));

    expect(created).toHaveLength(0);
    expect(telegram.messages.at(-1)!.text).toContain('انجام ندادم');
    const action = await store.getPendingAction((await store.sql.all<{ id: string }>('SELECT id FROM pending_actions'))[0]!.id);
    expect(action!.status).toBe('rejected');
  });

  it('runs the tools exactly once when "بله" is typed twice', async () => {
    const created: string[] = [];
    const { bot, telegram } = await createTestBot({
      registerMocks: (m) => {
        mockRepoCreation(m, created);
        mockGeminiTurns(m, [
          { toolCalls: [{ name: 'create_github_repo', args: { name: 'once-app' } }] },
          { text: 'ساخته شد' },
        ]);
      },
    });

    await bot.handleUpdate(text('مخزن once-app را بساز'));
    await bot.handleUpdate(text('بله', 2));
    await bot.handleUpdate(text('بله', 3));

    // The second "بله" finds no pending action, so it is just another chat turn;
    // what matters is that the repository was created exactly once.
    expect(created).toEqual(['once-app:true']);
    expect(telegram.messages.length).toBeGreaterThan(0);
  });

  it('approves through the inline button too', async () => {
    const created: string[] = [];
    const { bot, store } = await createTestBot({
      registerMocks: (m) => {
        mockRepoCreation(m, created);
        mockGeminiTurns(m, [
          { toolCalls: [{ name: 'create_github_repo', args: { name: 'button-app' } }] },
          { text: 'انجام شد' },
        ]);
      },
    });

    await bot.handleUpdate(text('مخزن button-app را بساز'));
    const action = (await store.latestPendingAction(OWNER_ID))!;

    await bot.handleUpdate({
      update_id: 9,
      callback_query: {
        id: 'cb-1',
        from: { id: OWNER_ID },
        data: `ag|${action.id}|y`,
        message: { message_id: 2, date: 0, chat: { id: OWNER_ID, type: 'private' } },
      },
    });

    expect(created).toEqual(['button-app:true']);
  });

  it('says it has no access instead of pretending when a capability is missing', async () => {
    const { bot, telegram, mock } = await createTestBot({
      env: { GITHUB_TOKEN: undefined },
      registerMocks: (m) => {
        mockGeminiTurns(m, [
          { toolCalls: [{ name: 'create_github_repo', args: { name: 'no-token-app' } }] },
          { text: 'من دسترسی به گیت‌هاب ندارم و نمی‌توانم مخزن بسازم.' },
        ]);
      },
    });

    await bot.handleUpdate(text('یک مخزن بساز'));

    expect(telegram.messages.at(-1)!.text).toContain('دسترسی به گیت‌هاب ندارم');
    // No approval was requested for an impossible action.
    expect(await bot.store.latestPendingAction(OWNER_ID)).toBeNull();
    // And nothing was sent to GitHub.
    expect(mock.callsTo('api.github.com')).toHaveLength(0);
    const toolTurn = JSON.stringify(mock.callsTo('generativelanguage')[1]!.body);
    expect(toolTurn).toContain('در دسترس نیست');
  });

  it('reads a repository file without asking for approval', async () => {
    const { bot, telegram, mock } = await createTestBot({
      registerMocks: (m) => {
        mockGeminiTurns(m, [
          { toolCalls: [{ name: 'read_github_file', args: { repo: 'owner/repo', path: 'src/app.ts' } }] },
          { text: 'فایل را خواندم.' },
        ]);
      },
    });

    await bot.handleUpdate(text('فایل src/app.ts را بخوان'));

    expect(telegram.messages.at(-1)!.text).toContain('فایل را خواندم');
    const toolTurn = JSON.stringify(mock.callsTo('generativelanguage')[1]!.body);
    expect(toolTurn).toContain('export const add');
    // A read-only tool never becomes a pending action.
    expect(await bot.store.latestPendingAction(OWNER_ID)).toBeNull();
  });

  it('refuses to run tests for a repository it does not manage', async () => {
    const { bot, store, mock } = await createTestBot({
      registerMocks: (m) => {
        mockGeminiTurns(m, [
          { toolCalls: [{ name: 'run_tests', args: { repo: 'owner/repo', commands: ['npm test'] } }] },
          { text: 'من به این مخزن دسترسی ندارم.' },
        ]);
      },
    });

    await bot.handleUpdate(text('تست‌های مخزن owner/repo را اجرا کن'));

    expect(await store.listJobs()).toHaveLength(0);
    expect(await bot.store.latestPendingAction(OWNER_ID)).toBeNull();
    // Nothing was dispatched to GitHub Actions either.
    expect(mock.callsTo('/actions/workflows/')).toHaveLength(0);
  });

  it('queues a test run after approval for a registered project', async () => {
    const { bot, store } = await createTestBot({
      registerMocks: (m) => {
        mockGeminiTurns(m, [
          { toolCalls: [{ name: 'run_tests', args: { repo: 'owner/repo', commands: ['npm test'] } }] },
          { text: 'تست‌ها در صف قرار گرفت.' },
        ]);
      },
    });

    const project = await store.createProject({ name: 'repo', owner: 'owner', repo: 'repo' });
    await store.setSetting('active_project_id', project.id);

    await bot.handleUpdate(text('تست‌ها را اجرا کن'));
    expect(await bot.store.latestPendingAction(OWNER_ID)).not.toBeNull();
    expect(await store.listJobs()).toHaveLength(0);

    await bot.handleUpdate(text('بله', 2));

    const jobs = await store.listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.kind).toBe('tests');
    expect(JSON.parse(jobs[0]!.payload_json)).toMatchObject({ projectId: project.id, commands: ['npm test'] });
  });

  it('/cancel drops a waiting approval', async () => {
    const created: string[] = [];
    const { bot, telegram, store } = await createTestBot({
      registerMocks: (m) => {
        mockRepoCreation(m, created);
        mockGeminiTurns(m, [{ toolCalls: [{ name: 'create_github_repo', args: { name: 'cancelled-app' } }] }]);
      },
    });

    await bot.handleUpdate(text('مخزن cancelled-app را بساز'));
    await bot.handleUpdate(text('/cancel', 2));

    expect(telegram.messages.at(-1)!.text).toContain('لغو');
    expect(await store.latestPendingAction(OWNER_ID)).toBeNull();
    expect(created).toHaveLength(0);
  });

  it('/reset clears the conversation memory', async () => {
    const { bot, store, telegram } = await createTestBot({ aiReply: { text: 'باشه' } });

    await bot.handleUpdate(text('یک چیز', 1));
    expect(await store.countChatMessages(OWNER_ID)).toBe(2);

    await bot.handleUpdate(text('/reset', 2));
    expect(await store.countChatMessages(OWNER_ID)).toBe(0);
    expect(telegram.messages.at(-1)!.text).toContain('حافظه گفتگو پاک شد');
  });

  it('keeps a valid transcript when an approval question is left unanswered', async () => {
    const created: string[] = [];
    const { bot, mock } = await createTestBot({
      registerMocks: (m) => {
        mockRepoCreation(m, created);
        mockGeminiTurns(m, [
          { toolCalls: [{ name: 'create_github_repo', args: { name: 'pending-app' } }] },
          { text: 'باشه، فعلاً کاری نمی‌کنم.' },
        ]);
      },
    });

    await bot.handleUpdate(text('مخزن pending-app را بساز'));
    await bot.handleUpdate(text('راستی فردا هوا چطوره؟', 2));

    // The unanswered tool call got a placeholder result before the new turn.
    const calls = mock.callsTo('generativelanguage');
    expect(calls).toHaveLength(2);
    const second = JSON.stringify(calls[1]!.body);
    expect(second).toContain('functionResponse');
    expect(created).toHaveLength(0);
  });
});

describe('approval intent parsing', () => {
  it.each([
    ['بله', 'approve'],
    ['آره انجام بده', 'approve'],
    ['ok go ahead', 'approve'],
    ['خیر', 'reject'],
    ['نه، انجام نده', 'reject'],
    ['cancel', 'reject'],
    ['فردا هوا چطوره؟', 'unclear'],
    ['باشه', 'unclear'],
    ['ok', 'unclear'],
    ['ممنون', 'unclear'],
    ['', 'unclear'],
  ])('classifies %s as %s', (input, expected) => {
    expect(classifyApprovalReply(input)).toBe(expected);
  });
});

describe('router without menus', () => {
  it('routes free text to the agent and keeps /start, /cancel as commands', () => {
    expect(routeUpdate(text('یک مخزن بساز'))).toEqual({ kind: 'text', text: 'یک مخزن بساز' });
    expect(routeUpdate(text('/start'))).toMatchObject({ kind: 'command', command: '/start' });
    expect(routeUpdate(text('/cancel'))).toMatchObject({ kind: 'command', command: '/cancel' });
  });

  it('does not treat the old menu labels as menu taps', () => {
    expect(routeUpdate(text('پروژه‌های من'))).toEqual({ kind: 'text', text: 'پروژه‌های من' });
  });
});
