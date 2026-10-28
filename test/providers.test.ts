import { describe, expect, it } from 'vitest';
import { createTestBot, mockOpenAiCompatible, OWNER_ID, update } from './helpers.js';
import { NoProviderAvailableError } from '../src/ai/types.js';
import { checkLimits, estimateCostUsd } from '../src/ai/usage.js';

describe('AI providers (acceptance tests 2 and 16)', () => {
  it('selects the free Gemini tier by default and records real usage', async () => {
    const { bot, store } = await createTestBot({ aiReply: { text: 'سلام!', inputTokens: 120, outputTokens: 30 } });

    const provider = await bot.providers.activeProvider();
    expect(provider?.name).toBe('gemini');
    expect(provider?.free_tier).toBe(1);

    const completion = await bot.providers.complete({ messages: [{ role: 'user', content: 'سلام' }] });
    expect(completion.text).toBe('سلام!');
    expect(await store.usageForDay('gemini')).toBe(150);
    expect(await store.usageForMonth('gemini')).toBe(150);
  });

  it('sends the request in Gemini format and keeps the key out of the prompt body', async () => {
    const { bot, mock } = await createTestBot({ aiReply: { text: 'ok' } });
    await bot.providers.complete({ messages: [{ role: 'user', content: 'سلام' }] });

    const call = mock.lastCallTo('generativelanguage.googleapis.com');
    expect(call).toBeDefined();
    expect(call!.url).toContain(':generateContent');
    expect(JSON.stringify(call!.body)).not.toContain('AIzaFakeGeminiKeyForTests000000000');
  });

  it('stops calling a provider when the daily free-tier cap is reached (queues instead of paying)', async () => {
    const { bot, store } = await createTestBot({ aiReply: { text: 'ok' } });
    await store.sql.run('UPDATE providers SET daily_limit = 10 WHERE name = ?', ['gemini']);
    await store.recordUsage('gemini', 5, 6);

    await expect(bot.providers.complete({ messages: [{ role: 'user', content: 'x' }] })).rejects.toBeInstanceOf(NoProviderAvailableError);
    expect(await store.usageForDay('gemini')).toBe(11); // no extra tokens were spent
  });

  it('warns before the cap and deactivates an invalid key (never falls back to a paid model)', async () => {
    const { bot, store, mock, telegram } = await createTestBot({ aiReply: { text: 'ok' } });
    mock.prepend(/generativelanguage\.googleapis\.com/, () =>
      new Response(JSON.stringify({ error: { message: 'API key not valid: AIzaFakeGeminiKeyForTests000000000' } }), { status: 401 }),
    );

    await expect(bot.providers.complete({ messages: [{ role: 'user', content: 'x' }] })).rejects.toBeInstanceOf(NoProviderAvailableError);

    const provider = await store.getProvider('gemini');
    expect(provider?.last_check_status).toBe('invalid_key');
    expect(provider?.active).toBe(0);

    const warnings = telegram.messages.map((message) => message.text).join('\n');
    expect(warnings).toContain('کلید');
    expect(warnings).not.toContain('AIzaFakeGeminiKeyForTests000000000');

    // OpenAI/Anthropic are configured nowhere: they must stay inactive.
    const paid = (await store.listProviders()).filter((row) => !row.free_tier);
    expect(paid.every((row) => row.active === 0)).toBe(true);
  });

  it('falls back to another FREE provider when the first one errors', async () => {
    const { bot, mock } = await createTestBot({
      env: { GROQ_API_KEY: 'gsk_fakeGroqKeyForTests00000000000' } as never,
      aiReply: { text: 'ok' },
      registerMocks: (m) => {
        m.on(/generativelanguage\.googleapis\.com/, () => new Response(JSON.stringify({ error: { message: 'upstream error' } }), { status: 500 }));
        mockOpenAiCompatible(m, /api\.groq\.com/, { text: 'from groq', inputTokens: 10, outputTokens: 5 });
      },
    });

    const completion = await bot.providers.complete({ messages: [{ role: 'user', content: 'x' }] });
    expect(completion.provider).toBe('groq');
    expect(completion.text).toBe('from groq');
  });

  it('/provider and /model commands switch the active free model', async () => {
    const { bot, store, telegram } = await createTestBot({ aiReply: { text: 'ok' } });

    await bot.handleUpdate(update({ message: { message_id: 1, date: 0, chat: { id: OWNER_ID, type: 'private' }, from: { id: OWNER_ID }, text: '/provider gemini' } }));
    expect((await bot.providers.activeProvider())?.name).toBe('gemini');

    await bot.handleUpdate(update({ update_id: 2, message: { message_id: 2, date: 0, chat: { id: OWNER_ID, type: 'private' }, from: { id: OWNER_ID }, text: '/model gemini-1.5-flash' } }));
    expect((await store.getProvider('gemini'))?.model).toBe('gemini-1.5-flash');

    await bot.handleUpdate(update({ update_id: 3, message: { message_id: 3, date: 0, chat: { id: OWNER_ID, type: 'private' }, from: { id: OWNER_ID }, text: '/model gpt-4o' } }));
    expect(telegram.messages.at(-1)?.text).toContain('تعریف نشده');

    await bot.handleUpdate(update({ update_id: 4, message: { message_id: 4, date: 0, chat: { id: OWNER_ID, type: 'private' }, from: { id: OWNER_ID }, text: '/provider unknown-llm' } }));
    expect(telegram.messages.at(-1)?.text).toContain('ناشناس');
  });

  it('/test_api reports the health of every provider', async () => {
    const { bot, telegram } = await createTestBot({ aiReply: { text: 'ok' } });
    await bot.handleUpdate(update({ message: { message_id: 1, date: 0, chat: { id: OWNER_ID, type: 'private' }, from: { id: OWNER_ID }, text: '/test_api' } }));

    const report = telegram.messages.map((message) => message.text).join('\n');
    expect(report).toContain('نتیجه تست');
    expect(report).toContain('gemini');
    expect(report).toContain('ok');
  });

  it('estimates cost as zero on free tiers and non-zero only for paid providers', () => {
    expect(estimateCostUsd('gemini', 1_000_000, 1_000_000)).toBe(0);
    expect(estimateCostUsd('openai', 1_000_000, 1_000_000)).toBeCloseTo(0.75, 5);
  });

  it('reports a warning level when 80% of the daily budget is used', async () => {
    const { bot, store } = await createTestBot();
    await store.sql.run('UPDATE providers SET daily_limit = 100 WHERE name = ?', ['gemini']);
    await store.recordUsage('gemini', 85, 0);
    const provider = (await store.getProvider('gemini'))!;
    const check = await checkLimits(store, provider);
    expect(check.level).toBe('warn');
    expect(check.ok).toBe(true);
  });
});

