import { GithubClient, GithubError } from '../github/client.js';
import { parseAllowlist } from '../github/commands.js';
import { randomId } from '../util/crypto.js';
import { truncate } from '../util/text.js';
import { logger } from '../util/log.js';
import {
  optionalBoolean,
  optionalString,
  parseRepo,
  requireString,
  safePath,
  ToolInputError,
  type AgentContext,
  type AgentTool,
  type ToolAvailability,
  type ToolOutcome,
} from './types.js';

const MAX_FILE_BYTES = 200_000;
const MAX_FILE_CHARS = 40_000;

function githubConfigured(ctx: AgentContext): boolean {
  const hasPat = Boolean(ctx.env.GITHUB_TOKEN);
  const hasApp = Boolean(ctx.env.GITHUB_APP_ID && ctx.env.GITHUB_APP_PRIVATE_KEY && ctx.env.GITHUB_INSTALLATION_ID);
  return hasPat || hasApp;
}

function githubAvailability(ctx: AgentContext): ToolAvailability {
  if (githubConfigured(ctx)) return { available: true };
  return {
    available: false,
    reason: 'هیچ اعتبارنامه‌ای برای گیت‌هاب تنظیم نشده است (GitHub App یا Personal Access Token).',
  };
}

/** Resolve `owner/repo`, `repo`, or a URL into a concrete owner + repo pair. */
async function resolveRepo(ctx: AgentContext, raw: string): Promise<{ owner: string; repo: string; fullName: string }> {
  const parsed = parseRepo(raw);
  if (parsed.owner) return { owner: parsed.owner, repo: parsed.repo, fullName: `${parsed.owner}/${parsed.repo}` };

  // A bare repo name is resolved against what the bot already knows, so the
  // owner never has to repeat "owner/" for their own repositories.
  const projects = await ctx.store.listProjects();
  const known = projects.find((project) => project.repo_name.toLowerCase() === parsed.repo.toLowerCase());
  if (known) return { owner: known.repo_owner, repo: known.repo_name, fullName: `${known.repo_owner}/${known.repo_name}` };

  const client = await ctx.github();
  const user = await client.getAuthenticatedUser();
  return { owner: user.login, repo: parsed.repo, fullName: `${user.login}/${parsed.repo}` };
}

async function findProject(ctx: AgentContext, repo: string, owner?: string) {
  if (owner) {
    const exact = await ctx.store.getProjectByRepo(owner, repo);
    if (exact) return exact;
  }
  const all = await ctx.store.listProjects();
  return all.find((project) => project.repo_name.toLowerCase() === repo.toLowerCase()) ?? null;
}

function ok(content: string, data?: unknown): ToolOutcome {
  return { ok: true, content, ...(data === undefined ? {} : { data }) };
}

