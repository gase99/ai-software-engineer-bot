import { afterEach, describe, expect, it, vi } from 'vitest';
import { Bot } from '../src/bot.js';
import type { Env } from '../src/env.js';
import worker from '../src/index.js';

const update = {
  update_id: 42,
  message: {
    message_id: 1,
    date: 0,
    chat: { id: 1, type: 'private' },
    from: { id: 1 },
    text: '/start',
  },
};

function webhookRequest(token: string | undefined, path = '/telegram/webhook'): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (token !== undefined) headers.set('x-telegram-bot-api-secret-token', token);
  return new Request(`https://worker.example${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(update),
  });
}

afterEach(() => vi.restoreAllMocks());

describe('Worker fetch diagnostics', () => {
  it.each([
    { description: 'a health check', method: 'GET', path: '/health', webhookPath: undefined, status: 200 },
    { description: 'an unexpected path', method: 'POST', path: '/wrong', webhookPath: undefined, status: 404 },
    { description: 'a different method', method: 'GET', path: '/telegram/webhook', webhookPath: undefined, status: 404 },
    { description: 'the default path when a custom one is configured', method: 'POST', path: '/telegram/webhook', webhookPath: '/custom', status: 404 },
  ])('logs the fetch entry for $description without checking a webhook secret', async ({ method, path, webhookPath, status }) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const response = await worker.fetch(
      new Request(`https://worker.example${path}`, { method }),
      { WEBHOOK_PATH: webhookPath } as Env,
      { waitUntil: () => undefined },
    );

    expect(response.status).toBe(status);
    expect(log.mock.calls).toEqual([
      ['FETCH HANDLER STARTED'],
      ['FETCH ROUTE CHECK:', {
        isPost: method === 'POST',
        matchesConfiguredWebhookPath: path === (webhookPath ?? '/telegram/webhook'),
        matchesDefaultWebhookAlias: (webhookPath ?? '/telegram/webhook') === '/telegram/webhook' && path === '/webhook',
      }],
      ['FETCH RESPONSE:', { status }],
    ]);
  });

  it.each([
    { description: 'a wrong token', token: 'received-value', configured: 'configured-value', received: true, present: true },
    { description: 'a missing header', token: undefined, configured: 'configured-value', received: false, present: true },
    { description: 'an empty header', token: '', configured: 'configured-value', received: false, present: true },
    { description: 'a missing configured secret', token: 'received-value', configured: undefined, received: true, present: false },
    { description: 'an empty configured secret and header', token: undefined, configured: '', received: false, present: false },
  ])('logs safe diagnostics and rejects $description', async ({ token, configured, received, present }) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const response = await worker.fetch(
      webhookRequest(token),
      { TELEGRAM_WEBHOOK_SECRET: configured } as Env,
      { waitUntil: () => undefined },
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, error: 'unauthorized' });
    expect(log.mock.calls).toEqual([
      ['FETCH HANDLER STARTED'],
      ['FETCH ROUTE CHECK:', { isPost: true, matchesConfiguredWebhookPath: true, matchesDefaultWebhookAlias: false }],
      ['WEBHOOK SECRET CHECK:', { secretReceived: received, secretConfigured: present, matches: false }],
      ['FETCH RESPONSE:', { status: 401 }],
    ]);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('webhook.bad_secret'));
    const output = JSON.stringify([log.mock.calls, warn.mock.calls]);
    if (token) expect(output).not.toContain(token);
    if (configured) expect(output).not.toContain(configured);
  });

  it.each([
    { description: 'the default webhook path', path: '/telegram/webhook', webhookPath: undefined },
    { description: 'a custom webhook path', path: '/custom', webhookPath: '/custom' },
  ])('logs a match and continues processing on $description', async ({ path, webhookPath }) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const handleUpdate = vi.fn().mockResolvedValue(undefined);
    const createBot = vi.spyOn(Bot, 'create').mockResolvedValue({ handleUpdate } as unknown as Bot);
    const pending: Promise<unknown>[] = [];
    const token = 'matching-secret-value';
    const response = await worker.fetch(
      webhookRequest(token, path),
      { TELEGRAM_WEBHOOK_SECRET: token, WEBHOOK_PATH: webhookPath } as Env,
      { waitUntil: (promise) => { pending.push(promise); } },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(log.mock.calls.slice(0, 3)).toEqual([
      ['FETCH HANDLER STARTED'],
      ['FETCH ROUTE CHECK:', { isPost: true, matchesConfiguredWebhookPath: true, matchesDefaultWebhookAlias: false }],
      ['WEBHOOK SECRET CHECK:', { secretReceived: true, secretConfigured: true, matches: true }],
    ]);
    expect(log).toHaveBeenCalledWith('INCOMING UPDATE:', JSON.stringify(update));
    expect(log).toHaveBeenCalledWith('FETCH RESPONSE:', { status: 200 });
    expect(JSON.stringify(log.mock.calls)).not.toContain(token);
    expect(createBot).toHaveBeenCalledOnce();
    expect(handleUpdate).toHaveBeenCalledWith(update, { waitUntil: expect.any(Function) });
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
  });
});
