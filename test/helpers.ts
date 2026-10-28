import { sqliteSql, type Sql } from '../src/db/sql.js';
import { Bot } from '../src/bot.js';
import { Store } from '../src/db/store.js';
import type { Env } from '../src/env.js';

export interface CapturedCall {
  url: string;
  method: string;
  body: unknown;
}

type Handler = (url: URL, init: RequestInit) => Promise<Response> | Response;

/** Deterministic HTTP fake: no network is touched by the test-suite. */
export class FetchMock {
  calls: CapturedCall[] = [];
  private routes: Array<{ pattern: RegExp; handler: Handler }> = [];

  on(pattern: RegExp, handler: Handler): this {
    this.routes.push({ pattern, handler });
    return this;
  }

  /** Register a route with priority (used to override the default mocks). */
  prepend(pattern: RegExp, handler: Handler): this {
    this.routes.unshift({ pattern, handler });
    return this;
  }

  fetch: typeof fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const body = init?.body ? tryParseJson(String(init.body)) : undefined;
    this.calls.push({ url, method: init?.method ?? 'GET', body });
    for (const route of this.routes) {
      if (route.pattern.test(url)) return route.handler(new URL(url), init ?? {});
    }
    throw new Error(`unmocked request: ${init?.method ?? 'GET'} ${url}`);
  };

  callsTo(fragment: string): CapturedCall[] {
    return this.calls.filter((call) => call.url.includes(fragment));
  }

  lastCallTo(fragment: string): CapturedCall | undefined {
    return [...this.callsTo(fragment)].pop();
  }

  reset(): void {
    this.calls = [];
  }
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export interface TelegramRecorder {
  messages: Array<{ chatId: number | string; text: string; replyMarkup?: unknown }>;
  answers: string[];
}

export function mockTelegram(mock: FetchMock): TelegramRecorder {
  const recorder: TelegramRecorder = { messages: [], answers: [] };
  mock.on(/api\.telegram\.org\/bot[^/]+\/sendMessage/, (_url, init) => {
    const body = JSON.parse(String(init.body)) as { chat_id: number | string; text: string; reply_markup?: unknown };
    recorder.messages.push({ chatId: body.chat_id, text: body.text, replyMarkup: body.reply_markup });
    return jsonResponse({ ok: true, result: { message_id: recorder.messages.length, chat: { id: body.chat_id }, date: 0 } });
  });
  mock.on(/api\.telegram\.org\/bot[^/]+\/(editMessageText|sendChatAction|setWebhook|setMyCommands)/, () =>
    jsonResponse({ ok: true, result: true }),
  );
  mock.on(/api\.telegram\.org\/bot[^/]+\/answerCallbackQuery/, (_url, init) => {
    recorder.answers.push(String((JSON.parse(String(init.body)) as { text?: string }).text ?? ''));
    return jsonResponse({ ok: true, result: true });
  });
  return recorder;
}

export interface GithubState {
  files: Record<string, string>;
  tree: Array<{ path: string; type: 'blob' | 'tree'; size?: number; sha: string }>;
  branches: string[];
  commits: Array<{ path: string; content: string; branch: string }>;
  pullRequest?: { number: number; html_url: string };
}