function fail(content: string): ToolOutcome {
  return { ok: false, content };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const getCapabilities: AgentTool = {
  name: 'get_bot_capabilities',
  description:
    'فهرست توانایی‌های واقعی ربات را برمی‌گرداند: چه ابزارهایی در دسترس است، کدام‌یک به دلیل نداشتن کلید/دسترسی در دسترس نیست، چه مخزن‌هایی ثبت شده و چه محدودیت‌هایی وجود دارد. قبل از پاسخ به سؤال‌هایی مثل «چه کارهایی می‌توانی بکنی؟» یا «به دیتابیس X دسترسی داری؟» این را صدا بزن.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  sensitive: false,
  summarize: () => 'بررسی توانایی‌ها و دسترسی‌های ربات',
  availability: async () => ({ available: true }),
  run: async (_args, ctx) => {
    const tools = ctx.tools ?? [];
    const lines: string[] = ['ابزارهای موجود:'];
    for (const tool of tools) {
      const availability = await tool.availability(ctx);
      lines.push(
        availability.available
          ? `- ${tool.name}: در دسترس${tool.sensitive ? ' (عملیات حساس، نیازمند تأیید مالک)' : ''}`
          : `- ${tool.name}: در دسترس نیست — ${availability.reason}`,
      );
    }

    const repos = await ctx.store.listRepos();
    lines.push('', repos.length ? `مخزن‌های ثبت‌شده: ${repos.map((repo) => repo.full_name).join(', ')}` : 'مخزن ثبت‌شده‌ای وجود ندارد.');

    const projects = await ctx.store.listProjects();
    lines.push(projects.length ? `پروژه‌های فعال: ${projects.map((p) => `${p.repo_owner}/${p.repo_name}`).join(', ')}` : 'پروژه‌ای ثبت نشده است.');

    lines.push('', `دستورهای تست مجاز: ${parseAllowlist(ctx.env.COMMAND_ALLOWLIST).join(' | ')}`);
    lines.push('دیتابیس: فقط D1 خودِ همین ربات (چیز دیگری در دسترس نیست).');
    lines.push('اجرای کد دلخواه روی سرور: در دسترس نیست (تست‌ها فقط از طریق GitHub Actions اجرا می‌شوند).');
    return ok(lines.join('\n'));
  },
};

const listGithubRepos: AgentTool = {
  name: 'list_github_repos',
  description: 'مخزن‌هایی که این توکن به آن‌ها دسترسی دارد را از گیت‌هاب می‌خواند. برای پیدا کردن نام درست مخزن قبل از خواندن یا نوشتن فایل استفاده کن.',
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'integer', description: 'حداکثر تعداد مخزن (پیش‌فرض ۲۰)', minimum: 1, maximum: 50 },
    },
    additionalProperties: false,
  },
  sensitive: false,
  summarize: () => 'خواندن فهرست مخزن‌های گیت‌هاب',
  availability: async (ctx) => githubAvailability(ctx),
  run: async (args, ctx) => {
    const limit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.min(50, Math.max(1, Math.floor(args.limit))) : 20;
    try {
      const client = await ctx.github();
      const repos = await client.listAccessibleRepos(limit);
      if (!repos.length) return ok('هیچ مخزنی در دسترس این توکن نیست.');
      return ok(
        repos
          .slice(0, limit)
          .map((repo) => `- ${repo.full_name} (${repo.private ? 'خصوصی' : 'عمومی'}, شاخه پیش‌فرض: ${repo.default_branch})`)
          .join('\n'),
        repos,
      );
    } catch (error) {
      return fail(GithubClient.describeError(error));
    }
  },
};

const createGithubRepo: AgentTool = {
  name: 'create_github_repo',
  description: 'یک مخزن جدید در حساب گیت‌هاب مالک می‌سازد. این عملیات حساس است و قبل از اجرا از مالک تأیید گرفته می‌شود.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'نام مخزن (حروف انگلیسی، عدد، خط تیره و نقطه)' },
      private: { type: 'boolean', description: 'خصوصی باشد؟ پیش‌فرض بله' },
      description: { type: 'string', description: 'توضیح اختیاری مخزن' },
    },
    required: ['name'],
    additionalProperties: false,
  },
  sensitive: true,
  summarize: (args) => {
    const name = typeof args.name === 'string' ? args.name : '(بدون نام)';
    const isPrivate = args.private === undefined ? true : Boolean(args.private);
    return `ساخت مخزن جدید «${name}» در گیت‌هاب (${isPrivate ? 'خصوصی' : 'عمومی'})`;
  },
  availability: async (ctx) => githubAvailability(ctx),
  run: async (args, ctx) => {
    const name = requireString(args, 'name', 'نام مخزن', 100);
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) throw new ToolInputError('نام مخزن فقط می‌تواند شامل حروف انگلیسی، عدد، نقطه، خط تیره و زیرخط باشد.');
    const isPrivate = optionalBoolean(args, 'private') ?? true;
    const description = optionalString(args, 'description');

    try {
      const client = await ctx.github();
      const repo = await client.createRepo({ name, private: isPrivate, description, autoInit: true });
      await ctx.store.addRepo({
        owner: repo.full_name.split('/')[0] as string,
        name: repo.full_name.split('/')[1] as string,
        branch: repo.default_branch,
        private: repo.private,
      });
      await ctx.store.audit(String(ctx.userId), 'agent.repo.created', repo.full_name);
      return ok(`مخزن ${repo.full_name} ساخته شد (${repo.private ? 'خصوصی' : 'عمومی'}). آدرس: ${repo.html_url}`, repo);
    } catch (error) {
      if (error instanceof GithubError && error.status === 403) {
        return fail('توکن فعلی گیت‌هاب اجازه ساخت مخزن را ندارد (برای GitHub App این عملیات ممکن نیست).');
      }
      return fail(GithubClient.describeError(error));
    }
  },
};

