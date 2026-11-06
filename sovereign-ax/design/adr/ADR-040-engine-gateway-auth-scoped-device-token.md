# ADR-040. 엔진의 게이트웨이 인증: gateway 범위 기기 토큰을 main이 요청마다 준다

> 상태: 채택(팀장 결정 2026-11-06). 결정 1~5가 채택이다. 클라우드·데스크톱·엔진·금고 세션은 이 ADR을 기준으로 구현한다. 포트 메시지 모양(결정 2)은 세 세션 공통 계약이다.
> 관련: D01 §5.1(intent.resolve → 마스킹 → egress → gateway.decide), D04 §7, D09 §2.1·§3, [ADR-029](ADR-029-remote-recovery-data-minimization.md)(서버는 열쇠를 갖지 않는다, DPoP), [ADR-016](ADR-016-account-trust-anchor-hardware-approval.md)(AIK 신뢰 앵커), `poc/services/shared/CONTRACT.md` §2·§3, `poc/services/gateway/API.md` "인증", `poc/services/account/API.md` "기기 범위 토큰"

## 맥락

- 엔진은 대화 의도 해석(D01 §5.1)과 L1·L2 판정에서 게이트웨이(`/v1/run-tokens`·`/v1/decide`·`/v1/respond`)를 부른다.
  - 게이트웨이는 데스크톱 기기 범위 토큰(`gateway` 범위)과 DPoP(Vd 서명, `htu = GATEWAY_ORIGIN + 경로`)만 받는다.
- 지금 엔진 진입점(`packages/engine/src/entry.ts`)은 `new Egress()`에 게이트웨이 구성을 주지 않는다. 그래서 게이트웨이 송신은 늘 거부된다.
  - 붙일 자리는 있다: `EgressOptions.gateway.auth = GatewayAuth`(`packages/net/src/gateway.ts`).
- 기기 토큰은 데스크톱 main이 만든다(`apps/desktop/src/remote-account.ts` `DeviceSession`, `DeviceTokenCache` 메모리 15분, Vd 서명은 금고 control 포트 `crypto.signVd`).
  - 데스크톱 토큰의 범위는 전부다: `gateway, relay, wake, slots, devlist, acct_op`(`DESKTOP_SCOPES`).
- 금고의 engine 포트도 `crypto.publicKeys`·`noiseDH`·`signVd`·`signAik`·`hpkeOpen`을 허용한다(`packages/vault/src/protocol.ts` `RPC_BY_PORT.engine`). 그런데 엔진 소스에는 쓰는 곳이 없다. 장기 키 연산은 main이 control 포트로 한다.
- **문제**: 엔진에 전체 범위 토큰을 주면, 엔진이 뚫렸을 때 계정 작업까지 열린다. 그 토큰과 engine 포트의 Vd·AIK 서명으로 다음을 부를 수 있다:
  - 기기 목록 PUT(`devlist`)
  - 긴급 정지·계정 작업(`acct_op`)
  - 슬롯(`slots`)
  - 릴레이·깨우기(`relay`·`wake`)
- 엔진은 웹 페이지·포털 응답·모델 응답 같은 비신뢰 입력을 가장 많이 다루는 프로세스다. 그래서 엔진이 가진 권한은 게이트웨이 호출에 필요한 만큼이어야 한다.

## 결정

### 1. 클라우드: 범위를 줄인 기기 토큰

- `POST /v1/device-tokens`에 선택 필드 `scopes: string[]`를 더한다.
  - 없으면 지금처럼 그 역할의 전체 범위다(하위 호환).
  - 있으면 그 범위만 준다.
- 거부(`400 request.param_rejected`), 모두 인증서·DPoP 검증 전에 판정한다:
  - 빈 배열
  - 모르는 범위 이름(`Scope` 목록 밖)
  - 그 역할 범위의 부분집합이 아닌 것
  - 중복
- 응답 `scopes`는 실제로 준 범위다. 서명·`cnf`(Vx)·수명 15분·기기당 한도(60/시)는 그대로다.
- **발급 기록**: 발급마다 이벤트 이름에 역할·범위를 남긴다(예 `account.device_token_issued.desktop.gateway`, 전체면 `.all`). 기기 ID·계정 ID·토큰은 남기지 않는다(D09 §3, 로그 규칙).
- 게이트웨이는 바꾸지 않는다. 지금처럼 `gateway` 범위가 있는지만 본다. 범위 밖 경로는 각 서비스가 `403 account.scope_denied`로 거부한다(이미 있음).

