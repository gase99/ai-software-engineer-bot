import { describe, expect, it } from 'vitest';
import { createTestBot, OWNER_ID, update } from './helpers.js';

describe('owner authorization (acceptance test 1)', () => {
  it('rejects a user who is not the owner and audits the attempt', async () => {
    const { bot, store, telegram } = await createTestBot();

    await bot.handleUpdate(
      update({ message: { message_id: 2, date: 0, chat: { id: 555, type: 'private' }, from: { id: 555, username: 'stranger' }, text: '/start' } }),
    );

    expect(telegram.messages.some((message) => message.text.includes('اجازه استفاده'))).toBe(true);
    const audit = await store.recentAudit(10);
    expect(audit.some((entry) => entry.action === 'auth.denied')).toBe(true);
    // The /start welcome must never be sent to a stranger
    expect(telegram.messages.some((message) => message.text.includes('مهندس نرم‌افزار هوش مصنوعی'))).toBe(false);
  });

  it('accepts the owner and registers the chat', async () => {
    const { bot, store, telegram } = await createTestBot();

    await bot.handleUpdate(update({ message: { message_id: 3, date: 0, chat: { id: OWNER_ID, type: 'private' }, from: { id: OWNER_ID }, text: '/start' } }));

    expect(telegram.messages.some((message) => message.text.includes('مهندس نرم‌افزار'))).toBe(true);
    expect(await store.getSetting(`chat:${OWNER_ID}`)).toBe(String(OWNER_ID));
  });

  it('blocks callback queries from non-owners too', async () => {
    const { bot, telegram } = await createTestBot();

    await bot.handleUpdate({
      update_id: 9,
      callback_query: {
        id: 'cb1',
        from: { id: 777, username: 'intruder' },
        data: 'plan|req_1|1|approve|forged.token',
        message: { message_id: 4, date: 0, chat: { id: 777, type: 'private' } },
      },
    });

    expect(telegram.messages.some((message) => message.text.includes('اجازه استفاده'))).toBe(true);
  });

  it('rate limits bursts from the owner (30 messages per minute)', async () => {
    const { bot, telegram } = await createTestBot();

    for (let i = 0; i < 32; i++) {
      await bot.handleUpdate(
        update({ update_id: 100 + i, message: { message_id: 100 + i, date: 0, chat: { id: OWNER_ID, type: 'private' }, from: { id: OWNER_ID }, text: '/status' } }),
      );
    }

    expect(telegram.messages.some((message) => message.text.includes('تعداد پیام‌ها زیاد شد'))).toBe(true);
  });
});