const readGithubFile: AgentTool = {
  name: 'read_github_file',
  description: 'محتوای یک فایل را از مخزن گیت‌هاب می‌خواند. برای بررسی کد قبل از تغییر دادن آن استفاده کن.',
  parameters: {
    type: 'object',
    properties: {
      repo: { type: 'string', description: 'نام مخزن به شکل owner/repo یا فقط repo' },
      path: { type: 'string', description: 'مسیر فایل داخل مخزن، مثل src/index.ts' },
      ref: { type: 'string', description: 'شاخه یا کامیت (اختیاری، پیش‌فرض شاخه پیش‌فرض مخزن)' },
    },
    required: ['repo', 'path'],
    additionalProperties: false,
  },
  sensitive: false,
  summarize: (args) => `خواندن فایل «${String(args.path ?? '?')}» از مخزن «${String(args.repo ?? '?')}»`,
  availability: async (ctx) => githubAvailability(ctx),
  run: async (args, ctx) => {
    const repoInput = requireString(args, 'repo', 'مخزن', 200);
    const path = safePath(requireString(args, 'path', 'مسیر فایل', 400));
    const ref = optionalString(args, 'ref');
    try {
      const target = await resolveRepo(ctx, repoInput);
      const client = await ctx.github();
      const file = await client.getFile(target.owner, target.repo, path, ref);
      const body = file.size > MAX_FILE_BYTES ? truncate(file.content, MAX_FILE_CHARS) : file.content;
      const note = file.size > MAX_FILE_BYTES ? `\n\n[فایل بزرگ بود (${file.size} بایت)؛ فقط بخشی نمایش داده شد]` : '';
      return ok(`فایل ${path} از ${target.fullName}:\n\n${body}${note}`, { path, size: file.size, sha: file.sha });
    } catch (error) {
      return fail(GithubClient.describeError(error));
    }
  },
};

