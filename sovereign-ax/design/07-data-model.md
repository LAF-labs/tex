# D07. 데이터 모델

## 1. 저장소 개관

| 저장소 | 위치 | 암호화 | 내용 |
|---|---|---|---|
| 로컬 DB | `%LOCALAPPDATA%/SovereignAX/db.sqlite` (Win), `~/Library/Application Support/SovereignAX/` (mac) | `better-sqlite3-multiple-ciphers`, 32바이트 키는 키체인 | 프로필(비밀 없음), 거래처, 문서 메타, 실행·감사, 스케줄, 카운터, 설정 |
| 서류 보관함 | 사용자 지정 폴더(기본 `문서/소버린AX/`) | 평문 PDF(사용자 소유 파일). 옵션: 보관함 폴더 자체 암호화는 OS 기능(BitLocker/FileVault) 안내. Windows Controlled Folder Access가 켜져 있으면 문서 폴더 쓰기가 차단될 수 있으므로 실패를 감지해 허용 안내 또는 `%LOCALAPPDATA%` 폴백 | `세금계산서/2026/10/…pdf`, `민원/등본/…pdf` |
| 로컬 임시 | 앱 데이터 아래 `tmp/` | 평문, 24h 자동 삭제 | 마스킹 미리보기, 캡차 크롭(응답 즉시 삭제) |
| 클라우드 블롭 | S3 호환 | 클라이언트 E2EE(XChaCha20-Poly1305, 파일별 DEK) | PDF 암호문 |
| 클라우드 메타데이터 | PostgreSQL | 전송·저장 암호화(서버 측) | 종류·날짜·크기·dedup 토큰 |

## 2. 로컬 SQLite 스키마 (요약 DDL)

```sql
CREATE TABLE profiles (
  id TEXT PRIMARY KEY, kind TEXT CHECK(kind IN ('personal','business')) NOT NULL,
  display_name TEXT NOT NULL, biz_no TEXT, corp_no TEXT, rep_name TEXT, biz_type TEXT, biz_item TEXT,
  address TEXT, email TEXT, sign_method TEXT CHECK(sign_method IN ('cert','simple_auth','security_card',NULL)),
  keep_session INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
-- 계정당 kind별 1개: 앱 레벨 + 서버 계정 슬롯으로 이중 강제
CREATE UNIQUE INDEX ux_profiles_kind ON profiles(kind);

CREATE TABLE counterparties (
  id TEXT PRIMARY KEY, biz_no TEXT NOT NULL, name TEXT NOT NULL, rep_name TEXT, address TEXT, email TEXT,
  verified_at TEXT, verified_status TEXT, source TEXT CHECK(source IN ('manual','ocr','hometax')),
  last_used_at TEXT, use_count INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX ux_cp_bizno ON counterparties(biz_no);

CREATE TABLE documents (
  id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id),
  doc_type TEXT NOT NULL,            -- tax_invoice, resident_copy, localtax_cert, nhis_eligibility, sme_cert, ...
  issued_at TEXT, expires_at TEXT, issuer TEXT, path TEXT NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL,
  dedup_token TEXT NOT NULL,         -- HMAC(user_index_key, sha256)
  meta_json TEXT,                    -- 종류별 추가 필드(승인번호 등). 로컬 전용
  backup_state TEXT CHECK(backup_state IN ('none','pending','uploaded','failed')) NOT NULL DEFAULT 'none',
  blob_id TEXT, run_id TEXT, created_at TEXT NOT NULL
);
CREATE INDEX ix_documents_expiry ON documents(profile_id, doc_type, expires_at);

CREATE TABLE validity_rules (
  doc_type TEXT PRIMARY KEY, default_days INTEGER, rule TEXT NOT NULL,   -- 'fixed_days' | 'fiscal_year_rule' | 'none'
  user_override_days INTEGER, remind_days TEXT NOT NULL DEFAULT '7,1'
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY, playbook_id TEXT NOT NULL, playbook_version TEXT NOT NULL, profile_id TEXT NOT NULL,
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

CREATE TABLE irreversible_log (              -- 아이덴포턴시 원장 (D03 §4). 선행 기록(write-ahead)
  intent_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, step_id TEXT NOT NULL, business_key TEXT NOT NULL,
  state TEXT CHECK(state IN ('armed','dispatched','committed','not_committed','in_doubt')) NOT NULL,
  armed_at TEXT NOT NULL, dispatched_at TEXT, resolved_at TEXT, verify_ref TEXT, device_id TEXT NOT NULL
);
CREATE INDEX ix_irr_business ON irreversible_log(business_key, state);

CREATE TABLE schedules (
  id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, doc_type TEXT NOT NULL, playbook_id TEXT NOT NULL,
  mode TEXT CHECK(mode IN ('notify','semi_auto','auto')) NOT NULL, window_json TEXT NOT NULL,
  consent_json TEXT NOT NULL, next_due_at TEXT, last_run_id TEXT, enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE rate_counters (                 -- D03 §7. KST, 증가 커밋 → 행동
  portal TEXT NOT NULL, profile_id TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL,  -- runs_day | irreversible_day | navigations_min | logins_day | captcha_10m | login_session
  bucket TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(portal, profile_id, kind, bucket)
);
CREATE TABLE clock_guard (id INTEGER PRIMARY KEY CHECK(id=1), last_seen_at TEXT NOT NULL);
CREATE TABLE cooldowns (portal TEXT PRIMARY KEY, until TEXT NOT NULL, reason TEXT NOT NULL);

CREATE TABLE playbook_packages (
  id TEXT NOT NULL, version TEXT NOT NULL, channel TEXT NOT NULL, signature_ok INTEGER NOT NULL,
  installed_at TEXT NOT NULL, manifest_json TEXT NOT NULL, PRIMARY KEY(id, version)
);
CREATE TABLE policy (version TEXT PRIMARY KEY, body_json TEXT NOT NULL, signature_ok INTEGER NOT NULL, installed_at TEXT NOT NULL);

CREATE TABLE usage_local (month TEXT PRIMARY KEY, l1_input_tokens INTEGER, l2_input_tokens INTEGER, l2_output_tokens INTEGER, cost_usd REAL);
CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
CREATE TABLE remote_devices (device_id TEXT PRIMARY KEY, name TEXT, noise_pub BLOB NOT NULL, paired_at TEXT NOT NULL, last_seen_at TEXT, revoked INTEGER NOT NULL DEFAULT 0);
```

