/** Domain model shared by the DB layer, the AI layer and the Telegram layer. */

export interface Project {
  id: string;
  name: string;
  repo_owner: string;
  repo_name: string;
  default_branch: string;
  language: string | null;
  framework: string | null;
  architecture: string | null;
  description: string | null;
  active: number;
  created_at: string;
  updated_at: string;
}

export type RequestStatus = 'draft' | 'analyzing' | 'awaiting_approval' | 'approved' | 'executing' | 'done' | 'failed' | 'cancelled' | 'need_clarification';

export interface RequestRow {
  id: string;
  project_id: string;
  telegram_chat_id: string;
  telegram_message_id: string | null;
  raw_text: string;
  status: RequestStatus;
  current_plan_version: number;
  created_at: string;
  updated_at: string;
}

/** The structured output the analysis engine asks the model to produce. */
export interface PlanContent {
  understanding: string;
  outcome: string;
  files: string[];
  approach: string;
  impact: { database?: string; api?: string; ui?: string };
  tests: string[];
  risks: string[];
  unknowns: string[];
  effort: 'XS' | 'S' | 'M' | 'L';
  estimatedApiCostUsd: number;
  commands: string[];
  fileChanges?: FileChange[];
}

export interface FileChange {
  path: string;
  content?: string;
  diff?: string;
  action: 'create' | 'update' | 'delete';
}

export interface PlanRow {
  id: string;
  request_id: string;
  version: number;
  plan_json: string;
  report_fa: string;
  provider: string | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  created_at: string;
}

export type JobKind = 'analyze' | 'execute' | 'tests' | 'report' | 'provider_test';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'dead' | 'cancelled';

export interface JobRow {
  id: string;
  request_id: string | null;
  kind: JobKind;
  status: JobStatus;
  payload_json: string;
  result_json: string | null;
  attempts: number;
  max_attempts: number;
  run_after: string | null;
  lease_until: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProviderRow {
  name: string;
  display_name: string;
  base_url: string;
  model: string;
  active: number;
  free_tier: number;
  priority: number;
  daily_limit: number;
  monthly_limit: number;
  timeout_ms: number;
  max_retries: number;
  capabilities_json: string;
  last_check_status: string | null;
  last_check_at: string | null;
  last_error: string | null;
}

export interface ApprovalRow {
  id: string;
  request_id: string;
  plan_version: number;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  token_hash: string;
  expires_at: string;
  decided_at: string | null;
  actor: string | null;
}
