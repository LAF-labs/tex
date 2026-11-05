// D07 §2 요약 DDL을 순방향 마이그레이션으로 쌓는다(D07 §7). 이미 배포한 판의 SQL은 고치지 않는다(적용 기록의 sha256과 대조한다).
// v1(PoC-5·6): 프로필·거래처·문서·실행·저널·원장·게이트·카운터·설정.
// v2(PoC-6, ADR-021): 원장에 공급받는자 사업자번호·받는 이메일 HMAC 열. 처음 거래 판정은 committed 행만 센다.
// v3(M1-2): D07 §2의 나머지 코어 테이블(스케줄·패키지·정책·레지스트리·미리보기·사용량·리모트).
// v4(M1-2, ADR-031·034): 급여대장(직원·달·줄·근무표·시행일 표).
// v5(M1-2, ADR-032·034): 세무사 꾸러미(항목·달별 상태·내보내기·카드 조회·카드 내역·메모·종이 증빙·현금매출).
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'poc_core',
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
  {
    version: 2,
    name: 'ledger_hmac',
    sql: `
ALTER TABLE irreversible_log ADD COLUMN cp_biz_no_hmac TEXT;
ALTER TABLE irreversible_log ADD COLUMN recipient_email_hmac TEXT;
CREATE INDEX ix_irr_cp_hmac ON irreversible_log(cp_biz_no_hmac, state);
CREATE INDEX ix_irr_email_hmac ON irreversible_log(recipient_email_hmac, state);
`,
  },
  {
    version: 3,
    name: 'd07_core_rest',
    sql: `
CREATE TABLE schedules (
  id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, doc_type TEXT NOT NULL, playbook_id TEXT NOT NULL,
  mode TEXT CHECK(mode IN ('notify','semi_auto','auto')) NOT NULL, window_json TEXT NOT NULL,
  consent_json TEXT NOT NULL,
  next_due_at TEXT, last_run_id TEXT, enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE playbook_packages (
  id TEXT NOT NULL, version TEXT NOT NULL, channel TEXT NOT NULL, signature_ok INTEGER NOT NULL,
  installed_at TEXT NOT NULL, manifest_json TEXT NOT NULL, PRIMARY KEY(id, version)
);
CREATE TABLE policy (version TEXT PRIMARY KEY, body_json TEXT NOT NULL, signature_ok INTEGER NOT NULL, installed_at TEXT NOT NULL);
CREATE TABLE registry_state (
  role TEXT PRIMARY KEY,
  key_epoch INTEGER NOT NULL, max_version INTEGER NOT NULL,
  log_tree_size INTEGER, log_head_hash TEXT, updated_at TEXT NOT NULL
);

CREATE TABLE temp_previews (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, body_enc BLOB NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);

CREATE TABLE usage_local (month TEXT PRIMARY KEY, l1_input_tokens INTEGER, l2_input_tokens INTEGER, l2_output_tokens INTEGER, cost_usd REAL);

CREATE TABLE remote_devices (
  device_id TEXT PRIMARY KEY, role TEXT CHECK(role IN ('desktop','mobile')) NOT NULL, name TEXT,
  noise_pub BLOB NOT NULL, sign_pub BLOB NOT NULL,
  hw_approval_pub BLOB,
  registered_at TEXT NOT NULL, paired_at TEXT, cert_not_after TEXT, list_version INTEGER NOT NULL,
  last_seen_at TEXT, revoked INTEGER NOT NULL DEFAULT 0,
  hw_attest_state TEXT NOT NULL DEFAULT 'unverified' CHECK (hw_attest_state IN ('verified_strongbox','verified_tee','ios_app_attest','unverified')),
  hw_attest_chain_sha256 TEXT, hw_attest_verified_at TEXT,
  doc_scope_json TEXT NOT NULL DEFAULT '{"slots":["business"],"docTypes":"*"}'
);
CREATE TABLE remote_pair_state (
  pair_id TEXT PRIMARY KEY, ik_ts_max INTEGER NOT NULL, async_seq_max INTEGER NOT NULL, seq_bitmap BLOB NOT NULL,
  mbx_epoch INTEGER NOT NULL, qbundle_seq_max INTEGER NOT NULL DEFAULT 0, device_list_version INTEGER NOT NULL,
  registry_head_seen TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE remote_cmd_seen (
  pair_id TEXT NOT NULL, cmd_id TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY(pair_id, cmd_id)
);
`,
  },
  {
    version: 4,
    name: 'payroll',
    sql: `
CREATE TABLE employees (
  id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id),
  name TEXT NOT NULL, birth_date TEXT NOT NULL,
  rrn_enc BLOB,
  hired_on TEXT NOT NULL, left_on TEXT, job TEXT,
  pay_type TEXT CHECK(pay_type IN ('monthly','hourly')) NOT NULL DEFAULT 'monthly',
  base_pay INTEGER NOT NULL,
  nontax_json TEXT NOT NULL DEFAULT '{}',
  dependents INTEGER NOT NULL, children_8_20 INTEGER NOT NULL DEFAULT 0,
  withholding_pct INTEGER CHECK(withholding_pct IN (80,100,120)) NOT NULL DEFAULT 100,
  pension_applies INTEGER NOT NULL DEFAULT 1, health_applies INTEGER NOT NULL DEFAULT 1, employment_applies INTEGER NOT NULL DEFAULT 1,
  pension_base INTEGER, health_base INTEGER,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(profile_id, id)
);
CREATE TABLE payroll_months (
  profile_id TEXT NOT NULL REFERENCES profiles(id), month TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  status TEXT CHECK(status IN ('draft','confirmed')) NOT NULL,
  paid_on TEXT, rate_table_ids_json TEXT NOT NULL,
  notice_doc_ids_json TEXT NOT NULL DEFAULT '[]',
  confirmed_at TEXT, PRIMARY KEY(profile_id, month, revision)
);
CREATE TABLE payroll_lines (
  profile_id TEXT NOT NULL, month TEXT NOT NULL, revision INTEGER NOT NULL, employee_id TEXT NOT NULL,
  work_days INTEGER, work_minutes INTEGER, overtime_minutes INTEGER, night_minutes INTEGER, holiday_minutes INTEGER,
  items_json TEXT NOT NULL,
  gross INTEGER NOT NULL, nontax INTEGER NOT NULL,
  income_tax INTEGER NOT NULL, local_income_tax INTEGER NOT NULL,
  pension_est INTEGER NOT NULL, health_est INTEGER NOT NULL, ltc_est INTEGER NOT NULL, employment_est INTEGER NOT NULL,
  pension_notice INTEGER, health_notice INTEGER, ltc_notice INTEGER, employment_notice INTEGER,
  employer_json TEXT NOT NULL,
  net_pay INTEGER NOT NULL,
  PRIMARY KEY(profile_id, month, revision, employee_id),
  FOREIGN KEY(profile_id, month, revision) REFERENCES payroll_months(profile_id, month, revision),
  FOREIGN KEY(profile_id, employee_id) REFERENCES employees(profile_id, id)
);
CREATE TABLE shifts (
  id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, employee_id TEXT NOT NULL,
  work_day TEXT NOT NULL, starts_at TEXT NOT NULL, ends_at TEXT NOT NULL,
  break_minutes INTEGER NOT NULL DEFAULT 0, kind TEXT CHECK(kind IN ('planned','actual')) NOT NULL DEFAULT 'actual',
  updated_at TEXT NOT NULL,
  FOREIGN KEY(profile_id, employee_id) REFERENCES employees(profile_id, id)
);
CREATE INDEX ix_shifts_month ON shifts(profile_id, employee_id, work_day);
CREATE TABLE rate_tables (
  id TEXT PRIMARY KEY,
  kind TEXT CHECK(kind IN ('insurance_rate','pension_bounds','simple_tax_table','nontax_limits')) NOT NULL,
  effective_from TEXT NOT NULL, effective_to TEXT, body_json TEXT NOT NULL, rounding TEXT NOT NULL,
  package_version TEXT NOT NULL, signature_ok INTEGER NOT NULL,
  UNIQUE(kind, effective_from)
);
`,
  },
  {
    version: 5,
    name: 'tax_bundle',
    sql: `
CREATE TABLE bundle_items (
  id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id),
  tier INTEGER CHECK(tier IN (1,2,3)) NOT NULL, kind TEXT NOT NULL,
  name TEXT NOT NULL, cadence TEXT CHECK(cadence IN ('monthly','quarterly','once')) NOT NULL DEFAULT 'monthly',
  enabled INTEGER NOT NULL DEFAULT 1, source TEXT CHECK(source IN ('builtin','industry','user','pasted_request')) NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE bundle_entries (
  item_id TEXT NOT NULL REFERENCES bundle_items(id), period TEXT NOT NULL,
  status TEXT CHECK(status IN ('missing','partial','ready','not_applicable')) NOT NULL,
  doc_ids_json TEXT NOT NULL DEFAULT '[]', note TEXT, updated_at TEXT NOT NULL,
  PRIMARY KEY(item_id, period)
);
CREATE TABLE bundle_exports (
  id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id), period TEXT NOT NULL,
  sha256 TEXT NOT NULL, path TEXT NOT NULL, created_at TEXT NOT NULL,
  zip_sha256 TEXT, zip_path TEXT,
  rrn_included INTEGER NOT NULL DEFAULT 0,
  send_via TEXT CHECK(send_via IN ('mail_client','folder')),
  sent_to TEXT,
  sent_marked_at TEXT, sent_note TEXT,
  CHECK((zip_sha256 IS NULL) = (zip_path IS NULL))
);
CREATE TABLE card_fetches (
  run_id TEXT PRIMARY KEY REFERENCES runs(id), profile_id TEXT NOT NULL REFERENCES profiles(id),
  range_from TEXT NOT NULL, range_to TEXT NOT NULL, row_count INTEGER NOT NULL, completed_at TEXT NOT NULL
);
CREATE TABLE card_txns (
  id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id), fetch_run_id TEXT NOT NULL REFERENCES card_fetches(run_id),
  seq INTEGER NOT NULL,
  used_on TEXT NOT NULL, merchant TEXT, merchant_biz_no TEXT, card_last4 TEXT, approval_no TEXT,
  amount INTEGER NOT NULL, supply_amount INTEGER, vat_amount INTEGER, canceled INTEGER NOT NULL DEFAULT 0,
  UNIQUE(fetch_run_id, seq)
);
CREATE INDEX ix_card_txns_day ON card_txns(profile_id, used_on);
CREATE TABLE card_txn_memos (
  id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id),
  match_key TEXT NOT NULL,
  txn_id TEXT REFERENCES card_txns(id) ON DELETE SET NULL,
  memo TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(profile_id, match_key)
);
CREATE TABLE receipts (
  doc_id TEXT PRIMARY KEY REFERENCES documents(id),
  source TEXT CHECK(source IN ('pc_file','phone_capture')) NOT NULL,
  phone_msg_id TEXT UNIQUE,
  issued_on TEXT, merchant TEXT, merchant_biz_no TEXT, amount INTEGER,
  phone_ocr_json TEXT,
  ocr_json TEXT,
  confirmed_at TEXT
);
CREATE TABLE cash_sales (
  profile_id TEXT NOT NULL REFERENCES profiles(id), day TEXT NOT NULL, amount INTEGER NOT NULL, entered_at TEXT NOT NULL,
  source TEXT CHECK(source IN ('pc','phone')) NOT NULL DEFAULT 'pc',
  PRIMARY KEY(profile_id, day)
);
`,
  },
  {
    version: 6,
    name: 'onboarding',
    sql: `
ALTER TABLE profiles ADD COLUMN portal_login_id TEXT;
CREATE TABLE consents (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id TEXT REFERENCES profiles(id) ON DELETE CASCADE,
  kind TEXT CHECK(kind IN ('terms','model','telemetry','delegation')) NOT NULL,
  notice_key TEXT NOT NULL, notice_version TEXT NOT NULL, processors_version TEXT,
  choice TEXT CHECK(choice IN ('agreed','declined')) NOT NULL,
  at TEXT NOT NULL,
  via TEXT CHECK(via IN ('onboarding','settings','T-06')) NOT NULL,
  device_sig TEXT
);
CREATE INDEX ix_consents_profile_kind ON consents(profile_id, kind, seq);
CREATE TABLE onboarding_state (
  profile_kind TEXT PRIMARY KEY CHECK(profile_kind IN ('business','personal')),
  profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  step TEXT NOT NULL, state_json TEXT NOT NULL, updated_at TEXT NOT NULL
);
`,
  },
];
