# 급여대장·세무사 꾸러미·S-06 화면 연결 지점

2차 급여·꾸러미 화면 세션용 문서다. 백엔드는 `@sax/db`·`@sax/payroll`·`@sax/bundle`에 있고, 엔진 명령은 `src/service.ts`(`BundleService`)에 있다.

## 공통

- **함수는 엔진 프로세스에서 돈다.** 엔진은 DB를 여는 유일한 프로세스다(D05 §2, D07 §1.3).
  - 데스크톱 main에는 DB 키가 없다.
  - 화면은 렌더러 → main → 엔진 명령으로 부르고, 결과만 받는다.
  - 이름은 `packages/engine/src/protocol.ts`의 `PAYROLL_READ_QUERIES`·`PAYROLL_COMMANDS`다.
  - 엔진 `entry.ts`가 이 이름들을 `BundleService`로 보낸다(data-service보다 먼저).
- **모두 main 전용이다**(`PAYROLL_MAIN_ONLY`). 조회도 렌더러에 열지 않는다. 급여, 직원 이름, 주민번호 가림값, 내보내기 파일 경로·암호가 오가기 때문이다.
- **`ColumnCipher`는 엔진 `entry.ts`가 만든다.**
  - DB 키를 지우기 전에 `deriveColumnKey(key)` → `new ColumnCipher(columnKey)`를 만들고, 파생 바이트는 바로 지운다.
  - 키는 엔진 밖으로 나가지 않는다. 로그에도 남기지 않는다.
- **오류 형식은 data-service와 같다.**
  - 오류는 `code`만 가진다. 예: `profile_not_found`, `bad_month`, `rate_table_missing:<kind>`, `notice_choice_needed`.
  - 모르는 이름이면 `unknown_method`다.
  - 모든 명령은 `profileId`를 받는다. 직원·문서·내보내기 기록은 그 프로필 것만 받는다.
- **모델을 부르지 않는다.**
  - 화면 문구는 데스크톱이 갖는다. 명령은 코드·key·숫자만 낸다.
  - "신고세액 계산·절세 판단·신고서 작성"으로 읽히는 문구는 쓰지 않는다.
  - 로그에 급여·개인정보 값을 넣지 않는다.
- **금액은 엔진이 계산해 저장한다.** `payroll.saveDraft`는 `payroll.compute`와 같은 입력을 받아 다시 계산한다. main이 금액을 지어 보내는 길은 없다.

## 명령

| 화면 | 이름 | 인자 | 결과 |
|---|---|---|---|
| 급여대장 | `db.query.payroll.employees` | `profileId, month` | 그달 재직 직원 + `maskedRrn`(가림값만, `revealRrn` 안 씀) |
| | `db.query.payroll.month` | `profileId, month, revision?` | `{current, revisions, lines, summary}`. `revision`을 빼면 가장 큰 개정 |
| | `payroll.compute` | `profileId, month, paidOn, inputs?, employerSize?, industrialAccidentPpm?` | 그달 재직 직원 전부: `{rateTableIds, lines[{employeeId, name, result, statementMissing}], summary}`. 저장하지 않는다 |
| | `payroll.saveDraft` | compute 인자 + `noticeDocIds?` | compute 결과 + `draft`. 초안 줄은 그달 재직 직원과 같게 맞춘다. 확인한 달이면 `month_confirmed_use_revise` |
| | `payroll.confirm` | `profileId, month, revision` | 확인한 개정 |
| | `payroll.revise` | `profileId, month` | 다음 개정 초안(줄 복사) |
| | `payroll.takeHome` | `profileId, month, gross, settings, paidOn?` | 세전 → 실수령 |
| S-06 카드 | `notice.card` | `profileId, month, noticeDocId, rows` | `NoticeCard` |
| | `notice.confirm` | notice.card 인자 + `choices{key: employeeId\|null}` | `{month, noticeDocId, notices{employeeId: 고지액}}` |
| 꾸러미 | `db.query.bundle.status` | `profileId, month` | `ItemStatus[]` |
| | `db.query.bundle.missing` | `profileId, month` | `missingView` |
| | `bundle.ensureItems` | `profileId, industries[]` | 항목 |
| | `bundle.addItem` | `profileId, name, cadence` | 3층 항목 |
| | `bundle.cardSlipEnough` | `profileId, on, month(on일 때)` | `{from}`(다음 달부터, 끄면 null) |
| | `bundle.setIncludeRrn` | `profileId, on` | `{includeRrn}` |
| | `bundle.export` | `profileId, month, taxInvoices?` | `exportBundle` 결과 + `password` |
| | `bundle.markOpened` | `profileId, exportId, via, sentTo?` | 기록 |
| | `bundle.markSent` | `profileId, exportId, note?` | 기록 |
| | `payroll.exportRecord` | `profileId, fromMonth?, toMonth?` | `{record, file, months, password}` |
| 설정 | `db.query.rateTables.installed` | — | `{packageId, installed, tables[{id, kind, effectiveFrom, effectiveTo, review}]}` |

