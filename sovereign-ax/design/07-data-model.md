# D07. 데이터 모델

> 2026-11-06 정합(팀장 지시, 큐 1~15): §8 OCR 폴백의 언어 데이터 정정(`kor_fast` → `@tesseract.js-data/kor`의 `4.0.0_best_int`·`4.0.0`, docparse PR #78).
> 제품 정의 반영 2026-11-05: 급여대장(`employees`·`payroll_months`·`payroll_lines`·`rate_tables`, ADR-031)과 세무사 꾸러미(`bundle_items`·`bundle_entries`·`card_txns`·`receipts`·`cash_sales`, ADR-032) 테이블을 §2에 더했다. 모두 로컬 전용이고 서버 색인 대상이 아니다.
> ADR-034 결정 8 채택 2026-11-05: 근무표 범위 축소, `shifts` 삭제 제안(데이터 트랙 확인 전).
> 2026-11-05 팀장 결정(데이터 PR #53·#67): `rate_tables` 시행일 표 규칙(열린 표의 끝, 겹침, 고르기, `rate_table_missing`).
> 2026-11-05 팀장 결정·R13 D-L3: `card_txn_memos.match_key`의 승인번호 키에 사용일을 붙임(데이터 PR #53 Bugbot High), `bundle_exports`에 `zip_sha256`·`zip_path`·`rrn_included`(회차당 한 행), 꾸러미 내보내기 규칙(엑셀 + 첨부 ZIP 두 파일, 주민번호 가림이 기본)을 §2 끝에 적음.
> v1.3 — 공격표면 감사(research/AUDIT-A·B·C, design/19-attack-surface.md) 반영. 바뀐 절에는 근거 ID를 붙였다. · AUDIT-D 반영 2026-11-03: 단일 인스턴스·DB 배타 잠금·DB 키 유실 처리(§1.3), `remote_devices` 증명 상태·`doc_scope_json`(§2), 서버 시각 컬럼 금지(§5), 키 계층의 복구 문구 삭제(§6, ADR-016 v2), DB 키 래핑 사본(§7)(ADR-025·029, D19 §3.5). 상충 표기: `A/C-nn`은 감사 A §3, `B/C-nn`은 감사 B §3, `C/X-nn`은 감사 C §5. 맨 `C-nn`은 감사 C의 발견 ID다.

## 1. 저장소 개관

| 저장소 | 위치 | 암호화 | 내용 |
|---|---|---|---|
| 로컬 DB | `%LOCALAPPDATA%\SovereignAX\db\db.sqlite` (Win), `~/Library/Application Support/SovereignAX/db/` (mac, Phase 3) | `better-sqlite3-multiple-ciphers`, `cipher=sqlcipher, legacy=4` 명시, 32바이트 키는 키체인(§1.3) | 프로필(비밀 없음), 거래처, 문서 메타, 실행·감사, 원장, 게이트 요청, 스케줄, 카운터, 설정, 리모트 상태 |
| 서류 보관함 | 기본 `%LOCALAPPDATA%\SovereignAX\vault\`. 사용자 지정 폴더는 §1.2 규칙을 통과해야 한다 | Phase 1 평문 PDF + OS 디스크 암호화 상태 점검. Phase 2 파일별 DEK(`K_store`) at-rest 암호화(§1.4) | 평면 레이아웃 `{docType}_{yyyyMMdd}_{shortId}.pdf`(§4) |
| 로컬 임시 | 디스크에 두지 않는다 | 마스킹 미리보기는 DB 암호화 컬럼(`temp_previews`, 24시간 TTL), 캡차 크롭은 **메모리만**(응답 즉시 폐기) | (상충 A/C-02) |
| 다운로드 스테이징 | `%LOCALAPPDATA%\SovereignAX\staging\` | 평문(보관함과 같은 DACL). 보관함으로 옮긴 즉시 삭제, 기동 시 잔존 파일 정리 | 발급 직후 PDF |
| 클라우드 블롭 | S3 호환 API 하위 집합(D09 §9.1) | 클라이언트 E2EE(XChaCha20-Poly1305, 파일별 DEK), Padmé 패딩 | PDF 암호문 + 암호화된 문서 머리(§6) |
| 클라우드 메타데이터 | PostgreSQL | 전송·저장 암호화(서버 측) | 서버 색인을 켠 종류의 `doc_type`·발급 월·만료일, 키 객체(wDEK), 서명(§5). 크기·dedup 토큰·초 단위 시각 없음 (C-09·C-13) |

### 1.1 로컬 경로와 접근 통제 (A-18)

| 하위 폴더 | 내용 | 비고 |
|---|---|---|
| `userData` | Electron 렌더러 저장소·설정 | Electron 기본값은 로밍 `%APPDATA%`이므로 쓰지 않는다 |
| `db` | `db.sqlite`, 마이그레이션 백업 | §1.3 |
| `vault` | 기본 서류 보관함 | §1.2·§1.4 |
| `chrome-profile` | 전용 Chrome `user-data-dir` | §9 |
| `staging` | 다운로드 스테이징 | 위 표 |
| `logs` | 앱 로그(값 없음 원칙, D12) | |
| `crashDumps` | 크래시 덤프(업로드 금지, §9) | |

- 모든 경로는 `%LOCALAPPDATA%\SovereignAX\` 아래에 둔다. `app.setPath('userData' | 'logs' | 'crashDumps', …)`는 앱 `ready` 이전에 설정한다. 도메인 가입 PC의 로밍 프로필이 렌더러 저장소·덤프를 서버로 복사하는 경로를 막기 위해서다.
- 루트 `SovereignAX` 폴더 DACL: **소유자 + SYSTEM, 상속 차단**. 매 기동 시 확인하고, 다르면 복구하고 경고한다.
- Windows 검색 색인 제외(`FILE_ATTRIBUTE_NOT_CONTENT_INDEXED`)는 루트 전체에 적용한다.

### 1.2 사용자 지정 보관함 폴더 (A-19)

사용자가 보관함 폴더를 고르면 다음을 차례로 확인한다.

1. 파일 시스템이 NTFS가 아니거나(FAT·exFAT) 네트워크·이동식 경로면 **거부**한다. 사용자가 고집하면 강한 경고 뒤 Phase 1에서는 거부를 유지한다.
2. OneDrive·Dropbox·Google Drive·iCloud 동기화 루트인지 감지해 **경고**한다(등본 PDF가 평문으로 해외 클라우드에 올라가는 것을 막기 위해, `postprocess.sync_folder_warning`).
3. 폴더에 보호 DACL(소유자 + SYSTEM, 상속 차단)을 설정하고 다시 읽어 확인한다. 실패하면 `storage.acl_weak`를 띄우고 기본 위치를 권고한다.
4. Controlled Folder Access 쓰기 실패를 감지해 안내한다.

### 1.3 DB 소유 프로세스와 암호 설정 (A-24)

- **DB 소유 프로세스는 엔진 하나다.** main의 스케줄러와 렌더러의 감사 로그 뷰는 엔진의 읽기 전용 IPC 질의(`db.query.*` 스키마)를 쓰고 DB 파일을 직접 열지 않는다.
- DB 키는 금고가 `getDbKeyOnce()`로 기동당 1회 엔진에 넘긴다(두 번째 호출은 보안 이벤트, D05 §2).
- 암호 설정: `cipher=sqlcipher, legacy=4`(또는 `chacha20`)를 명시하고, 키는 Buffer를 함수형 `key()`로 전달한다(`PRAGMA key` 문자열을 만들지 않는다). `PRAGMA temp_store=MEMORY`로 정렬·임시 테이블이 평문 파일로 디스크에 남지 않게 한다.
- 앱 인스턴스는 하나다. 엔진은 DB를 열자마자 `PRAGMA locking_mode=EXCLUSIVE`와 한 번 쓰기로 잠금을 잡고, 못 잡으면 `db.locked_by_other_instance`로 끝낸다. 복구 루틴(`promoteInDoubt`·`expireOpen`·`interruptRunning`)은 잠금을 잡은 뒤에만 돈다(Phase 1, ADR-025, D-41(N-29)).
- DB 키 유실: 키 항목이 없는데 DB 파일이 있으면 새 키를 만들지 않는다(`db.key_missing`). 사용자가 '기록을 포기하고 새로 시작'을 고르면 기존 파일을 `db\db.sqlite.unreadable-<ts>`로 보존한 뒤 새로 만들고 `ledger.reset`을 남기며 첫 발급 카드에 경고를 1회 붙인다(복구 화면은 Phase 1, ADR-029, D-22(N-30)).

### 1.4 보관함 at-rest 암호화 (A-25, 상충 A/C-13)

- **Phase 1**: 보관함 PDF는 평문이다. 온보딩에서 시스템 드라이브의 BitLocker·장치 암호화 상태를 **읽기 전용으로** 확인해 꺼져 있으면 안내한다. 설정은 바꾸지 않는다. 관리자 권한 없이 상태를 읽는 방법은 확인 필요(S6m).
- **Phase 2**: 파일별 DEK를 `K_store`(키체인, 무인 등급)로 래핑해 저장한다. 앱 뷰어는 메모리에서 복호화하고, 외부 뷰어로 열기는 '내보내기'(평문 사본, 사용자 동작)로만 한다.
- 효과 범위: 노트북 분실·백업 도구 사본·동기화 오설정·다른 OS 사용자. **같은 사용자 권한의 악성코드에는 효과가 없다**(키체인을 같이 읽는다). 이 시점 표기(Phase 2, `K_store`)를 D11 T9와 맞춘다.

## 2. 로컬 SQLite 스키마 (요약 DDL)

```sql
CREATE TABLE profiles (
  id TEXT PRIMARY KEY, kind TEXT CHECK(kind IN ('personal','business')) NOT NULL,
  display_name TEXT NOT NULL, biz_no TEXT, corp_no TEXT, rep_name TEXT, biz_type TEXT, biz_item TEXT,
  address TEXT, email TEXT, sign_method TEXT CHECK(sign_method IN ('cert','simple_auth','security_card',NULL)),
  keep_session INTEGER NOT NULL DEFAULT 0,          -- (A-27) 세션 쿠키 유지 기본 꺼짐
  slot_token TEXT,                                   -- 서버 프로필 슬롯의 계정별 무작위 토큰 (C-09)
  biz_bound_at TEXT,                                 -- 서버에 사업자 HMAC을 바인딩한 시각 (B-28, 재바인딩 90일)
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
-- 계정당 kind별 1개: 앱 레벨 + 서버 계정 슬롯으로 이중 강제
CREATE UNIQUE INDEX ux_profiles_kind ON profiles(kind);

CREATE TABLE counterparties (
  id TEXT PRIMARY KEY, biz_no TEXT NOT NULL, name TEXT NOT NULL, rep_name TEXT, address TEXT, email TEXT,
  verified_at TEXT, verified_status TEXT, source TEXT CHECK(source IN ('manual','ocr','hometax')),
  last_used_at TEXT, use_count INTEGER NOT NULL DEFAULT 0,
  local_approved_at TEXT                             -- 로컬에서 한 번이라도 승인된 거래처(표시용). 처음 거래 판정(D08 §6.1 newCounterpartyRequiresLocal, 승인 바)은 이 열이 아니라 irreversible_log의 committed 행으로 한다(ADR-021)
);
CREATE UNIQUE INDEX ux_cp_bizno ON counterparties(biz_no);

CREATE TABLE documents (
  id TEXT PRIMARY KEY,                -- UUIDv4 (시각 비포함, 서버 doc_id와 같음) (C-09)
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  doc_type TEXT NOT NULL,             -- tax_invoice, resident_copy, localtax_cert, nhis_eligibility, sme_cert, ...
  display_name TEXT,                  -- 사람이 읽는 이름(거래처·승인번호 등). 파일명에 넣지 않는다(§4)
  issued_at TEXT, expires_at TEXT, issuer TEXT, path TEXT NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL,
  meta_json TEXT,                     -- 종류별 추가 필드(승인번호 등). 로컬 전용
  backup_state TEXT CHECK(backup_state IN ('none','pending','uploaded','failed')) NOT NULL DEFAULT 'none',
  blob_id TEXT,                       -- 중복 판단은 로컬 sha256 → blob_id 매핑으로만 (C-13)
  kek_ver INTEGER,
  index_exposed INTEGER NOT NULL DEFAULT 0,   -- 서버 인덱스 행 존재 여부(종류별 서버 색인, §3)
  index_rev_max INTEGER NOT NULL DEFAULT 0,   -- 서버 레코드의 최고 rev. 더 낮은 rev는 거부 (C-12)
  run_id TEXT, created_at TEXT NOT NULL
);
CREATE INDEX ix_documents_expiry ON documents(profile_id, doc_type, expires_at);
CREATE INDEX ix_documents_sha ON documents(sha256);

CREATE TABLE validity_rules (
  doc_type TEXT PRIMARY KEY, default_days INTEGER, rule TEXT NOT NULL,   -- 'fixed_days' | 'fiscal_year_rule' | 'none'
  user_override_days INTEGER, remind_days TEXT NOT NULL DEFAULT '7,1'
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY, playbook_id TEXT NOT NULL, playbook_version TEXT NOT NULL,
  package_digest TEXT NOT NULL,                     -- (B-13) 재개는 같은 package_digest가 설치되어 있을 때만
  profile_id TEXT NOT NULL,
  trigger TEXT CHECK(trigger IN ('local','remote','daemon')) NOT NULL, status TEXT NOT NULL,
  inputs_hash TEXT NOT NULL, inputs_json_enc BLOB,      -- 재개용. DB 키로 암호화된 컬럼(비밀 미포함)
  checkpoint TEXT, context_json_enc BLOB,   -- Paused 재개용 vars·intent_id (비밀 없음, 토큰 없음)
  started_at TEXT NOT NULL, finished_at TEXT, l1_calls INTEGER DEFAULT 0, l2_calls INTEGER DEFAULT 0,
  handoffs INTEGER DEFAULT 0, cost_usd REAL DEFAULT 0
);

CREATE TABLE run_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id),
  at TEXT NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL,   -- D03 §9 필드만. 값 없음
  prev_hash TEXT NOT NULL, hash TEXT NOT NULL                          -- 해시 체인
);

CREATE TABLE irreversible_log (              -- 아이덴포턴시 원장 (D03 §4). 선행 기록(write-ahead) (B-10)
  intent_id TEXT NOT NULL, step_id TEXT NOT NULL, run_id TEXT NOT NULL, business_key TEXT NOT NULL,
  playbook_id TEXT NOT NULL,                 -- 같은 intent_id로 다른 플레이북이 오면 거부(ledger.intent_reuse)
  inputs_hash TEXT NOT NULL,                 -- 같은 intent_id로 다른 입력이 오면 거부(ledger.intent_reuse)
  package_digest TEXT NOT NULL,
  action_hash TEXT NOT NULL,
  state TEXT CHECK(state IN ('armed','dispatched','committed','not_committed','in_doubt','observed_manual')) NOT NULL,
  reason TEXT,                               -- not_committed 사유: pre_dispatch_mismatch | identity_mismatch | payload_mismatch | verify
  armed_at TEXT NOT NULL, dispatched_at TEXT, resolved_at TEXT, verify_ref TEXT, device_id TEXT NOT NULL,  -- verify_ref: committed 판정의 B₁\B₀ 한 건(H-01 승인번호). bind 유무와 무관, verify가 committed로 판정하지 않은 행은 NULL (ADR-024)
  cp_biz_no_hmac TEXT,                       -- 공급받는자 사업자번호 HMAC(ledgerHmacKey = 엔진이 DB 키에서 HKDF로 파생). 처음 거래 판정은 state='committed' 행만 센다(ADR-021)
  recipient_email_hmac TEXT,                 -- 받는 이메일 HMAC(같은 키, 소문자 + 도메인 punycode로 정규화). 처음 보내는 주소 판정(ADR-021)
  attempt INTEGER NOT NULL CHECK(attempt >= 1),  -- 같은 (intent_id, step_id)의 시도 번호(ADR-042). 앞선 시도가 모두 not_committed일 때만 다음 번호(재게이트)
  PRIMARY KEY(intent_id, step_id, attempt)
);
CREATE INDEX ix_irr_business ON irreversible_log(business_key, state);
CREATE INDEX ix_irr_run ON irreversible_log(run_id);
CREATE UNIQUE INDEX ux_irr_live ON irreversible_log(intent_id, step_id) WHERE state <> 'not_committed';  -- (intent, step)마다 열린·committed 행은 하나(ADR-042)

CREATE TABLE gate_requests (                 -- 게이트 요청 단일 사용·결정 주체 기록 (B-10·B-33)
  req_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id),
  state TEXT CHECK(state IN ('open','approved','denied','expired','consumed')) NOT NULL,
  decided_by TEXT,                           -- 'local' 또는 원격 기기 device_id
  decided_at TEXT
);

CREATE TABLE schedules (
  id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, doc_type TEXT NOT NULL, playbook_id TEXT NOT NULL,
  mode TEXT CHECK(mode IN ('notify','semi_auto','auto')) NOT NULL, window_json TEXT NOT NULL,
  consent_json TEXT NOT NULL,   -- (B-27) {playbookId, major, effects[], docType, profileId, consentedAt, deviceSig}
  next_due_at TEXT, last_run_id TEXT, enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE rate_counters (                 -- D03 §7. KST, 증가 커밋 → 행동
  portal TEXT NOT NULL, profile_id TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL,  -- runs_day | irreversible_day | remote_irreversible_day | navigations_min | logins_day | captcha_10m | login_session
  bucket TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(portal, profile_id, kind, bucket)
);
CREATE TABLE clock_guard (id INTEGER PRIMARY KEY CHECK(id=1), last_seen_at TEXT NOT NULL);
CREATE TABLE cooldowns (portal TEXT PRIMARY KEY, until TEXT NOT NULL, reason TEXT NOT NULL);

CREATE TABLE playbook_packages (
  id TEXT NOT NULL, version TEXT NOT NULL, channel TEXT NOT NULL, signature_ok INTEGER NOT NULL,
  installed_at TEXT NOT NULL, manifest_json TEXT NOT NULL, PRIMARY KEY(id, version)
);
CREATE TABLE policy (version TEXT PRIMARY KEY, body_json TEXT NOT NULL, signature_ok INTEGER NOT NULL, installed_at TEXT NOT NULL);
CREATE TABLE registry_state (                -- D09 §8 (C-26)
  role TEXT PRIMARY KEY,                     -- index | policy | status | revoked_keys
  key_epoch INTEGER NOT NULL, max_version INTEGER NOT NULL,
  log_tree_size INTEGER, log_head_hash TEXT, updated_at TEXT NOT NULL
);

CREATE TABLE temp_previews (                 -- (상충 A/C-02) 마스킹 미리보기. 디스크 임시 파일 대신
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, body_enc BLOB NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL  -- 24h TTL
);

CREATE TABLE usage_local (month TEXT PRIMARY KEY, l1_input_tokens INTEGER, l2_input_tokens INTEGER, l2_output_tokens INTEGER, cost_usd REAL);
CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);   -- 'index.docTypeEnabled' 등

CREATE TABLE remote_devices (                -- D08 §4·§5 (C-01·C-06·C-20)
  device_id TEXT PRIMARY KEY, role TEXT CHECK(role IN ('desktop','mobile')) NOT NULL, name TEXT,
  noise_pub BLOB NOT NULL, sign_pub BLOB NOT NULL,
  hw_approval_pub BLOB,                      -- Px(SE/StrongBox P-256). 없으면 원격 비가역 승인 불가
  registered_at TEXT NOT NULL, paired_at TEXT, cert_not_after TEXT, list_version INTEGER NOT NULL,
  last_seen_at TEXT, revoked INTEGER NOT NULL DEFAULT 0,
  hw_attest_state TEXT NOT NULL DEFAULT 'unverified' CHECK (hw_attest_state IN ('verified_strongbox','verified_tee','ios_app_attest','unverified')),  -- ADR-029, D-36(N-55)
  hw_attest_chain_sha256 TEXT, hw_attest_verified_at TEXT,
  doc_scope_json TEXT NOT NULL DEFAULT '{"slots":["business"],"docTypes":"*"}'   -- 폰 서류 열람 범위, ADR-029, D-35(N-53)
);
CREATE TABLE remote_pair_state (             -- (C-33) pair별 영속 상태. 재페어링 시 epoch 증가
  pair_id TEXT PRIMARY KEY, ik_ts_max INTEGER NOT NULL, async_seq_max INTEGER NOT NULL, seq_bitmap BLOB NOT NULL,
  mbx_epoch INTEGER NOT NULL, qbundle_seq_max INTEGER NOT NULL DEFAULT 0, device_list_version INTEGER NOT NULL,
  registry_head_seen TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE remote_cmd_seen (               -- (B-10) 라이브·큐 cmd.run 모두 처리된 cmdId와 대조. 90일 보존
  pair_id TEXT NOT NULL, cmd_id TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY(pair_id, cmd_id)
);

-- 급여대장 (ADR-031, Phase 1 베타). 금액은 원 단위 정수
CREATE TABLE employees (
  id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id),
  name TEXT NOT NULL, birth_date TEXT NOT NULL,      -- 임금대장·임금명세서는 성명·생년월일로 쓴다
  rrn_enc BLOB,                                      -- 주민번호(선택). 원천세 자료로 세무사가 필요할 때만 넣는다. DB 키 암호화 컬럼, 화면에는 가려서, 모델·서버로 보내지 않는다
  hired_on TEXT NOT NULL, left_on TEXT, job TEXT,
  pay_type TEXT CHECK(pay_type IN ('monthly','hourly')) NOT NULL DEFAULT 'monthly',   -- 월급제 상용직 기본. hourly는 표시용이고 세전 금액은 사장님이 정한다(시급 × 시간 계산 없음, ADR-034 결정 8 채택)
  base_pay INTEGER NOT NULL,                         -- monthly면 월급, hourly면 시급
  nontax_json TEXT NOT NULL DEFAULT '{}',        -- 비과세 항목(식대 등) 이름 → 금액. 한도는 rate_tables(nontax_limits)로 막는다
  dependents INTEGER NOT NULL, children_8_20 INTEGER NOT NULL DEFAULT 0,    -- 공제대상가족 수, 8세 이상 20세 이하 자녀 수
  withholding_pct INTEGER CHECK(withholding_pct IN (80,100,120)) NOT NULL DEFAULT 100,
  pension_applies INTEGER NOT NULL DEFAULT 1, health_applies INTEGER NOT NULL DEFAULT 1, employment_applies INTEGER NOT NULL DEFAULT 1,   -- 보험별 적용 여부(연금 60세 이상 등)
  pension_base INTEGER, health_base INTEGER,          -- 국민연금 기준소득월액, 건강보험 보수월액. 고지내역에서 채우고 없으면 월급으로 예상
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(profile_id, id)
);
CREATE TABLE payroll_months (
  profile_id TEXT NOT NULL REFERENCES profiles(id), month TEXT NOT NULL,    -- 'YYYY-MM'
  revision INTEGER NOT NULL DEFAULT 1,                                     -- 확인 뒤 고치면 올린다(이미 준 명세서와 구분)
  status TEXT CHECK(status IN ('draft','confirmed')) NOT NULL,             -- 사장님이 확인하면 confirmed
  paid_on TEXT, rate_table_ids_json TEXT NOT NULL,                         -- 계산에 쓴 표의 id 목록(재현용)
  notice_doc_ids_json TEXT NOT NULL DEFAULT '[]',                          -- 넣은 4대보험 고지내역 파일들(S-06 후처리)
  confirmed_at TEXT, PRIMARY KEY(profile_id, month, revision)
);
CREATE TABLE payroll_lines (
  profile_id TEXT NOT NULL, month TEXT NOT NULL, revision INTEGER NOT NULL, employee_id TEXT NOT NULL,
  work_days INTEGER, work_minutes INTEGER, overtime_minutes INTEGER, night_minutes INTEGER, holiday_minutes INTEGER,   -- 임금대장 기재사항. 시간은 분 단위 정수로 두고 화면에서 시간으로 보인다. 사장님이 넣는 보조 입력이고, 가산·주휴 금액은 계산하지 않는다(ADR-034 결정 8 채택)
  items_json TEXT NOT NULL,                     -- 지급 항목별 [{name, amount, taxable, calc}]. calc는 임금명세서의 계산방법 문장
  gross INTEGER NOT NULL, nontax INTEGER NOT NULL,
  income_tax INTEGER NOT NULL, local_income_tax INTEGER NOT NULL,
  pension_est INTEGER NOT NULL, health_est INTEGER NOT NULL, ltc_est INTEGER NOT NULL, employment_est INTEGER NOT NULL,   -- 근로자 부담 예상치(요율 계산)
  pension_notice INTEGER, health_notice INTEGER, ltc_notice INTEGER, employment_notice INTEGER,   -- 근로자 부담 고지액(정본, 제안). 없으면 NULL
  employer_json TEXT NOT NULL,                  -- 사업주 부담분(연금·건강·장기요양·고용·산재, 예상치와 고지액). 인건비 총액에만 쓴다
  net_pay INTEGER NOT NULL,
  PRIMARY KEY(profile_id, month, revision, employee_id),
  FOREIGN KEY(profile_id, month, revision) REFERENCES payroll_months(profile_id, month, revision),
  FOREIGN KEY(profile_id, employee_id) REFERENCES employees(profile_id, id)
);
-- 2026-11-05 ADR-034 결정 8 채택: 근무표는 세전 → 세후 계산기로 좁혔다. 일별 시작·끝 입력이 없으므로 아래 shifts 테이블은 Phase 1 화면이 쓰지 않는다.
-- (제안, 데이터 트랙 확인 전) shifts를 지우고, 근무 시간 합계는 payroll_lines.work_minutes(보조 입력)만 쓴다. 가산·주휴 컬럼은 더하지 않는다.
CREATE TABLE shifts (                          -- 근무표(ADR-034 결정 8, D14 M6-15). 위 주석 참고
  id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, employee_id TEXT NOT NULL,
  work_day TEXT NOT NULL, starts_at TEXT NOT NULL, ends_at TEXT NOT NULL,   -- 'YYYY-MM-DD', 'HH:MM'(자정을 넘기면 ends_at < starts_at)
  break_minutes INTEGER NOT NULL DEFAULT 0, kind TEXT CHECK(kind IN ('planned','actual')) NOT NULL DEFAULT 'actual',
  updated_at TEXT NOT NULL,
  FOREIGN KEY(profile_id, employee_id) REFERENCES employees(profile_id, id)
); -- 달 합계는 payroll_lines의 work_minutes 등으로 넘긴다. 가산·주휴 판단 컬럼은 범위가 정해질 때 더한다
CREATE INDEX ix_shifts_month ON shifts(profile_id, employee_id, work_day);
CREATE TABLE rate_tables (                     -- 시행일 단위 표. 서명 데이터 패키지로 배포(D14 M6-10), 코드에 박지 않는다
  id TEXT PRIMARY KEY,
  kind TEXT CHECK(kind IN ('insurance_rate','pension_bounds','simple_tax_table','nontax_limits')) NOT NULL,
  effective_from TEXT NOT NULL, effective_to TEXT, body_json TEXT NOT NULL, rounding TEXT NOT NULL,   -- 표별 반올림·절사 규칙
  package_version TEXT NOT NULL, signature_ok INTEGER NOT NULL,
  UNIQUE(kind, effective_from)                 -- 기간이 겹치는 표는 패키지 검증에서 거부한다
);
-- 시행일 표 규칙(팀장 결정 2026-11-05, 데이터 PR #53·#67. 레지스트리 데이터 패키지 sax.rate-tables/v1 검증도 같다, D09 §8.4):
--   열린 표(effective_to NULL)는 같은 kind의 다음 표 시작 전날까지 유효하다.
--   겹침은 시작일이 같거나 닫힌 기간끼리 교차할 때만이다(열린 표 뒤에 새 표가 오는 것은 겹침이 아니다).
--   고르기: effective_from ≤ 그날(시작일 당일 포함)인 표 중 시작일이 가장 늦은 표. 그래서 새 표는 시작일 당일부터 쓴다. 그 표가 그날 전에 닫혔으면(effective_to < 그날. effective_to 당일까지는 유효) 표가 없다(rate_table_missing).

-- 세무사 꾸러미 (ADR-032, Phase 1 베타)
CREATE TABLE bundle_items (                    -- 꾸러미 항목 정의. 1층 고정·2층 업종 묶음·3층 사장님 추가
  id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id),
  tier INTEGER CHECK(tier IN (1,2,3)) NOT NULL, kind TEXT NOT NULL,       -- tax_invoice, payroll, card, paper_receipt, settlement_delivery, settlement_market, cash_sales, custom
  name TEXT NOT NULL, cadence TEXT CHECK(cadence IN ('monthly','quarterly','once')) NOT NULL DEFAULT 'monthly',
  enabled INTEGER NOT NULL DEFAULT 1, source TEXT CHECK(source IN ('builtin','industry','user','pasted_request')) NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE bundle_entries (                  -- 항목의 달별 상태와 첨부
  item_id TEXT NOT NULL REFERENCES bundle_items(id), period TEXT NOT NULL,   -- 'YYYY-MM' 또는 'YYYY-Qn'
  status TEXT CHECK(status IN ('missing','partial','ready','not_applicable')) NOT NULL,   -- not_applicable: 이번 달 해당 없음(사장님 표시)
  doc_ids_json TEXT NOT NULL DEFAULT '[]', note TEXT, updated_at TEXT NOT NULL,
  PRIMARY KEY(item_id, period)
);
CREATE TABLE bundle_exports (                  -- 내보내기 기록("어디로 무엇이 갔는지"). 한 번 내보내면(회차) 한 행
  id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id), period TEXT NOT NULL,
  sha256 TEXT NOT NULL, path TEXT NOT NULL, created_at TEXT NOT NULL,   -- 암호 엑셀 파일
  zip_sha256 TEXT, zip_path TEXT,               -- 같은 암호의 AES-256 ZIP(사진·PDF). 첨부가 없으면 둘 다 NULL
  rrn_included INTEGER NOT NULL DEFAULT 0,      -- 급여 시트(엑셀)에 주민번호 전체를 넣었는지. 기본 0(가림), 사장님이 설정 bundle.includeRrn을 켰을 때만 1(R13 D-L3 결정)
  send_via TEXT CHECK(send_via IN ('mail_client','folder')),   -- (채택, ADR-034 결정 10 (가)) 메일 프로그램에 첨부를 붙여 열었는지, 폴더만 열었는지
  sent_to TEXT,                                -- 연 시점의 "내 세무사" 주소(설정 bundle.accountantEmail). 실제 발송 여부는 메일 프로그램이 안다
  sent_marked_at TEXT, sent_note TEXT,         -- 사장님이 "보냈어요"로 표시한 시각과 메모
  CHECK((zip_sha256 IS NULL) = (zip_path IS NULL))
);
CREATE TABLE card_fetches (                    -- H-12 조회 구간. [최신화]는 구간의 행을 통째로 바꾼다
  run_id TEXT PRIMARY KEY REFERENCES runs(id), profile_id TEXT NOT NULL REFERENCES profiles(id),
  range_from TEXT NOT NULL, range_to TEXT NOT NULL, row_count INTEGER NOT NULL, completed_at TEXT NOT NULL
);
-- "마지막 최신화"는 card_fetches의 마지막 completed_at이다(빈 결과도 최신화다)
CREATE TABLE card_txns (                       -- H-12 사업용 카드 사용내역
  -- [최신화] 한 번은 트랜잭션 하나다: (1) 이 프로필의 used_on ∈ [range_from, range_to] 행을 어느 조회에서 왔든 모두 지운다
  -- (2) 새 결과를 seq 순서로 넣는다 (3) 메모를 match_key로 다시 잇는다. 그래서 같은 구간을 몇 번 눌러도 결과가 같다
  id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id), fetch_run_id TEXT NOT NULL REFERENCES card_fetches(run_id),
  seq INTEGER NOT NULL,                        -- 조회 결과 안의 순번
  used_on TEXT NOT NULL, merchant TEXT, merchant_biz_no TEXT, card_last4 TEXT, approval_no TEXT,
  amount INTEGER NOT NULL, supply_amount INTEGER, vat_amount INTEGER, canceled INTEGER NOT NULL DEFAULT 0,
  UNIQUE(fetch_run_id, seq)
);                                             -- 용도 분류·경비 판단 컬럼은 두지 않는다
CREATE INDEX ix_card_txns_day ON card_txns(profile_id, used_on);
CREATE TABLE card_txn_memos (                  -- 사장님 메모. 구간을 바꿀 때 승인번호(없으면 날짜·가게·금액·카드)로 다시 매칭
  id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id),
  match_key TEXT NOT NULL,                     -- 사용일·승인번호·취소 여부·금액(승인번호가 없으면 날짜·가게 사업자번호·금액·카드·취소 여부). 승인번호 키에도 사용일을 붙인다(승인번호는 달이 바뀌면 재사용돼 날짜 없이는 다른 달 메모를 덮어쓴다). 같은 값이 여러 건이면 seq 순서의 순번 '#n'을 붙인다. 승인과 그 취소는 취소 여부로 갈린다
  txn_id TEXT REFERENCES card_txns(id) ON DELETE SET NULL,   -- 행을 지우면 NULL이 되고 (3)에서 다시 잇는다. 못 이으면 화면에 "메모 대상 확인 필요"
  memo TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(profile_id, match_key)                -- 같은 키에 메모 둘이 붙지 않게
);
CREATE TABLE receipts (                        -- 종이 증빙. 원본은 documents(doc_type='paper_receipt')
  doc_id TEXT PRIMARY KEY REFERENCES documents(id),
  source TEXT CHECK(source IN ('pc_file','phone_capture')) NOT NULL,   -- phone_capture는 폰 앱(P-08)에서 E2EE로 받은 것(ADR-034)
  phone_msg_id TEXT UNIQUE,                    -- 폰 봉투의 메시지 ID(중복 수신 방지, D14 M7-4). PC 파일이면 NULL
  issued_on TEXT, merchant TEXT, merchant_biz_no TEXT, amount INTEGER,
  phone_ocr_json TEXT,                         -- 폰이 기기 안 OCR로 읽은 후보(제안). PC는 이 값을 믿지 않고 아래 샌드박스 결과와 나란히 보여 준다
  ocr_json TEXT,                               -- 샌드박스 OCR 원결과(로컬 전용)
  confirmed_at TEXT                            -- 사장님이 읽어 낸 값을 확인한 시각
);
CREATE TABLE cash_sales (                      -- 영수증을 발행하지 않은 현금매출. 하루 한 숫자
  profile_id TEXT NOT NULL REFERENCES profiles(id), day TEXT NOT NULL, amount INTEGER NOT NULL, entered_at TEXT NOT NULL,
  source TEXT CHECK(source IN ('pc','phone')) NOT NULL DEFAULT 'pc',   -- 폰(P-09, 제안)과 PC가 같은 날을 넣으면 나중 값으로 바꾸고 화면에 알린다
  PRIMARY KEY(profile_id, day)
);
```

원칙: 비밀 컬럼 없음. `inputs_json_enc`·`context_json_enc`·`temp_previews.body_enc`는 DB 키로 암호화된 컬럼이며, 비밀 참조(`secret_ref`)는 종류 이름만 담고 게이트 토큰·`runKey`는 절대 저장하지 않는다. 저널(`run_events`)은 상태 전이 기록이고, 재시작 복원은 원장·게이트·실행 테이블 상태 승격이다(D-45(N-71)).

급여·세무사 꾸러미(ADR-031·032):
- 테이블은 로컬 전용이며 서버 색인(§3·§5)에 올리지 않는다. 원본 파일은 `documents` 행으로 들어가는데, 그 doc_type(`paper_receipt`, `insurance_notice`, `settlement_file`, `payroll_ledger`, `pay_statement`, `bundle_export`)은 서버 색인을 끈 채 고정하고 설정으로도 켤 수 없다.
- 주민번호(`employees.rrn_enc`)는 마스킹 계층(D06)의 주민번호 규칙 대상이다. 다만 Phase 1 보관함은 평문 PDF라(§1.4) 고지내역·급여대장·임금명세서 파일에는 주민번호가 평문으로 남을 수 있다. 화면과 설정에 이 점을 적는다.
- 꾸러미 내보내기(팀장 결정 2026-11-05, ADR-032 결정 8):
  - 첨부는 두 파일이다. 암호 엑셀(ECMA-376 암호화)과, 사진·PDF가 있으면 같은 암호의 AES-256 ZIP이다. 사진·PDF를 암호 밖에 두지 않는다. 메일 창(ADR-034 결정 10 (가))에는 두 파일과 받는 쪽 안내 문구(예: "암호는 따로 알려 드려요. ZIP은 반디집·알집·7-Zip으로 여세요". 최종 문구는 화면 트랙)가 함께 들어간다. 운영체제 기본 압축 풀기가 AES ZIP을 못 여는 경우가 있어서다(데이터 PR #58 본문).
  - 급여 시트의 주민번호는 근거 확인 전 **가림이 기본**이다(R13 D-L3, yulmu 결정 2026-11-05). 사장님이 설정 `bundle.includeRrn`을 켜면 전체 번호를 넣고, 그 회차 행의 `bundle_exports.rrn_included`를 1로 남긴다(엑셀과 ZIP은 한 행에 함께 적는다). 처리 근거 질의(R13 Q9) 회신에 따라 기본값을 다시 본다.
  - [급여 기록 내보내기](08 D-06, 3년 보관용)에는 주민번호를 넣지 않는다.
  - "증빙과 대조되지 않은 카드 지출"은 '빠진 것' 시트와 화면에 표시만 한다. 판정하지 않고, 화면에서는 기본으로 접는다. 사장님이 "카드 전표로 충분"에 체크하면 다음 달부터 이 목록을 뺀다. 체크는 건마다가 아니라 사업장 설정 한 칸 `settings` `profile.<id>.bundle.cardSlipEnoughFrom`(시작 달)이고, 끄면 지우고 목록이 돌아온다(데이터 트랙 결정, decisions.tsv 2026-11-05 M6-14, PR #58). 건별 표시가 필요해지면 `card_txn_memos`에 표시 칸을 더한다.
- 월초 "세무사 꾸러미 준비됨" 알림은 `schedules`(서류 갱신용) 행이 아니라 설정 `bundle.reminderDay`·`payroll.halfYearWithholding`으로 데몬 `notify`가 계산한다.
- 설정(ADR-034): `bundle.accountantEmail`("내 세무사" 주소, 채택(ADR-034 결정 10). 로컬 설정이고 서버로 보내지 않는다), `bundle.industries`(2층 업종), `payroll.enabled`(급여대장 켬, 기본 끔. 끄면 레일에서 숨긴다), `payroll.shiftsEnabled`(근무표 = 세후 계산기 켬, 기본 끔), `bundle.includeRrn`(꾸러미 급여 시트에 주민번호 전체를 넣음, 기본 끔, R13 D-L3). 이 다섯은 프로필마다 다르므로 키에 프로필 ID를 붙여 `profile.<id>.bundle.accountantEmail`처럼 저장한다. `bundle.reminderDay`·`payroll.halfYearWithholding`도 같다.
- 이번 달 판(ADR-033)은 따로 테이블을 두지 않는다. `bundle_entries`·`documents`·`schedules`·거래처 발급 이력에서 매번 계산한다.
- 폰에서 받은 사진·현금매출(ADR-034)은 PC에 저장된 뒤에만 이 테이블에 들어간다. 폰 쪽 임시 보관은 앱 샌드박스의 파일 보호 등급 파일(iOS `NSFileProtectionComplete`, Android 앱 전용 저장소)로, 백업에서 빼고 카메라 롤·갤러리에는 저장하지 않는다. 파일 암호화 키만 `ThisDeviceOnly` 키 저장소에 둔다. PC가 받았다고 확인하면 지운다(D08 §3.1, D14 M7-4).
- 임금대장은 3년 보존 의무가 있다. 로컬 전용이라 PC를 잃으면 함께 사라지므로, Phase 2 E2EE 백업 범위에 넣을지 Phase 2 설계 때 정한다.

- 원장 규칙(B-10, ADR-042): 키는 `(intent_id, step_id, attempt)`다. 새 시도는 새 게이트 토큰 소비와 한 트랜잭션에서만 생기고, 같은 (intent, step)의 어느 시도든 `committed`이거나 종결되지 않은 행이 있으면 금지다(앞선 시도가 모두 `not_committed`일 때만). 앞선 시도의 사유·`verify_ref`는 감사 근거로 남는다. 같은 `intent_id`로 들어온 새 실행의 `inputs_hash`·`playbook_id`가 원장과 다르면 거부한다. '사후 스텝 점프'는 같은 `run_id`의 재개에만 적용한다(D03 §4).
- `schedules.consent_json`(B-27): `deviceSig`는 동의한 기기의 `Vx` 서명이며 문맥은 `"SAX-consent-v1"`(D08 §2.1)이다. 설치된 패키지의 `major`나 `effects`가 동의 당시와 다르면 `notify`로 강등하고 재동의를 받는다.

## 3. 문서 종류와 유효기간 규칙표 (초기값, 사용자 조정 가능)

"서버 색인" 열은 doc_type별 서버 색인의 기본값(켬·끔)이다(C-09). 계정의 '백업(메타데이터 동기화)' 스위치를 켠 경우에만 적용되고(Phase 2, 스위치가 꺼져 있으면 어떤 종류도 올라가지 않는다), 기본으로 켜진 종류가 있으므로 이 설정을 '옵트인'이라 부르지 않는다(2026-11-02 용어 정리). 꺼진 종류는 서버에 **인덱스 행이 없고**(키 객체만 있다, §5), 조회 에이전트는 그 종류에 답하지 못한다고 UI에 표시한다. 사용자는 설정에서 종류별로 바꿀 수 있다(`settings['index.docTypeEnabled']`). 단 표에서 "끔(고정)"인 종류는 바꿀 수 없다.

| doc_type | 한글 | 발급 포털 | 기본 유효(일) | 규칙 | 서버 색인 기본 | 비고 |
|---|---|---|---|---|---|---|
| `tax_invoice` | 전자세금계산서 | 홈택스 | — | none | 끔 | 만료 개념 없음. 월별 건수가 거래량을 드러낸다 |
| `biz_registration_cert` | 사업자등록증명 | 홈택스 | 90 | fixed_days | **켬** | 제출처 관행 기준 |
| `national_tax_cert` | 납세증명서(국세) | 홈택스 | 30 | fixed_days | **켬** | 증명서에 유효기간 명시 → `doc_meta_check`로 추출 우선 |
| `resident_copy` / `resident_abstract` | 주민등록 등본/초본 | 정부24 | 90 | fixed_days | 끔 | 세대 정황 |
| `localtax_cert` | 지방세 납세증명 | 정부24 | 30 | fixed_days | **켬** | 문서 명시 우선 |
| `localtax_item_cert` | 지방세 세목별 과세증명 | 정부24 | 90 | fixed_days | 끔 | 부동산 정황 |
| `nhis_eligibility` | 건강보험 자격득실확인서 | 정부24 | 90 | fixed_days | 끔 | 고용 변동 정황, 민감정보 해당 가능성(법무 확인) |
| `land_register` / `building_register` | 토지·건축물대장 | 정부24 | 90 | fixed_days | 끔 | 부동산 정황 |
| `sme_cert` | 중소기업확인서 | SMINFO | — | fiscal_year_rule | **켬** | 직전 사업연도 말일 + 3개월부터 1년(기본), 문서 명시 우선 |
| `insure4_cert` | 4대보험 완납증명 | 4대보험센터 | 30 | fixed_days | 끔 | 직원 존재 정황 |
| `paper_receipt` | 종이 증빙 사진 | 사용자 첨부 | — | none | **끔(고정)** | 세무사 꾸러미(ADR-032) |
| `insurance_notice` | 4대보험 고지내역 | 사용자 첨부(S-06 후처리) | — | none | **끔(고정)** | 직원별 금액·주민번호 포함 가능 |
| `settlement_file` | 배달앱·오픈마켓 정산내역 | 사용자 첨부(J-01·J-02) | — | none | **끔(고정)** | 매출 규모 정황 |
| `payroll_ledger` / `pay_statement` | 급여대장 / 임금명세서 | 앱이 만듦(ADR-031) | — | none | **끔(고정)** | 급여·주민번호 |
| `bundle_export` | 세무사 꾸러미 엑셀 | 앱이 만듦(ADR-032) | — | none | **끔(고정)** | 암호 걸린 묶음 |

"끔(고정)" 종류는 `index.docTypeEnabled`에 넣지 않고, 설정 화면에도 켜고 끄는 칸을 두지 않는다. 앱은 업로드 직전에 이 목록을 다시 확인해 행을 만들지 않는다.

규칙 평가: 문서 텍스트에서 유효기간이 추출되면 그것이 우선(`doc_meta_check_v1` 통과 시). 없으면 규칙표. 둘 다 없으면 "만료 미정"으로 표시하고 알림 없음.

## 4. 보관함 파일 레이아웃

```text
%LOCALAPPDATA%\SovereignAX\vault\
  tax_invoice_20261027_7K3P.pdf
  resident_copy_20261027_Q2MZ.pdf
  localtax_cert_20261027_9FAB.pdf
