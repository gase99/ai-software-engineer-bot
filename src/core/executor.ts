import type { GithubClient } from '../github/client.js';
import type { ActionsDispatcher, RunOutcome } from '../github/actions.js';
import type { AnalysisEngine } from './analyzer.js';
import type { ApprovalService } from './approval.js';
import type { Store } from '../db/store.js';
import type { FileChange, PlanContent, Project, RequestRow } from '../types.js';
import { Store as StoreClass } from '../db/store.js';
import { detectStack } from './context.js';
import { validateRepoPath } from './patch.js';
import { isCommandAllowed, parseAllowlist } from '../github/commands.js';
import { checkActionsQuota, estimateRunMinutes } from '../github/quota.js';
import { redact } from '../security/redact.js';
import { logger } from '../util/log.js';

export interface ExecutionResult {
  branch: string;
  commits: string[];
  changedFiles: string[];
  pullRequest?: { number: number; url: string };
  tests: {
    dispatched: boolean;
    runId?: number | null;
    url?: string | null;
    outcome?: RunOutcome;
    note?: string;
    rejectedCommands: string[];
  };
  quotaBlocked?: boolean;
}

export interface ExecutionContext {
  request: RequestRow;
  project: Project;
  plan: PlanContent;
  planVersion: number;
}

const MAX_FILE_BYTES = 400_000;

/**
 * Real execution: branch → commit → PR → tests in GitHub Actions.
 * Nothing here touches the default branch, and nothing here merges.
 */
export class ExecutionEngine {
  constructor(
    private readonly store: StoreClass,
    private readonly github: GithubClient,
    private readonly dispatcher: ActionsDispatcher,
    private readonly analysis: AnalysisEngine,
    private readonly approvals: ApprovalService,
    private readonly env: { COMMAND_ALLOWLIST?: string; ACTIONS_MONTHLY_MINUTE_LIMIT?: string } = {},
  ) {}

  private async requireApproval(context: ExecutionContext, actor: string): Promise<void> {
    const approval = await this.store.getApproval(context.request.id, context.planVersion);
    if (!approval || approval.status !== 'approved') {
      throw new Error('این درخواست تأیید معتبر ندارد؛ بدون تأیید هیچ تغییری اعمال نمی‌شود');
    }
    await this.store.audit(actor, 'execution.start', context.request.id, {
      planVersion: context.planVersion,
      files: context.plan.files,
    });
  }

