import { base64Decode, base64Encode, utf8 } from '../util/crypto.js';
import { redact, registerSecret } from '../security/redact.js';

export interface GithubRepo {
  full_name: string;
  default_branch: string;
  private: boolean;
  language: string | null;
  description: string | null;
  permissions?: Record<string, boolean>;
}

export interface TreeEntry {
  path: string;
  type: 'blob' | 'tree';
  size?: number;
  sha: string;
}

export interface FileContent {
  path: string;
  content: string;
  sha: string;
  size: number;
}

export interface PullRequest {
  number: number;
  html_url: string;
  state: string;
  title: string;
}

export interface WorkflowRun {
  id: number;
  status: string;
  conclusion: string | null;
  html_url: string;
  run_started_at?: string;
  updated_at?: string;
  head_branch?: string;
  display_title?: string;
  event?: string;
}

export class GithubError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly endpoint?: string,
  ) {
    super(redact(message));
    this.name = 'GithubError';
  }
}

/**
 * Minimal GitHub REST client. Works with either a GitHub App installation
 * token (recommended, short lived, repo-scoped) or a fine-grained PAT.
 */
export class GithubClient {
  constructor(
    private token: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {
    registerSecret(token);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.fetchImpl(`https://api.github.com${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'ai-software-engineer-bot',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (response.status === 204) return undefined as T;
    const payload = (await response.json().catch(() => ({}))) as T & { message?: string; documentation_url?: string };
    if (!response.ok) {
      throw new GithubError(`github ${method} ${path} failed (${response.status}): ${payload.message ?? 'unknown'}`, response.status, path);
    }
    return payload;
  }

  async getRepo(owner: string, repo: string): Promise<GithubRepo> {
    return this.request<GithubRepo>('GET', `/repos/${owner}/${repo}`);
  }

  /** The account the current credential acts as (PAT user or App bot). */
  async getAuthenticatedUser(): Promise<{ login: string }> {
    return this.request<{ login: string }>('GET', '/user');
  }

  /**
   * Create a repository for the authenticated account.
   *
   * A GitHub App installation token cannot create repositories at all - GitHub
   * answers 403 and the tool layer turns that into a plain-language refusal.
   */
  async createRepo(input: { name: string; private?: boolean; description?: string; autoInit?: boolean }): Promise<GithubRepo & { html_url: string }> {
    return this.request<GithubRepo & { html_url: string }>('POST', '/user/repos', {
      name: input.name,
      private: input.private ?? true,
      description: input.description,
      auto_init: input.autoInit ?? true,
    });
  }

  /**
   * Repositories this credential can see. Installation tokens cannot call
   * `/user/repos`, so the installation endpoint is tried first and the user
   * endpoint is the PAT fallback.
   */
  async listAccessibleRepos(limit = 30): Promise<GithubRepo[]> {
    try {
      const data = await this.request<{ repositories: GithubRepo[] }>('GET', `/installation/repositories?per_page=${limit}`);
      if (Array.isArray(data?.repositories)) return data.repositories;
    } catch {
      // Not an installation token (or no installation scope): fall through.
    }
    const repos = await this.request<GithubRepo[]>('GET', `/user/repos?per_page=${limit}&sort=updated&affiliation=owner,collaborator,organization_member`);
    return Array.isArray(repos) ? repos : [];
  }

  /** GitHub answers 403/404 for "no access" and 422 for "already exists". */
  static describeError(error: unknown): string {
    if (error instanceof GithubError) {
      if (error.status === 401) return 'توکن گیت‌هاب معتبر نیست یا منقضی شده است.';
      if (error.status === 403) return 'دسترسی لازم برای این عملیات در گیت‌هاب وجود ندارد (توکن یا App این اجازه را ندارد).';
      if (error.status === 404) return 'مخزن یا فایل پیدا نشد، یا این توکن به آن دسترسی ندارد.';
      if (error.status === 422) return 'گیت‌هاب این درخواست را نپذیرفت (مثلاً نام تکراری است یا شاخه وجود ندارد).';
      if (error.status === 409) return 'این مخزن خالی است یا وضعیت آن با درخواست هم‌خوان نیست.';
      return `گیت‌هاب خطا داد (${error.status ?? 'نامشخص'}): ${error.message}`;
    }
    return (error as Error).message;
  }

  async getTree(owner: string, repo: string, branch: string): Promise<TreeEntry[]> {
    const data = await this.request<{ tree: TreeEntry[]; truncated: boolean }>(
      'GET',
      `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    );
    return data.tree ?? [];
  }

  async getFile(owner: string, repo: string, path: string, ref?: string): Promise<FileContent> {
    const suffix = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    const data = await this.request<{ content: string; sha: string; size: number; encoding: string }>(
      'GET',
      `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}${suffix}`,
    );
    return {
      path,
      content: new TextDecoder().decode(base64Decode(data.content)),
      sha: data.sha,
      size: data.size,
    };
  }

  async listBranches(owner: string, repo: string): Promise<string[]> {
    const branches = await this.request<Array<{ name: string }>>('GET', `/repos/${owner}/${repo}/branches?per_page=100`);
    return (branches ?? []).map((b) => b.name);
  }

  async listCommits(owner: string, repo: string, branch?: string, perPage = 5): Promise<Array<{ sha: string; message: string; author?: string }>> {
    const suffix = branch ? `?sha=${encodeURIComponent(branch)}&per_page=${perPage}` : `?per_page=${perPage}`;
    const commits = await this.request<Array<{ sha: string; commit: { message: string; author?: { name?: string } } }>>(
      'GET',
      `/repos/${owner}/${repo}/commits${suffix}`,
    );
    return (commits ?? []).map((c) => ({ sha: c.sha, message: c.commit.message, author: c.commit.author?.name }));
  }

  async branchExists(owner: string, repo: string, branch: string): Promise<boolean> {
    try {
      await this.request('GET', `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
      return true;
    } catch {
      return false;
    }
  }

  async createBranch(owner: string, repo: string, newBranch: string, fromBranch: string): Promise<string> {
    const base = await this.request<{ object: { sha: string } }>('GET', `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(fromBranch)}`);
    await this.request('POST', `/repos/${owner}/${repo}/git/refs`, { ref: `refs/heads/${newBranch}`, sha: base.object.sha });
    return base.object.sha;
  }

  async putFile(input: {
    owner: string;
    repo: string;
    path: string;
    content: string;
    message: string;
    branch: string;
    sha?: string;
  }): Promise<{ commit: { sha: string } }> {
    const body: Record<string, unknown> = {
      message: input.message,
      content: base64Encode(utf8(input.content)),
      branch: input.branch,
    };
    if (input.sha) body.sha = input.sha;
    return this.request<{ commit: { sha: string } }>(
      'PUT',
      `/repos/${input.owner}/${input.repo}/contents/${encodeURIComponent(input.path)}`,
      body,
    );
  }

  async deleteFile(input: { owner: string; repo: string; path: string; message: string; branch: string; sha: string }): Promise<unknown> {
    return this.request('DELETE', `/repos/${input.owner}/${input.repo}/contents/${encodeURIComponent(input.path)}`, {
      message: input.message,
      sha: input.sha,
      branch: input.branch,
    });
  }

  async createPullRequest(input: { owner: string; repo: string; title: string; body: string; head: string; base: string; draft?: boolean }): Promise<PullRequest> {
    return this.request<PullRequest>('POST', `/repos/${input.owner}/${input.repo}/pulls`, {
      title: input.title,
      body: input.body,
      head: input.head,
      base: input.base,
      draft: input.draft ?? false,
    });
  }

  async dispatchWorkflow(input: { owner: string; repo: string; workflow: string; ref: string; inputs: Record<string, string> }): Promise<boolean> {
    await this.request('POST', `/repos/${input.owner}/${input.repo}/actions/workflows/${input.workflow}/dispatches`, {
      ref: input.ref,
      inputs: input.inputs,
    });
    return true;
  }

  async listWorkflowRuns(owner: string, repo: string, branch?: string, perPage = 5): Promise<WorkflowRun[]> {
    const query = new URLSearchParams({ per_page: String(perPage) });
    if (branch) query.set('branch', branch);
    const data = await this.request<{ workflow_runs: WorkflowRun[] }>(
      'GET',
      `/repos/${owner}/${repo}/actions/runs?${query.toString()}`,
    );
    return data.workflow_runs ?? [];
  }

  async getWorkflowRun(owner: string, repo: string, runId: number): Promise<WorkflowRun> {
    return this.request<WorkflowRun>('GET', `/repos/${owner}/${repo}/actions/runs/${runId}`);
  }

  async getRunJobs(owner: string, repo: string, runId: number): Promise<Array<{ name: string; conclusion: string | null; steps?: Array<{ name: string; conclusion: string | null; number: number }> }>> {
    const data = await this.request<{ jobs: Array<{ name: string; conclusion: string | null; steps?: Array<{ name: string; conclusion: string | null; number: number }> }> }>(
      'GET',
      `/repos/${owner}/${repo}/actions/runs/${runId}/jobs?per_page=10`,
    );
    return data.jobs ?? [];
  }
}
