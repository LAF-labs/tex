# 보안 스위트(D14 M5-1, M6-12)

`pnpm test:security`(= `node scripts/ci-security.mjs`)로 `tests/security/**/*.sec.ts`만 돈다. `pnpm test`(`*.test.ts`)와 분리한다(D13 §1 "전용 스위트, 릴리스 필수"). CI(`.github/workflows/ci.yml`)는 둘 다 돈다. 실키·실계정·실 포털 접속 없음(가짜 포털 `tests/fixtures/server.ts`, 시험 비밀 `testSecret`, 공개 시험 시드).

환경 변수: `SAX_FUZZ_ITER`(퍼징 회차, 기본 300), `SAX_FUZZ_SEED`(씨앗, 기본 20261105). 실패 메시지에 씨앗·회차·변이가 찍히므로 그대로 재현한다. 측정 결과는 `tests/measure-out.ts`로 `reports/raw/.local/security/`(또는 `SAX_MEASURE_DIR`)에 쓴다.

| 파일 | D14 항목 | 무엇 | 지금 | 남은 것(태스크) |
|---|---|---|---|---|
| `leak-cdp.sec.ts` | M5-1 누출 스캐너(CDP 이벤트) | 금고 `leak/scanner` 재사용. 양성 대조 + 실브라우저: 타이피스트 입력 뒤 포털 스크립트가 값을 콘솔·예외·URL·요청·DOM으로 흘려도 엔진이 받은 CDP 이벤트에 비밀 0건 | 돈다 | 진단 내보내기 형식 검사(D-11 P1, M4-4) |
| `fuzz-package.sec.ts` | M5-1 IR·셀렉터·정책 퍼징 | 골든 H-01 변이 → `validatePackage`: 예외·멈춤 없음, 결정적, 위반에 사용자 문자열 없음, 게이트를 제출 뒤로 옮기면 항상 거부. 스키마 7종 임의 JSON | 돈다 | 정책 로더 상한 접기(M1-4 뒷절반·M2-4) |
| `gate-bypass.sec.ts` | M5-1 게이트 우회 CE-7~16 | 정적 반쪽(엔진 core-validate·core-selector-ci 시험이 이름대로 있는지), CE-16 내장 상한 | 정적·CE-16 돈다, 실행 반쪽 10건 todo | 엔진 M2-1~M2-4 뒤 실행기 직접 주입 시나리오 |
| `registry.sec.ts` | M5-1 레지스트리 회귀 | 엔진 고정 시드 샘플(`tests/fixtures/registry`) 변조·되감기 거부 | #52 머지 전 건너뜀(머지 브랜치에서 3건 통과 확인) | loadPackage 되감기, #56 상호 검증 |
| `injection.sec.ts` | M5-1 인젝션 레드팀 회귀 | 모델 트랙 코퍼스(`s9-screens`·`l0-corpus`) → 결정적 사전 필터. 놓침 0(알려진 1건 목록화)·오탐 ≤ 5%(S17)·회피 변형 6종 | 돈다(오탐 3.2%) | S17 200건 코퍼스(M3-7·M1-8) |
| `parsers.sec.ts` | M6-12 파서 퍼징 | 파서 표(모듈·생성기·성질). OCR 문자 파서·문서 메타 추출은 지금 돈다 | 2 돈다, 이미지·엑셀 4 건너뜀 | docparse M6-4·M6-5 모듈 이름 연결, 숨김 텍스트 회귀 |
| `promotion-check.sec.ts` | ADR-035 결정 1.3 (라) | 제품 진입점이 `// PoC 폐기 대상` 파일을 import하지 않는다 | 돈다 | — |

알려진 발견(소유 트랙에 보고):
- `injection.sec.ts` KNOWN_MISSES `s9:inj_answer_steer`: 키워드·역할 태그 없이 판정기에게 답을 지시하는 문장을 사전 필터가 놓친다(엔진 `l0/injection-filter.ts`).
