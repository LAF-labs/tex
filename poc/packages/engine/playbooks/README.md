# 제품 플레이북 원본(서명 전)

레지스트리에 게시할 제품 패키지의 원본이다. 앱은 이 폴더를 읽지 않는다. 엔진은 레지스트리에서 받은 서명된 `.sxp`만 로드한다(D03 §3.1, `RegistrySync`).

| 폴더 = 패키지 id | 종류 | 버전 |
|---|---|---|
| `hometax.invoice.issue` | playbook(H-01 전자세금계산서 발급) | 2.1.0 |
| `hometax.invoice.lookup` | lookup(발급 목록 조회) | 1.0.0 |
| `hometax.invoice.email_status` | lookup(메일 발송 상태) | 1.0.0 |

- 파일: `manifest.json`·`playbook.json`·`selectors.json`·`strings.ko.json`.
- manifest의 `contentDigests`·`lookupsUsed[].digest`·`signatures`는 자리표시다. 게시 도구가 원시 바이트로 채우고 package 키 2개로 서명한다(클라우드 트랙 게시 도구, 서명은 사용자).
- 홈택스 셀렉터는 실제 화면과 대조하지 않았다(PoC-3 뒤, ADR-025 PoC 상한).
- 시험은 이 원본을 골든 패키지로 쓴다(`tests/core-fixtures.ts`). 바꾸면 레지스트리 샘플(`tests/fixtures/registry`)을 다시 만든다.
- fixture 포털(가짜 페이지) 패키지는 여기 두지 않는다. `tests/`에서만 만든다(ADR-039).