원칙: 비밀 컬럼 없음. `inputs_json_enc`·`context_json_enc`는 재개용이며 비밀 참조(`secret_ref`)는 종류 이름만, 게이트 토큰·`runKey`는 절대 저장하지 않는다. 저널(`run_events`)이 상태의 단일 진실이다.

## 3. 문서 종류와 유효기간 규칙표 (초기값, 사용자 조정 가능)

| doc_type | 한글 | 발급 포털 | 기본 유효(일) | 규칙 | 비고 |
|---|---|---|---|---|---|
| `tax_invoice` | 전자세금계산서 | 홈택스 | — | none | 만료 개념 없음 |
| `biz_registration_cert` | 사업자등록증명 | 홈택스 | 90 | fixed_days | 제출처 관행 기준 |
| `national_tax_cert` | 납세증명서(국세) | 홈택스 | 30 | fixed_days | 증명서에 유효기간 명시 → `doc_meta_check`로 추출 우선 |
| `resident_copy` / `resident_abstract` | 주민등록 등본/초본 | 정부24 | 90 | fixed_days | |
| `localtax_cert` | 지방세 납세증명 | 정부24 | 30 | fixed_days | 문서 명시 우선 |
| `localtax_item_cert` | 지방세 세목별 과세증명 | 정부24 | 90 | fixed_days | |
| `nhis_eligibility` | 건강보험 자격득실확인서 | 정부24 | 90 | fixed_days | |
| `land_register` / `building_register` | 토지·건축물대장 | 정부24 | 90 | fixed_days | |
| `sme_cert` | 중소기업확인서 | SMINFO | — | fiscal_year_rule | 직전 사업연도 말일 + 3개월부터 1년(기본), 문서 명시 우선 |
| `insure4_cert` | 4대보험 완납증명 | 4대보험센터 | 30 | fixed_days | |