export function mockGithub(mock: FetchMock, state: GithubState): GithubState {
  const encode = (value: string) => Buffer.from(value, 'utf8').toString('base64');

  mock.on(/api\.github\.com\/repos\/[^/]+\/[^/]+\/git\/trees\//, () =>
    jsonResponse({ tree: state.tree, truncated: false }),
  );
  mock.on(/\/repos\/[^/]+\/[^/]+\/git\/ref\/heads\//, (url) => {
    const branch = decodeURIComponent(url.pathname.split('/git/ref/heads/')[1] ?? '');
    if (!state.branches.includes(branch)) return jsonResponse({ message: 'Not Found' }, 404);
    return jsonResponse({ object: { sha: 'basesha0001' } });
  });
  mock.on(/\/repos\/[^/]+\/[^/]+\/git\/refs\?*$/, () => jsonResponse({ ref: 'refs/heads/new', object: { sha: 'basesha0001' } }, 201));
  mock.on(/\/repos\/[^/]+\/[^/]+\/contents\//, (url, init) => {
    const rawPath = decodeURIComponent(url.pathname.split('/contents/')[1] ?? '');
    const method = init.method ?? 'GET';
    if (method === 'GET') {
      const content = state.files[rawPath];
      if (content === undefined) return jsonResponse({ message: 'Not Found' }, 404);
      return jsonResponse({ content: encode(content), sha: `sha-${rawPath}`, size: content.length, encoding: 'base64' });
    }
    if (method === 'PUT') {
      const body = JSON.parse(String(init.body)) as { content: string; branch: string; message: string };
      const content = Buffer.from(body.content, 'base64').toString('utf8');
      state.commits.push({ path: rawPath, content, branch: body.branch });
      state.files[rawPath] = content;
      return jsonResponse({ commit: { sha: `commit-${state.commits.length}` }, content: { sha: `sha-${rawPath}` } });
    }
    return jsonResponse({ commit: { sha: 'deleted' } });
  });
  mock.on(/\/repos\/[^/]+\/[^/]+\/pulls\?*$/, () => {
    state.pullRequest = { number: 42, html_url: 'https://github.com/owner/repo/pull/42' };
    return jsonResponse({ number: 42, html_url: state.pullRequest.html_url, state: 'open', title: 'feat(ai)' }, 201);
  });
  mock.on(/\/repos\/[^/]+\/[^/]+\/branches/, () => jsonResponse(state.branches.map((name) => ({ name }))));
  mock.on(/\/repos\/[^/]+\/[^/]+\/commits/, () =>
    jsonResponse([{ sha: 'abc1234', commit: { message: 'initial commit', author: { name: 'owner' } } }]),
  );
  mock.on(/\/repos\/[^/]+\/[^/]+\/actions\/workflows\/.*\/dispatches/, () => new Response(null, { status: 204 }));
  mock.on(/\/repos\/[^/]+\/[^/]+\/actions\/runs\/(\d+)\/jobs/, () =>
    jsonResponse({ jobs: [{ name: 'run', conclusion: 'success', steps: [{ name: 'Run tests', conclusion: 'success', number: 1 }] }] }),
  );
  mock.on(/\/repos\/[^/]+\/[^/]+\/actions\/runs\/(\d+)$/, () =>
    jsonResponse({
      id: 555,
      status: 'completed',
      conclusion: 'success',
      html_url: 'https://github.com/owner/repo/actions/runs/555',
      run_started_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:03:00Z',
      head_branch: 'ai/test',
    }),
  );
  mock.on(/\/repos\/[^/]+\/[^/]+\/actions\/runs\?/, (url) =>
    jsonResponse({
      workflow_runs: [
        {
          id: 555,
          status: 'completed',
          conclusion: 'success',
          html_url: 'https://github.com/owner/repo/actions/runs/555',
          run_started_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:03:00Z',
          head_branch: url.searchParams.get('branch') ?? 'main',
        },
      ],
    }),
  );
  mock.on(/\/repos\/[^/]+\/[^/]+$/, () =>
    jsonResponse({ full_name: 'owner/repo', default_branch: 'main', private: false, language: 'TypeScript', description: 'demo repo' }),
  );
  return state;
}

export interface AiReply {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
}

