import type { Env } from './env.js';
import { num } from './env.js';
import { Store } from './db/store.js';
import type { Sql } from './db/sql.js';
import { TelegramClient, TelegramError, type TelegramMessage, type TelegramUpdate } from './telegram/api.js';
import { confirmKeyboard, mainMenuKeyboard, parseCallbackData, planApprovalKeyboard } from './telegram/keyboard.js';
import { routeUpdate, type Route } from './telegram/router.js';
import { ProviderManager, type ProviderEvent } from './ai/registry.js';
import { NoProviderAvailableError } from './ai/types.js';
import { AnalysisEngine } from './core/analyzer.js';
import { ApprovalService } from './core/approval.js';
import { ExecutionEngine } from './core/executor.js';
import { renderPlanReport } from './core/report.js';
import { takeSnapshot } from './core/snapshot.js';
import { GithubClient, GithubError } from './github/client.js';
import { ActionsDispatcher } from './github/actions.js';
import { resolveGithubToken } from './github/token.js';
import { checkActionsQuota } from './github/quota.js';
import { isCommandAllowed, parseAllowlist } from './github/commands.js';
import { JobRunner } from './jobs/dispatcher.js';
import { assertOwner, identityFromUpdate, isOwner, ownerIds, UnauthorizedError, type Identity } from './security/auth.js';
import { checkRateLimit } from './security/rateLimit.js';
import { isExplicitApproval, isRejection } from './security/promptGuard.js';
import { escHtml, splitTelegramMessage, toPersianDigits, truncate } from './util/text.js';
import { hmacSign, randomToken } from './util/crypto.js';
import { logger } from './util/log.js';
import type { JobKind, JobRow, PlanContent, Project, RequestRow } from './types.js';
import { Store as StoreType } from './db/store.js';

export interface BotContext {
  waitUntil?: (promise: Promise<unknown>) => void;
}

interface ConversationState {
  state: 'idle' | 'awaiting_request' | 'awaiting_revision';
  requestId?: string;
  note?: string;
}

const MENU_TO_COMMAND: Record<string, string> = {
  'پروژه‌های من': '/projects',
  'درخواست جدید': '/new',
  'ادامه قبلی': '/resume',
  'انتخاب مدل': '/models',
  'تنظیمات API': '/provider',
  'اتصال GitHub': '/github',
  'وضعیت وظایف': '/tasks',
  'تاریخچه': '/history',
  'گزارش تست‌ها': '/tests',
  'تنظیمات امنیتی': '/security',
  'راهنما': '/help',
};

const COMMANDS = [
  { command: 'start', description: 'شروع و نمایش منو' },
  { command: 'help', description: 'راهنمای فرمان‌ها' },
  { command: 'projects', description: 'لیست پروژه‌ها' },
  { command: 'project', description: 'انتخاب/افزودن پروژه: /project owner/repo' },
  { command: 'new', description: 'درخواست توسعه جدید' },
  { command: 'resume', description: 'ادامه آخرین درخواست' },
  { command: 'status', description: 'وضعیت ربات و پروژه فعال' },
  { command: 'tasks', description: 'وضعیت وظایف/صف' },
  { command: 'models', description: 'لیست ارائه‌دهنده‌ها و مدل‌ها' },
  { command: 'provider', description: 'انتخاب ارائه‌دهنده' },
  { command: 'model', description: 'انتخاب مدل ارائه‌دهنده فعال' },
  { command: 'test_api', description: 'تست اتصال کلیدهای هوش مصنوعی' },
  { command: 'github', description: 'وضعیت اتصال گیت‌هاب' },
  { command: 'usage', description: 'مصرف توکن و دقیقه Actions' },
  { command: 'tests', description: 'گزارش آخرین اجرای تست‌ها' },
  { command: 'history', description: 'تاریخچه درخواست‌ها' },
  { command: 'security', description: 'تنظیمات و وضعیت امنیتی' },
  { command: 'cancel', description: 'لغو درخواست/وظیفه جاری' },
  { command: 'settings', description: 'تنظیمات غیرمحرمانه' },
];

/** The bot: composition root plus all Telegram-facing behaviour. */
export class Bot {
  readonly telegram: TelegramClient;
  readonly providers: ProviderManager;
  readonly approvals: ApprovalService;
  readonly analysis: AnalysisEngine;
  readonly runner: JobRunner;

  private constructor(
    readonly env: Env,
    readonly store: StoreType,
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {
    this.telegram = new TelegramClient(env.TELEGRAM_BOT_TOKEN, fetchImpl);
    this.providers = new ProviderManager(store, env, (event) => this.onProviderEvent(event), fetchImpl);
    this.approvals = new ApprovalService(store, env.APPROVAL_SECRET, 30);
    this.analysis = new AnalysisEngine(this.providers, store, { COMMAND_ALLOWLIST: env.COMMAND_ALLOWLIST });
    this.runner = new JobRunner(this);
  }

  static async create(env: Env, sql?: Sql, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)): Promise<Bot> {
    const store = new StoreType(sql ?? (env.DB as unknown as Sql));
    await store.init();
    const bot = new Bot(env, store, fetchImpl);
    await bot.providers.sync();
    return bot;
  }

  // --------------------------------------------------------------- plumbing
  async github(): Promise<GithubClient> {
    const { token } = await resolveGithubToken(this.env, this.fetchImpl);
    return new GithubClient(token, this.fetchImpl);
  }

  async dispatcher(): Promise<ActionsDispatcher> {
    return new ActionsDispatcher(await this.github(), this.store, { COMMAND_ALLOWLIST: this.env.COMMAND_ALLOWLIST });
  }

  async executor(): Promise<ExecutionEngine> {
    return new ExecutionEngine(this.store, await this.github(), await this.dispatcher(), this.analysis, this.approvals, {
      COMMAND_ALLOWLIST: this.env.COMMAND_ALLOWLIST,
      ACTIONS_MONTHLY_MINUTE_LIMIT: this.env.ACTIONS_MONTHLY_MINUTE_LIMIT,
    });
  }

