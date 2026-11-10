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
| | `db.query.payroll.carryOver` | `profileId, month` | `{month, from: {month, revision, status}\|null, inputs{employeeId: {extras}}, newEmployees[{id, name}], leftEmployees[{id, name}]}`. 읽기만(M6-9, `PAYROLL_EMPLOYEE_READ_QUERIES`) |
| | `db.query.payroll.enabled` | `profileId` | `{enabled, source: setting\|employees}` |
| | `payroll.setEnabled` | `profileId, on` | `{enabled}`(레일에서 급여대장을 보이고 숨김, ADR-034 결정 8) |
| | `payroll.addEmployee` | `profileId, employee{name, birthDate, hiredOn, basePay, dependents, rrn?, leftOn?, job?, payType?, nontax?, children8to20?, withholdingPct?, pensionApplies?, healthApplies?, employmentApplies?, pensionBase?, healthBase?}` | 직원 + `maskedRrn`(주민번호 원문 없음) |
| | `payroll.updateEmployee` | `profileId, employeeId, patch`(위 칸 중 바뀐 것, `rrn: null`은 지움) | 직원 + `maskedRrn`. 퇴사는 `leftOn`. 지우는 명령은 없다 |
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
| | `bundle.addItem` | `profileId, name, cadence, source?` | 3층 항목. `source`는 `user`(기본)·`pasted_request`(붙여넣기 후보에서 고름) |
| | `bundle.requestCandidates` | `profileId, text` | `{candidates[{name, cadence, cadenceFromText, basis, existing, duplicateOf}]}`. 읽기만(M6-7, `BUNDLE_REQUEST_COMMANDS`) |
| | `bundle.cardSlipEnough` | `profileId, on, month(on일 때)` | `{from}`(다음 달부터, 끄면 null) |
| | `bundle.setIncludeRrn` | `profileId, on` | `{includeRrn}` |
| | `bundle.export` | `profileId, month, taxInvoices?` | `exportBundle` 결과 + `password` |
| | `bundle.markOpened` | `profileId, exportId, via, sentTo?` | 기록 |
| | `bundle.markSent` | `profileId, exportId, note?` | 기록 |
| | `payroll.exportRecord` | `profileId, fromMonth?, toMonth?` | `{record, file, months, password}` |
| 꾸러미 PC 입력 | `db.query.cash.month` | `profileId, month` | `{month, days[{day, amount, source, enteredAt}], total}`(M6-2, `BUNDLE_PC_READ_QUERIES`) |
| | `cash.put` | `profileId, day, amount` | `{day, amount, replaced: {amount, source}\|null}`. 같은 날이면 바꾼다(폰 값이어도) |
| | `cash.remove` | `profileId, day` | `{removed}` |
| | `db.query.receipt.list` | `profileId, month` | `{month, receipts[ReceiptView], unconfirmed}`. 확인 전 것이 먼저, 후보 `phoneOcr`·`ocr`은 기본값으로만 |
| | `receipt.confirm` | `profileId, docId, issuedOn, amount, merchant?, merchantBizNo?` | 확인한 증빙. 이 값만 빠진 것 대조·내보내기에 쓴다 |
| | `bundle.setEntry` | `profileId, itemId, month, status\|null, docIds?, note?` | `{period, entry\|null}`. 기간은 엔진이 항목 주기로 정한다 |
| PC 파일 | `receipt.pcStore` | `profileId, bytes, format: jpg\|png\|pdf, ocr?` | `{docId, duplicate}`(`PC_FILE_COMMANDS`, 처리 `PcFileIntake`) |
| | `bundle.attachFile` | `profileId, itemId, month, bytes, format: pdf\|jpg\|png\|xlsx\|xls\|docx\|hwp, displayName?` | `{docId, duplicate, period, entry}` |
| | `settlement.store` | `profileId, itemId, month, bytes, format: xlsx\|csv, parsed, displayName?` | `{docId, duplicate, period, entry, summary}`(M6-5, `SETTLEMENT_COMMANDS`) |
| 카드 내역 | `db.query.card.list` | `profileId, month` | `{month, lastFetch, daysSinceFetch, coverage: full\|partial\|none, rows[{…, memo}], detachedMemos[{id, text, usedOn, amount}]}`(M6-3, `CARD_READ_QUERIES`) |
| | `card.setMemo` | `profileId, txnId, memo` | 메모(빈 글이면 지움, 500자) |
| | `card.reattachMemo` | `profileId, memoId, txnId` | 떠 있던 메모를 고른 행에 다시 잇는다. 그 행에 메모가 있으면 `memo_exists` |
| | `card.deleteMemo` | `profileId, memoId` | `{deleted}` |
| 데몬 | `daemon.snapshot` | — | `@sax/daemon` `DaemonSnapshot` `{policy, status, profiles[]}`. 읽기 전용, main 전용(`DAEMON_READ_QUERIES`) |
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

