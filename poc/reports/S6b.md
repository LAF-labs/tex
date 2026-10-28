# S6b — Playwright가 금고 MessagePort 중계 위에서 동작하는가

- 날짜: 2026-10-28 · 태스크: PoC-4 · 브랜치 `claude/poc-vault-localdata-d175a0`
- 환경: macOS(arm64), 설치 Chrome **156.0.8078.73**, Playwright(playwright-core) **1.64.1**, Node 26 / Electron 45.1.0(Node 24.22)
- 근거 테스트: `poc/tests/playwright-relay.test.ts`, `poc/tests/vault-relay.test.ts`
- 원자료: `poc/reports/raw/s6b-playwright.json`, `poc/reports/raw/relay-measurements.json`
- Windows 11에서는 아직 재확인하지 않았다(PoC-1 VM 준비 후).

## 결론

| 질문(D13 S6b) | 결과 |
|---|---|
| Playwright가 MessagePort 중계 위에서 동작하는가 | **동작한다.** WS 폴백(D05 §3.2 `ws_fallback`)은 필요 없다. `relay.transport = messageport` 유지 |
| 브라우저 타깃 없이 쓸 수 있는 최소 CDP 메서드·도메인 집합 | 아래 §3. 루트(브라우저) 수준은 **합성 응답 3개**만 있으면 된다. 실제 브라우저 세션은 엔진에 주지 않는다 |
| 비밀 origin에서 `addScriptToEvaluateOnNewDocument`·`addBinding`을 막아도 동작하는가 | `Runtime.addBinding`은 **전면 거부해도 기본 조작이 된다**(`noDefaults`에서는 호출 안 함, `exposeFunction`만 실패). `Page.addScriptToEvaluateOnNewDocument`는 Playwright가 **page 부착 때마다 유틸리티 world용(빈 소스 + worldName)** 으로 부른다 → 비밀 origin 거부(Phase 2 `relay.denyOnSecretOrigins`)를 넣을 때 이 호출은 예외 처리하거나 "등록 시점 origin"으로 판정해야 한다(§5) |

## 1. 연결 방식

Playwright 1.64 클라이언트의 `chromium.connectOverCDP()`는 문서에 없는 오버로드로 **`ConnectionTransport` 객체**(`send()`·`close()`·`onmessage`·`onclose`)를 받는다. 이 경로는 in-process 모드(엔진 프로세스 안에서 Playwright 서버가 도는 기본 모드)에서만 쓸 수 있다. 엔진은 이 전송을 금고 포트(`{t:'cdp', m: JSON}`)에 연결한다(`poc/packages/engine/src/vault-client.ts`, `browser.ts`).

```ts
chromium.connectOverCDP(vault.cdpTransport(), { noDefaults: true, isLocal: true })
```

- `noDefaults: true`: 기본 컨텍스트에 `Browser.setDownloadBehavior`·`Emulation.setFocusEmulationEnabled`를 보내지 않는다. 다운로드 경로는 금고 상수(D05 §3.3)이므로 이 옵션이 맞다.
- 공개 타입에 없는 API라 **버전 고정이 필요하다**(playwright-core 1.64.1 고정, 올릴 때 이 보고서의 테스트를 회귀로 돌린다). 1.64 번들 안에 같은 목적의 내부 중계(MCP 확장용 relay)가 있어 당분간 유지될 가능성이 높지만 보장은 없다.

## 2. 가상 루트(브라우저 세션 대체)

엔진은 브라우저 타깃 세션을 받지 않는다. 엔진이 `sessionId` 없이 보내는 명령은 금고가 직접 처리한다(`poc/packages/vault/src/relay/relay.ts` `onRootCommand`).

| 루트 명령 | 금고 처리 | Playwright 연결에 필요한가 |
|---|---|---|
| `Browser.getVersion` | 금고가 기동 때 받은 값을 돌려준다 | 필요 |
| `Target.setAutoAttach{flatten:true}` | 엔진 자동 부착을 켠 것으로 기록한다. 노출 타깃(실행 page + 그 팝업)마다 금고가 `Target.attachToTarget`으로 **엔진 전용 세션**을 만들어 `Target.attachedToTarget`으로 알려 준다. 브라우저 수준 자동 부착은 금고만 한다 | 필요 |
| `Target.getTargetInfo`(인자 없음) | 가상 루트 정보(`type: browser`, 가짜 id)를 준다. Playwright는 연결 장벽으로만 쓰고 결과를 쓰지 않는다 | 필요 |
| `Target.getTargetInfo{targetId}` / `Target.closeTarget` / `Target.activateTarget` | 노출 타깃이면 금고가 전달, 아니면 거부 | `page.close()`에서 사용 |
| `Target.getBrowserContexts` | 빈 목록 | 호출 안 됨(예비) |
| 그 밖 전부 | 거부 + `vault.cdp_denied` | — |