const writeCodeToGithub: AgentTool = {
  name: 'write_code_to_github',
  description:
    'یک فایل را در مخزن گیت‌هاب می‌نویسد یا به‌روزرسانی می‌کند (کامیت روی شاخه مشخص). اگر شاخه وجود نداشته باشد از شاخه پیش‌فرض ساخته می‌شود. این عملیات حساس است و نیازمند تأیید مالک است.',
  parameters: {
    type: 'object',
    properties: {
      repo: { type: 'string', description: 'نام مخزن به شکل owner/repo یا فقط repo' },
      file_path: { type: 'string', description: 'مسیر فایل، مثل src/app.ts' },
      content: { type: 'string', description: 'محتوای کامل فایل بعد از تغییر' },
      branch: { type: 'string', description: 'شاخه‌ای که کامیت روی آن انجام شود (اختیاری؛ در نبود آن یک شاخه ai/... ساخته می‌شود)' },
      commit_message: { type: 'string', description: 'پیام کامیت (اختیاری)' },
    },
    required: ['repo', 'file_path', 'content'],
    additionalProperties: false,
  },
  sensitive: true,
  summarize: (args) => {
    const repo = String(args.repo ?? '?');
    const path = String(args.file_path ?? '?');
    const branch = typeof args.branch === 'string' && args.branch ? ` روی شاخه «${args.branch}»` : '';
    const size = typeof args.content === 'string' ? args.content.length : 0;
    return `کامیت فایل «${path}» (${size} کاراکتر) در مخزن «${repo}»${branch}`;
  },
  availability: async (ctx) => githubAvailability(ctx),
  run: async (args, ctx) => {
    const repoInput = requireString(args, 'repo', 'مخزن', 200);
    const filePath = safePath(requireString(args, 'file_path', 'مسیر فایل', 400));
    const content = requireString(args, 'content', 'محتوای فایل');
    const requestedBranch = optionalString(args, 'branch');
    const message = optionalString(args, 'commit_message') ?? `chore: update ${filePath} via AI agent`;

    try {
      const target = await resolveRepo(ctx, repoInput);
      const client = await ctx.github();
      const meta = await client.getRepo(target.owner, target.repo);
      const branch = requestedBranch ?? `ai/agent-${randomId('').slice(0, 8).toLowerCase()}`;

      if (branch !== meta.default_branch) {
        const exists = await client.branchExists(target.owner, target.repo, branch);
        if (!exists) await client.createBranch(target.owner, target.repo, branch, meta.default_branch);
      }

      let sha: string | undefined;
      try {
        const existing = await client.getFile(target.owner, target.repo, filePath, branch);
        sha = existing.sha;
      } catch {
        // New file on this branch: no sha needed.
        sha = undefined;
      }

      const result = await client.putFile({
        owner: target.owner,
        repo: target.repo,
        path: filePath,
        content,
        message,
        branch,
        ...(sha ? { sha } : {}),
      });
      await ctx.store.audit(String(ctx.userId), 'agent.file.written', `${target.fullName}:${filePath}`);
      return ok(
        `فایل ${filePath} در ${target.fullName} روی شاخه ${branch} کامیت شد (${sha ? 'به‌روزرسانی' : 'فایل جدید'}, کامیت ${result.commit.sha.slice(0, 7)}).`,
        { branch, commit: result.commit.sha, path: filePath },
      );
    } catch (error) {
      return fail(GithubClient.describeError(error));
    }
  },
};

const createPullRequest: AgentTool = {
  name: 'create_pull_request',
  description: 'برای یک شاخه در مخزن گیت‌هاب Pull Request می‌سازد. این عملیات حساس است و نیازمند تأیید مالک است.',
  parameters: {
    type: 'object',
    properties: {
      repo: { type: 'string', description: 'نام مخزن به شکل owner/repo یا فقط repo' },
      branch: { type: 'string', description: 'شاخه‌ای که باید ادغام شود (head)' },
      title: { type: 'string', description: 'عنوان Pull Request' },
      body: { type: 'string', description: 'توضیحات اختیاری' },
      base: { type: 'string', description: 'شاخه مقصد (اختیاری، پیش‌فرض شاخه پیش‌فرض مخزن)' },
    },
    required: ['repo', 'branch', 'title'],
    additionalProperties: false,
  },
  sensitive: true,
  summarize: (args) =>
    `ساخت Pull Request با عنوان «${String(args.title ?? '?')}» از شاخه «${String(args.branch ?? '?')}» در مخزن «${String(args.repo ?? '?')}»`,
  availability: async (ctx) => githubAvailability(ctx),
  run: async (args, ctx) => {
    const repoInput = requireString(args, 'repo', 'مخزن', 200);
    const branch = requireString(args, 'branch', 'شاخه', 200);
    const title = requireString(args, 'title', 'عنوان', 300);
    const body = optionalString(args, 'body') ?? '';
    const baseInput = optionalString(args, 'base');

    try {
      const target = await resolveRepo(ctx, repoInput);
      const client = await ctx.github();
      const meta = await client.getRepo(target.owner, target.repo);
      const pull = await client.createPullRequest({
        owner: target.owner,
        repo: target.repo,
        title,
        body,
        head: branch,
        base: baseInput ?? meta.default_branch,
      });
      await ctx.store.audit(String(ctx.userId), 'agent.pr.created', `${target.fullName}#${pull.number}`);
      return ok(`Pull Request #${pull.number} ساخته شد: ${pull.html_url}`, pull);
    } catch (error) {
      return fail(GithubClient.describeError(error));
    }
  },
};