### 인자 설명

- `inputs`: `{ [employeeId]: { extras?, workDays?, workMinutes?, notices? } }`. 이달만 바뀐 값이다.
  - `extras`는 과세 수당·차감 `{name, amount, calc}`다.
  - `notices`는 근로자 부담 고지액 `{pension?, health?, ltc?, employment?}`다.
  - 시급제는 근무표(`ShiftRepo`)를 엔진이 읽는다.
- `paidOn`: 지급일이다. 간이세액표는 지급일로 고르고, 보험 표는 귀속월 1일로 고른다. `takeHome`에서 `paidOn`을 빼면 귀속월 1일을 쓴다.
- `rows`: docparse `insurance_notice` 결과 행이다. main이 샌드박스에서 받아 넘긴다. 받는 칸은 `rowId, name, birthDate, insurance, base, total, employee, employer`뿐이다.
- 내보내기 폴더: 엔진이 정한다(`<앱 루트>/exports/<profileId>`). main·렌더러는 경로를 고르지 않는다. 메일 프로그램이나 폴더는 결과의 `file`·`zipFile`로 main이 연다.

## 화면별

### 급여대장

1. `db.query.payroll.employees`로 직원을 보인다.
2. 입력을 바꿀 때마다 `payroll.compute`를 부른다.
   - `result.notes`는 확인 표시일 뿐 판정이 아니다. 예: `nontax_over_limit:meal`, `insurance_notice_differs:<kind>`, `table_needs_review:<id>`.
   - `table_needs_review`는 "검수 필요"로 보인다.
   - `statementMissing`(P-1~P-6)은 임금명세서 경고다. 막지 않는다. 빈 목록이어도 "법정 양식 충족"이라 쓰지 않는다. 항목 이름은 `STATEMENT_ITEMS`에 있다.
   - 오류 `rate_table_missing:<kind>`는 "표 없음"으로 보인다.
3. 저장은 `payroll.saveDraft`, 확인은 `payroll.confirm`이다. 확인한 달을 고치려면 `payroll.revise`로 다음 개정을 연다(이미 준 명세서와 구분된다).
4. `summary`는 원천세 합계다. 신고서가 아니라 세무사에게 넘길 숫자다.
5. 간단 계산 화면은 `payroll.takeHome`이다. 연장·야간·휴일 가산과 주휴는 계산하지 않는다.

### S-06 4대보험 고지내역 확인 카드

1. `notice.card` → `NoticeCard { month, noticeDocId, people[], employees[], notOnNotice[], needsChoice }`.
   - `people[]`는 `{ key, name, birthDate, rowIds, employeeId|null, basis: name_birth|name_only|ambiguous|none, candidates[], notices, conflicts[], needsChoice }`다.
   - `needsChoice`면 사장님이 고른다. `name_only`도 확인을 받는다. 후보가 비면 `employees` 전체에서 고르게 한다.
   - `notOnNotice`는 보여 주기만 한다. 판정이 아니다.
