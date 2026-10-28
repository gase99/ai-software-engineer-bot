import { SCHEMA_SQL } from './schema.js';
import type { Sql } from './sql.js';
import type {
  ApprovalRow,
  FileChange,
  JobKind,
  JobRow,
  JobStatus,
  PlanContent,
  PlanRow,
  Project,
  ProviderRow,
  RequestRow,
  RequestStatus,
} from '../types.js';
import { randomId } from '../util/crypto.js';

export interface NewJob {
  requestId?: string | null;
  kind: JobKind;
  payload: unknown;
  maxAttempts?: number;
  runAfter?: string | null;
}

export class Store {
  constructor(public readonly sql: Sql) {}

  /**
   * Create the schema if it is missing. Running the full DDL on every webhook
   * would burn D1's free row-write budget for nothing, so it is a cheap probe
   * first.
   */
  async init(): Promise<void> {
    const existing = await this.sql.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projects'",
    );
    if (existing) return;
    await this.sql.exec(SCHEMA_SQL);
  }

  now(): string {
    return new Date().toISOString();
  }

  // ----------------------------------------------------------------- projects
  async createProject(input: { name: string; owner: string; repo: string; branch?: string }): Promise<Project> {
    const id = randomId('prj');
    const now = this.now();
    await this.sql.run(
      'INSERT INTO projects (id, name, repo_owner, repo_name, default_branch, created_at, updated_at) VALUES (?,?,?,?,?,?,?) ' +
        'ON CONFLICT(repo_owner, repo_name) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at',
      [id, input.name, input.owner, input.repo, input.branch ?? 'main', now, now],
    );
    const project = await this.getProjectByRepo(input.owner, input.repo);
    return project as Project;
  }

  async getProject(id: string): Promise<Project | null> {
    return this.sql.get<Project>('SELECT * FROM projects WHERE id = ?', [id]);
  }

  async getProjectByRepo(owner: string, repo: string): Promise<Project | null> {
    return this.sql.get<Project>('SELECT * FROM projects WHERE repo_owner = ? AND repo_name = ?', [owner, repo]);
  }

  async listProjects(): Promise<Project[]> {
    return this.sql.all<Project>('SELECT * FROM projects ORDER BY updated_at DESC');
  }

  async updateProjectMeta(id: string, meta: Partial<Pick<Project, 'language' | 'framework' | 'architecture' | 'description' | 'default_branch'>>): Promise<void> {
    const fields = Object.entries(meta).filter(([, v]) => v !== undefined);
    if (!fields.length) return;
    const setClause = fields.map(([key]) => `${key} = ?`).join(', ');
    await this.sql.run(`UPDATE projects SET ${setClause}, updated_at = ? WHERE id = ?`, [
      ...fields.map(([, v]) => v),
      this.now(),
      id,
    ]);
  }

  // ----------------------------------------------------------------- requests
  async createRequest(projectId: string, chatId: string | number, rawText: string, messageId?: number): Promise<RequestRow> {
    const id = randomId('req');
    const now = this.now();
    await this.sql.run(
      'INSERT INTO requests (id, project_id, telegram_chat_id, telegram_message_id, raw_text, status, current_plan_version, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [id, projectId, String(chatId), messageId ?? null, rawText, 'draft', 0, now, now],
    );
    return (await this.getRequest(id)) as RequestRow;
  }

  async getRequest(id: string): Promise<RequestRow | null> {
    return this.sql.get<RequestRow>('SELECT * FROM requests WHERE id = ?', [id]);
  }

  async setRequestStatus(id: string, status: RequestStatus): Promise<void> {
    await this.sql.run('UPDATE requests SET status = ?, updated_at = ? WHERE id = ?', [status, this.now(), id]);
  }

  async setCurrentPlanVersion(id: string, version: number): Promise<void> {
    await this.sql.run('UPDATE requests SET current_plan_version = ?, updated_at = ? WHERE id = ?', [version, this.now(), id]);
  }

  async latestRequestForProject(projectId: string): Promise<RequestRow | null> {
    return this.sql.get<RequestRow>('SELECT * FROM requests WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1', [projectId]);
  }

  // -------------------------------------------------------------------- plans
  async savePlan(input: {
    requestId: string;
    version: number;
    plan: PlanContent;
    reportFa: string;
    provider?: string | null;
    model?: string | null;
    inputTokens?: number;
    outputTokens?: number;
  }): Promise<PlanRow> {
    const id = randomId('pln');
    await this.sql.run(
      'INSERT INTO plans (id, request_id, version, plan_json, report_fa, provider, model, input_tokens, output_tokens, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [
        id,
        input.requestId,
        input.version,
        JSON.stringify(input.plan),
        input.reportFa,
        input.provider ?? null,
        input.model ?? null,
        input.inputTokens ?? 0,
        input.outputTokens ?? 0,
        this.now(),
      ],
    );
    await this.setCurrentPlanVersion(input.requestId, input.version);
    return (await this.sql.get<PlanRow>('SELECT * FROM plans WHERE id = ?', [id])) as PlanRow;
  }

  async getPlan(requestId: string, version: number): Promise<PlanRow | null> {
    return this.sql.get<PlanRow>('SELECT * FROM plans WHERE request_id = ? AND version = ?', [requestId, version]);
  }

  async latestPlan(requestId: string): Promise<PlanRow | null> {
    return this.sql.get<PlanRow>('SELECT * FROM plans WHERE request_id = ? ORDER BY version DESC LIMIT 1', [requestId]);
  }

  static parsePlan(row: PlanRow): PlanContent {
    return JSON.parse(row.plan_json) as PlanContent;
  }

  // ------------------------------------------------------------ approvals
  async createApproval(requestId: string, planVersion: number, tokenHash: string, expiresAt: string): Promise<string> {
    const id = randomId('apr');
    await this.sql.run(
      'INSERT INTO approvals (id, request_id, plan_version, status, token_hash, expires_at) VALUES (?,?,?,?,?,?)',
      [id, requestId, planVersion, 'pending', tokenHash, expiresAt],
    );
    return id;
  }

  async getApproval(requestId: string, planVersion: number): Promise<ApprovalRow | null> {
    return this.sql.get<ApprovalRow>(
      'SELECT * FROM approvals WHERE request_id = ? AND plan_version = ? ORDER BY id DESC LIMIT 1',
      [requestId, planVersion],
    );
  }

  async decideApproval(id: string, status: 'approved' | 'rejected' | 'expired', actor: string): Promise<void> {
    await this.sql.run('UPDATE approvals SET status = ?, decided_at = ?, actor = ? WHERE id = ?', [
      status,
      this.now(),
      actor,
      id,
    ]);
  }

  // ----------------------------------------------------------------- jobs
  async enqueue(job: NewJob): Promise<JobRow> {
    const id = randomId('job');
    const now = this.now();
    await this.sql.run(
      'INSERT INTO jobs (id, request_id, kind, status, payload_json, attempts, max_attempts, run_after, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [
        id,
        job.requestId ?? null,
        job.kind,
        'queued',
        JSON.stringify(job.payload ?? {}),
        0,
        job.maxAttempts ?? 3,
        job.runAfter ?? null,
        now,
        now,
      ],
    );
    return (await this.sql.get<JobRow>('SELECT * FROM jobs WHERE id = ?', [id])) as JobRow;
  }

  async claimNextJob(leaseMs = 60_000): Promise<JobRow | null> {
    const now = Date.now();
    const candidates = await this.sql.all<JobRow>(
      "SELECT * FROM jobs WHERE status IN ('queued','failed') AND (run_after IS NULL OR run_after <= ?) ORDER BY created_at LIMIT 5",
      [new Date(now).toISOString()],
    );
    for (const candidate of candidates) {
      if (candidate.attempts >= candidate.max_attempts) {
        await this.setJobStatus(candidate.id, 'dead', 'max attempts reached');
        continue;
      }
      const leaseUntil = new Date(now + leaseMs).toISOString();
      const result = await this.sql.run(
        "UPDATE jobs SET status = 'running', attempts = attempts + 1, lease_until = ?, updated_at = ? WHERE id = ? AND status IN ('queued','failed')",
        [leaseUntil, new Date().toISOString(), candidate.id],
      );
      if (result.changes > 0) return (await this.sql.get<JobRow>('SELECT * FROM jobs WHERE id = ?', [candidate.id])) as JobRow;
    }
    return null;
  }

  async getJob(id: string): Promise<JobRow | null> {
    return this.sql.get<JobRow>('SELECT * FROM jobs WHERE id = ?', [id]);
  }

  async setJobStatus(id: string, status: JobStatus, error?: string): Promise<void> {
    await this.sql.run('UPDATE jobs SET status = ?, last_error = ?, updated_at = ? WHERE id = ?', [
      status,
      error ?? null,
      this.now(),
      id,
    ]);
  }

  async completeJob(id: string, result: unknown): Promise<void> {
    await this.sql.run("UPDATE jobs SET status = 'succeeded', result_json = ?, updated_at = ? WHERE id = ?", [
      JSON.stringify(result ?? null),
      this.now(),
      id,
    ]);
  }

  async failJob(id: string, error: string, retryDelayMs = 60_000): Promise<void> {
    const job = await this.getJob(id);
    if (!job) return;
    const nextStatus: JobStatus = job.attempts >= job.max_attempts ? 'dead' : 'failed';
    await this.sql.run('UPDATE jobs SET status = ?, last_error = ?, run_after = ?, updated_at = ? WHERE id = ?', [
      nextStatus,
      error,
      new Date(Date.now() + retryDelayMs).toISOString(),
      this.now(),
      id,
    ]);
  }

  async requeueStaleJobs(leaseMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - leaseMs).toISOString();
    const result = await this.sql.run("UPDATE jobs SET status = 'queued' WHERE status = 'running' AND lease_until IS NOT NULL AND lease_until < ?", [cutoff]);
    return result.changes;
  }

  async addJobLog(jobId: string, level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: unknown): Promise<void> {
    await this.sql.run('INSERT INTO job_logs (job_id, level, message, meta_json, created_at) VALUES (?,?,?,?,?)', [
      jobId,
      level,
      message,
      meta ? JSON.stringify(meta) : null,
      this.now(),
    ]);
  }

  async getJobLogs(jobId: string): Promise<Array<{ level: string; message: string; created_at: string; meta_json: string | null }>> {
    return this.sql.all('SELECT level, message, created_at, meta_json FROM job_logs WHERE job_id = ? ORDER BY id', [jobId]);
  }

  async listJobs(status?: JobStatus, limit = 10): Promise<JobRow[]> {
    if (status) return this.sql.all<JobRow>('SELECT * FROM jobs WHERE status = ? ORDER BY updated_at DESC LIMIT ?', [status, limit]);
    return this.sql.all<JobRow>('SELECT * FROM jobs ORDER BY updated_at DESC LIMIT ?', [limit]);
  }

  // ------------------------------------------------------------- providers
  async upsertProvider(provider: Omit<ProviderRow, 'last_check_status' | 'last_check_at' | 'last_error'>): Promise<void> {
    await this.sql.run(
      `INSERT INTO providers (name, display_name, base_url, model, active, free_tier, priority, daily_limit, monthly_limit, timeout_ms, max_retries, capabilities_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(name) DO UPDATE SET
         display_name = excluded.display_name,
         base_url = excluded.base_url,
         model = excluded.model,
         priority = excluded.priority,
         free_tier = excluded.free_tier,
         daily_limit = excluded.daily_limit,
         monthly_limit = excluded.monthly_limit,
         capabilities_json = excluded.capabilities_json`,
      [
        provider.name,
        provider.display_name,
        provider.base_url,
        provider.model,
        provider.active,
        provider.free_tier,
        provider.priority,
        provider.daily_limit,
        provider.monthly_limit,
        provider.timeout_ms,
        provider.max_retries,
        provider.capabilities_json,
      ],
    );
  }

  async listProviders(): Promise<ProviderRow[]> {
    return this.sql.all<ProviderRow>('SELECT * FROM providers ORDER BY priority ASC, name ASC');
  }

  async getProvider(name: string): Promise<ProviderRow | null> {
    return this.sql.get<ProviderRow>('SELECT * FROM providers WHERE name = ?', [name]);
  }

  async setProviderModel(name: string, model: string): Promise<void> {
    await this.sql.run('UPDATE providers SET model = ? WHERE name = ?', [model, name]);
  }

  async setProviderActive(name: string, active: boolean): Promise<void> {
    await this.sql.run('UPDATE providers SET active = ? WHERE name = ?', [active ? 1 : 0, name]);
  }

  async updateProviderHealth(name: string, status: string, error?: string): Promise<void> {
    await this.sql.run('UPDATE providers SET last_check_status = ?, last_check_at = ?, last_error = ? WHERE name = ?', [
      status,
      this.now(),
      error ?? null,
      name,
    ]);
  }

  // ----------------------------------------------------------------- usage
  async recordUsage(provider: string, inputTokens: number, outputTokens: number, estimatedCostUsd = 0): Promise<void> {
    const day = new Date().toISOString().slice(0, 10);
    const month = day.slice(0, 7);
    await this.sql.run(
      `INSERT INTO api_usage (provider, day, month, input_tokens, output_tokens, requests, estimated_cost_usd)
       VALUES (?,?,?,?,?,1,?)
       ON CONFLICT(provider, day) DO UPDATE SET
         input_tokens = input_tokens + excluded.input_tokens,
         output_tokens = output_tokens + excluded.output_tokens,
         requests = requests + 1,
         estimated_cost_usd = estimated_cost_usd + excluded.estimated_cost_usd`,
      [provider, day, month, inputTokens, outputTokens, estimatedCostUsd],
    );
    await this.sql.run(
      'INSERT INTO models_used (provider, model, input_tokens, output_tokens, created_at) VALUES (?,?,?,?,?)',
      [provider, '', inputTokens, outputTokens, this.now()],
    );
  }

  async usageForDay(provider: string, day = new Date().toISOString().slice(0, 10)): Promise<number> {
    const row = await this.sql.get<{ total: number | null }>(
      'SELECT input_tokens + output_tokens AS total FROM api_usage WHERE provider = ? AND day = ?',
      [provider, day],
    );
    return row?.total ?? 0;
  }

  async usageForMonth(provider: string, month = new Date().toISOString().slice(0, 7)): Promise<number> {
    const row = await this.sql.get<{ total: number | null }>(
      'SELECT SUM(input_tokens + output_tokens) AS total FROM api_usage WHERE provider = ? AND month = ?',
      [provider, month],
    );
    return row?.total ?? 0;
  }

  async totalUsageToday(): Promise<number> {
    const row = await this.sql.get<{ total: number | null }>(
      'SELECT SUM(input_tokens + output_tokens) AS total FROM api_usage WHERE day = ?',
      [new Date().toISOString().slice(0, 10)],
    );
    return row?.total ?? 0;
  }

  // --------------------------------------------------------- github repos
  async addRepo(input: { owner: string; name: string; branch?: string; private?: boolean; installationId?: number }): Promise<void> {
    await this.sql.run(
      'INSERT INTO github_repos (owner, name, full_name, default_branch, private, installation_id, added_at) VALUES (?,?,?,?,?,?,?) ' +
        'ON CONFLICT(full_name) DO UPDATE SET default_branch = excluded.default_branch, installation_id = excluded.installation_id',
      [
        input.owner,
        input.name,
        `${input.owner}/${input.name}`,
        input.branch ?? 'main',
        input.private ? 1 : 0,
        input.installationId ?? null,
        this.now(),
      ],
    );
  }

  async listRepos(): Promise<Array<{ owner: string; name: string; full_name: string; default_branch: string; private: number; installation_id: number | null }>> {
    return this.sql.all('SELECT owner, name, full_name, default_branch, private, installation_id FROM github_repos ORDER BY full_name');
  }

  // ------------------------------------------------------- actions minutes
  async addActionsMinutes(minutes: number): Promise<void> {
    const month = new Date().toISOString().slice(0, 7);
    await this.sql.run(
      `INSERT INTO github_actions_usage (month, minutes, updated_at) VALUES (?,?,?)
       ON CONFLICT(month) DO UPDATE SET minutes = minutes + excluded.minutes, updated_at = excluded.updated_at`,
      [month, minutes, this.now()],
    );
  }

  async actionsMinutesThisMonth(): Promise<number> {
    const row = await this.sql.get<{ minutes: number | null }>(
      'SELECT minutes FROM github_actions_usage WHERE month = ?',
      [new Date().toISOString().slice(0, 7)],
    );
    return row?.minutes ?? 0;
  }

  // ---------------------------------------------------------------- memory
  async addMemory(projectId: string, kind: 'decision' | 'constraint' | 'fact' | 'test_result', content: string, source?: string): Promise<void> {
    await this.sql.run('INSERT INTO project_memory (project_id, kind, content, source, created_at) VALUES (?,?,?,?,?)', [
      projectId,
      kind,
      content,
      source ?? null,
      this.now(),
    ]);
  }

  async listMemory(projectId: string, kind?: string): Promise<Array<{ kind: string; content: string; created_at: string }>> {
    if (kind) return this.sql.all('SELECT kind, content, created_at FROM project_memory WHERE project_id = ? AND kind = ? ORDER BY id DESC LIMIT 50', [projectId, kind]);
    return this.sql.all('SELECT kind, content, created_at FROM project_memory WHERE project_id = ? ORDER BY id DESC LIMIT 50', [projectId]);
  }

  // ----------------------------------------------------------------- audit
  async audit(actor: string, action: string, target?: string, meta?: unknown): Promise<void> {
    await this.sql.run('INSERT INTO audit_log (actor, action, target, meta_json, created_at) VALUES (?,?,?,?,?)', [
      actor,
      action,
      target ?? null,
      meta ? JSON.stringify(meta) : null,
      this.now(),
    ]);
  }

  async recentAudit(limit = 20): Promise<Array<{ actor: string; action: string; target: string | null; created_at: string }>> {
    return this.sql.all('SELECT actor, action, target, created_at FROM audit_log ORDER BY id DESC LIMIT ?', [limit]);
  }

  // -------------------------------------------------------------- settings
  async getSetting(key: string): Promise<string | null> {
    const row = await this.sql.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]);
    return row?.value ?? null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await this.sql.run(
      'INSERT INTO settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      [key, value, this.now()],
    );
  }

  async getActiveProjectId(): Promise<string | null> {
    return this.getSetting('active_project_id');
  }
}

export function summarizeFileChanges(changes: FileChange[]): string {
  return changes.map((c) => `${c.action}:${c.path}`).join(', ');
}