```
**파일명에 PII를 넣지 않는다**: 기본 템플릿 `{docType}_{yyyyMMdd}_{shortId}.pdf`, 표시 이름(거래처·승인번호 등)은 DB `documents.display_name`에 둔다. 플레이북 IR의 `save_pdf.nameTemplate`은 D02 §6 V-23(B-25)으로 허용 토큰(`docType`·날짜·`shortId`)만 쓸 수 있다(상충 B/C-09, A/C-07). 사용자가 '내보내기'할 때만 사람이 읽는 이름으로 사본을 만든다. 사용자가 파일을 옮기면 DB의 `path`는 다음 스캔에서 `sha256`으로 재연결.

## 5. 클라우드 메타데이터 인덱스 (서버 스키마, 최소) (C-09·C-12·C-13·C-08)

논리 레코드는 `{account_id, slot_token, doc_id, doc_type, issued_month, expires_on, blob_id, wdek, kek_ver, rev, sig}` 하나다. 물리적으로는 백업 정책이 다른 두 테이블로 나눈다.

```sql
-- 키 객체(wDEK 테이블): 모든 백업 문서. DB 정기 백업에서 제외하거나 보존 ≤ 7일인 별도 저장소에 둔다 (C-08)
CREATE TABLE doc_keys (
  account_id UUID NOT NULL,
  doc_id UUID PRIMARY KEY,                 -- UUIDv4. 시각 비포함
  blob_id UUID NOT NULL,                   -- 서버가 발급한 무작위 UUID
  wdek BYTEA NOT NULL, kek_ver SMALLINT NOT NULL,
  rev BIGINT NOT NULL,                     -- 문서별 단조 증가. 서버도 rev ≤ 저장값인 PUT을 거부
  signer_device_id UUID NOT NULL,          -- 서명한 데스크톱(AIK 서명 기기 목록의 role=desktop)
  sig BYTEA NOT NULL                       -- Sign_Vd(아래 canonical)
);
-- 조회용 인덱스: 서버 색인이 켜진 종류만 행이 있다
CREATE TABLE doc_index (
  account_id UUID NOT NULL,
  slot_token BYTEA NOT NULL,               -- 계정별 무작위 16B. 슬롯 번호·종류 의미 없음
  doc_id UUID PRIMARY KEY REFERENCES doc_keys(doc_id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL,                  -- 열거형 사전만
  issued_month CHAR(7),                    -- 'YYYY-MM' (일 단위 발급일 없음)
  expires_on DATE
);
CREATE INDEX ON doc_index(account_id, slot_token, doc_type, expires_on);
```

- 레코드 무결성: `sig = Sign_Vd("SAX-docrec-v1" ‖ canonical-CBOR{doc_id, blob_id, doc_type, issued_month, expires_on, wdek, kek_ver, rev})`. 색인이 꺼진 문서는 `doc_type`·`issued_month`·`expires_on`을 `null`로 넣어 서명한다. 대칭 키 `K_meta`는 **없앴다**. 폰은 `K_meta`를 받지 않고 AIK 서명 기기 목록의 `Vd`로 검증만 한다. 폐기된 폰은 레코드를 위조할 수 없다(C-12).
- 클라이언트는 문서별 최고 `rev`(`documents.index_rev_max`)를 저장하고 더 낮은 `rev`를 거부한다. 서버가 만료일을 바꾸거나 옛 레코드로 롤백하면 서명·`rev` 검사에서 걸린다.
- **없는 것**: 파일명, 상호, 사업자번호, 금액, 승인번호, 경로, **크기(`bytes`)**, **초 단위 갱신 시각(`client_updated_at`)**, **일 단위 발급일**, **dedup 토큰**. 동기화 충돌은 `rev`로 판정한다(D09 §6).
- 서버가 알 수 있는 것(정직한 서술, 상충 C/X-05): 프로필 슬롯 개수, 그리고 사업자 프로필이 있으면 `profile_slots.biz_hmac`이 있으므로 '사업자 프로필 보유' 여부를 안다. 사업자번호·상호는 모른다. 슬롯 번호는 종류를 뜻하지 않는다.
- dedup(C-13): 서버 `dedup_token`을 **삭제**했다. 중복 판단은 로컬 `documents.sha256 → blob_id` 매핑으로만 한다. 새 PC 복구 시에는 블롭 안의 암호화된 문서 머리(§6)에서 `sha256`을 되살려 매핑을 다시 만든다.
- `K_idx`는 dedup에 쓰지 않는다. 남은 용도는 프로필 사업자 HMAC(B-28, Phase 1부터)과 업무 키 표시 HMAC(`biz_key_marks`, B-30, Phase 2·데스크톱 2대 계정, ADR-024)이며 서버 테이블은 D09 §2·§6에 있다.
- **발급 활동 표시**(정직한 서술, E-07, ADR-024): 위 "없는 것" 원칙의 예외로, Phase 2에서 폐기되지 않은 데스크톱이 2대 이상이고 백업(메타데이터 동기화)을 켠 계정에서는 서버 `biz_key_marks`에 업무 키 HMAC·상태(`armed`·`committed`·`in_doubt`·`observed_manual`)·일 단위 날짜가 90일(`armed`는 10분) 남는다. 초 단위 시각은 없지만 서버는 이것으로 계정별 발급 건수·영업 리듬과 게이트 조회 시각을 안다. 백업을 끄거나 PC가 한 대면 이 기록이 없고, 기기 간 중복 경고는 PC가 포털 발급목록 기준선으로만 한다(D09 §6, D03 §4). Phase 1에는 이 기록이 없다.

- 서버 메타데이터(`doc_index`)·`biz_key_marks` 테이블에는 생성·갱신 시각 컬럼을 두지 않는다(감사는 `day`만). `track_commit_timestamp=off`. 스키마 린트가 `*_at`·`timestamp`·`timestamptz` 컬럼을 막는다(ADR-029, D-52(N-83)). 백업·WAL 보존은 D09 §10.

## 6. E2EE 블롭 봉투

```text
키 객체(doc_keys에 저장, 블롭과 분리): wDEK = AEAD(KEK_N, DEK, nonce, ad = "SAX-dek-v1" ‖ blob_id ‖ kek_ver)
데이터 객체: header = {v:1, alg:"xchacha20poly1305-stream", blob_id, doc_id, chunk_size}   # 불변 필드만, AAD에 포함
            body   = 청크 STREAM(secretstream 또는 청크별 AEAD, 청크 AD = H(header) ‖ chunk_no ‖ final)
                     첫 청크 = 암호화된 문서 머리 CBOR{doc_type, issued_at, expires_at, display_name, sha256}
                     전체 길이는 Padmé 패딩 (서버는 패딩된 크기만 본다)
레코드 서명: Sign_Vd("SAX-docrec-v1" ‖ canonical{doc_id, blob_id, doc_type, issued_month, expires_on, wdek, kek_ver, rev})  (§5)
```

- `header.alg`가 알고리즘 식별자다. 새 스위트는 `v`를 올려 공존시킨다(D08 §2).
- AAD의 `blob_id`·`doc_id`로 서버가 블롭을 맞바꾸는 공격을 막는다.
- 키 계층은 D08 §3을 따른다: RK(첫 PC가 무작위로 생성) → `KEK_N = HKDF(RK, "kek/blob/vN" ‖ salt_N)`(파일 DEK 래핑), `K_idx`(프로필 사업자 HMAC, Phase 2부터 업무 키 표시, ADR-024). 복구 문구와 `K_chk`는 없다. 기기별 랜덤 키(Noise·서명·inbox)는 RK와 분리한다. 계정 신뢰 앵커는 첫 PC가 만든 AIK다. RK·AIK의 래핑 사본은 페어링된 폰과 사용자가 고른 두 번째 PC에만 있고 서버에는 없다(ADR-016 v2·ADR-029, D-16(N-09)). 폰은 문서를 열 때 그 문서의 wDEK만 받아 쓰고 대량 동기화하지 않는다(C-07).
- **KEK 회전의 한계(C-07)**: 키 객체가 분리되어 있어 KEK 회전은 wDEK 재래핑만으로 끝나지만, 이것은 **아직 wDEK를 받지 않은 문서**에 대해서만 폐기 기기의 접근을 막는다. DEK는 바뀌지 않으므로 폐기 전에 기기가 받은 wDEK의 문서는 블롭을 재암호화하지 않으면 계속 열 수 있다. PC·폰 도난이면 새 RK·전체 재암호화가 필요하다. 절차는 D08 §9.
- **키-객체 분리는 운영 편의(회전·삭제)이지 기밀성 분리가 아니다(C-08).** 키 객체와 블롭은 같은 운영자 안에 있다. 기밀성은 클라이언트만 가진 KEK에서 온다.
- 평문 해시·평문 해시의 HMAC은 서버에 보내지 않는다. 정부 서류는 양식이 고정되고 가변 필드 엔트로피가 낮아 평문 해시가 사전 대입에 취약하다.
- 블롭·메타데이터 저장소는 국내 리전에 둔다(개인정보보호법 제28조의8 국외이전 요건 회피). 공급사 가정은 D09 §9.1.
- **삭제 순서와 완료 시점(C-08)**: (1) 클라이언트가 키 객체(`doc_keys` 행)를 먼저 지우고 (2) 서버가 블롭을 지운다(유예 규칙은 D09 §2·§5). (3) 블롭 버전·백업은 30일 내 소거한다. wDEK 백업은 ≤ 7일만 보존하므로 **문서 삭제의 암호적 완료 시점은 'wDEK 백업 보존 만료 시점'**이다. 그 뒤 남은 블롭 백업은 키가 없어 복호할 수 없다. 이 날짜를 투명성 페이지와 삭제 확인 화면에 표시한다.

## 7. 마이그레이션

- Phase 2 폰 복구 묶음에 DB 키 래핑 사본을 넣는다(ADR-029, D-22(N-30)).
- 스키마 버전 테이블 + 전진 전용 마이그레이션. 앱 업데이트 시 자동 적용, 실패 시 이전 버전 DB 백업 유지(`db\` 아래, 같은 DACL).
- 플레이북 입력 스키마 변경(major)은 `runs.inputs_json_enc` 재개 불가 → 사용자에게 "다시 시작" 안내. 재개는 같은 `runs.package_digest`가 설치되어 있을 때만 한다(B-13).
- v1.2 → v1.3: `documents.dedup_token` 제거, `irreversible_log` PK 교체(`intent_id` → `(intent_id, step_id)`, 기존 행은 `step_id`를 저널에서 채움), `profiles.keep_session` 기본값 0(기존 행 값은 유지하되 온보딩에서 다시 묻는다). 서버 `doc_index`의 `bytes`·`client_updated_at`·`dedup_token`·일 단위 날짜는 삭제하고 월 단위로 재기록한다.

## 8. PDF 텍스트 추출 메모(R3)

- `pdfjs-dist`로 한글 텍스트 추출. 공백이 U+0001로 나오는 경우가 있어 정규화한다. ToUnicode 맵이 없는 PDF는 추출이 깨지므로 S13에서 부재율을 측정한다.
- `mupdf` npm은 AGPL이라 제외. OCR 폴백은 `tesseract.js` + `@tesseract.js-data/kor`(사진 `4.0.0_best_int`, 증명서 `4.0.0`. ~~번들 `kor_fast`~~는 그 패키지에 없다, docparse PR #78), 그 다음 OS OCR.

## 9. 평문 잔존 지점과 처리(R-B D-4·D-5, 상충 A/C-01·A/C-02)

- 엔진·메인 크래시 덤프: 로컬 생성(`%LOCALAPPDATA%\SovereignAX\crashDumps\`)은 사용자 요청 시에만, **업로드 금지**(DB 키·토큰·PII 포함 가능). 금고는 덤프 비활성(D05 §8).
- 전용 Chrome 프로필: 비밀번호 저장·자동완성·동기화 끔, 종료 시 캐시 정리, `keep_session`은 DDL 기본값부터 0이다(A-27).
- 임시 데이터: 마스킹 미리보기는 디스크 대신 **DB 암호화 컬럼**(`temp_previews`, 24시간 TTL)에 둔다. 캡차 크롭은 **메모리에만** 두고 응답 즉시 버린다(디스크·DB 모두 쓰지 않는다).
- 다운로드 스테이징: 보관함으로 옮긴 즉시 삭제, 기동 시 잔존 파일 정리.
- 클립보드(후처리 복사 버튼): 30초 뒤 값이 그대로면 비운다.
