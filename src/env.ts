import type { D1Database } from './db/sql.js';

/**
 * Worker bindings + secrets.
 *
 * Secrets are injected by the platform (Cloudflare Secrets / .dev.vars locally)
 * and are never committed, never logged and never sent to an AI provider.
 */
export interface Env {
  // --- Bindings -------------------------------------------------------------
  DB: D1Database;

  // --- Core secrets ---------------------------------------------------------
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  OWNER_TELEGRAM_ID: string;
  APPROVAL_SECRET: string;

  // --- GitHub (App preferred, PAT as fallback) ------------------------------
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_INSTALLATION_ID?: string;
  GITHUB_TOKEN?: string;

  // --- AI providers (all optional; free tiers first) ------------------------
  GEMINI_API_KEY?: string;
  GROQ_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;

  // --- Public callback URL used by GitHub Actions to report results ---------
  BOT_CALLBACK_URL?: string;
  ACTIONS_CALLBACK_TOKEN?: string;

  // --- Non-secret configuration (wrangler.toml [vars]) ----------------------
  WEBHOOK_PATH?: string;
  DEFAULT_BRANCH?: string;
  MAX_DIFF_BYTES?: string;
  MAX_UPLOAD_BYTES?: string;
  AI_DAILY_TOKEN_LIMIT?: string;
  AI_MONTHLY_TOKEN_LIMIT?: string;
  ACTIONS_MONTHLY_MINUTE_LIMIT?: string;
  COMMAND_ALLOWLIST?: string;
}

export function num(env: Env, key: keyof Env, fallback: number): number {
  const raw = env[key];
  const parsed = typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  return source as unknown as Env;
}