0. 직원 목록(처음 한 번 입력, M6-9)
   - `db.query.payroll.employees`에서 `month`를 빼면 퇴사자까지 모든 직원이다. 넣기는 `payroll.addEmployee`, 고치기는 `payroll.updateEmployee`다.
   - 생년월일은 꼭 받고, 주민번호는 선택이다. 주민번호 앞 7자리가 생년월일과 어긋나면 `rrn_birth_mismatch`다. 화면에는 `maskedRrn`만 보인다.
   - 퇴사는 `leftOn`을 넣는다. 직원을 지우지 않는다(임금대장 3년 보관).
   - 오류: `name_required`, `invalid_birth_date`, `invalid_hired_on`, `invalid_left_on`, `invalid_base_pay`, `invalid_dependents`, `invalid_children_8_20`, `invalid_pay_type`, `invalid_withholding_pct`, `invalid_nontax`(비과세는 `meal·vehicle·childcare·research`만), `invalid_rrn`, `rrn_birth_mismatch`, `bad_employee`, `bad_employee_field`, `employee_not_found`.
   - 급여 기능은 `payroll.setEnabled`로 켜고 끈다. 설정이 없으면 직원이 있을 때 켜진 것으로 본다(`source: employees`).
1. `db.query.payroll.employees`로 그달 직원을 보인다.
   - "지난달과 같나요?"는 `db.query.payroll.carryOver`다. [같아요]면 `inputs`를 그대로 `payroll.compute`에 넣고, 바뀐 것만 고친다.
   - 넘기는 것은 과세 수당·차감(`extras`)뿐이다. 근로일수·시간·고지액은 넘기지 않는다(달마다 다르고, 시급제 시간은 근무표, 고지액은 S-06). 비과세는 직원 설정에서 다시 나온다.
   - `newEmployees`는 이번 달 입력을 따로 받는다. `leftEmployees`는 보여 주기만 한다.
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
- 세무사 요청 붙여넣기(M6-7): 붙여 넣은 글을 `bundle.requestCandidates`로 보내 후보를 받는다. 규칙 사전만 쓰고 모델은 부르지 않는다. 글은 저장하지 않는다.
  - 후보는 고칠 수 있는 줄로 보인다(이름·주기). `cadenceFromText: false`면 주기는 기본값이라 확인을 받는다.
  - `existing`이 있으면 이미 있는 1·2층 항목이다. 새로 넣지 않는다. `itemId: null`이면 꺼진 2층이고, `industry`를 켜자고 안내한다(`bundle.ensureItems`).
  - `duplicateOf`가 있으면 같은 이름의 3층 항목이 이미 있다.
  - 사장님이 고른 것만 `bundle.addItem { source: 'pasted_request' }`로 넣는다. 후보 이름은 화면에 글자로만 그린다(HTML 아님).
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

### 꾸러미 PC 입력(08 D-05, M6-2·M6-4)

- 현금매출: 하루 한 숫자를 `cash.put`으로 넣는다. `replaced`가 있으면 "그날 n원을 바꿨어요"라고 알린다. 폰에서 넣은 값이어도 바꾼다(나중 입력이 이긴다).
- 종이 증빙: `db.query.receipt.list`의 확인 전 것을 위에 보인다. 읽어 낸 후보(`phoneOcr.candidates`·`ocr`)는 입력 칸의 기본값으로만 쓰고 글자로만 그린다. 사장님이 [확인]하면 `receipt.confirm`이다.
  - 확인 전 증빙은 "증빙과 대조되지 않은 카드 지출" 대조에 쓰지 않는다.
  - 사업자번호는 `-`가 있어도 된다. 비우면 null이다.
- 항목 상태: [해당 없음]·[다 됐어요]·파일 붙이기는 `bundle.setEntry`다. 화면은 달만 넘기고, 분기·한 번 항목의 기간은 엔진이 정한다. 표시를 지우려면 `status: null`이다.
  - 사업용 카드와 급여를 쓰는 업체의 급여대장은 앱이 센다. 해당 없음만 표시할 수 있다(`entry_derived`).
  - `docIds`는 이미 보관함에 들어간 그 프로필 문서다. 파일을 떼려면 남길 목록으로 `docIds`를 다시 보낸다(파일은 보관함에 남는다).
