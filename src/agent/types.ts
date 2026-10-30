import type { Env } from '../env.js';
import type { Store } from '../db/store.js';
import type { GithubClient } from '../github/client.js';
import type { AiToolSpec } from '../ai/types.js';

/** Everything a tool may use. Tools never reach into the Telegram layer. */
export interface AgentContext {
  env: Env;
  store: Store;
  userId: number;
  chatId: number;
  /** Lazily resolved so a read-only chat turn never asks GitHub for a token. */
  github: () => Promise<GithubClient>;
  fetchImpl: typeof fetch;
  /** Filled in by the agent so `get_bot_capabilities` can introspect itself. */
  tools?: AgentTool[];
}

export interface ToolAvailability {
  available: boolean;
  /** Persian sentence shown to the owner and to the model. */
  reason?: string;
}

export interface ToolOutcome {
  ok: boolean;
  /** Compact, model-facing result (becomes the `tool` message content). */
  content: string;
  /** Optional structured data for logs/audit; never sent verbatim to Telegram. */
  data?: unknown;
}

/**
 * A capability the agent can use. `sensitive` tools change state outside the
 * bot (GitHub writes, CI minutes) and therefore always require an explicit
 * owner approval before `run` is called.
 */
export interface AgentTool {
  name: string;
  description: string;
  /** JSON Schema (type: object) for the arguments. */
  parameters: Record<string, unknown>;
  sensitive: boolean;
  /** Persian, human-readable description of exactly what will happen. */
  summarize: (args: Record<string, unknown>) => string;
  /**
   * Whether the tool can run at all. `args` is best-effort (the model may call
   * the tool with a partial argument object), so it must never do network I/O
   * and must not throw - it exists purely to refuse early and naturally.
   */
  availability: (ctx: AgentContext, args?: Record<string, unknown>) => Promise<ToolAvailability>;
  run: (args: Record<string, unknown>, ctx: AgentContext) => Promise<ToolOutcome>;
}

export function toToolSpec(tool: AgentTool): AiToolSpec {
  return { name: tool.name, description: tool.description, parameters: tool.parameters };
}

/** Argument coercion with Persian error messages the model can recover from. */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

export function requireString(args: Record<string, unknown>, key: string, label: string, maxLength = 200_000): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new ToolInputError(`پارامتر «${label}» (${key}) لازم است.`);
  }
  if (value.length > maxLength) {
    throw new ToolInputError(`مقدار «${label}» بیش از حد مجاز است (${maxLength} کاراکتر).`);
  }
  return value;
}

export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (['true', '1', 'yes', 'بله'].includes(value.toLowerCase())) return true;
    if (['false', '0', 'no', 'خیر'].includes(value.toLowerCase())) return false;
  }
  return undefined;
}

/** "owner/repo" or a bare repo name (the bot owner's account). */
export function parseRepo(value: string): { owner?: string; repo: string } {
  const cleaned = value.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  const parts = cleaned.split('/').filter(Boolean);
  if (!parts.length || parts.length > 2) throw new ToolInputError(`نام مخزن «${value}» معتبر نیست. قالب درست: owner/repo`);
  const repo = parts[parts.length - 1] as string;
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(repo)) throw new ToolInputError(`نام مخزن «${repo}» معتبر نیست.`);
  const owner = parts.length === 2 ? parts[0] : undefined;
  if (owner && !/^[A-Za-z0-9._-]{1,100}$/.test(owner)) throw new ToolInputError(`نام مالک «${owner}» معتبر نیست.`);
  return { owner, repo };
}

/** Guards against path traversal and absolute paths before any GitHub call. */
export function safePath(value: string): string {
  const path = value.trim().replace(/^\/+/, '');
  if (!path) throw new ToolInputError('مسیر فایل خالی است.');
  if (path.includes('..') || path.includes('\\')) throw new ToolInputError(`مسیر فایل «${value}» مجاز نیست.`);
  if (path.length > 400) throw new ToolInputError('مسیر فایل بیش از حد طولانی است.');
  return path;
}