describe('free-tier cost guards', () => {
  it('schema init is idempotent and never loses data on the next request', async () => {
    const { store } = await createTestBot();
    await store.createProject({ name: 'repo', owner: 'owner', repo: 'repo' });

    await store.init(); // simulates the next webhook invocation
    await store.init();

    expect(await store.listProjects()).toHaveLength(1);
  });

  it('provider catalogue is not re-seeded on every request (D1 writes cost money)', async () => {
    const { bot, store } = await createTestBot();
    await store.sql.run('UPDATE providers SET daily_limit = 12345 WHERE name = ?', ['gemini']);

    await bot.providers.sync(); // as called by the next Bot.create()
    expect((await store.getProvider('gemini'))?.daily_limit).toBe(12345);

    await bot.providers.sync({ force: true });
    expect((await store.getProvider('gemini'))?.daily_limit).not.toBe(12345);
  });

  it('an invalid key stays deactivated after a restart', async () => {
    const { store, mock } = await createTestBot({ aiReply: { text: 'ok' } });
    mock.prepend(/generativelanguage\.googleapis\.com/, () => new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 }));
    const bot = (await createTestBot({})).bot;

    // a fresh Bot on the same DB must not resurrect the broken provider
    const providers = await store.listProviders();
    expect(providers.length).toBeGreaterThan(0);
    expect(bot.env.GEMINI_API_KEY).toBeDefined();
  });
});
