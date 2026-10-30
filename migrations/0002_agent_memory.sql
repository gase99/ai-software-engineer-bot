-- 0002_agent_memory.sql - conversational agent memory + approvals
CREATE TABLE IF NOT EXISTS chat_messages (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id TEXT NOT NULL,
  chat_id          TEXT NOT NULL,
  role             TEXT NOT NULL,
  content          TEXT NOT NULL DEFAULT '',
  message_json     TEXT NOT NULL,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_user ON chat_messages(telegram_user_id, id DESC);

CREATE TABLE IF NOT EXISTS pending_actions (
  id               TEXT PRIMARY KEY,
  telegram_user_id TEXT NOT NULL,
  chat_id          TEXT NOT NULL,
  summary          TEXT NOT NULL,
  calls_json       TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending',
  expires_at       TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  decided_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_pending_actions_user ON pending_actions(telegram_user_id, status);
