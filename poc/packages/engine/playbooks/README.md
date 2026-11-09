# 제품 플레이북 원본(서명 전)

레지스트리에 게시할 제품 패키지의 원본이다. 앱은 이 폴더를 읽지 않는다. 엔진은 레지스트리에서 받은 서명된 `.sxp`만 로드한다(D03 §3.1, `RegistrySync`).

| 폴더 = 패키지 id | 종류 | 버전 |
|---|---|---|
| `hometax.invoice.issue` | playbook(H-01 전자세금계산서 발급) | 2.1.0 |
| `hometax.invoice.lookup` | lookup(발급 목록 조회) | 1.0.0 |
| `hometax.invoice.email_status` | lookup(메일 발송 상태) | 1.0.0 |
| `hometax.cert.biz_registration` | playbook(H-03 사업자등록증명) | 1.0.0 |
| `hometax.cert.vat_tax_base` | playbook(H-08 부가가치세 과세표준증명) | 1.0.0 |
| `hometax.cert.financial_statements` | playbook(H-09 표준재무제표증명) | 1.0.0 |

- 파일: `manifest.json`·`playbook.json`·`selectors.json`·`strings.ko.json`.
- manifest의 `contentDigests`·`lookupsUsed[].digest`·`signatures`는 자리표시다. 게시 도구가 원시 바이트로 채우고 package 키 2개로 서명한다(클라우드 트랙 게시 도구, 서명은 사용자).
- 홈택스 셀렉터는 실제 화면과 대조하지 않았다(PoC-3 뒤, ADR-025 PoC 상한).
- 시험은 이 원본을 골든 패키지로 쓴다(`tests/core-fixtures.ts`). 바꾸면 레지스트리 샘플(`tests/fixtures/registry`)을 다시 만든다.
- fixture 포털(가짜 페이지) 패키지는 여기 두지 않는다. `tests/`에서만 만든다(ADR-039).
- `hometax.cert.{biz_registration,vat_tax_base,financial_statements}` 3개는 공유 템플릿 `scripts/playbooks/hometax-certificate.ts`(ADR-018 결정 2: 즉시발급 민원증명 하나)에서 만든다. 발급 확인 조회는 H-04와 같이 쓰는 `hometax.cert.issued_list`(LAF-labs/tex#247)를 참조만 한다. 손으로 고치지 말고 템플릿을 고친 뒤 `node --conditions=development scripts/gen-cert-playbooks.ts`로 다시 만든다(시험 `tests/cert-playbooks.test.ts`가 같은지 본다).
- 민원증명 셀렉터·메뉴·조회 열은 실기기 캡처 전이다. 캡처할 것은 `CAPTURE-hometax-cert.md`(템플릿이 같이 만든다).
- 민원증명 승인 카드(`cert.confirm`)의 요약 칸(서류·사용 용도·제출처·주민번호 공개 여부, H-04와 공통)은 앱 내장 승인 바 요약 표(`core/loader.ts` APPROVAL_SUMMARIES)·fieldKey 닫힌 목록(`gate.ts` FIELD_KEYS)·데스크톱 카드 라벨(`approval-gate.ts` summarizeCert)에 있다. 다만 게이트 요청을 만드는 길(`buildGateRequest`·READBACK_KEYS·`gateSelfCheck`·`run/card.ts`, docType 'H-01')은 아직 H-01 13칸 고정이라, 민원증명을 실제로 돌리려면 엔진이 서류 종류별 게이트 요청을 만들어야 한다.