2. `notice.confirm`은 엔진이 같은 입력으로 카드를 다시 만들고 고른 결과를 적용한다. main이 넘긴 카드를 믿지 않는다.
   - 오류: `notice_choice_needed`, `notice_employee_twice`, `notice_employee_not_active`, `notice_unknown_person`.
3. 결과를 `payroll.saveDraft`에 넣는다: `inputs[employeeId].notices = notices[employeeId]`, `noticeDocIds`에 `noticeDocId`.

### 세무사 꾸러미(이번 달 판 · 빠진 것 · 내보내기)

- 항목: 온보딩·설정 뒤에 `bundle.ensureItems`를 부른다. 여러 번 불러도 같다. 3층은 `bundle.addItem`이다.
- 이번 달 판: `db.query.bundle.status` → `ItemStatus[] { item, period, status: missing|partial|ready|not_applicable, basis: entry|derived, docIds, note, counts }`.
- 빠진 것: `db.query.bundle.missing` → `{ month, sections[], openCount, cardSlipEnough }`.
  - `sections`는 화면 순서로 온다. 펼침: `empty_items`, `payroll`. 접힘: `card_without_evidence`, `memos_need_check`, `invoice_sum_gaps`.
  - 빈 구획은 오지 않는다. 막는 칸이 없다(확인 강제·보내기 차단 금지). 홈 배지는 `openCount`다.
  - "카드 전표로 충분"은 `bundle.cardSlipEnough { on: true, month }`이고, 다음 달부터 적용된다. `cardSlipEnough`가 true면 끄기 링크를 보인다.
- 급여 기능 켜짐: 설정 `profile.<id>.payroll.enabled`를 따른다. 설정이 없으면 직원이 한 명이라도 있으면 켜짐으로 본다. 꺼지면 급여대장 항목은 파일 첨부 칸이다(ADR-032 결정 11).
- 내보내기: `bundle.export` → `{ record, file, zipFile|null, guide[], rrnIncluded, sheets, attachments, skippedChanged, duplicateInvoicesDropped, password }`.
  - 암호는 저장하지 않는다. 화면에 한 번 보여 주고 사장님이 따로 전한다.
  - `guide`(ZIP 여는 법·주민번호 가림 안내)를 같이 보인다.
  - 주민번호는 기본 가림이다. `bundle.setIncludeRrn { on: true }`로 켠다.
  - `taxInvoices`는 H-02 결과다. 부르는 쪽(main)이 넘긴다.
- 보내기: PC 메일 첨부만 쓴다. 서버 메일은 없다.
  - 메일 프로그램이나 폴더를 열 때 `bundle.markOpened { via: 'mail_client' | 'folder', sentTo }`.
  - 사장님이 "보냈어요"를 누르면 `bundle.markSent { note }`.
- 급여 기록(3년 보관): `payroll.exportRecord`. 주민번호는 늘 뺀다.

### 시행일 표 업데이트(화면 없음, 업데이트 채널)

- 설정의 "급여 표 판" 칸은 `db.query.rateTables.installed`의 `installed?.version`이다. 받기 전이면 `null`이고, 기본 표를 쓴다.
- 서명 배포를 받는 순서는 아래와 같다. 엔진 업데이트 채널 몫이며 이번 명령에는 없다.

  ```ts
  const repo = new RateTableRepo(db)
  const r = core.loadDataPackage(raw, { …, schemas: RATE_TABLE_SCHEMAS, installed: repo.installedPackage(RATE_TABLES_PACKAGE_ID) })
  applyRateTableUpdate(repo, r)
  ```

  실패해도 표는 그대로고, 계산은 기존 표로 계속된다.