  private ownerChatId(): number | null {
    const ids = [...ownerIds(this.env)];
    return ids.length ? (ids[0] as number) : null;
  }

  private async reply(chatId: number, text: string, replyMarkup?: unknown): Promise<TelegramMessage | null> {
    try {
      const chunks = splitTelegramMessage(text);
      let last: TelegramMessage | null = null;
      for (const chunk of chunks) {
        last = await this.telegram.sendMessage(chatId, chunk, { parseMode: 'HTML', replyMarkup });
      }
      return last;
    } catch (error) {
      logger.error('telegram.send_failed', { error: (error as Error).message });
      return null;
    }
  }

  private providerEventMessage(event: ProviderEvent): string {
    switch (event.type) {
      case 'key_invalid':
        return `⚠️ کلید ارائه‌دهنده <b>${escHtml(event.provider)}</b> معتبر نیست (منقضی یا اشتباه). این ارائه‌دهنده غیرفعال شد.`;
      case 'rate_limited':
        return `⏳ ارائه‌دهنده <b>${escHtml(event.provider)}</b> به محدودیت نرخ خورده؛ درخواست در صف قرار گرفت.`;
      case 'limit_warning':
        return `📊 <b>${escHtml(event.provider)}</b> نزدیک سقف رایگان است: ${escHtml(event.message)}`;
      case 'fallback':
        return `🔄 به‌دلیل خطا از <b>${escHtml(event.from)}</b> به <b>${escHtml(event.to)}</b> تغییر مسیر دادم (بدون استفاده از مدل پولی).`;
    }
  }

  private async onProviderEvent(event: ProviderEvent): Promise<void> {
    const chatId = this.ownerChatId();
    if (!chatId) return;
    const message = this.providerEventMessage(event);
    const target = event.type === 'fallback' ? `${event.from}->${event.to}` : event.provider;
    await this.reply(chatId, message);
    await this.store.audit('system', `provider.${event.type}`, target);
  }

