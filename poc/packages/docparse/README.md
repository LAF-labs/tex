# @sax/docparse

사장님이 넣는 파일(증명서 PDF, 종이 증빙 사진, 배달앱·오픈마켓 정산 엑셀, 4대보험 고지내역)을 읽는 계약과 규칙 파서. D14 M1-8·M6-4·M6-5, ADR-014, D17 §3, ADR-031·032.

- 모델을 부르지 않는다(ADR-031 결정 7, ADR-032 결정 11). 결과에는 **판정이 없다**: 추출값, 칸마다 신뢰도(0~1), 경고 코드뿐이다. 사장님 확인 카드가 정본이다.
- 신뢰하지 않는 바이트를 여는 일(pdf.js, 그림 디코드, tesseract, ZIP·XML)은 모두 docparse 샌드박스(숨김 BrowserWindow, 네트워크 차단 파티션)에서 한다. 이 패키지는 Electron에 의존하지 않는다. 샌드박스 어댑터는 `apps/desktop/src/docparse.ts`다.

## 공개 인터페이스

```ts
parse(bytes: Uint8Array, kind: 'certificate' | 'receipt' | 'settlement' | 'insurance_notice', host: DocparseHost, opts?): Promise<ParseOutcome>
// ParseOutcome = { schema: 'sax.docparse/v1', kind, result, confidence, warnings, needsManual, source, text }
```

- 데스크톱(main): `parseInSandbox(bytes, kind, opts)` = `parse(bytes, kind, sandboxHost())`.
- `kind`는 사장님이 넣은 칸이다(꾸러미 항목·보관함). 내용으로 종류를 추측하지 않는다. 칸과 형식이 안 맞으면 `wrong_kind`.
- 형식은 바이트 머리로 고른다(확장자·MIME은 믿지 않는다): PDF, JPEG, PNG, xlsx, CSV. `.xls`(BIFF)·암호 xlsx·HEIC·WebP·HTML 표는 `unsupported_format`(+`detail`로 알아본 형식)으로 거부하고 화면이 "xlsx(또는 JPEG)로 다시 저장"을 안내한다.
- 실패는 `DocparseError.code`로만 알린다(파일 내용·경로 없음).
- 수동 입력 폴백: `needsManual`이면 화면이 바로 폼을 띄운다. 사장님이 확인·수정한 값은 `checkManual(raw)`로 검사해 엔진에 넘긴다(`ManualInput`).
- 원본 보관 이름: `storedFileName({docType, date, shortId, format})` → `paper_receipt_20261031_7K3P.jpg`(D07 §4, PII 없음). 옮기기·`documents` 행은 엔진이 한다.

## 스키마(`schema/`)

| 파일 | 내용 |
|---|---|
| `sandbox-output.schema.json` | 샌드박스 → main 출력: `pdf`(D17 §3 + OCR 폴백 정보), `image`(줄마다 신뢰도), `sheet`(표·무시한 것 플래그), `error`(코드 목록). main은 통과한 값만 쓴다 |
| `parse-result.schema.json` | `parse()` 결과 봉투. 증명서 `result`는 `docmeta-extract-v1`(@sax/engine/docmeta, 그대로 재사용) |

칸(`Extracted<T>`): 값이 있으면 `reason`이 null, 값이 없으면 `confidence` 0과 `reason`(`not_found`·`ambiguous`·`checksum_failed`·`unparseable`), 후보는 `candidates`. 스키마가 `additionalProperties:false`라 "공제 가능" 같은 판정 필드를 둘 곳이 없다.

## 종이 증빙(M6-4)

- 사진은 샌드박스에서 머리로 크기를 먼저 보고(50MP·긴 변 12000 넘으면 거부), 디코드 → 긴 변 2400px → 국소 임계 흑백(`cleanPhotoForOcr`, 붉은 직인 제거) → tesseract 블록 출력(줄마다 신뢰도).
- OCR 언어 데이터: D14의 `kor_fast`는 `@tesseract.js-data/kor`에 없다. 같은 패키지의 `4.0.0_best_int`(LSTM 전용 정수)를 사진 기본으로 쓴다. 증명서(document 모드)는 PoC-8에서 잰 `4.0.0`을 그대로 둔다. 새 의존성은 없다(같은 패키지의 다른 파일).
- 규칙(`receipt.ts`): 합계 라벨 우선순위, 날짜 라벨·기한 문구 배제, 사업자번호 체크섬(OCR 혼동 문자 복원, 한 자리를 놓친 번호는 후보만), 상호 라벨·맨 윗줄, 승인번호·카드 끝 4자리(전체 번호는 내지 않는다).
- 신뢰도 = 규칙 강도 × 줄 OCR 신뢰도. 교차 확인(공급가액+부가세=합계, 품목 합, 합계 라벨끼리)이 어긋나면 값은 두고 신뢰도를 0.45 이하로 낮추고 다른 값을 후보로 둔다. 목표: **높은 신뢰도로 틀리지 않는다**.
- 폰 사진(M7-4): 폰이 E2EE로 보낸 JPEG(EXIF 제거됨)도 `parseInSandbox(bytes, 'receipt')` 같은 길이다. 폰은 지우기 전에 방향을 화소에 반영해야 한다(EXIF가 없으면 회전 정보가 없다). PC 파일에 EXIF가 남아 있으면 `exif_present` 경고(위치 정보 가능, 꾸러미 ZIP으로 나가기 전 처리는 꾸러미 트랙). 폰 기기 안 OCR 결과는 `receipts.phone_ocr_json`에 두고, `parseReceipt({text, lines})`를 폰 쪽에서도 같은 규칙으로 쓸 수 있다(순수 함수).

