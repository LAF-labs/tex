# ADR-039. 엔진 시험용 fixture 포털 패키지: 루프백 http만, 세 곳에서 거부

> 상태: 채택(팀장 결정 2026-11-06, (가) 채택·(나) 기각, 조건 5개) · 엔진 M2-3 PR-A
> 관련: D02 §3(manifest)·§6.1(V-06·V-25), D03 §3.1(로더), D09 §8(레지스트리), [ADR-035](ADR-035-poc-promotion-two-week-phase1.md) W-7(설치본에 데모·e2e·가짜 포털 코드 없음), 엔진 RunService IR 전환 PR-A~D

## 맥락

- RunService를 H01Runner에서 IR 조율기(RunController)로 바꾼다. 기준은 골든 s10~s37 대조에서 차이 0이다. 대조는 실제 홈택스가 아니라 가짜 H-01 페이지(`apps/desktop/src/h01-fixture.ts`)에서 해야 한다(실제 포털 접속 금지).
- 가짜 페이지는 `http://127.0.0.1:PORT`(시험마다 빈 포트)에 뜬다. 그런데 IR은 지금 `https`이고 포트가 없는 URL만 받는다(스키마 패턴, V-06). manifest.portal도 실제 포털 이름만 받는다.
- 그래서 가짜 페이지를 가리키는 IR 패키지를 정적 검증·로더로 통과시키려면 길이 하나 있어야 한다.

## 선택지

| | (가) portal `fixture` + 루프백 http 허용 | (나) 금고 Chrome 호스트 매핑 + 시험 인증서 |
|---|---|---|
| 방법 | manifest·IR·셀렉터 사전에 portal `fixture`를 두고, 그 패키지만 `http://127.0.0.1:PORT`·`http://[::1]:PORT`를 받는다 | 패키지는 `https://hometax.go.kr` 그대로 두고, 금고가 띄우는 Chrome에 hometax.go.kr → 127.0.0.1 우회 규칙과 시험 루트 인증서 신뢰를 넣는다 |
| 바뀌는 곳 | 스키마·정적 검증·엔진 로더·레지스트리 | 금고 Chrome 기동 인자·인증서 저장소·시험 하네스 |
| 새는 경우의 피해 | fixture 패키지가 제품에 들어가도 세 곳이 거부한다. 루프백 밖으로는 가지 못한다 | 우회 규칙이나 시험 인증서 신뢰가 제품 빌드에 남으면, 실제 포털 이름으로 아무 서버나 믿는다. 가장 위험한 경로(포털 위장, 비밀 입력 창이 가짜 서버로)가 된다 |
| 결정 | **채택** | **기각** |

(나)를 기각한 이유: 금고 Chrome의 호스트·인증서 설정은 비밀 입력 창(D05 §3.5)과 커밋 가드(D05 §3.3)가 믿는 바탕이다. 그 바탕에 시험용 예외를 넣으면, 그것이 제품 빌드로 새는 순간 실제 포털 이름을 단 가짜 서버에 공동인증서 비밀번호를 넣게 된다. (가)는 예외를 패키지 이름표(`portal: fixture`)에 묶는다. 그 이름표는 제품 경로 세 곳에서 따로 거부된다.

## 결정

1. **fixture URL은 `http://127.0.0.1:PORT`와 `http://[::1]:PORT`만 받는다.**
   - `localhost` 같은 이름이나 다른 호스트는 받지 않는다. 이름은 hosts 파일로 바뀌기 때문이다.
   - 포트는 있어야 하고 userinfo는 없어야 한다. 호스트는 manifest.domains(`127.0.0.1`·`[::1]`만) 안이어야 한다.
   - portal이 fixture가 아니면 지금 규칙(V-06: https, 포트 없음)을 그대로 쓴다.
   - 둘이 섞이면 **V-25**로 거부한다. fixture 패키지에 https 실제 URL이나 루프백 밖 domains가 있는 경우, 그리고 실제 포털 패키지에 루프백 URL이나 IP 주소 domains가 있는 경우다.
   - 스키마(IR v1.3.5, manifest v1.3.1, 셀렉터 v1.1.1)는 모양만 넓힌다. 묶음은 V-25가 맡는다.