### 2. 데스크톱 main: 게이트웨이 인증 호스트(포트 계약)

- 엔진 init 때 `MessageChannelMain` 하나를 더 만들어 **auth 포트**로 넘긴다(gate 포트와 같은 방식).
- main은 **gateway 전용 `DeviceTokenCache`**를 따로 둔다(`scopes: ['gateway']`로 발급). 전체 범위 토큰은 엔진으로 가지 않는다.
- 메시지 모양(세 세션 공통 계약):

  | 방향 | 메시지 | 뜻 |
  |---|---|---|
  | 엔진 → main | `{t:'gw.auth', id, htm, htu}` | 이 요청에 붙일 헤더를 달라. `id`는 엔진이 정하는 요청 번호(문자열) |
  | main → 엔진 | `{t:'gw.auth.result', id, headers:{authorization, dpop}}` | 성공. `authorization` = `DPoP <gateway 범위 토큰>`, `dpop` = 그 `htm`·`htu`에 대한 증명 |
  | main → 엔진 | `{t:'gw.auth.result', id, code}` | 실패. `code`는 아래 표 |
  | 엔진 → main | `{t:'gw.auth.invalidate'}` | 게이트웨이가 401을 줬다. gateway 캐시를 지워라(응답 없음) |

- `code`:
  - `auth.denied`: 허용 목록 밖
  - `account.signed_out`: 로그인 안 됨·신원 파일 없음·금고 잠김
  - `auth.unavailable`: 토큰 발급 실패·계정 서비스 장애
- **허용 목록**(main이 강제): `htm === 'POST'`이고 `htu`가 정확히 `GATEWAY_ORIGIN + '/v1/run-tokens'`·`'/v1/decide'`·`'/v1/respond'` 중 하나다.
  - 쿼리·조각·다른 origin·경로 정규화(`..`·`%2e`)는 모두 `auth.denied`다. 이벤트는 이름만 남긴다.
  - `/v1/biz/status`는 넣지 않는다. 엔진의 사업자 조회는 BYOK 직접 경로다.
- `gw.auth.invalidate`는 분당 상한(6회)을 둔다. 넘으면 무시하고 이벤트를 남긴다.
- 토큰·헤더는 main 메모리에만 있다. 로그·렌더러·파일에 쓰지 않는다.
- DPoP는 지금 키 다섯 개(CONTRACT §3)다. 엔진의 `bodySha256`은 포트로 보내지 않는다.

### 3. 엔진: 포트로 `GatewayAuth`를 구성

- `entry.ts` init에 auth 포트가 있으면 다음처럼 구성한다:
  - `new Egress({ gateway: { auth, bundles } })`
  - `auth.headers`는 `gw.auth`를 보내고 5초 안에 결과를 받는다.
  - `auth.invalidate()`는 `gw.auth.invalidate`를 보낸다.
- auth 포트가 없으면 게이트웨이 구성 없이 지금처럼 둔다. 개발 콘솔·시험 경로가 그렇다.
- `GatewayAuth`에 선택 메서드 `invalidate?()`를 더한다. 재시도는 `Egress.toGateway`가 맡는다(오류 의미는 결정 5).
- 실행 토큰(`/v1/run-tokens`, `sxr1.`)은 지금 계약대로 엔진이 범위별로 받는다. 기기 토큰과 별개다.

### 4. 금고: engine 포트에서 장기 키 연산을 뺀다(같은 묶음, 후속이 아니다)

- `RPC_BY_PORT.engine`에서 `crypto.publicKeys`·`crypto.noiseDH`·`crypto.signVd`·`crypto.signAik`·`crypto.hpkeOpen`을 뺀다.
  - control 포트(main)는 그대로다.
- 엔진이 그 메서드를 부르면 `vault.rpc_denied`다.
- 이것이 빠져야 결정 1~3의 범위 축소가 완성된다. 엔진이 뚫려도 Vd로 다른 경로의 DPoP를 서명하지 못하고, AIK로 계정 작업에 서명하지 못한다.

