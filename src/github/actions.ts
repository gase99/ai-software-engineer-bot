import type { GithubClient, WorkflowRun } from './client.js';
import type { Store } from '../db/store.js';
import { buildCommandScript, parseAllowlist } from './commands.js';
import { recordRunMinutes } from './quota.js';
import { GithubError } from './client.js';

export interface DispatchInput {
  owner: string;
  repo: string;
  branch: string;
  jobId: string;
  requestId: string;
  commands: string[];
  workflowFile?: string;
}

export interface DispatchResult {
  runId: number | null;
  url: string | null;
  usedFallback: boolean;
  rejectedCommands: string[];
  note?: string;
}

export interface RunOutcome {
  status: string;
  conclusion: string | null;
  url: string;
  jobs: Array<{ name: string; conclusion: string | null; failedStep?: string }>;
  minutes: number;
  finished: boolean;
}

/**
 * Execution dispatcher (Mode A): the Worker never runs user code. It asks
 * GitHub Actions to run a whitelisted test/build workflow and then reads the
 * result back through the API (the workflow also posts a signed callback).
 */
export class ActionsDispatcher {
  constructor(
    private readonly client: GithubClient,
    private readonly store: Store,
    private readonly env: { COMMAND_ALLOWLIST?: string } = {},
  ) {}

  allowlist(): string[] {
    return parseAllowlist(this.env.COMMAND_ALLOWLIST);
  }

  async dispatch(input: DispatchInput): Promise<DispatchResult> {
    const { script, rejected } = buildCommandScript(input.commands, this.allowlist());
    const workflowFile = input.workflowFile ?? 'ai-exec.yml';
    try {
      await this.client.dispatchWorkflow({
        owner: input.owner,
        repo: input.repo,
        workflow: workflowFile,
        ref: input.branch,
        inputs: {
          job_id: input.jobId,
          request_id: input.requestId,
          commands: script,
        },
      });
      const run = await this.waitForRun(input.owner, input.repo, input.branch, input.jobId);
      return { runId: run?.id ?? null, url: run?.html_url ?? null, usedFallback: false, rejectedCommands: rejected };
    } catch (error) {
      const err = error as GithubError;
      // A repository without the ai-exec workflow is common: report it clearly
      // instead of pretending tests ran.
      return {
        runId: null,
        url: null,
        usedFallback: true,
        rejectedCommands: rejected,
        note: err.message,
      };
    }
  }

  /** Find the run created for our dispatch by matching the job_id in the title. */
  private async waitForRun(owner: string, repo: string, branch: string, jobId: string, attempts = 3): Promise<WorkflowRun | null> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const runs = await this.client.listWorkflowRuns(owner, repo, branch, 10);
      const match = runs.find((run) => run.head_branch === branch);
      if (match) return match;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    return null;
  }

  async outcome(owner: string, repo: string, runId: number): Promise<RunOutcome> {
    const run = await this.client.getWorkflowRun(owner, repo, runId);
    const jobs = await this.client.getRunJobs(owner, repo, runId);
    const finished = run.status === 'completed';
    const minutes = finished ? await recordRunMinutes(this.store, run.run_started_at, run.updated_at) : 0;
    return {
      status: run.status,
      conclusion: run.conclusion,
      url: run.html_url,
      jobs: (jobs ?? []).map((job) => ({
        name: job.name,
        conclusion: job.conclusion,
        failedStep: (job.steps ?? []).find((step) => step.conclusion === 'failure')?.name,
      })),
      minutes,
      finished,
    };
  }

  async recentMinutes(owner: string, repo: string, branch: string): Promise<number[]> {
    const runs = await this.client.listWorkflowRuns(owner, repo, branch, 5);
    return runs
      .filter((run) => run.status === 'completed' && run.run_started_at && run.updated_at)
      .map((run) => {
        const seconds = (new Date(run.updated_at as string).getTime() - new Date(run.run_started_at as string).getTime()) / 1000;
        return Math.max(1, Math.ceil(seconds / 60));
      });
  }
}
