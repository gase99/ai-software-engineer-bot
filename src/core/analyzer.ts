import type { ProviderManager } from '../ai/registry.js';
import type { Store } from '../db/store.js';
import type { FileChange, PlanContent, RequestRow } from '../types.js';
import { buildAnalysisMessages, buildCodeMessages } from './prompts.js';
import { buildContext, detectStack, type RepoSnapshot } from './context.js';
import { validateRepoPath } from './patch.js';
import { isCommandAllowed, parseAllowlist } from '../github/commands.js';
import { scanForInjection } from '../security/promptGuard.js';
import { logger } from '../util/log.js';

const EFFORTS = new Set(['XS', 'S', 'M', 'L']);

export function extractJsonObject(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('خروجی مدل شیء JSON نداشت');
  return JSON.parse(candidate.slice(start, end + 1));
}

function asStringArray(value: unknown, max = 20): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, max);
}

/** Validate + sanitise whatever the model returned. Never trust it raw. */
export function coercePlan(raw: unknown, allowlist: string[]): PlanContent {
  const input = (raw ?? {}) as Record<string, unknown>;
  const impact = (input.impact ?? {}) as Record<string, unknown>;
  const commands = asStringArray(input.commands)
    .map((command) => isCommandAllowed(command, allowlist))
    .filter((check) => check.allowed)
    .map((check) => check.command);
  const files = asStringArray(input.files, 40)
    .map((path) => {
      try {
        return validateRepoPath(path);
      } catch {
        return null;
      }
    })
    .filter((path): path is string => Boolean(path));

  return {
    understanding: String(input.understanding ?? '').slice(0, 2000) || 'نامشخص',
    outcome: String(input.outcome ?? '').slice(0, 2000) || 'نامشخص',
    files,
    approach: String(input.approach ?? '').slice(0, 4000) || 'نامشخص',
    impact: {
      database: String(impact.database ?? 'ندارد').slice(0, 500),
      api: String(impact.api ?? 'ندارد').slice(0, 500),
      ui: String(impact.ui ?? 'ندارد').slice(0, 500),
    },
    tests: asStringArray(input.tests),
    risks: asStringArray(input.risks),
    unknowns: asStringArray(input.unknowns),
    effort: EFFORTS.has(String(input.effort)) ? (String(input.effort) as PlanContent['effort']) : 'S',
    estimatedApiCostUsd: Number.isFinite(Number(input.estimatedApiCostUsd)) ? Number(input.estimatedApiCostUsd) : 0,
    commands,
  };
}

export interface AnalysisResult {
  plan: PlanContent;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  injectionFindings: Array<{ pattern: string; excerpt: string }>;
  includedFiles: string[];
}

export class AnalysisEngine {
  constructor(
    private readonly manager: ProviderManager,
    private readonly store: Store,
    private readonly env: { COMMAND_ALLOWLIST?: string } = {},
  ) {}

  /** Step 2/3 of the workflow: read the repo, then ask the model for a plan. */
  async analyze(request: RequestRow, snapshot: RepoSnapshot, memory: string[] = []): Promise<AnalysisResult> {
    const stack = detectStack(snapshot.tree, snapshot.files);
    const context = buildContext(snapshot, request.raw_text);
    const injectionFindings = scanForInjection(`${request.raw_text}\n${Object.values(snapshot.files).join('\n').slice(0, 20_000)}`);

    const completion = await this.manager.complete({
      messages: buildAnalysisMessages({
        context: context.text,
        requestText: request.raw_text,
        memory,
        testCommand: stack.testCommand,
      }),
      jsonMode: true,
      temperature: 0.2,
      maxOutputTokens: 3000,
      timeoutMs: 45_000,
    });

    let plan: PlanContent;
    try {
      plan = coercePlan(extractJsonObject(completion.text), parseAllowlist(this.env.COMMAND_ALLOWLIST));
    } catch (error) {
      // Never claim success when the model output is unusable.
      logger.warn('analysis.unparsable_plan', { requestId: request.id, error: (error as Error).message });
      throw new Error(`خروجی مدل قابل تحلیل نبود: ${(error as Error).message}`);
    }
    if (injectionFindings.length) {
      plan.risks = [...plan.risks, `احتمال تلاش برای دستورکاری در محتوای مخزن تشخیص داده شد: ${injectionFindings.map((f) => f.pattern).join(', ')}`];
    }

    return {
      plan,
      provider: completion.provider,
      model: completion.model,
      inputTokens: completion.inputTokens,
      outputTokens: completion.outputTokens,
      injectionFindings,
      includedFiles: context.includedFiles,
    };
  }

  /** Step 5: generate real code changes for the approved plan. */
  async writeCode(input: {
    requestText: string;
    plan: PlanContent;
    files: Record<string, string>;
  }): Promise<{ changes: FileChange[]; tests: string[]; notes: string }> {
    const completion = await this.manager.complete({
      messages: buildCodeMessages({
        requestText: input.requestText,
        planSummary: JSON.stringify(input.plan).slice(0, 6000),
        changeScope: input.plan.files,
        files: input.files,
      }),
      jsonMode: true,
      temperature: 0.1,
      maxOutputTokens: 8000,
      timeoutMs: 60_000,
    });

    const parsed = extractJsonObject(completion.text) as { files?: Array<{ path?: string; action?: string; content?: string }>; tests?: string[]; notes?: string };
    const changes: FileChange[] = (parsed.files ?? [])
      .map((entry) => {
        try {
          const path = validateRepoPath(String(entry.path ?? ''));
          const action = entry.action === 'delete' ? 'delete' : entry.action === 'create' ? 'create' : 'update';
          return { path, action, content: typeof entry.content === 'string' ? entry.content : undefined } as FileChange;
        } catch {
          return null;
        }
      })
      .filter((change): change is FileChange => Boolean(change))
      .filter((change) => input.plan.files.includes(change.path) || change.action === 'create');

    if (!changes.length) throw new Error('مدل هیچ تغییر معتبری تولید نکرد');
    return { changes, tests: asStringArray(parsed.tests), notes: String(parsed.notes ?? '') };
  }
}