2. **세 곳에서 따로 거부한다.** 각각 시험이 있다.
   - ① 정적 검증기: V-25(위 1).
   - ② 제품 엔진 로더: `loadPackage`는 portal fixture면 서명·결속을 보기 전에 `loader.fixture_package`로 거부한다. 예외는 엔진을 TS 소스로 읽을 때(`--conditions=development`, 시험·개발)뿐이다(`FIXTURE_LOAD_ALLOWED`). 제품 설치본에는 진입점에서 닿는 `dist/*.js`만 들어가므로 이 값은 언제나 거짓이다. 설정·인자로 켜는 길은 없다. 실기기 시험 빌드(`--test-build`)도 dist라 거부한다(조건보다 좁다). 엔진의 레지스트리 인덱스 수용도 fixture 항목이 있으면 인덱스를 거부한다(`registry.portal_blocked`, 개발 조건에서도).
   - ②′ 실행 시 출처 판정(팀장 결정 2026-11-07): 액추에이터(`GuardedActuator.goto`)와 goto 핸들러의 출처 판정은 제품의 마지막 방어선이다. 그래서 허용 목록을 넓히지 않는다. fixture 패키지를 실행할 때만 로더가 낸 허가(`fixtureOriginGrant`)를 따로 주입한다.
     - 허가가 있으면 규칙을 fixture 규칙(V-25)으로 바꾼다. 합치지 않으므로 그때도 실제 포털 URL은 거부한다. 허가가 없으면 실제 포털 규칙(V-06)만 쓴다.
     - 관문은 ②와 같은 `FIXTURE_LOAD_ALLOWED`다. 제품 dist는 허가를 내지 않는다. 다른 곳에서 만든 허가(소스가 낸 것, 같은 모양의 객체)도 인정하지 않는다. 시험(`core-fixture-origin`)은 dist 액추에이터·핸들러를 직접 불러 이것을 확인한다.
   - ③ 레지스트리: 게시(패키지 검증)와 배포(인덱스)에서 모두 `registry.portal_blocked`로 거부한다. services/registry `BLOCKED_PORTALS`에 `fixture`를 넣어 위택스와 같은 길로 막는다. 엔진 PR-A에서 함께 고친다(팀장 결정: 결정 하나를 PR 하나로). 엔진 인덱스 수용과 같은 판정인지 대조 시험(engine-registry-sync)이 본다.
3. **fixture 패키지는 운영 신뢰 루트로 서명하지 않는다.** 시험 전용 키(`tests/core-fixtures.ts` testKeys)로 시험 중에 만들어 서명한다. 가짜 페이지의 포트가 시험마다 다르므로, 패키지는 저장소에 서명된 채로 두지 않고 하네스가 그때 만든다. 운영 키로 서명되더라도 ②·③이 서명과 무관하게 거부한다.
4. **설치본에 들어가면 betaDistributable이 막는다(2차 방어).** 1차 방어는 결정 2 ②의 제품 로더 거부다. 포장 제외는 그 뒤의 2차다.
   - package-win의 `DEV_ONLY_RE`는 진입점에서 닿는 JS 파일 이름에 `fixture`가 있으면 `dev_only_code_included`로 판정한다. 그래서 엔진·데스크톱 쪽에서 fixture 패키지를 만드는 모듈은 이름에 `fixture`를 넣는다.
   - fixture 패키지 원본(JSON)과 빌더는 `tests/` 아래(`@sax/tests`)에 둔다. 이 패키지는 데스크톱 앱의 운영 의존이 아니어서 `pnpm deploy --prod`에 들어가지 않는다. electron-builder `EXCLUDE`도 `tests`·`fixtures` 폴더와 모든 `.ts`를 뺀다.
   - 이름 규칙에만 기대면 파일 이름이 바뀌는 순간 조용히 깨진다. 그래서 가드 시험(`tests/fixture-packaging-guard.test.ts`)을 둔다. 포장 규칙은 포장 트랙 파일이라 시험은 읽기만 한다. 시험이 보는 것:
     - 제품 소스(데스크톱과 전이 운영 의존 패키지의 src)에서 portal을 fixture로 두는 코드는 파일 이름이 `DEV_ONLY_RE`에 걸린다.
     - `@sax/tests`는 운영 의존에 없다.
     - 제품 소스는 `tests/`를 import하지 않는다.
     - `EXCLUDE`가 `.ts`·`tests`·`fixtures`를 뺀다. 그래서 설치본의 엔진은 dist로만 돌고 `FIXTURE_LOAD_ALLOWED`는 거짓이다.
     - fixture 포털 manifest는 `fixtures` 폴더 안에만 있다.
5. 정책(portalMap)·실행 한도의 portal은 그대로다(`Portal`, fixture 없음). 패키지 쪽만 `PackagePortal = Portal | 'fixture'`다. 서명된 정책에 fixture 항목이 생길 일이 없다.

## 결과

- 골든 대조 하네스(PR-C)는 같은 s10~s37을 가짜 페이지 셀렉터·루프백 URL로 묶은 fixture 패키지로 IR 조율기를 돌린다.
- 실제 포털 패키지는 바뀌지 않는다. 기존 패키지는 V-25에 걸리지 않는다(domains에 IP가 없다).
- 되돌리기: 이 ADR의 스키마 enum·패턴, V-25, 로더 검사, BLOCKED_PORTALS 항목을 함께 되돌린다. 원장·DB 변화는 없다.