### 5. 오류 의미

| 상황 | 엔진 동작 | 사용자에게 |
|---|---|---|
| 게이트웨이 `401 gateway.unauthorized` | `invalidate` 뒤 **한 번만** 다시 보낸다. 두 번째 401이면 실패 | 실패면 아래 "게이트웨이 없음"과 같다 |
| 게이트웨이 `403`(`gateway.device_suspended`·`account.scope_denied`) | 재시도하지 않는다 | 정지된 기기 안내(기존) |
| `account.signed_out` | 게이트웨이를 부르지 않는다. `GatewayError('gateway.unavailable')` | 오프라인 대체(의도 해석은 로컬 정규식) |
| `auth.denied`·`auth.unavailable`·auth 포트 5초 초과 | `GatewayError('gateway.unavailable')`. 재시도 없음 | 오프라인 대체 |
| 그 밖(429·5xx·시간 초과) | 지금 계약 그대로(`gateway.*`) | 기존 |

- 인증 실패(401)는 실행 토큰 예산을 쓰지 않는다. 게이트웨이는 인증을 통과한 뒤에 센다.
- `intent.resolve`에서 위 실패는 모두 `decide.unavailable`이다. main은 그 코드로 오프라인 정규식으로 대체한다(desktop-pending "M4-3 ③", main 상한 4초).

## 기각한 대안

- **엔진에 전체 범위 토큰을 준다**(main이 지금 토큰을 그대로 넘김): 가장 간단하다. 하지만 엔진이 뚫리면 기기 목록·긴급 정지·슬롯·릴레이 권한이 함께 넘어간다(맥락). 게이트웨이 호출에 필요한 것보다 훨씬 넓다.
- **엔진이 직접 키 연산을 한다**(엔진이 금고 engine 포트의 `crypto.signVd`로 DPoP를 서명하고, 토큰도 엔진이 받는다): main을 거치지 않아 포트가 하나 줄어든다. 하지만 엔진이 Vd·AIK 서명 능력을 계속 가져야 한다. 그러면 토큰 범위를 줄여도 엔진이 다른 범위의 토큰을 스스로 발급받을 수 있다(인증서 + Vx DPoP는 금고가 서명). 결정 4와 함께 기각한다.
- **main이 게이트웨이 요청 전체를 대신 보낸다**(엔진은 본문만 넘김): 키·토큰이 엔진에 전혀 없다. 하지만 마스킹 검사·모델 송신 검사(`ModelGuard`)·감사(`modelAudit`)가 엔진 `Egress`에 있다. 송신 지점이 둘이 되어 D01 §3 "송신은 Egress 한 곳" 원칙이 깨진다. 헤더만 main에서 받는 쪽을 택한다.

## 영향과 잔여 위험

- 엔진이 뚫리면 gateway 범위 토큰(15분)으로 그 기기의 게이트웨이 예산을 쓸 수 있다. 피해는 계정 월 토큰 한도·실행 예산·분당 한도 안에 머문다. 그 밖의 범위는 없다.
- main이 뚫리면 지금과 같다(main은 원래 전체 범위를 가진다).
- 세션 나눔:
  - ① 클라우드(계정 서비스 `scopes`, 발급 기록)
  - ② 데스크톱(auth 포트 호스트·gateway 전용 캐시·허용 목록)
  - ③ 엔진(포트 `GatewayAuth`·401 1회 재시도·`intent.resolve`)
  - ④ 금고(engine 포트 축소)
  - ①·④는 독립이다. ②·③은 결정 2의 메시지 모양으로 따로 간다. ③이 ④보다 늦으면 엔진은 그동안 키 연산을 쓰지 않으므로 영향이 없다.
- 시험:
  - ①: 부분집합·빈 배열·모르는 범위·중복 거부, gateway 전용 토큰으로 `/v1/slots` 403·`/v1/decide` 통과
  - ②: 허용 목록·`signed_out`·invalidate·헤더 비기록
  - ③: 401 → 1회 재시도, 403 재시도 없음, 시간 초과
  - ④: 엔진 포트 `crypto.*` 거부
  - e2e: 개발 스택에서 로그인 → 엔진 `intent.resolve` → `/v1/decide` 200
