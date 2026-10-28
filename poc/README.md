# poc/ — 소버린 AX PoC 스파이크(폐기 전제, ADR-017)

금고 경계(비밀은 엔진 프로세스 밖)·커밋 게이트·원장은 설계대로 넣고, 나머지는 버릴 코드다.

| 패키지 | 역할 | 설계 |
|---|---|---|
| `packages/vault` | Chrome 파이프 단독 소유, 기본 거부 허용 목록 CDP 중계, 응답 정리, 비밀 창·타이피스트, 누출 스캐너, DB 키 1회 전달 | D05 §3~§4, ADR-005 v3 |
| `packages/engine` | 금고 중계 위 Playwright, DB 단독 소유(DataService), 진위확인, 사업자등록증 파서 | D01 §2, D07 §1.3 |
| `packages/db` | 암호화 SQLite(sqlcipher), D07 DDL, 프로필·거래처 저장소 | D07 §1·§2 |
| `packages/net` | 엔진의 단일 송신 모듈(egress) | D01 §3 |
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

결과: [reports/PoC-4-5.md](reports/PoC-4-5.md), [reports/S6b.md](reports/S6b.md).
