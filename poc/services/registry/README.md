# 레지스트리(D14 M4-7)

플레이북·조회·핫픽스·데이터 패키지, 인덱스, 정책, 긴급 status, 폐기 목록, 앱 업데이트 매니페스트를 정적 파일로 내보내는 서비스. 게시는 서명 검증 관문을 지나야 한다. API는 [API.md](API.md), 환경 변수는 [ENV.md](ENV.md).

**서버는 서명하지 않는다.** 개인 키는 CI 밖 하드웨어 서명 의식(2-of-3, 3인 분리 보관)에만 있고 이 서비스·이미지·CI·저장소에는 공개키만 있다(ADR-013·028). 시험의 서명 키는 시험 실행 중 메모리에서 만들고 버린다.

**침해되면 무엇이 새는가**(D09 §1): 공개 산출물(이미 누구나 받는 파일)뿐이다. 계정·기기·IP·앱 버전을 저장하지 않는다. 운영자 토큰이 새도 서명 없는 패키지·정책을 올릴 수 없고(관문이 2-of-3을 본다), 관문을 우회해 파일을 바꿔도 클라이언트가 같은 검증을 다시 하므로 실행되지 않는다. 최악은 가용성(파일 삭제·옛 파일 재게시 → 클라이언트가 단조 값·만료로 거부하고 stale로 멈춤)이다.

## 저장 ↔ D09 §1.1 "레지스트리"

DB 테이블이 없다. 저장하는 것은 아래 정적 파일뿐이다.

| 파일 | 내용 |
|---|---|
| `registry/{channel}/index.json` | 서명된 인덱스 |
| `registry/status.json`·`registry/revoked_keys.json` | 서명된 status·폐기 목록 |
| `policy/{ver}.json`·`policy/current.json` | 서명된 정책 |
| `packages/{id}@{ver}.sxp` | 서명된 패키지 바이트(불변) |
| `releases/{channel}/latest.json`·`latest.yml` | 서명된 릴리스 매니페스트와 거기서 만든 yml |

D09 §1.1의 "다운로드 IP·시각·앱 버전"은 **남기지 않는다**(더 엄격). 접근 로그는 공통 모듈의 고정 필드(라우트 패턴·상태·지연)뿐이고 IP·User-Agent·쿼리를 쓰지 않는다(시험이 확인). CDN을 앞에 두면 CDN 로그 보존도 같은 기준으로 끈다(배포 설정, Phase 1 범위 밖).

## 실행

```bash
cd poc && pnpm build
REGISTRY_STORE=memory REGISTRY_ADMIN_TOKEN=dev TRUST_ROOT_JSON='…' node services/registry/dist/main.js
```

컨테이너: `docker build -f services/registry/Dockerfile .`(빌드 컨텍스트 `poc/`). 실제 배포는 Phase 1 범위 밖이다.

## 아직 하지 않는 것

- 투명성 로그(RFC 9162 머클 포함 증명, ADR-028)와 미러 교차 확인: 별도 PR.
- 인덱스 자체의 타임스탬프 서명(지금은 14일 만료로 신선도를 묶는다).
- 클라이언트 쪽 검증 연결(`apps/desktop` main): 데스크톱 트랙. 같은 규칙을 [`src/verify.ts`](src/verify.ts)가 순수 함수로 내보낸다.
