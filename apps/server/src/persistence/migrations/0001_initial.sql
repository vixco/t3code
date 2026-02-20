CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  project_id TEXT NULL,
  thread_id TEXT NULL,
  sort_key INTEGER NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  data_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  kind TEXT NOT NULL,
  method TEXT NOT NULL,
  thread_id TEXT NULL,
  turn_id TEXT NULL,
  item_id TEXT NULL,
  request_id TEXT NULL,
  request_kind TEXT NULL,
  text_delta TEXT NULL,
  message TEXT NULL,
  payload_json TEXT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS state_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_documents_kind ON documents(kind);
CREATE INDEX IF NOT EXISTS idx_documents_project_kind ON documents(project_id, kind);
CREATE INDEX IF NOT EXISTS idx_documents_thread_kind_sort ON documents(thread_id, kind, sort_key);
CREATE INDEX IF NOT EXISTS idx_documents_kind_updated ON documents(kind, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_provider_events_session_seq ON provider_events(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_provider_events_thread_seq ON provider_events(thread_id, seq);
CREATE INDEX IF NOT EXISTS idx_state_events_seq ON state_events(seq);
