import type { Env } from './env.js';
import { Bot } from './bot.js';
import type { TelegramUpdate } from './telegram/api.js';
import { safeEqual } from './util/crypto.js';
import { logger } from './util/log.js';

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/**
 * Cloudflare Worker entry point (Mode A).
 *
 * The Worker stays tiny: it verifies the request, answers Telegram, enqueues
 * work and lets GitHub Actions (or the cron tick) do the heavy lifting.
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true, service: 'ai-software-engineer-bot', time: new Date().toISOString() });
    }

    // GitHub Actions reports results here (shared-secret protected).
    if (request.method === 'POST' && url.pathname === '/actions/callback') {
      const provided = request.headers.get('x-actions-token') ?? '';
      const expected = env.ACTIONS_CALLBACK_TOKEN ?? '';
      if (!expected || !(await safeEqual(provided, expected))) {
        logger.warn('actions_callback.unauthorized');
        return json({ ok: false, error: 'unauthorized' }, 401);
      }
      const body = (await request.json().catch(() => ({}))) as Record<string, string>;
      const bot = await Bot.create(env);
      ctx.waitUntil(
        bot.handleActionCallback(body as never).catch((error) => logger.error('actions_callback.failed', { error: (error as Error).message })),
      );
      return json({ ok: true, received: true });
    }

    // Telegram webhook.
    if (request.method === 'POST' && url.pathname === (env.WEBHOOK_PATH ?? '/telegram/webhook')) {
      const secret = request.headers.get('x-telegram-bot-api-secret-token') ?? '';
      if (env.TELEGRAM_WEBHOOK_SECRET && !(await safeEqual(secret, env.TELEGRAM_WEBHOOK_SECRET))) {
        logger.warn('webhook.bad_secret');
        return json({ ok: false, error: 'unauthorized' }, 401);
      }
      const update = (await request.json().catch(() => null)) as TelegramUpdate | null;
      if (!update) return json({ ok: false, error: 'invalid payload' }, 400);

      const bot = await Bot.create(env);
      ctx.waitUntil(
        bot.handleUpdate(update, { waitUntil: (promise) => ctx.waitUntil(promise) }).catch((error) =>
          logger.error('webhook.handler_failed', { error: (error as Error).message }),
        ),
      );
      // Telegram only needs a fast 200; long work continues in the background.
      return json({ ok: true });
    }

    // Admin helper: register/refresh the webhook (protected by the same secret).
    if (request.method === 'POST' && url.pathname === '/admin/set-webhook') {
      const provided = request.headers.get('x-admin-token') ?? '';
      if (!env.ACTIONS_CALLBACK_TOKEN || !(await safeEqual(provided, env.ACTIONS_CALLBACK_TOKEN))) {
        return json({ ok: false, error: 'unauthorized' }, 401);
      }
      const body = (await request.json().catch(() => ({}))) as { url?: string };
      if (!body.url) return json({ ok: false, error: 'url required' }, 400);
      const bot = await Bot.create(env);
      const path = env.WEBHOOK_PATH ?? '/telegram/webhook';
      await bot.telegram.setWebhook(`${body.url.replace(/\/$/, '')}${path}`, env.TELEGRAM_WEBHOOK_SECRET);
      await bot.telegram.setMyCommands([
        { command: 'projects', description: 'پروژه‌های من' },
        { command: 'new', description: 'درخواست جدید' },
        { command: 'status', description: 'وضعیت' },
        { command: 'models', description: 'انتخاب مدل' },
      ]);
      return json({ ok: true, webhook: `${body.url}${path}` });
    }

    return json({ ok: false, error: 'not found' }, 404);
  },

  /** Workers Cron (free plan): drains the queue every few minutes. */
  async scheduled(_event: unknown, env: Env, ctx: ExecutionContext): Promise<void> {
    const bot = await Bot.create(env);
    ctx.waitUntil(
      bot.tick().then(
        (result) => logger.info('cron.tick', result),
        (error) => logger.error('cron.failed', { error: (error as Error).message }),
      ),
    );
  },
};