  private branchName(request: RequestRow, project: Project): string {
    const slug = request.raw_text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 30);
    return `ai/${request.id.slice(4, 12)}-${slug || 'change'}`.slice(0, 120);
  }

  async execute(context: ExecutionContext, actor = 'owner'): Promise<ExecutionResult> {
    await this.requireApproval(context, actor);
    const { project, plan, request } = context;
    const owner = project.repo_owner;
    const repo = project.repo_name;
    const baseBranch = project.default_branch;

    // 1. Git state check -----------------------------------------------------
    if (!(await this.github.branchExists(owner, repo, baseBranch))) {
      throw new Error(`شاخه اصلی ${baseBranch} در مخزن پیدا نشد`);
    }
    const branch = this.branchName(request, project);
    const branchAlreadyExists = await this.github.branchExists(owner, repo, branch);
    if (!branchAlreadyExists) {
      await this.github.createBranch(owner, repo, branch, baseBranch);
      await this.store.addJobLog(request.id, 'info', `شاخه کاری ${branch} ساخته شد`, { base: baseBranch });
    }

    // 2. Produce the actual file changes -------------------------------------
    let changes: FileChange[] = plan.fileChanges ?? [];
    if (!changes.length) {
      const files: Record<string, string> = {};
      for (const path of plan.files.slice(0, 10)) {
        try {
          const validated = validateRepoPath(path);
          const file = await this.github.getFile(owner, repo, validated, branch);
          files[validated] = file.content;
        } catch {
          files[path] = '';
        }
      }
      const generated = await this.analysis.writeCode({ requestText: request.raw_text, plan, files });
      changes = generated.changes;
      if (generated.tests.length) plan.tests = [...new Set([...plan.tests, ...generated.tests])];
    }

    // 3. Commit --------------------------------------------------------------
    const commits: string[] = [];
    const changedFiles: string[] = [];
    for (const change of changes) {
      const path = validateRepoPath(change.path);
      if (change.content && Buffer.byteLength(change.content, 'utf8') > MAX_FILE_BYTES) {
        throw new Error(`فایل ${path} بیش از حد بزرگ است`);
      }
      if (change.action === 'delete') {
        const existing = await this.github.getFile(owner, repo, path, branch);
        await this.github.deleteFile({ owner, repo, path, message: `chore(ai): remove ${path}`, branch, sha: existing.sha });
        changedFiles.push(path);
        continue;
      }
      if (!change.content) continue;
      let sha: string | undefined;
      try {
        const existing = await this.github.getFile(owner, repo, path, branch);
        sha = existing.sha;
      } catch {
        sha = undefined;
      }
      const commit = await this.github.putFile({
        owner,
        repo,
        path,
        content: change.content,
        branch,
        sha,
        message: `feat(ai): ${path}\n\nrequest: ${request.id}\nplan-version: ${context.planVersion}`,
      });
      commits.push(commit.commit.sha);
      changedFiles.push(path);
    }

    // 4. Pull request --------------------------------------------------------
    const prBody = [
      '## درخواست مالک',
      request.raw_text,
      '',
      '## نتیجه مورد انتظار',
      plan.outcome,
      '',
      '## فایل‌های تغییر‌یافته',
      changedFiles.map((file) => `- ${file}`).join('\n') || '- (بدون تغییر)',
      '',
      '## تست‌های لازم',
      plan.tests.map((test) => `- ${test}`).join('\n') || '- (تعریف نشده)',
      '',
      '## ریسک‌ها',
      plan.risks.map((risk) => `- ${risk}`).join('\n') || '-',
      '',
      `شناسه درخواست: ${request.id} · نسخه طرح: ${context.planVersion}`,
      '',
      '> این PR توسط ربات و پس از تأیید صریح مالک ایجاد شده است. ادغام نیازمند تأیید جداگانه است.',
    ].join('\n');

    const pullRequest = await this.github.createPullRequest({
      owner,
      repo,
      title: `feat(ai): ${plan.outcome.slice(0, 70)}`,
      body: prBody,
      head: branch,
      base: baseBranch,
    });

    // 5. Tests in GitHub Actions ---------------------------------------------
    const allowlist = parseAllowlist(this.env.COMMAND_ALLOWLIST);
    const stack = detectStack([], {});
    const commandCandidates = plan.commands.length ? plan.commands : [stack.testCommand];
    const commands = commandCandidates.map((command) => isCommandAllowed(command, allowlist)).filter((check) => check.allowed).map((check) => check.command);
    const rejectedCommands = commandCandidates
      .map((command) => isCommandAllowed(command, allowlist))
      .filter((check) => !check.allowed)
      .map((check) => `${check.command} (${check.reason ?? 'نامجاز'})`);

    const quota = await checkActionsQuota(this.store, Number(this.env.ACTIONS_MONTHLY_MINUTE_LIMIT ?? 2000));
    const tests: ExecutionResult['tests'] = { dispatched: false, rejectedCommands };

    if (quota.level === 'blocked') {
      tests.note = `سقف ${quota.limitMinutes} دقیقه Actions این ماه پر شده (${Math.round(quota.usedMinutes)} دقیقه مصرف شده). اجرای تست در صف منتظر ماه بعد یا افزایش سقف است.`;
      await this.store.audit(actor, 'actions.quota_blocked', String(pullRequest.number), quota);
    } else if (commands.length) {
      const job = await this.store.enqueue({ requestId: request.id, kind: 'tests', payload: { owner, repo, branch, commands } });
      const previousMinutes = await this.dispatcher.recentMinutes(owner, repo, branch).catch(() => [] as number[]);
      const estimate = estimateRunMinutes(previousMinutes);
      if (quota.remainingMinutes < estimate) {
        tests.note = `دقیقه باقیمانده Actions (${quota.remainingMinutes}) کمتر از برآورد این اجرا (${estimate}) است؛ قبل از اجرا به شما اطلاع داده می‌شود.`;
      }
      const dispatch = await this.dispatcher.dispatch({ owner, repo, branch, jobId: job.id, requestId: request.id, commands });
      tests.dispatched = Boolean(dispatch.runId);
      tests.runId = dispatch.runId;
      tests.url = dispatch.url;
      if (dispatch.rejectedCommands.length) tests.rejectedCommands.push(...dispatch.rejectedCommands);
      if (dispatch.runId) {
        tests.outcome = await this.dispatcher.outcome(owner, repo, dispatch.runId);
      } else {
        // Be explicit: an unrun test suite is never reported as a success.
        tests.note = dispatch.note
          ? `تستی اجرا نشد (اجرای GitHub Actions ناموفق بود: ${dispatch.note})`
          : 'تستی اجرا نشد (workflow اجرای تست در مخزن پیدا نشد)';
      }
      await this.store.setJobStatus(job.id, tests.outcome?.conclusion === 'success' ? 'succeeded' : 'failed', tests.outcome?.conclusion ?? tests.note);
      await this.store.addJobLog(job.id, 'info', 'نتیجه اجرای تست', { conclusion: tests.outcome?.conclusion ?? null, minutes: tests.outcome?.minutes ?? 0 });
    } else {
      tests.note = 'هیچ دستور تستی در لیست مجاز برای این پروژه تعریف نشده است';
    }

    await this.store.addMemory(project.id, 'decision', `تغییرات ${changedFiles.join(', ')} روی شاخه ${branch} و PR #${pullRequest.number}`, request.id);
    await this.store.audit(actor, 'pr.created', String(pullRequest.number), { branch, commits: commits.length, files: changedFiles });
    logger.info('execution.completed', { requestId: request.id, branch, pr: pullRequest.number, files: changedFiles.length });

    return {
      branch,
      commits,
      changedFiles,
      pullRequest: { number: pullRequest.number, url: pullRequest.html_url },
      tests: { ...tests, note: tests.note ? redact(tests.note) : undefined },
      quotaBlocked: quota.level === 'blocked',
    };
  }
}
