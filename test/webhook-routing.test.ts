import { afterEach, describe, expect, it, vi } from 'vitest';
import { Bot } from '../src/bot.js';
import type { Env } from '../src/env.js';
import worker from '../src/index.js';
import { createTestBot, OWNER_ID, update } from './helpers.js';

const secret = 'configured-webhook-secret';
const sampleUpdate = {
  update_id: 42,
  message: { message_id: 1, date: 0, chat: { id: 1, type: 'private' }, from: { id: 1 }, text: '/start' },
};

function post(path: string, token: string | undefined, body = JSON.stringify(sampleUpdate)): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (token !== undefined) headers.set('x-telegram-bot-api-secret-token', token);
  return new Request(`https://worker.example${path}`, { method: 'POST', headers, body });
}

function env(webhookPath?: string, webhookSecret = secret): Env {
  return { WEBHOOK_PATH: webhookPath, TELEGRAM_WEBHOOK_SECRET: webhookSecret } as Env;
}

afterEach(() => vi.restoreAllMocks());

describe('Telegram webhook routing', () => {
  it.each([
    { path: '/webhook', configuredPath: undefined, configuredMatch: false, aliasMatch: true },
    { path: '/webhook', configuredPath: '/telegram/webhook', configuredMatch: false, aliasMatch: true },
    { path: '/telegram/webhook', configuredPath: undefined, configuredMatch: true, aliasMatch: false },
    { path: '/telegram/webhook', configuredPath: '/telegram/webhook', configuredMatch: true, aliasMatch: false },
    { path: '/webhook', configuredPath: '/webhook', configuredMatch: true, aliasMatch: false },
    { path: '/custom', configuredPath: '/custom', configuredMatch: true, aliasMatch: false },
  ])('accepts $path with configured path $configuredPath after verifying the secret', async ({ path, configuredPath, configuredMatch, aliasMatch }) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const handleUpdate = vi.fn().mockResolvedValue(undefined);
    const createBot = vi.spyOn(Bot, 'create').mockResolvedValue({ handleUpdate } as unknown as Bot);
    const pending: Promise<unknown>[] = [];
    const response = await worker.fetch(post(path, secret), env(configuredPath), {
      waitUntil: (promise) => { pending.push(promise); },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(log).toHaveBeenCalledWith('FETCH ROUTE CHECK:', {
      isPost: true,
      matchesConfiguredWebhookPath: configuredMatch,
      matchesDefaultWebhookAlias: aliasMatch,
    });
    expect(log).toHaveBeenCalledWith('WEBHOOK SECRET CHECK:', {
      secretReceived: true, secretConfigured: true, matches: true,
    });
    expect(log).toHaveBeenCalledWith('FETCH RESPONSE:', { status: 200 });
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    expect(createBot).toHaveBeenCalledOnce();
    expect(handleUpdate).toHaveBeenCalledOnce();
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
  });

  it.each([
    { description: 'missing header', provided: undefined, configured: secret },
    { description: 'empty header', provided: '', configured: secret },
    { description: 'wrong header', provided: 'wrong-webhook-secret', configured: secret },
    { description: 'empty configured secret', provided: secret, configured: '' },
  ])('rejects /webhook with $description before starting any bot work', async ({ provided, configured }) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const createBot = vi.spyOn(Bot, 'create');
    const waitUntil = vi.fn();
    const response = await worker.fetch(post('/webhook', provided), env('/telegram/webhook', configured), { waitUntil });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, error: 'unauthorized' });
    expect(log).toHaveBeenCalledWith('FETCH RESPONSE:', { status: 401 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('webhook.bad_secret'));
    expect(createBot).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
    const output = JSON.stringify([log.mock.calls, warn.mock.calls]);
    if (provided) expect(output).not.toContain(provided);
    if (configured) expect(output).not.toContain(configured);
  });

  it.each([
    { method: 'POST', path: '/webhook', configuredPath: '/custom', configuredMatch: false, aliasMatch: false },
    { method: 'POST', path: '/telegram/webhook', configuredPath: '/webhook', configuredMatch: false, aliasMatch: false },
    { method: 'POST', path: '/wrong', configuredPath: undefined, configuredMatch: false, aliasMatch: false },
    { method: 'GET', path: '/webhook', configuredPath: undefined, configuredMatch: false, aliasMatch: true },
  ])('returns 404 for $method $path when it is not an allowed webhook route', async ({ method, path, configuredPath, configuredMatch, aliasMatch }) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const createBot = vi.spyOn(Bot, 'create');
    const waitUntil = vi.fn();
    const response = await worker.fetch(new Request(`https://worker.example${path}`, { method }), env(configuredPath), { waitUntil });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ ok: false, error: 'not found' });
    expect(log).toHaveBeenCalledWith('FETCH ROUTE CHECK:', {
      isPost: method === 'POST',
      matchesConfiguredWebhookPath: configuredMatch,
      matchesDefaultWebhookAlias: aliasMatch,
    });
    expect(log).toHaveBeenCalledWith('FETCH RESPONSE:', { status: 404 });
    expect(log).not.toHaveBeenCalledWith('WEBHOOK SECRET CHECK:', expect.anything());
    expect(createBot).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it('does not log paths, query parameters, headers, or configured secrets when routing fails', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const response = await worker.fetch(
      post('/received-private-path?token=private-query-value', 'private-header-value'),
      env('/expected-private-path', 'private-configured-value'),
      { waitUntil: () => undefined },
    );

    expect(response.status).toBe(404);
    const output = JSON.stringify(log.mock.calls);
    for (const privateValue of ['received-private-path', 'private-query-value', 'private-header-value', 'expected-private-path', 'private-configured-value']) {
      expect(output).not.toContain(privateValue);
    }
  });

  it('logs and returns 400 for invalid JSON on the alias after authentication', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const createBot = vi.spyOn(Bot, 'create');
    const waitUntil = vi.fn();
    const response = await worker.fetch(post('/webhook', secret, '{'), env(), { waitUntil });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: 'invalid payload' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('webhook.invalid_payload'));
    expect(log).toHaveBeenCalledWith('FETCH RESPONSE:', { status: 400 });
    expect(createBot).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it('processes /start through the alias and sends the owner a reply', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const testBot = await createTestBot();
    vi.spyOn(Bot, 'create').mockResolvedValue(testBot.bot);
    const pending: Promise<unknown>[] = [];
    const response = await worker.fetch(
      post('/webhook', testBot.env.TELEGRAM_WEBHOOK_SECRET, JSON.stringify(update())),
      { ...testBot.env, WEBHOOK_PATH: '/telegram/webhook' },
      { waitUntil: (promise) => { pending.push(promise); } },
    );

    expect(response.status).toBe(200);
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    expect(log).toHaveBeenCalledWith('AUTH CHECK:', { ownerId: String(OWNER_ID), senderId: OWNER_ID });
    expect(testBot.telegram.messages.some((message) => message.text.includes('مهندس نرم‌افزار'))).toBe(true);
  });

  it('returns 200 without waiting for asynchronous update processing', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let finish!: () => void;
    const task = new Promise<void>((resolve) => { finish = resolve; });
    const handleUpdate = vi.fn().mockReturnValue(task);
    vi.spyOn(Bot, 'create').mockResolvedValue({ handleUpdate } as unknown as Bot);
    const pending: Promise<unknown>[] = [];
    const response = await worker.fetch(post('/webhook', secret), env(), {
      waitUntil: (promise) => { pending.push(promise); },
    });

    expect(response.status).toBe(200);
    expect(pending).toHaveLength(1);
    let completed = false;
    void pending[0]!.then(() => { completed = true; });
    await Promise.resolve();
    expect(completed).toBe(false);
    finish();
    await Promise.all(pending);
    expect(completed).toBe(true);
  });

  it('logs a background handler failure after the 200 acknowledgement', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handleUpdate = vi.fn().mockRejectedValue(new Error('synthetic handler failure'));
    vi.spyOn(Bot, 'create').mockResolvedValue({ handleUpdate } as unknown as Bot);
    const pending: Promise<unknown>[] = [];
    const response = await worker.fetch(post('/webhook', secret), env(), {
      waitUntil: (promise) => { pending.push(promise); },
    });

    expect(response.status).toBe(200);
    await Promise.all(pending);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('webhook.handler_failed'));
  });

  it('logs and propagates bot initialization failures without acknowledging or scheduling', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(Bot, 'create').mockRejectedValue(new Error('synthetic database failure'));
    const waitUntil = vi.fn();

    await expect(worker.fetch(post('/webhook', secret), env(), { waitUntil })).rejects.toThrow('synthetic database failure');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('webhook.bot_init_failed'));
    expect(log).not.toHaveBeenCalledWith('FETCH RESPONSE:', { status: 200 });
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it.each([
    { configuredPath: undefined, registeredPath: '/telegram/webhook' },
    { configuredPath: '/custom', registeredPath: '/custom' },
  ])('the admin endpoint registers the configured path $registeredPath', async ({ configuredPath, registeredPath }) => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const setWebhook = vi.fn().mockResolvedValue(true);
    const setMyCommands = vi.fn().mockResolvedValue(true);
    vi.spyOn(Bot, 'create').mockResolvedValue({ telegram: { setWebhook, setMyCommands } } as unknown as Bot);
    const response = await worker.fetch(
      new Request('https://worker.example/admin/set-webhook', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-admin-token': 'admin-secret' },
        body: JSON.stringify({ url: 'https://worker.example' }),
      }),
      { ...env(configuredPath), ACTIONS_CALLBACK_TOKEN: 'admin-secret' },
      { waitUntil: () => undefined },
    );

    expect(response.status).toBe(200);
    expect(setWebhook).toHaveBeenCalledWith(`https://worker.example${registeredPath}`, secret);
    expect(setMyCommands).toHaveBeenCalledOnce();
  });
});
