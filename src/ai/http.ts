import { redact } from '../security/redact.js';
import { AiProviderError } from './types.js';

export interface PostJsonOptions {
  url: string;
  headers?: Record<string, string>;
  body: unknown;
  timeoutMs: number;
  provider: string;
  fetchImpl?: typeof fetch;
}

/**
 * JSON POST with a hard timeout. The timeout is required on Cloudflare Workers:
 * an unresponsive free-tier provider must not burn the whole invocation.
 */
export async function postJson<T>(options: PostJsonOptions): Promise<T> {
  const doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await doFetch(options.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
      body: JSON.stringify(options.body),
      signal: controller.signal,
    });
    const raw = await response.text();
    if (!response.ok) {
      let detail = raw.slice(0, 400);
      try {
        const parsed = JSON.parse(raw) as { error?: { message?: string }; message?: string };
        detail = parsed.error?.message ?? parsed.message ?? detail;
      } catch {
        /* keep the raw excerpt */
      }
      const retryable = response.status === 429 || response.status >= 500;
      throw new AiProviderError(redact(`${options.provider} responded ${response.status}: ${detail}`), options.provider, response.status, retryable);
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new AiProviderError(`${options.provider} returned invalid JSON`, options.provider, 502, true);
    }
  } catch (error) {
    if (error instanceof AiProviderError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new AiProviderError(`${options.provider} request timed out after ${options.timeoutMs}ms`, options.provider, 408, true);
    }
    throw new AiProviderError(redact(`${options.provider} unreachable: ${(error as Error).message}`), options.provider, undefined, true);
  } finally {
    clearTimeout(timer);
  }
}

export function authFailure(status: number | undefined): boolean {
  return status === 401 || status === 403;
}
