import { describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { redact, registerSecret } from '../src/security/redact.js';
import { createTestBot } from './helpers.js';
import { checkActionsQuota, estimateRunMinutes } from '../src/github/quota.js';
import { checkRateLimit } from '../src/security/rateLimit.js';

describe('secret hygiene (acceptance test 12)', () => {
  it('masks every known secret shape', () => {
    const samples = [
      'token 123456789:AAFaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'key AIzaSyD-1234567890abcdefghijklmnopqrst',
      'pat ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'groq gsk_abcdefghijklmnopqrstuvwxyz012345',
      'openai sk-proj-abcdefghijklmnopqrstuvwxyz',
      'url https://x.test/callback?key=super-secret-value',
      '-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----',
    ];
    for (const sample of samples) {
      const cleaned = redact(sample);
      expect(cleaned).toContain('[REDACTED');
    }
  });

  it('masks registered runtime secrets everywhere', () => {
    registerSecret('super-secret-runtime-value-123');
    expect(redact('the value is super-secret-runtime-value-123 ok')).toBe('the value is [REDACTED:SECRET] ok');
  });

  it('never prints a secret into the structured log', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { logger } = await import('../src/util/log.js');
    registerSecret('AIzaLogSecretValue0000000000000');
    logger.info('provider.error', { message: 'failed with AIzaLogSecretValue0000000000000', nested: { token: 'ghp_LogSecret000000000000000000000' } });
    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    logSpy.mockRestore();
    expect(output).not.toContain('AIzaLogSecretValue0000000000000');
    expect(output).not.toContain('ghp_LogSecret000000000000000000000');
    expect(output).toContain('[REDACTED');
  });

  it('no committed source file contains a real-looking secret', () => {
    const suspicious = /(AIza[0-9A-Za-z_-]{20,}|gsk_[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
    const roots = ['src', 'migrations', 'docs', 'scripts'];
    const offenders: string[] = [];
    for (const root of roots) {
      let entries: string[] = [];
      try {
        entries = readdirSync(root);
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = join(root, entry);
        if (statSync(full).isDirectory()) continue;
        const content = readFileSync(full, 'utf8');
        if (suspicious.test(content)) offenders.push(full);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('GitHub Actions budget (acceptance test 17)', () => {
  it('blocks dispatch when the monthly budget is exhausted', async () => {
    const { store } = await createTestBot();
    await store.addActionsMinutes(2000);
    const quota = await checkActionsQuota(store, 2000);
    expect(quota.level).toBe('blocked');
    expect(quota.remainingMinutes).toBe(0);
  });

  it('warns when getting close to the cap', async () => {
    const { store } = await createTestBot();
    await store.addActionsMinutes(1800);
    const quota = await checkActionsQuota(store, 2000);
    expect(quota.level).toBe('warn');
  });

  it('estimates the next run from previous durations', () => {
    expect(estimateRunMinutes([3, 5])).toBe(5);
    expect(estimateRunMinutes([])).toBe(3);
  });

  it('records real billable minutes from a finished run', async () => {
    const { store } = await createTestBot();
    const { recordRunMinutes } = await import('../src/github/quota.js');
    const minutes = await recordRunMinutes(store, '2026-01-01T00:00:00Z', '2026-01-01T00:03:30Z');
    expect(minutes).toBe(4);
    expect(await store.actionsMinutesThisMonth()).toBe(4); // metered, so the next dispatch can be capped
  });
});

describe('rate limiting', () => {
  it('allows up to the limit and then blocks inside the window', async () => {
    const { store } = await createTestBot();
    for (let i = 0; i < 5; i++) {
      const result = await checkRateLimit(store.sql, 'test-key', 5, 60_000);
      expect(result.allowed).toBe(true);
    }
    const blocked = await checkRateLimit(store.sql, 'test-key', 5, 60_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);

    const other = await checkRateLimit(store.sql, 'another-key', 5, 60_000);
    expect(other.allowed).toBe(true);
  });
});
