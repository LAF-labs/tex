// D07 §2 요약 DDL(v1.3) 그대로. PoC-5는 profiles·counterparties·settings를 쓰고, 나머지는 PoC-6(원장·게이트)이 쓴다.
export const MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
CREATE TABLE profiles (
  id TEXT PRIMARY KEY, kind TEXT CHECK(kind IN ('personal','business')) NOT NULL,
  display_name TEXT NOT NULL, biz_no TEXT, corp_no TEXT, rep_name TEXT, biz_type TEXT, biz_item TEXT,
  address TEXT, email TEXT, sign_method TEXT CHECK(sign_method IN ('cert','simple_auth','security_card',NULL)),
  keep_session INTEGER NOT NULL DEFAULT 0,
  slot_token TEXT,
  biz_bound_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_profiles_kind ON profiles(kind);

CREATE TABLE counterparties (
  id TEXT PRIMARY KEY, biz_no TEXT NOT NULL, name TEXT NOT NULL, rep_name TEXT, address TEXT, email TEXT,
  verified_at TEXT, verified_status TEXT, source TEXT CHECK(source IN ('manual','ocr','hometax')),
  last_used_at TEXT, use_count INTEGER NOT NULL DEFAULT 0,
  local_approved_at TEXT
);
CREATE UNIQUE INDEX ux_cp_bizno ON counterparties(biz_no);

CREATE TABLE documents (
  id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id), doc_type TEXT NOT NULL, display_name TEXT,
  issued_at TEXT, expires_at TEXT, issuer TEXT, path TEXT NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, meta_json TEXT,
  backup_state TEXT CHECK(backup_state IN ('none','pending','uploaded','failed')) NOT NULL DEFAULT 'none',
  blob_id TEXT, kek_ver INTEGER, index_exposed INTEGER NOT NULL DEFAULT 0, index_rev_max INTEGER NOT NULL DEFAULT 0,
  run_id TEXT, created_at TEXT NOT NULL
);
CREATE INDEX ix_documents_expiry ON documents(profile_id, doc_type, expires_at);
CREATE INDEX ix_documents_sha ON documents(sha256);

CREATE TABLE validity_rules (
  doc_type TEXT PRIMARY KEY, default_days INTEGER, rule TEXT NOT NULL, user_override_days INTEGER, remind_days TEXT NOT NULL DEFAULT '7,1'
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY, playbook_id TEXT NOT NULL, playbook_version TEXT NOT NULL, package_digest TEXT NOT NULL, profile_id TEXT NOT NULL,
  trigger TEXT CHECK(trigger IN ('local','remote','daemon')) NOT NULL, status TEXT NOT NULL,
  inputs_hash TEXT NOT NULL, inputs_json_enc BLOB, checkpoint TEXT, context_json_enc BLOB,
  started_at TEXT NOT NULL, finished_at TEXT, l1_calls INTEGER DEFAULT 0, l2_calls INTEGER DEFAULT 0, handoffs INTEGER DEFAULT 0, cost_usd REAL DEFAULT 0
);

CREATE TABLE run_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id),
  at TEXT NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL
);

CREATE TABLE irreversible_log (
  intent_id TEXT NOT NULL, step_id TEXT NOT NULL, run_id TEXT NOT NULL, business_key TEXT NOT NULL, playbook_id TEXT NOT NULL,
  inputs_hash TEXT NOT NULL, package_digest TEXT NOT NULL, action_hash TEXT NOT NULL,
  state TEXT CHECK(state IN ('armed','dispatched','committed','not_committed','in_doubt','observed_manual')) NOT NULL,
  reason TEXT, armed_at TEXT NOT NULL, dispatched_at TEXT, resolved_at TEXT, verify_ref TEXT, device_id TEXT NOT NULL,
  PRIMARY KEY(intent_id, step_id)
);
CREATE INDEX ix_irr_business ON irreversible_log(business_key, state);

CREATE TABLE gate_requests (
  req_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id),
  state TEXT CHECK(state IN ('open','approved','denied','expired','consumed')) NOT NULL, decided_by TEXT, decided_at TEXT
);

CREATE TABLE rate_counters (
  portal TEXT NOT NULL, profile_id TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL, bucket TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(portal, profile_id, kind, bucket)
);
CREATE TABLE clock_guard (id INTEGER PRIMARY KEY CHECK(id=1), last_seen_at TEXT NOT NULL);
CREATE TABLE cooldowns (portal TEXT PRIMARY KEY, until TEXT NOT NULL, reason TEXT NOT NULL);
CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
`,
  },
];