export function mockGemini(mock: FetchMock, reply: AiReply | ((body: unknown) => AiReply)): void {
  mock.on(/generativelanguage\.googleapis\.com/, (_url, init) => {
    const body = init.body ? tryParseJson(String(init.body)) : undefined;
    const resolved = typeof reply === 'function' ? reply(body) : reply;
    return jsonResponse({
      candidates: [{ content: { parts: [{ text: resolved.text }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: resolved.inputTokens ?? 100, candidatesTokenCount: resolved.outputTokens ?? 200 },
    });
  });
}

export function mockOpenAiCompatible(mock: FetchMock, hostPattern: RegExp, reply: AiReply | ((body: unknown) => AiReply)): void {
  mock.on(hostPattern, (_url, init) => {
    const body = init.body ? tryParseJson(String(init.body)) : undefined;
    const resolved = typeof reply === 'function' ? reply(body) : reply;
    return jsonResponse({
      choices: [{ message: { content: resolved.text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: resolved.inputTokens ?? 100, completion_tokens: resolved.outputTokens ?? 200 },
    });
  });
}

export interface TestBot {
  bot: Bot;
  env: Env;
  store: Store;
  sql: Sql;
  mock: FetchMock;
  telegram: TelegramRecorder;
  github: GithubState;
}

export const OWNER_ID = 1001;

export async function createTestBot(options: {
  env?: Partial<Env>;
  githubState?: Partial<GithubState>;
  aiReply?: AiReply | ((body: unknown) => AiReply);
  registerMocks?: (mock: FetchMock) => void;
} = {}): Promise<TestBot> {
  const sql = await sqliteSql(':memory:');
  const env: Env = {
    TELEGRAM_BOT_TOKEN: '123456789:AAF-fake-telegram-token-for-tests',
    TELEGRAM_WEBHOOK_SECRET: 'webhook-secret',
    OWNER_TELEGRAM_ID: String(OWNER_ID),
    APPROVAL_SECRET: 'approval-secret',
    GITHUB_TOKEN: 'ghp_fakeGithubTokenForTests000000000',
    GEMINI_API_KEY: 'AIzaFakeGeminiKeyForTests000000000',
    AI_DAILY_TOKEN_LIMIT: '500000',
    ACTIONS_MONTHLY_MINUTE_LIMIT: '2000',
    COMMAND_ALLOWLIST: 'npm test,pytest,npm run lint',
    ...options.env,
  } as Env;

  const mock = new FetchMock();
  const telegram = mockTelegram(mock);
  const github = mockGithub(mock, {
    files: options.githubState?.files ?? { 'README.md': '# demo repo\n', 'src/app.ts': 'export const add = (a: number, b: number) => a + b;\n' },
    tree: options.githubState?.tree ?? [
      { path: 'README.md', type: 'blob', size: 11, sha: 'sha-1' },
      { path: 'src/app.ts', type: 'blob', size: 40, sha: 'sha-2' },
    ],
    branches: options.githubState?.branches ?? ['main'],
    commits: options.githubState?.commits ?? [],
  });

  // Custom routes are registered first so a test can override the defaults.
  options.registerMocks?.(mock);
  if (options.aiReply) mockGemini(mock, options.aiReply);

  const bot = await Bot.create(env, sql, mock.fetch);
  return { bot, env, store: bot.store, sql, mock, telegram, github };
}

export function planJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    understanding: 'اضافه کردن تابع تفریق و تست آن',
    outcome: 'تابع subtract اضافه شود و تست آن سبز باشد',
    files: ['src/app.ts', 'tests/app.test.ts'],
    approach: 'یک تابع جدید اضافه می‌کنیم و برای آن تست واحد می‌نویسیم',
    impact: { database: 'ندارد', api: 'ندارد', ui: 'ندارد' },
    tests: ['npm test'],
    risks: ['ممکن است تست‌ها نیاز به تنظیم داشته باشند'],
    unknowns: [],
    effort: 'S',
    commands: ['npm test'],
    estimatedApiCostUsd: 0,
    ...overrides,
  });
}

export function codeJson(): string {
  return JSON.stringify({
    files: [
      {
        path: 'src/app.ts',
        action: 'update',
        content: 'export const add = (a: number, b: number) => a + b;\nexport const subtract = (a: number, b: number) => a - b;\n',
      },
    ],
    tests: ['npm test'],
    notes: 'تابع تفریق اضافه شد',
  });
}

export function update(overrides: Partial<TelegramUpdate> = {}): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      date: 0,
      chat: { id: OWNER_ID, type: 'private' },
      from: { id: OWNER_ID, is_bot: false, username: 'owner' },
      text: '/start',
      ...overrides.message,
    },
    ...overrides,
  };
}

import type { TelegramUpdate } from '../src/telegram/api.js';
