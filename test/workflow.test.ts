import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DEFAULT_ALLOWLIST } from '../src/github/commands.js';

const workflow = readFileSync(new URL('../.github/workflows/ai-exec.yml', import.meta.url), 'utf8');
const ci = readFileSync(new URL('../.github/workflows/bot-ci.yml', import.meta.url), 'utf8');

describe('GitHub Actions execution sandbox (acceptance test 18)', () => {
  it('is dispatch-only and takes the documented inputs', () => {
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('job_id');
    expect(workflow).toContain('request_id');
    expect(workflow).toContain('commands');
  });

  it('keeps the 15 minute cap, minimal permissions and a concurrency group', () => {
    expect(workflow).toContain('timeout-minutes: 15');
    expect(workflow).toMatch(/permissions:\s*\n\s*contents: read/);
    expect(workflow).toContain('concurrency:');
  });

  it('caps the captured output at 100 KB', () => {
    expect(workflow).toContain('MAX_OUTPUT_BYTES');
    expect(workflow).toContain('102400');
    expect(workflow).toContain('output truncated');
  });

  it('validates commands against the same allow-list as the bot', () => {
    for (const command of DEFAULT_ALLOWLIST) {
      expect(workflow.includes(`"${command}"`), `missing in workflow allow-list: ${command}`).toBe(true);
    }
    expect(workflow).toContain('shell metacharacter');
    expect(workflow).toContain('not allowlisted');
  });

  it('emits a structured JSON log and reports back to the bot over a protected callback', () => {
    expect(workflow).toContain('ai_exec.finished');
    expect(workflow).toContain('BOT_CALLBACK_URL');
    expect(workflow).toContain('x-actions-token');
    expect(workflow).toContain('ACTIONS_CALLBACK_TOKEN');
  });

  it('checks out without persisting credentials', () => {
    expect(workflow).toContain('persist-credentials: false');
  });

  it('CI runs typecheck and the test suite on every pull request', () => {
    expect(ci).toContain('npm run typecheck');
    expect(ci).toContain('npm test');
    expect(ci).toContain('pull_request');
  });
});