팝업은 금고의 브라우저 수준 자동 부착(`waitForDebuggerOnStart`)으로 멈춘 채 들어온다. 실측하면 Chrome은 이때 팝업과 OOPIF iframe의 `targetInfo.url`을 **비워 준다**. 그래서 노출 판정은 **fail-closed**로 한다(PR #1 Bugbot 재검토 반영).

- 빈 URL은 "허용"이 아니라 "모름"이다. 금고가 숨긴 채 재개하고, **문서 커밋(`Page.frameNavigated`) 뒤 `Page.getFrameTree`로 같은 URL을 다시 확인**한 경우에만 엔진에 붙인다. 시간이 지났다고 노출하지는 않는다(이전의 1.5초 폴백은 없앴다).
- about:blank는 opener·부모가 허용 origin이고 커밋·`getFrameTree`로 확인된 경우에만 통과한다. 빈 URL과 `chrome-error://`는 확인된 것으로 치지 않는다. 허용 밖 이동 시작(`frameStartedNavigating`, 서버 리디렉션 포함)이나 허용 밖 커밋이 한 번이라도 확인된 팝업은 **영구 거부**한다(`vault.popup_hidden`). 나중에 허용 host로 와도 노출하지 않는다. 자식의 `revokeChild`와 같은 규칙이고, 노출 뒤 `originLeft`된 타깃도 다시 노출하지 않는다.
- 노출 뒤에는 `Page.frameStartedNavigating`(Chrome 156)으로 **이동이 시작되는 순간** 허용 밖이면 엔진 세션을 분리한다. 그래서 커밋 전 틈이 없다. 커밋 시점 재검사(`frameNavigated`)도 그대로 둔다.
- 거부는 단조롭다. 상태(`revoked`)를 먼저 기록하고 세션은 그 뒤에 분리한다. `expose()`·`attachEngine()`은 await마다 이 표시를 다시 확인하고, 거부되면 새 엔진 세션을 분리할 뿐 `attachedToTarget`을 보내지 않는다. 메인 프레임 판정은 `mainFrameId` 유무와 무관하게 타깃 ID 기준이다(경쟁 회귀 `tests/relay-race.test.ts`).
- 엔진은 팝업을 `waitingForDebugger: false`(실행 중)로 받는다. 사용자가 연 탭은 재개만 하고 엔진에 알리지 않는다(`vault.user_tab_hidden`).

자식(OOPIF iframe) 세션도 같은 원칙을 따른다.
- 금고가 자식 세션에 `Page.enable`을 켜 둔다(엔진의 `Page.disable`은 거부). 이동 시작과 커밋마다 origin을 재검사하고, 허용 밖이면 **그 자식과 자손만** 분리한 뒤 엔진에 분리 이벤트를 합성한다(`vault.child_origin_left`). 부모 page는 유지된다.
- 부착 url이 비면 `getFrameTree`의 커밋 URL로 판정한다. 아직 커밋 전이면 보류하고, 커밋 + `getFrameTree` 확인 뒤에만 엔진에 알린다.
- 회귀 테스트: 3초 늦게 응답하는 허용 밖 host로 가는 팝업·iframe은 5초 동안 끝까지 비노출이다. 빈 팝업이 허용 밖으로 이동을 시작하면 응답 전에 분리된다. 허용 host로 늦게 커밋되는 팝업은 커밋 뒤 노출된다. 허용 밖 host를 거쳐 허용 host로 리디렉션되는 팝업(서버 302·클라이언트 이동)은 끝까지 비노출이다.

## 3. 최소 메서드 집합(관측)

Playwright 기본 조작(goto·fill·click·focus·inputValue·waitForURL·evaluate·frameLocator·popup·worker·request 이벤트·screenshot)에서 금고를 통과한 메서드 전체:

- **루트(합성)**: `Browser.getVersion`, `Target.setAutoAttach`, `Target.getTargetInfo`, (`Target.closeTarget`)
- **page·자식 세션(전달)**: `Page.enable`, `Page.getFrameTree`, `Page.setLifecycleEventsEnabled`, `Page.addScriptToEvaluateOnNewDocument`, `Page.createIsolatedWorld`, `Page.navigate`, `Page.getLayoutMetrics`, `Page.setFontFamilies`, `Page.captureScreenshot`, `Runtime.enable`, `Runtime.evaluate`, `Runtime.callFunctionOn`, `Runtime.getProperties`, `Runtime.releaseObject`, `Runtime.runIfWaitingForDebugger`, `DOM.describeNode`, `DOM.resolveNode`, `DOM.getContentQuads`, `DOM.scrollIntoViewIfNeeded`, `Input.dispatchMouseEvent`, `Input.insertText`, `Network.enable`, `Log.enable`, `Inspector.enable`, `Target.setAutoAttach`(page 수준, `flatten:true` 강제)
- 이에 맞춰 허용 목록 상수(`poc/packages/vault/src/constants.ts`)를 D05 §3.3 초기값에서 다음처럼 조정했다: `Inspector`(enable·disable)를 추가했다. `Target`은 page 세션의 `setAutoAttach`·`detachFromTarget`만 허용한다. `Network`는 이벤트 수신·읽기 메서드만 허용하고 `setUserAgentOverride`·쿠키 계열은 거부한다. `Emulation`은 포커스·미디어 3개만 허용한다. `Fetch.enable`은 패턴이 허용 호스트일 때만 허용한다.

## 4. 허용 목록 밖 Playwright API(실패해야 하는 것)

| Playwright 호출 | 결과 |
|---|---|
| `context.newPage()` | 실패 — `Target.createTarget` 거부(실행 page는 금고가 만든다) |
| `browser.newContext()` | 실패 — `Target.createBrowserContext` 거부 |
| `context.newCDPSession(page)` | 실패 — `Target.attachToBrowserTarget` 거부 |
| `context.cookies()` / `addCookies()` / `clearCookies()` / `storageState()` | 실패 — `Storage.*` 거부 |
| `page.exposeFunction()` | 실패 — `Runtime.addBinding` 거부 |
| `page.goto('https://example.com/')` | 실패 — `Page.navigate` origin 거부 |
| 링크로 허용 밖 origin 이동 | 금고가 문서 커밋을 보고 엔진 세션 분리(`vault.origin_left`), 그 커밋 이벤트는 엔진에 안 감 |
| `DOM.setFileInputFiles`(원시) | 거부 |
| `context.addInitScript()`, `page.screenshot()`(오염 전) | 허용(동작) |

실패 뒤에도 같은 page를 계속 쓸 수 있다(세션이 깨지지 않음).

## 5. 비밀 창과의 상호작용(S6f와 겹치는 관측)

1. **활성 창 동안** 엔진의 Playwright 조작은 실패한다. `click`은 시간 초과, `evaluate`는 "Execution context was destroyed"로 보이고, `title()`은 거부된 호출을 빈 문자열로 돌려준다. 값은 새지 않는다. 엔진은 `secret_window.closed` 이벤트를 기다린 뒤 다음 스텝을 진행해야 한다.
2. **오염 상태에서 Playwright 주입 스크립트를 처음 띄우는 것이 막힌다.** D05 §3.4의 값 접근 패턴 차단(`.value` 등)이 Playwright 주입 스크립트 소스(약 33만 자, `.value` 포함)에도 걸리기 때문이다. 그래서 그 world에서는 locator가 멈춘다. PoC는 엔진이 비밀 창을 열기 전에 메인·유틸리티 world를 미리 만든다(`warmForSecretWindow`). 문서가 커밋되면 오염이 풀리므로, 제출 뒤 새 페이지는 영향이 없다.
3. Playwright의 `Runtime.callFunctionOn`은 범용 래퍼(`(utilityScript, ...args) => utilityScript.evaluate(...args)`)이고 실제 코드는 **문자열 인자**로 간다. 함수 선언만 보는 패턴 차단은 이 경로를 전혀 못 거른다. PoC는 문자열 인자까지 검사하도록 넓혔다. 그래도 `page.inputValue('#pw')`는 통과했고(`injected.inputValue` 경유), 평문은 **알려진 값 지우기**(금고가 입력했거나 활성 창 종료 때 읽은 값의 직렬화 변형을 엔진행 메시지에서 `[vault-redacted]`로 바꿈)에서 막혔다. D05 §3.5 정직 문구("패턴 차단은 경계가 아니다")가 그대로 맞다.
4. `Page.addScriptToEvaluateOnNewDocument`(D05 §4.1 `denyOnSecretOrigins`, Phase 2): Playwright는 page 부착 때 `{source: '', worldName: <utility>}`를 등록한다. 비밀 origin 문서 스크립트를 일괄 거부하면 Playwright 초기화가 깨질 수 있다. 빈 소스 + 유틸리티 world 등록은 예외로 두거나, 등록 시점(about:blank)과 비밀 창 개시 시점에 각각 따로 판정해야 한다. Phase 2 착수 때 다시 측정한다.

## 6. 설계에 올린 질문(보드 PoC-4 스레드)

- D05 §4-3: `Input.setIgnoreInputEvents(true)`는 CDP `Input.dispatchKeyEvent`도 막는다(`insertText`만 통과, 실측). PoC 기본값은 "입력 차단 + 글자 단위 `insertText`(키 이벤트 없음)"이고, 상수 `TYPIST_INPUT_MODE`로 바꿀 수 있다.
- D05 §3.4: 오염 중 Runtime 패턴 차단이 Playwright 주입 스크립트 첫 기동과 충돌한다(위 §5-2). 엔진 사전 준비, 주입 스크립트 해시 허용 목록, 패턴 차단 제거 가운데 어느 것으로 갈지 정해야 한다.
- D05 §3.3 "`Target.setAutoAttach`는 금고만": PoC는 **브라우저 수준**만 금고가 하고, page 수준은 엔진에 허용한다. 자식 세션(워커·iframe)은 금고가 origin으로 걸러 허용 밖이면 재개 후 분리한다. 이 해석이 맞는지 확인이 필요하다.

## 7. 재현

```bash
cd poc && pnpm install && node scripts/run-tests.mjs playwright-relay vault-relay
```
