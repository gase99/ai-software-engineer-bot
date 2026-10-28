-- 0001_init.sql - AI Software Engineer Bot
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  repo_owner     TEXT NOT NULL,
  repo_name      TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  language       TEXT,
  framework      TEXT,
  architecture   TEXT,
  description    TEXT,
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (repo_owner, repo_name)
);

CREATE TABLE IF NOT EXISTS requests (
  id                   TEXT PRIMARY KEY,
  project_id           TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  telegram_chat_id     TEXT NOT NULL,
  telegram_message_id  TEXT,
  raw_text             TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'draft',
  current_plan_version INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_requests_project ON requests(project_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS plans (
  id             TEXT PRIMARY KEY,
  request_id     TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  version        INTEGER NOT NULL,
  plan_json      TEXT NOT NULL,
  report_fa      TEXT NOT NULL,
  provider       TEXT,
  model          TEXT,
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  UNIQUE (request_id, version)
);

CREATE TABLE IF NOT EXISTS approvals (
  id           TEXT PRIMARY KEY,
  request_id   TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  plan_version INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  token_hash   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  decided_at   TEXT,
  actor        TEXT
);
CREATE INDEX IF NOT EXISTS idx_approvals_request ON approvals(request_id, plan_version);

CREATE TABLE IF NOT EXISTS jobs (
  id           TEXT PRIMARY KEY,
  request_id   TEXT REFERENCES requests(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'queued',
  payload_json TEXT NOT NULL,
  result_json  TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  run_after    TEXT,
  lease_until  TEXT,
  last_error   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, run_after);

CREATE TABLE IF NOT EXISTS job_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id     TEXT NOT NULL,
  level      TEXT NOT NULL,
  message    TEXT NOT NULL,
  meta_json  TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_job_logs_job ON job_logs(job_id, id);

CREATE TABLE IF NOT EXISTS providers (
  name              TEXT PRIMARY KEY,
  display_name      TEXT NOT NULL,
  base_url          TEXT NOT NULL,
  model             TEXT NOT NULL,
  active            INTEGER NOT NULL DEFAULT 0,
  free_tier         INTEGER NOT NULL DEFAULT 1,
  priority          INTEGER NOT NULL DEFAULT 100,
  daily_limit       INTEGER NOT NULL DEFAULT 500000,
  monthly_limit     INTEGER NOT NULL DEFAULT 10000000,
  timeout_ms        INTEGER NOT NULL DEFAULT 60000,
  max_retries       INTEGER NOT NULL DEFAULT 2,
  capabilities_json TEXT NOT NULL DEFAULT '["chat","code"]',
  last_check_status TEXT,
  last_check_at     TEXT,
  last_error        TEXT
);

CREATE TABLE IF NOT EXISTS models_used (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  provider     TEXT NOT NULL,
  model        TEXT NOT NULL,
  request_id   TEXT,
  job_id       TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_usage (
  provider          TEXT NOT NULL,
  day               TEXT NOT NULL,
  month             TEXT NOT NULL,
  input_tokens      INTEGER NOT NULL DEFAULT 0,
  output_tokens     INTEGER NOT NULL DEFAULT 0,
  requests          INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (provider, day)
);

CREATE TABLE IF NOT EXISTS github_repos (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  owner           TEXT NOT NULL,
  name            TEXT NOT NULL,
  full_name       TEXT NOT NULL UNIQUE,
  installation_id INTEGER,
  default_branch  TEXT NOT NULL DEFAULT 'main',
  private         INTEGER NOT NULL DEFAULT 0,
  added_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS github_actions_usage (
  month     TEXT PRIMARY KEY,
  minutes   REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_memory (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  content    TEXT NOT NULL,
  source     TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  target     TEXT,
  meta_json  TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);

CREATE TABLE IF NOT EXISTS rate_counters (
  id           TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
