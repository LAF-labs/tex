# 제품 플레이북 원본(서명 전)

레지스트리에 게시할 제품 패키지의 원본이다. 앱은 이 폴더를 읽지 않는다. 엔진은 레지스트리에서 받은 서명된 `.sxp`만 로드한다(D03 §3.1, `RegistrySync`).

| 폴더 = 패키지 id | 종류 | 버전 |
|---|---|---|
| `hometax.invoice.issue` | playbook(H-01 전자세금계산서 발급) | 2.2.0 |
| `hometax.invoice.lookup` | lookup(발급 목록 조회) | 1.2.0 |
| `hometax.invoice.email_status` | lookup(메일 발송 상태) | 1.2.0 |
| `hometax.cert.taxpayment` | playbook(H-04 납세증명서(국세) 발급) | 1.0.0 |
| `hometax.cert.issued_list` | lookup(민원신청 처리결과 조회. 민원증명 공통: H-04 verify, H-03·H-08·H-09도 같이 쓴다) | 1.0.0 |
| `hometax.cert.biz_registration` | playbook(H-03 사업자등록증명) | 1.0.0 |
| `hometax.cert.vat_tax_base` | playbook(H-08 부가가치세 과세표준증명) | 1.0.0 |
| `hometax.cert.financial_statements` | playbook(H-09 표준재무제표증명) | 1.0.0 |

- 파일: `manifest.json`·`playbook.json`·`selectors.json`·`strings.ko.json`.
- manifest의 `contentDigests`·`lookupsUsed[].digest`·`signatures`는 자리표시다. 게시 도구가 원시 바이트로 채우고 package 키 2개로 서명한다(클라우드 트랙 게시 도구, 서명은 사용자).
- 홈택스 셀렉터: H-01 3종(`hometax.invoice.*` 2.2.0·1.2.0)은 2026-11-11 실제 발급 1건 캡처(부장 세션, 레포 밖 기록)에 맞춰 다시 썼다. 실제 id(`mf_txppWframe_…`)·직접 주소·창 순서·요청(actionId)·그리드 `data-col_id`.
  캡처가 없는 부분(로그인 절차 세부, 보안카드·사업자 간편인증 갈래, 인증서 창 [취소] 뒤 화면, 세션 만료, 접근성 이름 일부)은 가정이고 사람 차례로 둔다. 가정 목록은 PR 본문. 건조 실행: `tests/h01-real-dryrun.test.ts`(가짜 홈택스 `tests/hometax-fake.ts`).
  민원증명(`hometax.cert.*`) 셀렉터는 아직 실제 화면과 대조하지 않았다(PoC-3 뒤, ADR-025 PoC 상한).
