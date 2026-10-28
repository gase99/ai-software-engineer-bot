import type { Env } from '../env.js';
import type { Store } from '../db/store.js';
import type { ProviderRow } from '../types.js';
import { PROVIDER_CATALOG, catalogEntry } from './defaults.js';
import { completeGemini, testGemini } from './providers/gemini.js';
import { completeOpenAiCompatible, testOpenAiCompatible } from './providers/openaiCompatible.js';
import { completeAnthropic, testAnthropic } from './providers/anthropic.js';
import { authFailure } from './http.js';
import {
  AiProviderError,
  NoProviderAvailableError,
  type AiCompletion,
  type AiCompletionRequest,
  type ProviderHealth,
} from './types.js';
import { checkLimits, estimateCostUsd } from './usage.js';
import { logger } from '../util/log.js';

export type ProviderEvent =
  | { type: 'key_invalid'; provider: string; message: string }
  | { type: 'rate_limited'; provider: string; message: string }
  | { type: 'limit_warning'; provider: string; message: string }
  | { type: 'fallback'; from: string; to: string; message: string };

/**
 * Multi-provider manager with a single hard rule: never silently switch to a
 * more expensive model. Paid providers are only reachable if the owner
 * activates them on purpose.
 */
export class ProviderManager {
  constructor(
    private readonly store: Store,
    private readonly env: Env,
    private readonly notify?: (event: ProviderEvent) => void | Promise<void>,
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {}

  private keyFor(name: string): string | undefined {
    const definition = catalogEntry(name);
    if (!definition) return undefined;
    const value = this.env[definition.envKey];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  /** Seed/refresh provider rows from the catalogue + available env keys. */
  async sync(options: { force?: boolean } = {}): Promise<void> {
    const existing = await this.store.listProviders();
    const hasActive = existing.some((row) => row.active === 1 && this.keyFor(row.name));
    // Re-seeding on every webhook would cost D1 writes; only do it when the
    // catalogue changed, an installation is missing, or it is forced.
    if (!options.force && existing.length >= PROVIDER_CATALOG.length && hasActive) return;

    for (const definition of PROVIDER_CATALOG) {
      const hasKey = Boolean(this.keyFor(definition.name));
      const existing = await this.store.getProvider(definition.name);
      await this.store.upsertProvider({
        name: definition.name,
        display_name: definition.displayName,
        base_url: definition.baseUrl,
        model: existing?.model ?? definition.defaultModel,
        active: existing ? existing.active : hasKey && definition.freeTier ? 1 : 0,
        free_tier: definition.freeTier ? 1 : 0,
        priority: definition.priority,
        daily_limit: definition.dailyLimit,
        monthly_limit: definition.monthlyLimit,
        timeout_ms: 60_000,
        max_retries: 2,
        capabilities_json: JSON.stringify(definition.capabilities),
      });
      if (hasKey) {
        const { registerSecret } = await import('../security/redact.js');
        registerSecret(this.keyFor(definition.name) as string);
      }
    }

    const providers = await this.store.listProviders();
    const active = providers.find((p) => p.active === 1 && this.keyFor(p.name));
    if (!active) {
      const candidate = providers
        .filter((p) => this.keyFor(p.name) && p.free_tier === 1)
        .sort((a, b) => a.priority - b.priority)[0];
      if (candidate) await this.store.setProviderActive(candidate.name, true);
    }
  }

  async list(): Promise<ProviderRow[]> {
    return this.store.listProviders();
  }

  async configured(): Promise<ProviderRow[]> {
    const providers = await this.store.listProviders();
    return providers.filter((p) => Boolean(this.keyFor(p.name)));
  }

  async activeProvider(): Promise<ProviderRow | null> {
    const providers = await this.store.listProviders();
    const active = providers.find((p) => p.active === 1 && this.keyFor(p.name));
    if (active) return active;
    const fallback = providers
      .filter((p) => this.keyFor(p.name) && p.free_tier === 1)
      .sort((a, b) => a.priority - b.priority)[0];
    return fallback ?? null;
  }

  async setActive(name: string, model?: string): Promise<ProviderRow> {
    const provider = await this.store.getProvider(name);
    if (!provider) throw new AiProviderError(`ارائه‌دهنده ${name} ناشناس است`, name, 404);
    if (!this.keyFor(name)) throw new AiProviderError(`کلید ${name} در تنظیمات سرور نیست`, name, 400);
    if (model) {
      const definition = catalogEntry(name);
      if (definition?.models && !definition.models.includes(model)) {
        throw new AiProviderError(`مدل ${model} برای ${name} تعریف نشده`, name, 400);
      }
      await this.store.setProviderModel(name, model);
    }
    const all = await this.store.listProviders();
    for (const row of all) await this.store.setProviderActive(row.name, row.name === name);
    return (await this.store.getProvider(name)) as ProviderRow;
  }

  /** Provider order: the active one first, then free tiers by priority. */
  private async orderedCandidates(): Promise<ProviderRow[]> {
    const active = await this.activeProvider();
    const others = (await this.configured())
      .filter((p) => p.name !== active?.name)
      .sort((a, b) => Number(b.free_tier) - Number(a.free_tier) || a.priority - b.priority);
    return active ? [active, ...others] : others;
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletion> {
    const candidates = await this.orderedCandidates();
    const reasons: Array<{ provider: string; reason: string }> = [];

    for (const provider of candidates) {
      const limits = await checkLimits(this.store, provider);
      if (!limits.ok) {
        reasons.push({ provider: provider.name, reason: limits.reason ?? 'limit' });
        continue;
      }
      if (limits.level === 'warn' && this.notify) {
        await this.notify({ type: 'limit_warning', provider: provider.name, message: limits.reason ?? 'نزدیک سقف رایگان' });
      }
      try {
        const completion = await this.dispatch(provider, request);
        const cost = estimateCostUsd(provider.name, completion.inputTokens, completion.outputTokens);
        await this.store.recordUsage(provider.name, completion.inputTokens, completion.outputTokens, cost);
        await this.store.updateProviderHealth(provider.name, 'ok');
        if (reasons.length && this.notify) {
          await this.notify({ type: 'fallback', from: reasons[0]!.provider, to: provider.name, message: 'fallback used' });
        }
        return completion;
      } catch (error) {
        const err = error as AiProviderError;
        if (authFailure(err.status)) {
          await this.store.updateProviderHealth(provider.name, 'invalid_key', err.message);
          await this.store.setProviderActive(provider.name, false);
          if (this.notify) await this.notify({ type: 'key_invalid', provider: provider.name, message: err.message });
          reasons.push({ provider: provider.name, reason: 'invalid_key' });
        } else if (err.status === 429) {
          await this.store.updateProviderHealth(provider.name, 'rate_limited', err.message);
          if (this.notify) await this.notify({ type: 'rate_limited', provider: provider.name, message: err.message });
          reasons.push({ provider: provider.name, reason: 'rate_limited' });
        } else {
          await this.store.updateProviderHealth(provider.name, 'error', err.message);
          reasons.push({ provider: provider.name, reason: err.message });
        }
        logger.warn('ai.provider_failed', { provider: provider.name, status: err.status });
      }
    }

    throw new NoProviderAvailableError(reasons);
  }

  private async dispatch(provider: ProviderRow, request: AiCompletionRequest): Promise<AiCompletion> {
    const apiKey = this.keyFor(provider.name);
    if (!apiKey) throw new AiProviderError(`provider ${provider.name} has no key`, provider.name, 400);
    const timeoutMs = request.timeoutMs ?? provider.timeout_ms ?? 60_000;
    if (provider.name === 'gemini') {
      return completeGemini({
        apiKey,
        baseUrl: provider.base_url,
        model: provider.model,
        request,
        timeoutMs,
        fetchImpl: this.fetchImpl,
      });
    }
    if (provider.name === 'anthropic') {
      return completeAnthropic({
        apiKey,
        baseUrl: provider.base_url,
        model: provider.model,
        request,
        timeoutMs,
        fetchImpl: this.fetchImpl,
      });
    }
    return completeOpenAiCompatible({
      provider: provider.name,
      apiKey,
      baseUrl: provider.base_url,
      model: provider.model,
      request,
      timeoutMs,
      fetchImpl: this.fetchImpl,
    });
  }

  async test(name?: string): Promise<Array<{ provider: string; health: ProviderHealth }>> {
    const providers = name ? [await this.store.getProvider(name)] : await this.store.listProviders();
    const results: Array<{ provider: string; health: ProviderHealth }> = [];
    for (const provider of providers) {
      if (!provider) continue;
      const apiKey = this.keyFor(provider.name);
      if (!apiKey) {
        results.push({ provider: provider.name, health: { ok: false, status: 'no_key', latencyMs: 0, error: 'کلید تنظیم نشده' } });
        continue;
      }
      let health: ProviderHealth;
      if (provider.name === 'gemini') {
        health = await testGemini({ apiKey, baseUrl: provider.base_url, model: provider.model, timeoutMs: provider.timeout_ms, fetchImpl: this.fetchImpl });
      } else if (provider.name === 'anthropic') {
        health = await testAnthropic({ apiKey, baseUrl: provider.base_url, model: provider.model, timeoutMs: provider.timeout_ms, fetchImpl: this.fetchImpl });
      } else {
        health = await testOpenAiCompatible({
          provider: provider.name,
          apiKey,
          baseUrl: provider.base_url,
          model: provider.model,
          timeoutMs: provider.timeout_ms,
          fetchImpl: this.fetchImpl,
        });
      }
      await this.store.updateProviderHealth(provider.name, health.status, health.error);
      results.push({ provider: provider.name, health });
    }
    return results;
  }
}