규칙 평가: 문서 텍스트에서 유효기간이 추출되면 그것이 우선(`doc_meta_check_v1` 통과 시). 없으면 규칙표. 둘 다 없으면 "만료 미정"으로 표시하고 알림 없음.

## 4. 보관함 파일 레이아웃

```text
소버린AX/
  세금계산서/2026/10/㈜거래처_20261027_12345678-12345678-12345678.pdf
  민원/등본/홍길동_20261027.pdf
  민원/지방세납세증명/㈜우리회사_20261027.pdf
  .index/ (앱 전용, 숨김) — 없음. 인덱스는 DB에만
```
파일명 템플릿은 플레이북 `nameTemplate`. 충돌 시 `_2` 접미. 사용자가 파일을 옮기면 DB의 `path`는 다음 스캔에서 `sha256`으로 재연결.

## 5. 클라우드 메타데이터 인덱스 (서버 스키마, 최소)

```sql
CREATE TABLE doc_index (
  account_id UUID NOT NULL, profile_slot SMALLINT NOT NULL CHECK(profile_slot IN (1,2)),
  doc_id UUID PRIMARY KEY, doc_type TEXT NOT NULL, issued_at DATE, expires_at DATE,
  bytes INTEGER NOT NULL, blob_id UUID, dedup_token TEXT NOT NULL, client_updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX ON doc_index(account_id, profile_slot, doc_type, expires_at);
```
- 없는 것: 파일명, 상호, 사업자번호, 금액, 승인번호, 경로. `profile_slot`은 1/2일 뿐 종류(개인/법인)도 서버는 모른다(클라이언트가 안다).
- `dedup_token = HMAC-SHA256(user_index_key, sha256(plaintext))`. 서버는 평문 해시를 모른다.

## 6. E2EE 블롭 봉투

```text
blob = header || ciphertext
header = {v:1, alg:"xchacha20poly1305", nonce(24B), wrappedDEK(KEK로 봉인), kekId}
ciphertext = AEAD(DEK, nonce, plaintextPDF, aad=header)
```
- 키 계층은 D08 §3을 따른다: 복구 문구(BIP39 12단어) → RK → `KEK_N`(파일 DEK 래핑), `K_idx`(dedup HMAC), `K_meta`(레코드 무결성). 기기별 랜덤 키(Noise·서명·inbox)는 복구 문구와 분리한다. 기기 추가 시 복구 문구 또는 기존 기기 승인(페어링 채널로 `KEK_N` 전달)으로 공유. KEK 회전은 DEK 재래핑 후 옛 KEK 폐기.
- 평문 해시는 서버에 보내지 않는다. 정부 서류는 양식이 고정되고 가변 필드 엔트로피가 낮아 평문 해시가 사전 대입에 취약하다. 서버 측 dedup 태그는 `HMAC(K_idx, sha256)`만.
- 블롭·메타데이터 저장소는 국내 리전에 둔다(개인정보보호법 제28조의8 국외이전 요건 회피).
- 서버는 `blob_id`·크기만 안다. 삭제는 (1) 클라이언트가 wDEK 레코드를 먼저 지우고 (2) 서버가 블롭을 즉시 삭제하며 (3) 버전·백업은 30일 내 소거한다. 키를 먼저 지우면 백업 사본은 복호 불가 상태가 된다.

## 7. 마이그레이션

- 스키마 버전 테이블 + 전진 전용 마이그레이션. 앱 업데이트 시 자동 적용, 실패 시 이전 버전 DB 백업 유지.
- 플레이북 입력 스키마 변경(major)은 `runs.inputs_json_enc` 재개 불가 → 사용자에게 "다시 시작" 안내.

## 8. PDF 텍스트 추출 메모(R3)

- `pdfjs-dist`로 한글 텍스트 추출. 공백이 U+0001로 나오는 경우가 있어 정규화한다. ToUnicode 맵이 없는 PDF는 추출이 깨지므로 S13에서 부재율을 측정한다.
- `mupdf` npm은 AGPL이라 제외. OCR 폴백은 `tesseract.js` + 번들 `kor_fast`, 그 다음 OS OCR.