- 시험은 이 원본을 골든 패키지로 쓴다(`tests/core-fixtures.ts`). 바꾸면 레지스트리 샘플(`tests/fixtures/registry`)을 다시 만든다.
- fixture 포털(가짜 페이지) 패키지는 여기 두지 않는다. `tests/`에서만 만든다(ADR-039).
- `hometax.cert.{biz_registration,vat_tax_base,financial_statements}` 3개는 공유 템플릿 `scripts/playbooks/hometax-certificate.ts`(ADR-018 결정 2: 즉시발급 민원증명 하나)에서 만든다. 발급 확인 조회는 H-04와 같이 쓰는 `hometax.cert.issued_list`(LAF-labs/tex#247)를 참조만 한다. 손으로 고치지 말고 템플릿을 고친 뒤 `node --conditions=development scripts/gen-cert-playbooks.ts`로 다시 만든다(시험 `tests/cert-playbooks.test.ts`가 같은지 본다).
- 민원증명 셀렉터·메뉴·조회 열은 실기기 캡처 전이다. 캡처할 것은 `CAPTURE-hometax-cert.md`(템플릿이 같이 만든다).
- 민원증명 승인 카드(`cert.confirm`)의 요약 칸(서류·사용 용도·제출처·주민번호 공개 여부, H-04와 공통)은 앱 내장 승인 바 요약 표(`core/loader.ts` APPROVAL_SUMMARIES)·fieldKey 닫힌 목록(`gate.ts` FIELD_KEYS)·데스크톱 카드 라벨(`approval-gate.ts` summarizeCert)에 있다. 게이트 요청(`buildGateRequest`·`gateSelfCheck`·`run/card.ts` readbackCard)은 승인 카드 id별 앱 내장 표 `gate.ts` GATE_CARDS를 본다: `invoice.confirm` = docType `H-01`·13칸, `cert.confirm` = docType `cert`·4칸(CERT_READBACK_KEYS). 데스크톱 승인 바가 docType `cert`에 summarizeCert를 고르기 전에는 민원증명 게이트가 무장 거부(요약 칸 없음)로 닫힌다.

## H-04 납세증명서(국세) — 캡처 필요(실기기, S16)

H-04 패키지(`hometax.cert.taxpayment`·`hometax.cert.issued_list`)의 셀렉터는 대부분 **실제 화면과 대조하지 않은 자리표시**다.

2026-11-10 캡처(개인사업자 사업자 인증서 로그인)로 확정·반영한 것:
- 메뉴 직접 주소: 납세증명서 `tm2lIdx=4315010000&tm3lIdx=4315010300`, 처리결과 조회 `4315050000`(둘 다 `websquare.html?w2xPath=/ui/pp/index_pp.xml&tmIdx=43…`).
- **납세증명서는 개인사업자(사업자 인증서) 로그인으로 열리지 않는다.** 알림 "해당 화면은 개인사업자는 이용할 수 없습니다."(`mf_wfHeader_info<숫자>`)가 뜬다. 그래서 양식 체크포인트(`s11`, 양식 또는 알림)를 지난 뒤 `s11a`가 이 문구를 보면 `portal.personal_login_required`(H-03·08·09와 같은 코드·알림 항목 `hometax.cert.alert`·문구 `cert.block.personalOnly`)로 멈추고, 데스크톱이 "대표자 개인 인증서로 다시 로그인" 안내를 보인다. 양식은 대표자 개인(주민번호) 로그인으로 다시 캡처한다.
- 처리결과 조회: 조회기간은 [1주일]·[1개월] 버튼, 민원명 칸 `#mf_txppWframe_ibx_cvaKndNm`, [조회] `#mf_txppWframe_btn_search`. 결과는 카드 목록이고 접수번호(`…_tbx_rcatNo`)를 눌러 들어간다. **용도·제출처 열이 없어** verify `match`는 민원명(`certDoc`)뿐이다. `bind` 변수 이름은 즉시발급 3종과 같은 `issueNo`이고 값은 목록의 접수번호다.

나머지는 아래 화면을 실기기에서 캡처해 확정한다. 이름·역할은 H-01과 같은 틀로 적었다(`lastVerified`는 원본을 쓴 날). 실기기에서 아래 화면을 캡처해 셀렉터(role·접근성 이름·css 후보)·URL·선택지를 확정한다. 그 전에는 레지스트리에 게시하지 않는다.

| # | 화면 | 확정할 것 |
|---|---|---|
| CAP-1 | 홈택스 첫 화면(로그인 전·후) | `hometax.nav.home`, 로그인 성공 표지(`hometax.login.successMarker` 문구) |
| CAP-2 | 로그인 화면: **대표자 개인** 공동·금융인증서 / 간편인증 선택 | `hometax.login.startButton`(지금 이름 "공동·금융인증서"), 인증서 창이 뜨는 프레임(금고 비밀 창 b 대상), 메뉴 차단 알림의 접근성 역할·이름(`hometax.cert.alert`, 지금 dialog "알림") |
| CAP-3 | 자동입력 방지 문자(나오는 경우) | `hometax.captcha.*` |
| CAP-4 | 민원증명 › 납세증명서(국세완납증명) 신청 화면(**대표자 개인 로그인**) | 진입 URL(`s10`·`s11`), 양식 랜드마크 이름, 칸 7개(사업자등록번호·상호·민원명·사용용도·제출처·주민등록번호 공개여부·발급부수)의 역할·이름, 양식 안 다른 입력 칸(V-03j: 전부 readback 대상) |
| CAP-5 | 사용용도·제출처 드롭다운 펼친 상태 | 선택지 문구 → IR `inputs.purpose.values`·`inputs.submitTo.values`. 주민등록번호 비공개 선택지 문구(`allowedConstants` "공개안함"). 민원명 표시 문구(`strings` `cert.doc.taxpayment`) |
| CAP-6 | [신청하기] 직후(확인 대화상자·전자서명 창이 뜨는지) | 확인 문구가 있으면 `submit.expectConfirm`, 서명이 있으면 `submit.signFlow`(지금 없음), 실패·취소 신호 → `verify.failSignals` |
| CAP-7 | 신청 요청의 HAR(`/wqAction.do` actionId) | `selectors.commitEndpoints`(지금 비어 있음: H-01 항목과 합집합이라 실행은 되지만 커밋 가드가 이 요청을 분류하지 못한다) |
| CAP-8 | 민원신청 처리결과 조회의 카드 목록·접수번호를 눌러 들어간 화면(신청 뒤, 사용자 승인 필요) | 목록·카드의 접근성 역할·이름(`hometax.certlookup.rows`, 지금 list), 민원명 칸이 searchbox인지(V-22: 조회 fill은 searchbox·combobox만), 접수번호 → 열람 창 |
| CAP-9 | 처리결과의 [출력]·[열람] → 증명서 화면 | `hometax.cert.taxpayment.result.printButton`, 문서 화면 랜드마크(`doc.root`), 새 창(팝업)인지, 인쇄 PDF에 유효기간 글자가 남는지(docmeta `national_tax_cert`) |
| CAP-10 | 사업자용 간편인증으로 민원증명이 발급되는지(ADR-018 결정 10) | 안 되면 H-04는 공동·금융인증서 경로만 |

- 로그인·비밀: 인증서 비밀번호는 사용자가 전용 Chrome의 인증서 창에 직접 넣는다(`sign` → `human:secret`, 금고 비밀 창 (b), ADR-020 결정 2). 보안카드는 전자(세금)계산서 발급 전용이라 H-04에 없다(02 §5.1).
- 개인 프로필(02 §10 "개인/사업자")은 v1.0.0에 없다. 신청인 대조가 `$profile.bizNo`라 business만 받는다(V-12). 대표자 개인 로그인 양식에 사업자번호 칸이 없으면(주민번호로 신청) 이 대조와 프로필 종류를 다시 정한다(CAP-4 뒤).
- 승인 카드는 민원증명 공통 `cert.confirm`이고 요약 칸은 `certDoc`·`certPurpose`·`certSubmitTo`·`rrnDisclosure`다(팀장 결정 2026-11-09). 요약 표(`APPROVAL_SUMMARIES`)·`FIELD_KEYS` 항목은 데이터 세션 PR이 넣는다.
- 조회 `hometax.cert.issued_list`는 IR 조회 패키지다(H-01 조회와 같은 방식, 서명 대상). 입력 `key`는 민원명이고, 즉시발급 3종도 같은 패키지를 쓴다.
- 엔진: 게이트 카드는 GATE_CARDS(`cert.confirm` 4칸), 제품이 받는 id는 `registry-sync.ts` PRODUCT_PACKAGE_IDS(H-01·H-03·H-04·H-08·H-09, 조회는 lookupsUsed로 따라온다). RunService(세금계산서 입력·원장 재료)는 아직 `invoice.confirm`만 게이트를 연다(민원증명 실행 입력·원장 재료는 후속).

