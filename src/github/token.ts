import type { Env } from '../env.js';
import { createInstallationToken } from './appJwt.js';
import { registerSecret } from '../security/redact.js';

interface CachedToken {
  token: string;
  expiresAt: number;
}

const cache = new Map<string, CachedToken>();

/**
 * Resolve a GitHub credential.
 *
 * Preferred: GitHub App installation token (short lived, scoped to the
 * installation's repositories). Fallback: fine-grained PAT limited to one repo.
 * Tokens are cached in memory and registered for redaction - they are never
 * logged and never sent to an AI provider.
 */
export async function resolveGithubToken(env: Env, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)): Promise<{ token: string; source: 'app' | 'pat' }> {
  if (env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY && env.GITHUB_INSTALLATION_ID) {
    const key = `app:${env.GITHUB_APP_ID}:${env.GITHUB_INSTALLATION_ID}`;
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now() + 60_000) return { token: cached.token, source: 'app' };

    const result = await createInstallationToken({
      appId: env.GITHUB_APP_ID,
      privateKeyPem: env.GITHUB_APP_PRIVATE_KEY,
      installationId: env.GITHUB_INSTALLATION_ID,
      fetchImpl,
    });
    const expiresAt = new Date(result.expires_at).getTime() || Date.now() + 50 * 60_000;
    cache.set(key, { token: result.token, expiresAt });
    registerSecret(result.token);
    return { token: result.token, source: 'app' };
  }

  if (env.GITHUB_TOKEN) {
    registerSecret(env.GITHUB_TOKEN);
    return { token: env.GITHUB_TOKEN, source: 'pat' };
  }

  throw new Error('هیچ اعتبارنامه گیت‌هابی تنظیم نشده (GitHub App یا PAT)');
}

export function clearTokenCache(): void {
  cache.clear();
}