const runTests: AgentTool = {
  name: 'run_tests',
  description:
    'تست‌ها را برای یک مخزن ثبت‌شده از طریق GitHub Actions اجرا می‌کند. فقط دستورهای داخل لیست مجاز پذیرفته می‌شوند. این عملیات از دقیقه‌های Actions مصرف می‌کند و نیازمند تأیید مالک است.',
  parameters: {
    type: 'object',
    properties: {
      repo: { type: 'string', description: 'نام مخزن به شکل owner/repo یا فقط repo' },
      branch: { type: 'string', description: 'شاخه‌ای که تست روی آن اجرا شود (اختیاری)' },
      commands: { type: 'array', items: { type: 'string' }, description: 'دستورهای تست؛ حداکثر ۵ مورد' },
    },
    required: ['repo'],
    additionalProperties: false,
  },
  sensitive: true,
  summarize: (args) => {
    const repo = String(args.repo ?? '?');
    const branch = typeof args.branch === 'string' && args.branch ? ` روی شاخه «${args.branch}»` : '';
    const commands = Array.isArray(args.commands) ? args.commands.filter((c): c is string => typeof c === 'string') : [];
    return `اجرای تست‌ها در مخزن «${repo}»${branch}${commands.length ? ` با دستور: ${commands.slice(0, 5).join('، ')}` : ''} (مصرف دقیقه GitHub Actions)`;
  },
  availability: async (ctx, args) => {
    const base = githubAvailability(ctx);
    if (!base.available) return base;
    const raw = typeof args?.repo === 'string' ? args.repo : '';
    if (!raw) return { available: true };
    let owner: string | undefined;
    let repo: string;
    try {
      ({ owner, repo } = parseRepo(raw));
    } catch {
      // Bad input is reported by run(); refusing here would hide the real reason.
      return { available: true };
    }
    const project = await findProject(ctx, repo, owner);
    if (!project) {
      return {
        available: false,
        reason: `مخزن «${raw}» به‌عنوان پروژه در ربات ثبت نشده و من به تنظیمات GitHub Actions آن دسترسی ندارم.`,
      };
    }
    return { available: true };
  },
  run: async (args, ctx) => {
    const repoInput = requireString(args, 'repo', 'مخزن', 200);
    const branchInput = optionalString(args, 'branch');
    const rawCommands = Array.isArray(args.commands) ? args.commands.filter((c): c is string => typeof c === 'string') : [];
    try {
      const target = await resolveRepo(ctx, repoInput);
      const project = await findProject(ctx, target.repo, target.owner);
      if (!project) {
        return fail(
          `این مخزن (${target.fullName}) در ربات ثبت نشده است؛ برای اجرای تست اول باید به‌عنوان پروژه ثبت شود. من به تنظیمات Actions این مخزن دسترسی لازم را ندارم.`,
        );
      }
      const allowlist = parseAllowlist(ctx.env.COMMAND_ALLOWLIST);
      const commands = (rawCommands.length ? rawCommands : ['npm test']).slice(0, 5);
      const rejected = commands.filter((command) => !allowlist.includes(command.trim()));
      if (rejected.length) {
        return fail(`این دستورها در لیست مجاز نیستند و اجرا نمی‌شوند: ${rejected.join(' | ')}`);
      }
      await ctx.store.enqueue({
        requestId: null,
        kind: 'tests',
        payload: { projectId: project.id, branch: branchInput ?? project.default_branch, commands, chatId: ctx.chatId },
      });
      logger.info('agent.tests_queued', { repo: target.fullName, commands });
      return ok('تست‌ها در صف اجرا قرار گرفتند؛ نتیجه پس از پایان اجرا در همین گفتگو اعلام می‌شود.');
    } catch (error) {
      return fail(GithubClient.describeError(error));
    }
  },
};

/** The complete tool surface the model can see. */
export function createDefaultTools(): AgentTool[] {
  return [getCapabilities, listGithubRepos, createGithubRepo, readGithubFile, writeCodeToGithub, createPullRequest, runTests];
}