## 엑셀(M6-5): 라이브러리를 쓰지 않는다

선정 근거:

| 후보 | 판단 |
|---|---|
| SheetJS(`xlsx`) | npm 판(0.18.5)은 갱신이 멈췄고 알려진 취약점(프로토타입 오염·ReDoS)이 있다. 새 판은 npm 밖(cdn.sheetjs.com) 배포라 ADR-028 공급망 규칙(고정 판·서명 확인 대상)에 맞추기 어렵다. 수식·.xls·암호 등 우리가 막고 싶은 기능이 다 들어 있다 |
| ExcelJS | Node 스트림·`fs` 의존, 브라우저 묶음이 크다(~1MB). 외부 연결·수식을 읽어 들이는 코드가 같이 실린다 |
| 직접(약 500줄) | 필요한 것은 "보이는 시트의 저장된 칸 값"뿐이다. 중앙 디렉터리 → 고른 항목만 `DecompressionStream('deflate-raw')`로 풀고(푸는 도중 바이트 상한) → DTD 없는 작은 XML 토크나이저 → 칸. 매크로·외부 연결·데이터 연결·OLE 항목은 **풀지도 않는다**(있다는 표시만). 공급망 0, 상한·거부를 우리가 정한다 |

- 수식은 계산하지 않고 파일에 저장된 값만 쓴다(`formula_cached_values`). 수식처럼 보이는 글자(`=`·`+`·`@`로 시작)는 세서 `formula_like_text` 경고. **꾸러미 트랙**: 이 값을 다시 엑셀로 내보낼 때 수식이 되지 않게 이스케이프해야 한다.
- 숨김 시트는 행을 읽지 않고, 숨김 행은 뺀다(숨긴 글자가 화면·꾸러미로 새지 않게).
- CSV: BOM → UTF-8, 아니면 UTF-8(엄격) → EUC-KR(CP949).

## 정산·고지내역 형식(추정)

- J-01·J-02(`settlement.ts`): 머리글 칸 이름 동의어(정산일·주문금액·수수료·정산금액 등)로 칸 역할을 붙인다. 플랫폼 이름(배달의민족·쿠팡이츠·요기요·땡겨요·스마트스토어·쿠팡·11번가·ESM)은 제목·시트 이름에서 찾는다. **실물 정산 파일을 받기 전이라 모든 프로필은 `estimated: true`이고 `format_estimated` 경고가 붙는다.** 파일 안 합계 줄은 줄에서 빼고 우리가 더한 값과 견주기만 한다(`total_mismatch`). 실물을 받으면 플랫폼별 프로필(`baemin-v1` 등)을 더하고 estimated를 내린다.
- S-06(`insurance.ts`): 성명·주민등록번호(앞 7자리만 남김)·보수월액/기준소득월액·산출보험료·근로자/사업자 부담. 보험별 파일(국민연금 결정내역 등)과 한 줄에 여러 보험(건강·장기요양 두 줄 머리글)을 모두 받는다. 역시 추정이다.
- **직원 매칭은 하지 않는다.** 입력 타입 `InsuranceNoticeMatchInput`·결과 `InsuranceNoticeMatch`를 데이터 트랙에 제안했다(`types.ts`). 매칭·예상치와의 차이 표시는 데이터 트랙(ADR-031 결정 4).
- 고지내역 PDF는 아직 받지 않는다(표 파일만). 실물 PDF 양식을 보고 텍스트 규칙을 더한다.

## 다운로드 화면 열기(D17 재사용 지점)

정산·고지내역 파일 넣기 안내에서 "관리자 페이지 열기"는 후처리 모드의 기본 브라우저 열기(D17 §1.1: 렌더러는 키만 넘기고 main이 내장 표의 https 허용 호스트만 `shell.openExternal`)를 그대로 쓴다. 이 패키지는 URL을 갖지 않는다. 키(`settlement.baemin` 등)와 허용 호스트 표는 후처리 모드 구현(M3-6) 쪽에 둔다.

## 샌드박스 순수 모듈(`src/sandbox/`)

샌드박스 페이지(`apps/desktop/static/docparse/docparse.mjs`)가 `sax-docparse://app/lib/index.js`로 빌드된 `dist/sandbox/*.js`를 싣는다. 이 폴더는 상대 경로 import만, 송신 API·eval·Function 없음(`tests/docparse-self.test.ts`).

## 테스트

| 파일 | Electron | 내용 |
|---|---|---|
| `tests/docparse-receipt.test.ts` | 없음 | 합성 영수증 24장 × 잡음 3단계 규칙 정확도, 교차 확인, OCR 잡음 |
| `tests/docparse-sheets.test.ts` | 없음 | xlsx·CSV 읽기, 정산·고지내역 규칙 |
| `tests/docparse-reject.test.ts` | 없음 | 퍼징 시드 코퍼스: 거부할 것·무시할 것 |
| `tests/docparse-contract.test.ts` | 없음 | `parse()` 계약(가짜 host), 스키마, 수동 입력, 보관 이름 |
| `tests/docparse-self.test.ts` | 없음 | 자기 점검(정적): 송신·eval 없음, 창·파티션·CSP 설정 |
| `apps/desktop/src/docparse-e2e.ts` | 있음 | 실제 샌드박스: 서류 PDF(PoC-8), 창 안 eval·송신 0, 영수증 사진 정확도 표, 표 파일, 시드 코퍼스 송신 0 |

퍼징 시드를 파일로 쓰기(M6-12 스위트 입력): `node --conditions=development packages/docparse/scripts/write-seeds.ts <빈 폴더>`.
