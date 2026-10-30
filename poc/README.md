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
| `apps/desktop` | Electron main(utilityProcess 배선, 승인 창, docparse 샌드박스, 비밀 입력 창, UI) | D01 §2.1, ADR-014 |
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

```bash
pnpm start
```

번들 다이제스트·허용 목록 재생성(번들·접두를 고친 뒤), S-L0 합성 측정, S9(키 없으면 모의):

```bash
pnpm bundles && node --conditions=development scripts/s-l0-measure.ts && pnpm s9
```

결과: [reports/PoC-1.md](reports/PoC-1.md)(환경·[위험 수용](reports/PoC-1-risk-acceptance.md)), [reports/PoC-4-5.md](reports/PoC-4-5.md), [reports/S6b.md](reports/S6b.md), [reports/PoC-7.md](reports/PoC-7.md), [reports/S-L0.md](reports/S-L0.md), [reports/S9.md](reports/S9.md).
