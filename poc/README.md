# poc/ — 소버린 AX PoC 스파이크(폐기 전제, ADR-017)

금고 경계(비밀은 엔진 프로세스 밖)·커밋 게이트·원장은 설계대로 넣고, 나머지는 버릴 코드다.

| 패키지 | 역할 | 설계 |
|---|---|---|
| `packages/vault` | Chrome 파이프 단독 소유, 기본 거부 허용 목록 CDP 중계, 응답 정리, 비밀 창·타이피스트, 누출 스캐너, DB 키 1회 전달 | D05 §3~§4, ADR-005 v3 |
| `packages/engine` | 금고 중계 위 Playwright, DB 단독 소유(DataService), 진위확인, 사업자등록증 파서, L0 규칙·판정 조율(`l0/`) | D01 §2, D07 §1.3, D13 S-L0 |
| `packages/db` | 암호화 SQLite(sqlcipher), D07 DDL, 프로필·거래처 저장소 | D07 §1·§2 |
| `packages/net` | 엔진의 단일 송신 모듈(egress), 모델 송신 BYOK 로컬 검사 4종 | D01 §3, D04 §8 |
| `packages/redaction` | 마스킹 최소판, `RedactedText` 브랜드 | D06 §4·§8 |
| `packages/model` | L1·L2 계약, 번들 8종 + BV 검증기, 임계값 프로필, OpenAI Decisions·Responses 어댑터, Upstage 스텁 | D04, ADR-003·015 |
| `packages/platform` | `%LOCALAPPDATA%\SovereignAX` 경로·ACL·로그·포트 추상화 | D07 §1.1 |
| `apps/desktop` | Electron main(utilityProcess 배선·환경 변수 허용 목록, 기동 자기 점검 `harden.ts`, 승인 바, docparse 샌드박스, 금고 요청으로만 여는 비밀 입력 창), 셸(`shell*.ts`, `static/shell/`), 개발 콘솔(`main.ts`, 엔진·금고 연결 확인용) | D01 §2.1, ADR-014·021, 08 |
| `tests` | 통합 테스트·픽스처·앱 스모크 | D13 S6 |

```bash
cd poc && pnpm install
```

```bash
pnpm build && pnpm lint && pnpm test
```

```bash
./node_modules/.bin/electron apps/desktop/dist/e2e.js
```

데모 셸(가짜 홈택스 페이지, 시험 구성 금고)과 그 e2e·스크린샷(`reports/raw/poc-6/shell/`). Linux에서 root로 돌리면 `xvfb-run -a pnpm exec electron apps/desktop/dist/shell-e2e.js --no-sandbox`:

```bash
pnpm demo
```

```bash
pnpm demo:e2e
```

실제 홈택스(PoC-3, ADR-025). 앱이 PoC 상한(하루 실행 20·실발급 1·PoC 전체 실발급 3)·단일 인스턴스·디버그 스위치 거부·자식 환경 변수 허용 목록을 집행하고, 비밀 입력 창은 금고가 요청할 때만 열린다. 차단·추가 인증 사전이 비어 있으면 시작 때 저널에 남기고, 모르는 화면은 "멈춤·확인 필요"로 끝난다:

```bash
pnpm start:hometax
```

개발 콘솔(엔진·금고 연결 확인. 비밀 입력·데모 승인 버튼은 ADR-025로 없앴다):

```bash
pnpm start
```

번들 다이제스트·허용 목록 재생성(번들·접두를 고친 뒤), S-L0 합성 측정, S9(키 없으면 모의):

```bash
pnpm bundles && node --conditions=development scripts/s-l0-measure.ts && pnpm s9
```

결과: [reports/PoC-1.md](reports/PoC-1.md)(환경·[위험 수용](reports/PoC-1-risk-acceptance.md)), [reports/PoC-4-5.md](reports/PoC-4-5.md), [reports/S6b.md](reports/S6b.md), [reports/PoC-7.md](reports/PoC-7.md), [reports/S-L0.md](reports/S-L0.md), [reports/S9.md](reports/S9.md), [reports/PoC-9.md](reports/PoC-9.md), [reports/PoC-6.md](reports/PoC-6.md), [reports/PoC-8.md](reports/PoC-8.md), [reports/PoC-10.md](reports/PoC-10.md), 회고 [reports/RETRO-2026-11-02.md](reports/RETRO-2026-11-02.md), 보안 감사 [../sovereign-ax/research/AUDIT-D-v13-poc-security.md](../sovereign-ax/research/AUDIT-D-v13-poc-security.md).