  // ------------------------------------------------------------ update entry
  async handleUpdate(update: TelegramUpdate, context: BotContext = {}): Promise<void> {
    try {
      const identity = assertOwner(this.env, update);
      const route = routeUpdate(update);
      const limit = await checkRateLimit(this.store.sql, `chat:${identity.telegramUserId}`, 30, 60_000);
      if (!limit.allowed) {
        const chatId = this.chatIdFromRoute(update, identity);
        if (chatId) await this.reply(chatId, `⏳ تعداد پیام‌ها زیاد شد؛ ${toPersianDigits(limit.retryAfterSeconds)} ثانیه دیگر دوباره تلاش کن.`);
        return;
      }
      await this.dispatchRoute(route, update, identity, context);
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        await this.handleUnauthorized(error, update);
        return;
      }
      logger.error('update.failed', { error: (error as Error).message, updateId: update.update_id });
      const chatId = update.message?.chat?.id ?? update.callback_query?.message?.chat?.id;
      if (chatId) await this.reply(chatId, `❌ خطا: ${escHtml(truncate((error as Error).message, 400))}`);
    }
  }

  private chatIdFromRoute(update: TelegramUpdate, identity: Identity): number | null {
    return update.message?.chat?.id ?? update.edited_message?.chat?.id ?? update.callback_query?.message?.chat?.id ?? identity.chatId ?? null;
  }

  private async handleUnauthorized(error: UnauthorizedError, update: TelegramUpdate): Promise<void> {
    const chatId = this.chatIdFromRoute(update, { telegramUserId: error.identity?.telegramUserId ?? 0, chatId: error.identity?.chatId ?? 0 });
    await this.store.audit(String(error.identity?.telegramUserId ?? 'unknown'), 'auth.denied', chatId ? String(chatId) : undefined);
    logger.warn('auth.denied', { telegramUserId: error.identity?.telegramUserId });
    if (chatId) await this.reply(chatId, '🚫 شما اجازه استفاده از این ربات را ندارید.');
  }

  private async dispatchRoute(route: Route, update: TelegramUpdate, identity: Identity, context: BotContext): Promise<void> {
    const chatId = this.chatIdFromRoute(update, identity);
    if (!chatId) return;

    if (route.kind === 'callback') {
      await this.handleCallback(route.data, update, chatId, identity, context);
      return;
    }

    if (route.kind === 'document') {
      await this.handleDocument(route.fileName, route.fileSize, chatId, identity);
      return;
    }

    if (route.kind === 'menu') {
      const mapped = MENU_TO_COMMAND[route.label];
      if (mapped) await this.runCommand(mapped, '', chatId, identity, context);
      return;
    }

    if (route.kind === 'command') {
      await this.runCommand(route.command, route.args, chatId, identity, context);
      return;
    }

    if (route.kind === 'text') {
      await this.handleFreeText(route.text, chatId, identity, context);
    }
  }

  // --------------------------------------------------------------- commands
  async runCommand(rawCommand: string, args: string, chatId: number, identity: Identity, context: BotContext = {}): Promise<void> {
    const command = rawCommand.replace(/^\//, '').toLowerCase();
    const actor = String(identity.telegramUserId);
    await this.store.audit(actor, `command.${command}`, args.slice(0, 200));

    switch (command) {
      case 'start': {
        await this.store.setSetting(`chat:${identity.telegramUserId}`, String(chatId));
        await this.telegram.sendMessage(
          chatId,
          'سلام 👋\nمن مهندس نرم‌افزار هوش مصنوعی شما هستم.\nدرخواستت را به فارسی ساده بنویس؛ من مخزن را تحلیل می‌کنم، طرح می‌دهم و بعد از تأیید خودت کد می‌نویسم، تست اجرا می‌کنم و Pull Request می‌سازم.\n\nهیچ تغییری بدون تأیید شما انجام نمی‌شود.',
          { replyMarkup: mainMenuKeyboard() },
        );
        return;
      }
      case 'help': {
        const list = COMMANDS.map((item) => `/${item.command} — ${item.description}`).join('\n');
        await this.reply(chatId, `📖 <b>فرمان‌ها</b>\n\n${escHtml(list)}\n\nهمچنین می‌توانی جمله‌ات را ساده بنویسی، مثلاً:\n«یک بخش لاگ اضافه کن که خطاها را ذخیره کند»`);
        return;
      }
      case 'projects': {
        const projects = await this.store.listProjects();
        if (!projects.length) {
          await this.reply(chatId, 'هنوز پروژه‌ای ثبت نشده. یک پروژه اضافه کن:\n<code>/project owner/repo</code>');
          return;
        }
        const activeId = await this.store.getActiveProjectId();
        const lines = projects.map((project) => {
          const mark = project.id === activeId ? '✅' : '•';
          return `${mark} <b>${escHtml(project.name)}</b> — <code>${escHtml(project.repo_owner)}/${escHtml(project.repo_name)}</code>@${escHtml(project.default_branch)}`;
        });
        await this.reply(chatId, `📁 <b>پروژه‌ها</b>\n\n${lines.join('\n')}\n\nبرای انتخاب: <code>/project owner/repo</code>`);
        return;
      }
      case 'project': {
        const target = args.trim();
        if (!target.includes('/')) {
          await this.reply(chatId, 'قالب درست: <code>/project owner/repo</code>');
          return;
        }
        const [owner, repo] = target.split('/').map((part) => part.trim());
        if (!owner || !repo) {
          await this.reply(chatId, 'قالب درست: <code>/project owner/repo</code>');
          return;
        }
        await this.reply(chatId, `🔍 در حال بررسی <code>${escHtml(owner)}/${escHtml(repo)}</code> …`);
        const client = await this.github();
        const meta = await client.getRepo(owner, repo);
        const project = await this.store.createProject({ name: repo, owner, repo, branch: meta.default_branch });
        await this.store.updateProjectMeta(project.id, { language: meta.language, description: meta.description, default_branch: meta.default_branch });
        await this.store.setSetting('active_project_id', project.id);
        await this.store.addRepo({ owner, name: repo, branch: meta.default_branch, private: meta.private });
        await this.reply(
          chatId,
          `✅ پروژه فعال شد:\n<b>${escHtml(repo)}</b> (<code>${escHtml(owner)}/${escHtml(repo)}</code>)\nشاخه اصلی: <code>${escHtml(meta.default_branch)}</code>\nزبان: ${escHtml(meta.language ?? 'نامشخص')}`,
        );
        return;
      }
      case 'new': {
        const text = args.trim();
        if (!text) {
          await this.setConversation(identity.telegramUserId, { state: 'awaiting_request' });
          await this.reply(chatId, 'چه تغییری می‌خواهی؟ به فارسی ساده بنویس.');
          return;
        }
        await this.startRequest(text, chatId, identity, context);
        return;
      }
      case 'resume': {
        const project = await this.activeProject();
        if (!project) {
          await this.reply(chatId, 'اول یک پروژه انتخاب کن: <code>/project owner/repo</code>');
          return;
        }
        const request = await this.store.latestRequestForProject(project.id);
        if (!request) {
          await this.reply(chatId, 'درخواست قبلی برای این پروژه نداریم. با /new شروع کن.');
          return;
        }
        await this.reply(chatId, `آخرین درخواست (${escHtml(request.status)}):\n${escHtml(truncate(request.raw_text, 500))}`);
        if (request.status === 'awaiting_approval') await this.sendPlanMessage(request, chatId);
        return;
      }
      case 'status': {
        const project = await this.activeProject();
        const provider = await this.providers.activeProvider();
        const usedToday = await this.store.totalUsageToday();
        const minutes = await this.store.actionsMinutesThisMonth();
        const jobs = await this.store.listJobs(undefined, 5);
        const rows = [
          `پروژه فعال: ${project ? `${project.repo_owner}/${project.repo_name}@${project.default_branch}` : 'انتخاب نشده'}`,
          `ارائه‌دهنده فعال: ${provider ? `${provider.display_name} / ${provider.model}` : 'هیچ‌کدام'}`,
          `مصرف امروز: ${usedToday.toLocaleString('en-US')} توکن`,
          `دقیقه Actions این ماه: ${minutes.toLocaleString('en-US')}`,
          `آخرین وظایف: ${jobs.map((job) => `${job.kind}:${job.status}`).join(', ') || 'ندارد'}`,
        ];
        await this.reply(chatId, `📊 <b>وضعیت</b>\n\n${rows.map((row) => `• ${escHtml(row)}`).join('\n')}`);
        return;
      }
      case 'tasks': {
        const jobs = await this.store.listJobs(undefined, 10);
        if (!jobs.length) {
          await this.reply(chatId, 'هیچ وظیفه‌ای در صف نیست.');
          return;
        }
        const lines = jobs.map((job) => `• <code>${escHtml(job.id)}</code> ${escHtml(job.kind)} — <b>${escHtml(job.status)}</b> (تلاش ${toPersianDigits(job.attempts)})`);
        await this.reply(chatId, `🧾 <b>وظایف</b>\n\n${lines.join('\n')}`);
        return;
      }
      case 'models':
      case 'provider': {
        if (command === 'provider' && args.trim()) {
          await this.providers.setActive(args.trim().toLowerCase());
          const provider = await this.providers.activeProvider();
          await this.reply(chatId, `✅ ارائه‌دهنده فعال: <b>${escHtml(provider?.display_name ?? '')}</b> (${escHtml(provider?.model ?? '')})`);
          return;
        }
        const providers = await this.providers.list();
        const lines = providers.map((provider) => {
          const configured = this.hasKey(provider.name);
          const flags = [
            configured ? '🔑' : '🚫',
            provider.active ? '✅ فعال' : 'غیرفعال',
            provider.free_tier ? 'رایگان' : 'پولی',
          ];
          return `${flags.join(' ')} <b>${escHtml(provider.name)}</b> — ${escHtml(provider.model)} (${escHtml(provider.last_check_status ?? 'تست‌نشده')})`;
        });
        await this.reply(
          chatId,
          `🤖 <b>ارائه‌دهنده‌ها</b>\n\n${lines.join('\n')}\n\nانتخاب: <code>/provider gemini</code>\nتغییر مدل: <code>/model gemini-1.5-flash</code>\nتست اتصال: /test_api`,
        );
        return;
      }
      case 'model': {
        const model = args.trim();
        if (!model) {
          await this.reply(chatId, 'قالب: <code>/model model-name</code>');
          return;
        }
        const provider = await this.providers.activeProvider();
        if (!provider) {
          await this.reply(chatId, 'هیچ ارائه‌دهنده فعالی نیست.');
          return;
        }
        await this.providers.setActive(provider.name, model);
        await this.reply(chatId, `✅ مدل <code>${escHtml(model)}</code> برای <b>${escHtml(provider.name)}</b> تنظیم شد.`);
        return;
      }
      case 'test_api': {
        await this.reply(chatId, '🔌 در حال تست کلیدها …');
        const results = await this.providers.test();
        const lines = results.map(({ provider, health }) => {
          const icon = health.ok ? '✅' : health.status === 'no_key' ? '🚫' : '❌';
          return `${icon} <b>${escHtml(provider)}</b> — ${escHtml(health.status)} (${toPersianDigits(health.latencyMs)} ms)`;
        });
        await this.reply(chatId, `🔌 <b>نتیجه تست</b>\n\n${lines.join('\n')}`);
        return;
      }
      case 'github': {
        try {
          const { source } = await resolveGithubToken(this.env, this.fetchImpl);
          const client = await this.github();
          const repos = await this.store.listRepos();
          let detail = `نوع اتصال: <b>${source === 'app' ? 'GitHub App' : 'Personal Access Token'}</b>`;
          if (!repos.length) {
            await this.reply(chatId, `${detail}\nهنوز مخزنی ثبت نشده. با <code>/project owner/repo</code> اضافه کن.`);
            return;
          }
          const lines: string[] = [];
          for (const repo of repos.slice(0, 5)) {
            const branches = await client.listBranches(repo.owner, repo.name).catch(() => [] as string[]);
            const commits = await client.listCommits(repo.owner, repo.name, repo.default_branch, 3).catch(() => []);
            lines.push(
              `• <code>${escHtml(repo.full_name)}</code> (شاخه‌ها: ${toPersianDigits(branches.length)})\n  آخرین کامیت‌ها: ${commits
                .map((commit) => escHtml(`${commit.sha.slice(0, 7)} ${commit.message.split('\n')[0] ?? ''}`))
                .join(' | ') || '—'}`,
            );
          }
          await this.reply(chatId, `🔗 <b>اتصال گیت‌هاب</b>\n${detail}\n\n${lines.join('\n')}`);
        } catch (error) {
          await this.reply(chatId, `❌ اتصال گیت‌هاب برقرار نیست: ${escHtml(truncate((error as Error).message, 300))}`);
        }
        return;
      }
      case 'usage': {
        const providers = await this.providers.list();
        const lines: string[] = [];
        for (const provider of providers) {
          const day = await this.store.usageForDay(provider.name);
          const month = await this.store.usageForMonth(provider.name);
          if (day === 0 && month === 0) continue;
          lines.push(
            `• <b>${escHtml(provider.name)}</b>: امروز ${toPersianDigits(day.toLocaleString('en-US'))} / ${toPersianDigits(
              provider.daily_limit.toLocaleString('en-US'),
            )} توکن · این ماه ${toPersianDigits(month.toLocaleString('en-US'))}`,
          );
        }
        const minutes = await this.store.actionsMinutesThisMonth();
        const limit = num(this.env, 'ACTIONS_MONTHLY_MINUTE_LIMIT', 2000);
        lines.push(`• دقیقه Actions این ماه: ${toPersianDigits(minutes.toLocaleString('en-US'))} / ${toPersianDigits(limit.toLocaleString('en-US'))}`);
        await this.reply(chatId, `📈 <b>مصرف</b>\n\n${lines.join('\n') || 'هنوز مصرفی ثبت نشده.'}`);
        return;
      }
      case 'tests': {
        const jobs = await this.store.listJobs('succeeded', 3);
        const failed = await this.store.listJobs('failed', 3);
        const format = (job: JobRow) => {
          const result = job.result_json ? (JSON.parse(job.result_json) as Record<string, unknown>) : null;
          return `• <code>${escHtml(job.id)}</code> ${escHtml(job.kind)} — ${escHtml(String(result?.conclusion ?? job.status))}`;
        };
        const lines = [...jobs.map(format), ...failed.map(format)];
        await this.reply(chatId, `🧪 <b>گزارش تست‌ها</b>\n\n${lines.join('\n') || 'هنوز تستی اجرا نشده است.'}`);
        return;
      }
      case 'history': {
        const project = await this.activeProject();
        if (!project) {
          await this.reply(chatId, 'اول پروژه را انتخاب کن.');
          return;
        }
        const audit = await this.store.recentAudit(10);
        const lines = audit.map((entry) => `• ${escHtml(entry.created_at.slice(0, 16))} — ${escHtml(entry.action)} ${entry.target ? escHtml(entry.target) : ''}`);
        await this.reply(chatId, `🕘 <b>تاریخچه</b>\n\n${lines.join('\n') || 'موردی ثبت نشده.'}`);
        return;
      }
      case 'security': {
        const audit = await this.store.recentAudit(5);
        const lines = [
          `فقط مالک پاسخ می‌گیرد: شناسه(های) مجاز ${[...ownerIds(this.env)].length} عدد`,
          'بررسی مالک سمت سرور انجام می‌شود (نه در رابط کاربر)',
          'کلیدها فقط در Secrets پلتفرم هستند و در لاگ/چت/کد نمی‌آیند',
          'تأییدها امضاشده و دارای انقضا هستند؛ متن آزاد تأیید محسوب نمی‌شود',
          'دستورهای اجرایی فقط از لیست مجاز عبور می‌کنند',
          'ادغام/حذف/انتشار نیازمند تأیید جداگانه است',
        ];
        const auditLines = audit.map((entry) => `• ${escHtml(entry.action)} — ${escHtml(entry.actor)}`);
        await this.reply(chatId, `🔐 <b>وضعیت امنیتی</b>\n\n${lines.map((line) => `• ${escHtml(line)}`).join('\n')}\n\nآخرین رویدادها:\n${auditLines.join('\n')}`);
        return;
      }
      case 'cancel': {
        const conversation = await this.getConversation(identity.telegramUserId);
        await this.setConversation(identity.telegramUserId, { state: 'idle' });
        const project = await this.activeProject();
        if (project) {
          const request = await this.store.latestRequestForProject(project.id);
          if (request && ['draft', 'analyzing', 'awaiting_approval'].includes(request.status)) {
            await this.store.setRequestStatus(request.id, 'cancelled');
            await this.reply(chatId, `🚫 درخواست <code>${escHtml(request.id)}</code> لغو شد.`);
            return;
          }
        }
        await this.reply(chatId, conversation?.state === 'idle' ? 'چیزی برای لغو نیست.' : '🚫 عملیات جاری لغو شد.');
        return;
      }
      case 'settings': {
        const rows = [
          `شاخه پیش‌فرض: ${this.env.DEFAULT_BRANCH ?? 'main'}`,
          `سقف روزانه توکن (پیش‌فرض): ${num(this.env, 'AI_DAILY_TOKEN_LIMIT', 500000).toLocaleString('en-US')}`,
          `سقف دقیقه Actions: ${num(this.env, 'ACTIONS_MONTHLY_MINUTE_LIMIT', 2000).toLocaleString('en-US')}`,
          `حجم مجاز فایل ارسالی: ${num(this.env, 'MAX_UPLOAD_BYTES', 200000).toLocaleString('en-US')} بایت`,
          `دستورهای مجاز: ${parseAllowlist(this.env.COMMAND_ALLOWLIST).join(' | ')}`,
        ];
        await this.reply(chatId, `⚙️ <b>تنظیمات</b>\n\n${rows.map((row) => `• ${escHtml(row)}`).join('\n')}\n\n(کلیدها نمایش داده نمی‌شوند)`);
        return;
      }
      default:
        await this.reply(chatId, `فرمان ناشناس: /${escHtml(command)}\nبرای دیدن فرمان‌ها /help را بزن.`);
    }
  }

  private hasKey(name: string): boolean {
    const map: Record<string, string | undefined> = {
      gemini: this.env.GEMINI_API_KEY,
      groq: this.env.GROQ_API_KEY,
      openrouter: this.env.OPENROUTER_API_KEY,
      deepseek: this.env.DEEPSEEK_API_KEY,
      openai: this.env.OPENAI_API_KEY,
      anthropic: this.env.ANTHROPIC_API_KEY,
    };
    return Boolean(map[name]);
  }

  // -------------------------------------------------------------- free text
  private async handleFreeText(text: string, chatId: number, identity: Identity, context: BotContext): Promise<void> {
    const conversation = await this.getConversation(identity.telegramUserId);

    if (conversation?.state === 'awaiting_request') {
      await this.setConversation(identity.telegramUserId, { state: 'idle' });
      await this.startRequest(text, chatId, identity, context);
      return;
    }

    if (conversation?.state === 'awaiting_revision' && conversation.requestId) {
      await this.setConversation(identity.telegramUserId, { state: 'idle' });
      await this.revisePlan(conversation.requestId, text, chatId, identity, context);
      return;
    }

    if (isExplicitApproval(text)) {
      const project = await this.activeProject();
      const request = project ? await this.store.latestRequestForProject(project.id) : null;
      if (request && request.status === 'awaiting_approval') {
        await this.reply(chatId, 'برای اطمینان، دکمه «تأیید و شروع» زیر همان طرح را بزن (تأیید شفاهی کافی نیست).');
        await this.sendPlanMessage(request, chatId);
        return;
      }
    }

    if (isRejection(text)) {
      await this.runCommand('/cancel', '', chatId, identity, context);
      return;
    }

    const token = await this.signAction('newreq', text.slice(0, 64));
    await this.reply(
      chatId,
      `می‌خواهی این را به‌عنوان درخواست جدید ثبت کنم؟\n\n«${escHtml(truncate(text, 300))}»`,
      confirmKeyboard('newreq', text.slice(0, 64).replace(/\|/g, ' '), token),
    );
  }

  private async handleDocument(fileName: string, fileSize: number, chatId: number, identity: Identity): Promise<void> {
    const maxBytes = num(this.env, 'MAX_UPLOAD_BYTES', 200_000);
    const allowed = /\.(md|txt|json|jsonl|patch|diff|log|ya?ml|py|ts|js|tsx|jsx|toml)$/i.test(fileName);
    if (!allowed) {
      await this.reply(chatId, `نوع فایل مجاز نیست. فقط فایل‌های متنی/کد تا ${toPersianDigits(maxBytes)} بایت پذیرفته می‌شود.`);
      return;
    }
    if (fileSize > maxBytes) {
      await this.reply(chatId, `حجم فایل بیش از حد مجاز (${toPersianDigits(maxBytes)} بایت) است.`);
      return;
    }
    await this.store.setSetting(`upload:${identity.telegramUserId}`, JSON.stringify({ fileName, fileSize, at: new Date().toISOString() }));
    await this.store.audit(String(identity.telegramUserId), 'document.accepted', fileName);
    await this.reply(chatId, `📄 فایل <code>${escHtml(fileName)}</code> پذیرفته شد و در درخواست بعدی به‌عنوان زمینه استفاده می‌شود.`);
  }

  // ------------------------------------------------------------- callbacks
  private async handleCallback(data: string, update: TelegramUpdate, chatId: number, identity: Identity, context: BotContext): Promise<void> {
    const parsed = parseCallbackData(data);
    const queryId = update.callback_query?.id;
    if (!parsed) {
      if (queryId) await this.telegram.answerCallbackQuery(queryId, 'دکمه نامعتبر است');
      return;
    }

    if (parsed.scope === 'plan') {
      const planVersion = parsed.planVersion ?? 0;
      if (parsed.action === 'approve') {
        const verification = await this.approvals.approve(parsed.requestId, planVersion, parsed.token, String(identity.telegramUserId));
        if (!verification.ok) {
          if (queryId) await this.telegram.answerCallbackQuery(queryId, verification.reason ?? 'تأیید نامعتبر', true);
          await this.reply(chatId, `🚫 ${escHtml(verification.reason ?? 'تأیید نامعتبر است')}`);
          await this.store.audit(String(identity.telegramUserId), 'approval.rejected_invalid', parsed.requestId);
          return;
        }
        if (queryId) await this.telegram.answerCallbackQuery(queryId, 'تأیید شد؛ شروع به کار');
        await this.store.setRequestStatus(parsed.requestId, 'approved');
        await this.reply(chatId, '✅ تأیید ثبت شد. ساخت شاخه، نوشتن کد و اجرای تست شروع می‌شود…');
        await this.enqueueExecution(parsed.requestId, planVersion, chatId, context);
        return;
      }

      // revise / explain / cancel only need a *valid, pending* approval token,
      // never an approval decision.
      const verification = await this.approvals.verify(parsed.requestId, planVersion, parsed.token);
      if (!verification.ok) {
        if (queryId) await this.telegram.answerCallbackQuery(queryId, verification.reason ?? 'درخواست منقضی شده', true);
        return;
      }

      if (parsed.action === 'revise') {
        await this.setConversation(identity.telegramUserId, { state: 'awaiting_revision', requestId: parsed.requestId });
        await this.reply(chatId, 'چه تغییری در طرح می‌خواهی؟ بنویس تا نسخه جدیدی از طرح بسازم.');
      } else if (parsed.action === 'explain') {
        await this.explainPlan(parsed.requestId, planVersion, chatId);
      } else if (parsed.action === 'cancel') {
        await this.approvals.reject(parsed.requestId, planVersion, parsed.token, String(identity.telegramUserId));
        await this.store.setRequestStatus(parsed.requestId, 'cancelled');
        await this.reply(chatId, '🚫 درخواست لغو شد. هیچ تغییری در مخزن ایجاد نشد.');
        await this.store.audit(String(identity.telegramUserId), 'request.cancelled', parsed.requestId);
      }
      if (queryId) await this.telegram.answerCallbackQuery(queryId);
      return;
    }

    if (parsed.action === 'confirm' && parsed.scope === 'newreq') {
      const expected = await this.signAction('newreq', parsed.requestId);
      if (expected.split('.')[1] !== parsed.token.split('.')[1]) {
        if (queryId) await this.telegram.answerCallbackQuery(queryId, 'درخواست منقضی شده', true);
        return;
      }
      await this.startRequest(parsed.requestId, chatId, identity, context);
      if (queryId) await this.telegram.answerCallbackQuery(queryId);
      return;
    }

    if (queryId) await this.telegram.answerCallbackQuery(queryId, 'انجام شد');
  }

  // -------------------------------------------------------- request pipeline
  private async activeProject(): Promise<Project | null> {
    const id = await this.store.getActiveProjectId();
    if (id) {
      const project = await this.store.getProject(id);
      if (project) return project;
    }
    const [first] = await this.store.listProjects();
    return first ?? null;
  }

  private async startRequest(text: string, chatId: number, identity: Identity, context: BotContext): Promise<void> {
    const project = await this.activeProject();
    if (!project) {
      await this.reply(chatId, 'اول یک پروژه انتخاب کن: <code>/project owner/repo</code>');
      return;
    }
    const request = await this.store.createRequest(project.id, chatId, text);
    await this.store.setRequestStatus(request.id, 'analyzing');
    await this.reply(chatId, `🧠 درخواست ثبت شد (<code>${escHtml(request.id)}</code>). در حال تحلیل مخزن …`);

    const job = await this.store.enqueue({ requestId: request.id, kind: 'analyze', payload: { requestId: request.id, chatId } });
    const work = this.runJob(job.id, 'analyze').catch((error) => {
      logger.error('analyze.failed', { requestId: request.id, error: (error as Error).message });
      return this.reply(chatId, `❌ تحلیل انجام نشد: ${escHtml(truncate((error as Error).message, 400))}`);
    });
    // Run inline when the invocation has budget left; the cron tick is the
    // safety net when it does not.
    if (context.waitUntil) context.waitUntil(work);
    else await work;
  }

  private async enqueueExecution(requestId: string, planVersion: number, chatId: number, context: BotContext): Promise<void> {
    const job = await this.store.enqueue({ requestId, kind: 'execute', payload: { requestId, planVersion, chatId } });
    const work = this.runJob(job.id, 'execute').catch((error) => {
      logger.error('execute.failed', { requestId, error: (error as Error).message });
      return this.reply(chatId, `❌ اجرا انجام نشد: ${escHtml(truncate((error as Error).message, 400))}`);
    });
    if (context.waitUntil) context.waitUntil(work);
    else await work;
  }

  private async revisePlan(requestId: string, note: string, chatId: number, identity: Identity, context: BotContext): Promise<void> {
    const request = await this.store.getRequest(requestId);
    if (!request) {
      await this.reply(chatId, 'درخواست پیدا نشد.');
      return;
    }
    await this.store.sql.run('UPDATE requests SET raw_text = ?, updated_at = ? WHERE id = ?', [
      `${request.raw_text}\n\nاصلاحیه مالک: ${note}`,
      new Date().toISOString(),
      requestId,
    ]);
    await this.store.setRequestStatus(requestId, 'analyzing');
    await this.reply(chatId, '✏️ در حال ساخت نسخه جدید طرح …');
    const job = await this.store.enqueue({ requestId, kind: 'analyze', payload: { requestId, chatId } });
    const work = this.runJob(job.id, 'analyze');
    if (context.waitUntil) context.waitUntil(work);
    else await work;
    await this.store.audit(String(identity.telegramUserId), 'plan.revise', requestId);
  }

  private async explainPlan(requestId: string, planVersion: number, chatId: number): Promise<void> {
    const planRow = await this.store.getPlan(requestId, planVersion);
    if (!planRow) {
      await this.reply(chatId, 'طرح پیدا نشد.');
      return;
    }
    const plan = StoreType.parsePlan(planRow);
    try {
      const completion = await this.providers.complete({
        messages: [
          {
            role: 'system',
            content: 'تو معلم صبوری هستی که برای یک کاربر غیرفنی توضیح می‌دهی. فقط فارسی ساده، بدون اصطلاح پیچیده، حداکثر ۱۵۰ کلمه.',
          },
          {
            role: 'user',
            content: `این طرح را ساده توضیح بده:\n${JSON.stringify(plan).slice(0, 4000)}`,
          },
        ],
        temperature: 0.3,
        maxOutputTokens: 800,
      });
      await this.reply(chatId, `🗣 <b>توضیح ساده</b>\n\n${escHtml(completion.text)}`);
    } catch (error) {
      await this.reply(chatId, `توضیح بیشتر ممکن نشد: ${escHtml(truncate((error as Error).message, 200))}`);
    }
  }

  private async sendPlanMessage(request: RequestRow, chatId: number): Promise<void> {
    const planRow = await this.store.latestPlan(request.id);
    const project = await this.store.getProject(request.project_id);
    if (!planRow || !project) {
      await this.reply(chatId, 'طرحی برای این درخواست وجود ندارد.');
      return;
    }
    const plan = StoreType.parsePlan(planRow);
    const report = renderPlanReport(plan, {
      projectName: project.name,
      repo: `${project.repo_owner}/${project.repo_name}`,
      branch: project.default_branch,
      provider: planRow.provider,
      model: planRow.model,
      requestId: request.id,
      planVersion: planRow.version,
    });
    const token = await this.approvals.issue(request.id, planRow.version);
    await this.reply(chatId, report, planApprovalKeyboard({ requestId: request.id, planVersion: planRow.version, token }));
  }

  // --------------------------------------------------------------- job kinds
  async runJob(jobId: string, kind: JobKind): Promise<void> {
    const job = await this.store.getJob(jobId);
    if (!job) throw new Error('job not found');
    const payload = JSON.parse(job.payload_json) as { requestId?: string; chatId?: number; planVersion?: number; commands?: string[] };
    const chatId = payload.chatId ?? this.ownerChatId();

    if (kind === 'analyze') {
      if (!payload.requestId) throw new Error('analyze job without requestId');
      await this.runAnalyze(payload.requestId, chatId);
      await this.store.completeJob(jobId, { requestId: payload.requestId });
      return;
    }

    if (kind === 'execute') {
      if (!payload.requestId) throw new Error('execute job without requestId');
      await this.store.setRequestStatus(payload.requestId, 'executing');
      const planRow = await this.store.latestPlan(payload.requestId);
      const request = await this.store.getRequest(payload.requestId);
      const project = request ? await this.store.getProject(request.project_id) : null;
      if (!request || !project || !planRow) throw new Error('داده‌های درخواست ناقص است');

      const executor = await this.executor();
      const result = await executor.execute(
        { request, project, plan: StoreType.parsePlan(planRow), planVersion: planRow.version },
        'owner',
      );
      await this.store.setRequestStatus(payload.requestId, 'done');
      if (chatId) await this.reportExecution(result, request, chatId);
      await this.store.completeJob(jobId, { branch: result.branch, pr: result.pullRequest?.number ?? null });
      return;
    }

    if (kind === 'tests') {
      const project = await this.activeProject();
      if (!project) throw new Error('پروژه فعالی برای اجرای تست نیست');
      const dispatcher = await this.dispatcher();
      const branch = String((job.payload_json && JSON.parse(job.payload_json).branch) || project.default_branch);
      const commands = (payload.commands ?? []).map((command) => isCommandAllowed(command, parseAllowlist(this.env.COMMAND_ALLOWLIST))).filter((c) => c.allowed).map((c) => c.command);
      if (!commands.length) throw new Error('هیچ دستور مجازی برای اجرا وجود ندارد');
      const dispatch = await dispatcher.dispatch({ owner: project.repo_owner, repo: project.repo_name, branch, jobId, requestId: payload.requestId ?? '', commands });
      if (!dispatch.runId) throw new Error(dispatch.note ?? 'اجرای تست در Actions ممکن نشد');
      const outcome = await dispatcher.outcome(project.repo_owner, project.repo_name, dispatch.runId);
      if (chatId) {
        await this.reply(
          chatId,
          outcome.conclusion === 'success'
            ? `✅ تست‌ها موفق بودند (${toPersianDigits(outcome.minutes)} دقیقه).\n${escHtml(outcome.url)}`
            : `❌ تست‌ها ناموفق بودند (${escHtml(String(outcome.conclusion))}).\n${escHtml(outcome.url)}`,
        );
      }
      await this.store.completeJob(jobId, { runId: dispatch.runId, conclusion: outcome.conclusion, minutes: outcome.minutes });
      return;
    }

    if (kind === 'provider_test') {
      const results = await this.providers.test();
      await this.store.completeJob(jobId, results);
      return;
    }

    throw new Error(`job kind ${kind} پشتیبانی نمی‌شود`);
  }

  private async runAnalyze(requestId: string, chatId: number | null): Promise<void> {
    const request = await this.store.getRequest(requestId);
    if (!request) throw new Error('درخواست پیدا نشد');
    const project = await this.store.getProject(request.project_id);
    if (!project) throw new Error('پروژه پیدا نشد');

    try {
      const client = await this.github();
      const snapshot = await takeSnapshot(client, project.repo_owner, project.repo_name, project.default_branch, {
        keywords: request.raw_text.split(/\s+/).slice(0, 8),
      });
      const memory = (await this.store.listMemory(project.id)).map((entry) => `${entry.kind}: ${entry.content}`);

      let result;
      try {
        result = await this.analysis.analyze(request, snapshot, memory);
      } catch (error) {
        if (error instanceof NoProviderAvailableError) {
          await this.store.setRequestStatus(requestId, 'failed');
          if (chatId) {
            await this.reply(
              chatId,
              `⏸ هیچ ارائه‌دهنده رایگانی در دسترس نیست (${escHtml(
                error.reasons.map((reason) => `${reason.provider}: ${reason.reason}`).join(' | '),
              )}). درخواست در صف ماند و بعداً ادامه می‌دهیم.`,
            );
          }
          return;
        }
        throw error;
      }

      const version = ((await this.store.latestPlan(requestId))?.version ?? 0) + 1;
      await this.store.savePlan({
        requestId,
        version,
        plan: result.plan,
        reportFa: renderPlanReport(result.plan, {
          projectName: project.name,
          repo: `${project.repo_owner}/${project.repo_name}`,
          branch: project.default_branch,
          provider: result.provider,
          model: result.model,
          requestId,
          planVersion: version,
        }),
        provider: result.provider,
        model: result.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      });
      await this.store.setRequestStatus(requestId, 'awaiting_approval');
      await this.store.audit('owner', 'plan.created', requestId, { provider: result.provider, model: result.model, version });

      if (chatId) await this.sendPlanMessage(request, chatId);
    } catch (error) {
      await this.store.setRequestStatus(requestId, 'failed');
      if (chatId) await this.reply(chatId, `❌ تحلیل مخزن انجام نشد: ${escHtml(truncate((error as Error).message, 400))}`);
      throw error;
    }
  }

  private async reportExecution(result: Awaited<ReturnType<ExecutionEngine['execute']>>, request: RequestRow, chatId: number): Promise<void> {
    const testLine = result.tests.outcome
      ? result.tests.outcome.conclusion === 'success'
        ? `✅ تست‌ها موفق بودند (${toPersianDigits(result.tests.outcome.minutes)} دقیقه Actions)`
        : `❌ نتیجه تست‌ها: ${escHtml(String(result.tests.outcome.conclusion))}`
      : `⚠️ ${escHtml(result.tests.note ?? 'تستی اجرا نشد')}`;

    const lines = [
      '🎉 <b>اجرا تمام شد</b>',
      '',
      `شاخه کاری: <code>${escHtml(result.branch)}</code>`,
      `فایل‌های تغییر‌یافته: ${escHtml(result.changedFiles.join(', ') || 'بدون تغییر')}`,
      `تعداد کامیت‌ها: ${toPersianDigits(result.commits.length)}`,
      result.pullRequest ? `Pull Request: <a href="${escHtml(result.pullRequest.url)}">#${toPersianDigits(result.pullRequest.number)}</a>` : 'PR ساخته نشد',
      testLine,
    ];
    if (result.tests.rejectedCommands.length) {
      lines.push('', `دستورهای ردشده (خارج از لیست مجاز): ${escHtml(result.tests.rejectedCommands.join(' | '))}`);
    }
    lines.push('', 'ادغام یا انتشار نیازمند تأیید جداگانه شماست.');
    await this.reply(chatId, lines.join('\n'));
  }

  // ----------------------------------------------------------- conversation
  private async getConversation(userId: number): Promise<ConversationState | null> {
    const raw = await this.store.getSetting(`convo:${userId}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ConversationState;
    } catch {
      return null;
    }
  }

  private async setConversation(userId: number, state: ConversationState): Promise<void> {
    await this.store.setSetting(`convo:${userId}`, JSON.stringify(state));
  }

  private async signAction(scope: string, subject: string): Promise<string> {
    const nonce = randomToken(12);
    return `${nonce}.${await hmacSign(this.env.APPROVAL_SECRET, `${scope}.${subject}.${nonce}`)}`;
  }

  async tick(): Promise<{ processed: number; failed: number }> {
    return this.runner.tick();
  }

  /** Used by the GitHub Actions callback endpoint (HMAC verified). */
  async handleActionCallback(body: { jobId: string; requestId?: string; status?: string; conclusion?: string; log?: string }): Promise<void> {
    const job = await this.store.getJob(body.jobId);
    if (!job) throw new Error('job not found');
    await this.store.addJobLog(body.jobId, body.conclusion === 'success' ? 'info' : 'warn', body.status ?? 'callback', body);
    if (body.conclusion === 'success') await this.store.completeJob(body.jobId, body);
    else if (body.conclusion) await this.store.failJob(body.jobId, `actions: ${body.conclusion}`, 0);
    const chatId = this.ownerChatId();
    if (chatId && body.conclusion) {
      await this.reply(chatId, body.conclusion === 'success' ? `✅ اجرای Actions برای وظیفه <code>${escHtml(body.jobId)}</code> موفق بود.` : `❌ اجرای Actions برای وظیفه <code>${escHtml(body.jobId)}</code> با وضعیت ${escHtml(body.conclusion)} تمام شد.`);
    }
  }
}

export { TelegramError, GithubError, checkActionsQuota, Store };
