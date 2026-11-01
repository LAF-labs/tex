# PoC-8 홈택스 민원증명 H-04 맥 선행 보고 (2026-11-01)

범위: 발급 **뒤** 단계(PDF → docparse 샌드박스 추출 → 메타 규칙 → 보관함·만료 표시)를 맥에서 먼저 만들었다. 실물 PDF가 나오면 발급 단계(S16·S3a, PoC-6 뒤)만 붙이면 된다. **범위 밖**: 실제 발급(S16 PDF 확보 경로, S3a 무대화상자 저장), 실물 20건 측정(스크립트만 준비), 셸 문서함 연결(PR #11 머지 뒤 이 PR에 더함), `doc_meta_check_v1` 모델 호출.

근거: D14 §0 PoC-8, D13 S16·S3a·S4·S13b, D17 §3, D07 §3·§4, ADR-014. 양식 조사는 국세징수법 시행규칙 별지 제94호(납세증명서), 국세청 민원사무처리규정 별지 제5호(사업자등록증명), 국세징수법 시행령 제96조(유효기간), 홈택스 민원증명 원본확인 화면(발급번호 14자리 4-3-4-3)을 따랐다. 실제 홈택스 출력본이 서식과 글자 단위로 같은지는 실물로만 확인할 수 있다.

## 1. 무엇을 만들었나

| 위치 | 내용 |
|---|---|
| `apps/desktop/src/docparse.ts`, `static/docparse.{html,mjs}`, `static/docparse-text.mjs`, `static/docparse-image.mjs` | docparse 샌드박스에 pdf.js PDF 경로. 작업마다 새 숨김 창, 시간·메모리 상한, 렌더러 사망 감지, 출력 스키마 검증. 텍스트 층이 없거나 깨졌으면 같은 창에서 앞 2쪽을 그려 tesseract OCR |
| `packages/engine/src/docmeta/` | 메타 규칙(`extract.ts`), 만료 규칙(`validity.ts`), 결과 JSON Schema(`schema.ts`, ajv), `doc_meta_check_v1` L0 그림자 판정(`shadow.ts`) |
| `packages/db/src/documents.ts`, `packages/engine/src/documents.ts` | 보관함: v1 `documents` 테이블(스키마 변경 없음), 엔진이 파일을 쓰고 등록, 사용자 확인·수정 |
| `packages/engine/src/protocol.ts`, `data-service.ts` | `db.query.documents.list`, `document.import`(main 전용), `document.update` |
| `apps/desktop/src/vault-import.ts`, `main.ts`, `static/vault-panel.js`, `app.html` | 개발 콘솔 보관함 구역: PDF 가져오기(열기 암호 재시도), 목록·만료(D-n)·만료일 출처·확인 필요 표시, 확인·수정 |
| `apps/desktop/src/synthetic-certs.ts` | 합성 서류(가짜 이름·번호): 납세증명 8, 사업자등록증명 8, 지원 밖 3(지방세 납세증명·사업자등록증·휴폐업 사실증명), RC4 암호 PDF, ToUnicode 끊기 |
| `apps/desktop/src/docparse-e2e.ts` | Electron e2e + S13b 측정 → `reports/raw/poc-8-docparse.json` |
| `apps/desktop/src/poc8-measure.ts` | 실물 20건 측정 스크립트(§6) |
| `tests/docmeta.test.ts`, `tests/documents.test.ts`, `tests/vault-smoke.ts` | 규칙·만료·텍스트 정리 28건, 보관함 14건, 앱 스모크(수동, 임시 앱 폴더) |

## 2. docparse PDF 경로(D17 §3, ADR-014)

- **pdf.js 6.4.299 고정.** CVE-2026-16633(스크립팅 경로, 6.2.108에서 수정) 이후 버전이다. **6.x에는 eval 경로가 아예 없어 `isEvalSupported` 옵션이 없어졌다**(5.7.284에서 PostScript 함수가 Wasm·인터프리터로 바뀜). D17 §3·ADR-014의 "`isEvalSupported:false`"는 "eval 경로가 없는 버전(≥ 5.7)으로 고정"으로 고쳐 적기를 제안한다.
- **워커는 페이지가 직접 띄워 `workerPort`로 넘긴다.** `workerSrc`로 두면 워커를 못 띄울 때 pdf.js가 메인 스레드 가짜 워커로 조용히 넘어가 파서와 MessagePort가 같은 JS 세계에 놓인다. 워커 응답에는 CSP 헤더를 따로 붙인다(워커는 페이지 CSP를 물려받지 않는다). 커스텀 스킴 모듈 스크립트·모듈 워커는 `standard`·`secure`·`supportFetchAPI`만으로 돌았다(`corsEnabled` 불필요).
- 함께 싣는 파일: cmaps(ToUnicode 없는 Adobe-Korea1 CID 폰트 복원), 표준 폰트·wasm 3종(OCR 렌더링용). 스크립팅용 quickjs는 싣지 않는다. 옵션: `useWorkerFetch:false`(커스텀 스킴은 메인 스레드 XHR), `disableFontFace`, `useSystemFonts:false`, `enableXfa:false`, `stopAtErrors:false`, `maxImageSize` 2,500만 화소, 앞 5쪽만.
- **줄 재구성**: 같은 y(글자 크기 절반 허용)끼리 묶고 x 순으로 잇는다. 칸 사이가 벌어지면 공백. NFC, 제어 문자 정리.
- **텍스트 층 판정**: 쪽당 20자 미만, 깨진 글자(PUA·U+FFFD·제어) 2% 초과, 한글·ASCII·흔한 기호 90% 미만이면 "없음". ToUnicode를 끊은 합성 PDF 19건이 모두 "깨짐"으로 판정돼 OCR로 넘어갔다.
- **OCR 전처리**: 서식의 음영 칸·표 선이 tesseract를 크게 흔들었다(첫 측정에서 핵심 칸 11/19, 신뢰도 중앙값 75). 흑백 변환(임계 170) + 글자일 수 없는 긴 가로·세로 선 제거 뒤 19/19, 신뢰도 90이 됐다.
- **암호 PDF**: 권한 암호만 걸린 PDF는 그냥 열린다. 열기 암호는 `password_required`·`password_incorrect` 코드로 묻고, 사용자가 넣은 값으로 다시 연다(저장하지 않는다). 보관함에는 받은 파일을 그대로 둔다. D17 §1의 "복호화 사본 보관"은 Phase 1에서 정한다(pdf.js에는 복호화 저장 기능이 없다).
- 실패는 코드로만: `input_size`·`not_pdf`·`invalid_pdf`·`parse_failed`·`timeout`·`memory_limit`·`renderer_gone`·`schema`. 파일 내용·경로를 로그에 남기지 않는다.

## 3. S13b 측정(맥, M5 Pro, Electron 45.1.0 / Chromium 156)

`reports/raw/poc-8-docparse.json`. 작업 시간은 창 생성부터 결과 검증까지, 메모리는 docparse 렌더러 프로세스 작업 집합 최고치(pdf.js·tesseract 워커 포함)다.

| 경로 | 건수 | 작업 시간 중앙값 / 최대 | 메모리 중앙값 / 최대 | 핵심 칸(종류·발급일·만료일) | 비고 |
|---|---|---|---|---|---|
| 텍스트 층 PDF | 19 | 91ms / 110ms | 117MB / 118MB | 19/19 | 발급기관·발급번호·사업자번호까지 19/19 |
| ToUnicode 끊은 PDF → OCR | 19 | 1.09초 / 1.38초 | 531MB / 537MB | 19/19 | OCR 신뢰도 중앙값 89 |
| 그림 PDF(약 290dpi) → OCR | 19 | 1.10초 / 1.34초 | 595MB / 601MB | 19/19 | OCR 신뢰도 중앙값 90 |
| 7쪽 텍스트 PDF(앞 5쪽) | 1 | 100ms | 122MB | — | D13 S13b 기준 "5쪽 ≤ 3초" 통과 |

- 기준 "규칙 추출 ≥ 95%"는 합성 자료에서 세 경로 모두 100%다. 실물에서는 다시 잰다(§6).
- OCR 경로에서 놓친 부가 칸: 발급번호 첫 칸 T를 1로 읽은 1건(값이 틀린 채 남음), 사업자번호 줄을 통째로 놓친 1건(빈 칸). 그래서 **OCR로 읽은 서류는 만료일을 사용자 확인 전에는 확정하지 않는다**(`read_by_ocr`). 형식이 맞는 오독은 규칙으로 걸러지지 않기 때문이다.
- 대안 (b) AppContainer/Low IL 실행 파일과의 비교(ADR-014 조건)는 지금 수치로는 필요 없다고 본다. Windows 실측 뒤 확정한다.

## 4. 메타 규칙(S4)과 만료 규칙(D07 §3)

- **종류 판별**: 제목 + 본문 문구(OCR은 글자 사이를 넓힌 제목을 자주 놓친다). 국세 납세증명 = (`납세증명서` 또는 `국세징수법`+`체납`) ∧ (`세무서장` 또는 `국세징수법`). 사업자등록증명 = `사업자등록증명` 또는 (`사업자등록일`+`증명합니다`+`세무서장`). 지방세 납세증명·사업자등록증·휴폐업 사실증명·영문 증명·두 종류가 섞인 PDF는 `docType: null`과 이유로 남기고, 보관은 `other`로 한다(ADR-018 결정 7).
- **라벨**: 공백을 지운 사본에서 찾고 값은 원문에서 읽는다(서식 라벨이 「사 업 장 소 재 지」처럼 띄어 인쇄된다). 날짜는 `2026년 11월 1일`·`2026. 11. 1.`·`2026-11-01`을 받고 실제 날짜인지 확인한다.
- **발급일**: 마지막 `증명합니다` 뒤 맺음 부분의 날짜(담당부서·세무서장 줄). 출력일시·납부기한·개업일·등록일·유효기간 라벨이 붙은 날짜, 시각이 붙은 날짜, 기간 표기의 양 끝은 뺀다. 서로 다른 날짜가 둘 이상이면 정하지 않고 후보로 둔다.
- **유효기간**(납세증명서만): `유효기간` 라벨 바로 뒤 날짜, `A ~ B`면 끝 날짜. **발급일 ≤ 유효기간 ≤ 발급일 + 30일**이 아니면 쓰지 않는다(시행령 제96조. 지정납부기한으로 짧아지는 것은 정상).
- **발급기관·발급번호·사업자번호**: `○○세무서장`(이름 1~5자, 붙은 글자·띄운 낱글자·섞인 OCR 모두), 발급번호 4-3-4-3(OCR이 T를 ㅠ·ㅜ로 읽는 것을 되돌림), 사업자번호는 체크섬이 맞아야 값으로 둔다(틀리면 후보).
- **못 뽑은 칸**은 값 없이 이유(`not_found`·`unparseable`·`ambiguous`·`checksum_failed`·`not_applicable`·`unsupported_doc`)를 남긴다. 결과는 JSON Schema(값이 있으면 이유 없음, 없으면 이유 있음, 형식 패턴)를 통과해야 저장한다.
- **만료일**:

| 경우 | 만료일 | 출처 | 확인 필요 |
|---|---|---|---|
| 납세증명서, 유효기간이 범위 안 | 문서 값 | 문서에서 읽음 | 아니오 |
| 납세증명서, 유효기간 못 읽음·여럿·범위 밖 | 발급일 포함 30일(발급일 + 29) | 추정 | **예**(지정납부기한으로 더 짧을 수 있다) |
| 사업자등록증명 | 발급일 포함 90일(사용자 조정 일수 우선) | 추정 | 아니오(사용자 결정 2026-11-01: 90일 추정 표시) |
| OCR로 읽음 | 위와 같음 | 위와 같음 | **예**(`read_by_ocr`) |
| 발급일 없음·미래, 종류 모름 | 계산 가능하면 계산 | — | 예 |

  초일 산입 여부는 실물로 확인 전이라 짧은 쪽(발급일 포함)으로 잡았다. 남은 날은 한국 시간 달력 기준(만료일 당일 D-day, 지나면 "만료됨", 7일 이하 주의 색).
- **`doc_meta_check_v1` 후보**: 날짜 ±40자 문맥(마스킹, 최대 8개)을 만들고 L0 규칙의 그림자 판정을 기록한다. 모델은 부르지 않는다. **지금 L0 규칙은 실제 서식 배치에서 답하지 못한다.** 서식에서 `유효기간`·`발급일` 문구가 여러 날짜 가까이 있어 ±40자 문맥이 겹치고, 규칙은 "문맥에 라벨이 있는 후보가 정확히 하나"일 때만 답하기 때문이다. Phase 1 제안: 후보 문맥을 "날짜 앞 문맥"으로 바꾸거나, 라벨 바로 뒤 날짜를 고르는 이 PoC의 규칙 추출기를 1차 판정으로 쓰고 `doc_meta_check_v1`은 추출기가 정하지 못한 칸에만 부른다(D04 §3 변경, PoC-12에서 결정).

## 5. 보관함(D07 §1.3·§4)

- 엔진이 파일을 `vault/{docType}_{yyyyMMdd}_{shortId}.pdf`로 쓴다. 임시 파일에 쓰고 fsync한 뒤 하드 링크로 이름을 붙인다(같은 이름이 있으면 덮어쓰지 않고 다른 shortId). 하드 링크를 못 거는 파일 시스템이면 `COPYFILE_EXCL` 복사. 권한 0600, 지난 실행의 임시 파일은 다음 저장 때 지운다. DB 등록이 실패하면 쓴 파일을 지운다.
- 같은 파일(sha256)은 다시 쓰지 않고 기존 항목을 돌려준다. 같은 서류의 다른 파일(그 서류를 스캔한 PDF 등)은 따로 보관된다. 발급번호가 같으니 Phase 1에서 "같은 발급번호 서류가 이미 있음" 안내를 더한다.
- DB는 v1 `documents` 행 그대로다(스키마 변경 없음 → PoC-6의 v2 마이그레이션과 겹치지 않는다). `meta_json`에는 추출 칸·이유·만료 출처·텍스트 층 정보만 두고 원문 텍스트는 두지 않는다. 렌더러 보기에는 파일 경로가 없다.
- 사업자 프로필에 붙이고, 대상 사업자번호가 다르면 "다른 사업자 서류"로 표시한다. 사업자 프로필이 없으면 `profile_required`.
- `document.import`는 main 전용이다(렌더러 허용 목록에서 뺐다). 렌더러는 바이트·텍스트를 지어 보낼 수 없고, main은 사용자가 고른 파일만 docparse로 넘긴다(D17 §1.3).
- 사용자 확인·수정(`document.update`): 그대로 확인하면 추정이 "확인함"으로, 날짜를 넣으면 그 값(확인함), 종류·발급일만 바꾸면 만료일을 규칙으로 다시 정한다.

**앱 스모크**(`tests/vault-smoke.ts`, 임시 앱 폴더, `reports/raw/poc-8-vault-smoke.json`·`reports/raw/poc-8/vault-panel.png`): 개발 콘솔에서 사업자 프로필 없음 안내 → 납세증명 텍스트 PDF(문서에서 읽은 만료일) → 같은 파일 다시(중복 안내) → 사업자등록증명(추정 90일, 다른 사업자 표시) → 그림 PDF(OCR, 확인 필요) → 열기 암호 PDF(암호 요청 → 틀린 암호 안내 → 맞는 암호로 보관) → 렌더러가 직접 부른 `document.import`는 `unknown_method`로 거부. 파일명 4개 모두 `{docType}_{yyyyMMdd}_XXXX.pdf`. 스모크 중에 숨김 처리한 암호·수정 줄이 `.row{display:flex}`에 가려 보이던 결함을 찾아 고쳤다(`[hidden]` 규칙).

## 6. 실물 20건 측정(준비됨, 미실행)

1. 발급받은 납세증명서·사업자등록증명 PDF를 **git 작업 폴더 밖** 폴더에 둔다(스크립트가 작업 폴더 안이면 거부한다). 실물은 저장소에 커밋하지 않는다.
2. `pnpm build && electron apps/desktop/dist/poc8-measure.js <폴더> --draft` → `<폴더>/labels.draft.json`(추출값 초안). PDF를 직접 보고 값을 고쳐 `labels.json`으로 저장한다.
3. `electron apps/desktop/dist/poc8-measure.js <폴더>` → 건별 결과와 "종류·발급일·유효기간 모두 맞음 n/N", 합격 기준 20건 중 19건(95%). 저장소에는 값 없는 요약(`reports/raw/poc-8-real.json`: 순번·참거짓·이유 코드·시간·L0 그림자 답 여부)만 쓴다. 열기 암호는 `SAX_POC8_PDF_PASSWORD` 환경 변수로 준다. 오래된 샘플은 `SAX_POC8_TODAY`로 기준일을 줄 수 있다.
4. 합성 21건(텍스트 15·그림 6)으로 스크립트를 돌려 21/21을 확인했다(결과 파일은 지웠다).

## 7. 실행

```bash
pnpm build && pnpm lint && pnpm test
./node_modules/.bin/electron apps/desktop/dist/docparse-e2e.js   # 합성 PDF e2e + S13b → reports/raw/poc-8-docparse.json
node --conditions=development tests/vault-smoke.ts                # 앱 스모크(임시 앱 폴더) → reports/raw/poc-8-vault-smoke.json
```

## 8. 남은 일

- 실제 발급(S16): 홈택스 민원증명 출력이 텍스트 층 PDF인지, 보안 출력 프로그램을 거쳐 그림이 되는지, 열기 암호가 걸리는지. 이 PoC는 세 경우 모두 읽게 해 두었다(OCR이면 사용자 확인).
- S3a(Windows `--kiosk-printing` 무대화상자 저장)와 staging → 보관함 이동.
- 실물 20건 측정(§6), Windows에서 e2e·S13b 재측정.
- 셸 문서함(PoC-9, PR #11) 연결: 목업 목록을 `db.query.documents.list`로 바꾼다(PR #11 머지 뒤).
- 설계 반영 제안(PoC-12): D17 §3·ADR-014 `isEvalSupported` 문구, D04 §3 `doc_meta_check_v1` 후보 문맥(§4), D07 §3 초일 산입 규칙(실물 확인 뒤), D17 §1 암호 PDF 복호화 사본.