- PC 파일 넣기
  - 종이 증빙: main이 파일 바이트를 docparse 샌드박스에 먼저 넣어 읽기 결과를 받는다. 그다음 `receipt.pcStore { bytes, format, ocr }`로 보관함에 넣는다. 엔진은 파일을 열지 않고, `ocr`은 후보로 기록만 한다. 이어서 확인 화면(`receipt.confirm`)으로 간다.
  - 파일 칸: [파일 붙이기]는 `bundle.attachFile`이다. 그달 표시에 문서를 더한다. 표시가 없었으면 `ready`, 있었으면 상태는 그대로다. `displayName`은 원래 파일 이름이다(경로는 뺀다). 빼면 항목 이름이다.
  - `format`은 main이 확장자로 정한다. 엔진은 머리 바이트가 맞는지만 본다(`format_mismatch`). 상한은 15MiB다(`input_size`).
  - 같은 파일(sha256)을 같은 프로필에 다시 넣으면 새로 쓰지 않는다(`duplicate: true`). 증빙이면 새 읽기 후보만 바꾸고, 확인한 값은 그대로다.
  - 보관함 파일 이름은 `{종류}_{yyyyMMdd}_{shortId}.{ext}`다. 원래 파일 이름은 쓰지 않는다.
  - 파일 칸 문서의 종류(D07 §2): 정산 품목은 `settlement_file`, 급여대장 파일 칸은 `payroll_ledger`, 그 밖은 `bundle_file`이다.
  - 오류: `bad_format`, `format_mismatch`, `input_size`, `bad_ocr`, `bad_display_name`, `item_not_found`, `entry_derived`, `invalid_month`.
- 정산내역(배달앱·오픈마켓, M6-5)
  - main이 엑셀·csv를 docparse 샌드박스에 넣어 `SettlementResult`를 받는다. 그다음 `settlement.store { itemId, month, bytes, format, parsed }`로 넣는다. 엔진은 파일을 열지 않는다.
  - 남는 것은 요약(`summary`)뿐이다: 플랫폼·기간·매출·수수료·입금액·부가세·행 수, 형식 추정(`estimated`), 파일 합계와 다름(`totalMismatch`). 행·열 이름은 남기지 않는다.
  - 표시가 없었으면, 정산 기간이 그달을 다 덮을 때 `ready`, 아니면 `partial`이다. 화면은 `estimated`면 "형식을 추정해 읽었어요", `totalMismatch`면 "파일 합계와 달라요"를 보인다(판정 아님).
  - 꾸러미 '정산·현금매출' 시트에 파일마다 한 줄로 적는다. 비고는 "파일에서 읽은 값"이다.
  - 오류: `not_settlement_item`, `settlement_channel_mismatch`(배달앱 칸에 오픈마켓 파일 등), `bad_settlement`.
- 오류: `bad_day`, `bad_amount`, `bad_issued_on`, `bad_merchant`, `bad_merchant_biz_no`, `receipt_not_found`, `item_not_found`, `bad_status`, `entry_derived`, `bad_doc_ids`, `doc_not_found`, `bad_note`.

### 사업용 카드 내역(08 D-04)

- `db.query.card.list`로 그달 행을 그린다. 메모는 건마다 `card.setMemo`로 단다. 용도 분류·경비 인정 판단 문구는 쓰지 않는다(ADR-032 결정 3).
- "마지막 최신화: n일 전"은 `daysSinceFetch`다(한국 날짜, 오늘이면 0). 한 번도 안 했으면 `lastFetch: null`이다.
- `coverage`가 `partial`·`none`이면 그달 일부가 조회되지 않았다고 알리고 [최신화]를 권한다. 이번 달은 오늘까지만 본다.
- [최신화]를 다시 눌러 행이 바뀌면, 다시 잇지 못한 메모가 `detachedMemos`("확인 필요")에 사용일·금액과 함께 온다. 사장님이 행을 골라 `card.reattachMemo`로 잇거나 `card.deleteMemo`로 지운다.
- [최신화] 실행 자체는 이 명령에 없다(플레이북 H-12, M6-1).

### 시행일 표 업데이트(화면 없음, 업데이트 채널)

- 설정의 "급여 표 판" 칸은 `db.query.rateTables.installed`의 `installed?.version`이다. 받기 전이면 `null`이고, 기본 표를 쓴다.
- 서명 배포를 받는 순서는 아래와 같다. 엔진 업데이트 채널 몫이며 이번 명령에는 없다.

  ```ts
  const repo = new RateTableRepo(db)
  const r = core.loadDataPackage(raw, { …, schemas: RATE_TABLE_SCHEMAS, installed: repo.installedPackage(RATE_TABLES_PACKAGE_ID) })
  applyRateTableUpdate(repo, r)
  ```

  실패해도 표는 그대로고, 계산은 기존 표로 계속된다.
