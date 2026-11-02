# R11. PC 승인 근거 조사: Electron 입력 이벤트, WebContentsView, Windows Hello

> 조사일: 2026-10-31 · 대상: Electron 45.x(PoC 45.1.0), Windows 11 · 용도: ADR-021(PC 승인의 근거) 결정 입력
> **검증 수준**: 문서·공개 소스 조사 전용이다. Windows 실기 측정은 하지 않았다. 마지막 절의 확인 목록은 ADR-021 "조건"과 PoC-6에서 확인한다.

조사 시점 최신 안정판은 Electron 45.2.1이다. 내려받은 소스 사본은 저장소에 두지 않았다.

출처 표기: **[공식]** 공식 문서·릴리스 노트, **[소스]** Electron/Chromium/Microsoft 공개 소스 코드 또는 이슈·PR, **[2차]** 블로그·타사 앱 소스·npm 패키지, **[추론]** 내 추론. 확인 못 한 것은 "미확인"으로 적었다.

---

## Q1. `before-mouse-event`

**추가 버전.** Electron 36.5.0(2025-06-18 릴리스)과 37.0.0(2025-06-24 릴리스)에 들어갔다. 원 PR은 main에 2025-06-04 머지된 #47280이고 "Closes #15646"이다. 백포트는 36.x가 #47365, 37.x가 #47364다. Electron 45에는 당연히 포함된다. (확신도 높음)
- https://github.com/electron/electron/pull/47280
- https://github.com/electron/electron/pull/47365
- https://github.com/electron/electron/releases/tag/v36.5.0
- https://github.com/electron/electron/releases/tag/v37.0.0

**정확한 의미.** 브라우저(메인) 프로세스에서 동기로 발생하며, 렌더러로 보내기 전에 발생한다. (확신도 높음)
- 공식 문서 문구는 "Emitted before dispatching mouse events in the page. Calling `event.preventDefault` will prevent the page mouse events." 이다. https://www.electronjs.org/docs/latest/api/web-contents#event-before-mouse-event [공식]
- 구현은 Chromium `WebContentsDelegate::PreHandleMouseEvent`를 Electron이 받아 `Emit("before-mouse-event", event)`로 내보내는 것이다. 핸들러가 `preventDefault`하면 `true`를 돌려주고, Chromium은 그 이벤트를 렌더러로 보내지 않고 버린다. [소스]
  - Electron: https://github.com/electron/electron/blob/45-x-y/shell/browser/api/electron_api_web_contents.cc (`PreHandleMouseEvent`)
  - Chromium: https://github.com/chromium/chromium/blob/main/content/browser/renderer_host/render_widget_host_impl.cc (`ForwardMouseEventWithLatencyInfo`). 이 함수에서 `PreHandleMouseEvent`는 터치 에뮬레이터와 `InputRouter` 전송보다 앞에 있다.
- Chromium 헤더 주석: "Allows delegates to handle mouse events before sending to the renderer... NOTE: Does not currently handle wheel events." 또 "mousedown을 처리했으면 대응하는 mouseup도 처리하라", "핸들러에서 복잡한 일을 하면 재진입/UAF 위험이 있으니 단순하게 유지하라"는 경고가 붙어 있다. https://github.com/chromium/chromium/blob/main/content/public/browser/web_contents_delegate.h [소스]

**이벤트 종류.** (확신도 높음)
- 발생하는 것: mouseDown, mouseUp, mouseMove, mouseEnter, mouseLeave, contextMenu. 이벤트 객체는 `type, clickCount, movementX/Y, button, x, y, globalX, globalY`다. 숫자는 소수일 수 있다. 문서 예시의 `x: 632.359375`가 그 예다. [소스] PR #47280 diff
- 발생하지 않는 것: **mouseWheel**. `ForwardWheelEventWithLatencyInfo`에는 PreHandle이 없다. [소스]
- 터치스크린/제스처: 터치 입력은 `ForwardTouchEventWithLatencyInfo`, 제스처는 `ForwardGestureEvent` 경로라서 `ForwardMouseEvent`를 거치지 않는다. 따라서 **순수 터치 탭은 `before-mouse-event`를 일으키지 않을 가능성이 높다.** (확신도 중간, Windows 터치 기기에서 확인 필요) https://github.com/chromium/chromium/blob/main/content/browser/renderer_host/render_widget_host_view_event_handler.cc [소스+추론]
- 키보드로 버튼을 활성화(Enter/Space)하면 마우스 이벤트가 없다. 이때는 `before-input-event`만 발생한다. [추론]
- `before-input-event`는 keyDown(rawKeyDown)/keyUp만 낸다. Char 이벤트는 내지 않는다. [소스] 위 electron_api_web_contents.cc

**좌표.** (확신도 중간)
- 공식 문서는 단위를 말하지 않는다. `MouseInputEvent`는 `x, y Integer`로만 적혀 있다. https://www.electronjs.org/docs/latest/api/structures/mouse-input-event [공식]
- 소스상 `x, y`는 `PositionInWidget`이다. 해당 webContents 자신의 뷰(위젯) 기준이다.
- `before-mouse-event`가 도는 시점은 `InputRouterImpl::ScaleEvent`(device scale factor 곱셈)보다 앞이다. 그래서 물리 픽셀이 아니라 배율 적용 전, 곧 DIP 계열 좌표로 보는 것이 맞다. https://github.com/chromium/chromium/blob/main/components/input/input_router_impl.cc [소스+추론]
- 따라서 Windows 125%/150%에서도 좌표는 DIP 기준일 가능성이 높다. 페이지 줌(Ctrl +/-)은 렌더러 쪽 처리라서 이 좌표에 영향이 없을 것으로 본다. [추론, 미확인]
- `globalX/globalY`의 단위(물리/DIP)는 미확인이다. 쓰지 않는 편이 안전하다.
- 참고: `sendInputEvent` 좌표가 분수 배율에서 어긋난다는 보고(#53050)가 있다. 다만 Linux/Wayland 보고이고, 템플릿 미준수로 자동 종료됐으며, `before-mouse-event` 쪽 이야기가 아니다. Windows 근거로 쓰면 안 된다. https://github.com/electron/electron/issues/53050 [소스, 약함]

---

## Q2. 침해된 렌더러가 `before-input-event`/`before-mouse-event`를 일으킬 수 있는가

**결론.** 알려진 렌더러 경로는 없다. 다만 "OS 입력만"이 일으키는 이벤트는 아니다. (확신도 중간. Chromium 전체 mojo 표면을 감사한 것은 아니다.)

- 렌더러에서 `dispatchEvent`로 만든 DOM 이벤트는 렌더러 내부에만 있다(`isTrusted=false`). 브라우저 프로세스의 `RenderWidgetHost`로 올라오지 않는다. 이 이벤트는 PreHandle 경로를 타지 않는다. [추론]
- Chromium은 `ForwardMouseEventWithLatencyInfo` 안에 "Input comes from the OS (trusted)..."라고 적어 두었다. 이는 메모리 안전 검사 제외의 근거로 쓴 주석이다. 인증 보증을 약속하는 문서는 아니다. [소스]
- 프로덕션 코드에서 `RenderWidgetHostImpl::ForwardMouseEvent`를 부르는 곳은 다음과 같다. (`gh search code` 결과에서 테스트와 ChromeOS 전용 코드는 제외)
  - OS 입력 경로(`RenderWidgetHostViewEventHandler::ProcessMouseEvent`)
  - **DevTools 프로토콜 `Input.dispatchMouseEvent`** (`devtools/protocol/input_handler.cc`)
  - Electron `webContents.sendInputEvent` [소스]
  - 그러므로 CDP로 주입한 마우스 이벤트도 `before-mouse-event`를 일으킨다. CDP에 닿을 수 있는 쪽은 메인 프로세스(`webContents.debugger`)이거나, 앱이 `--remote-debugging-port/pipe`로 실행됐을 때의 로컬 프로세스다. 패키지 앱에서 이 스위치가 막히는지는 **미확인**이다. Electron fuses 문서에도 이를 막는 퓨즈는 없다. https://www.electronjs.org/docs/latest/tutorial/fuses [공식]
  - CDP 키 이벤트는 `native_key_code`가 없으면 `skip_if_unhandled=true`가 되어 `PreHandleKeyboardEvent`(`before-input-event`)를 건너뛴다. [소스+추론]
- `webContents.sendInputEvent`는 메인 전용 API다(문서 `Process: Main`). 마우스는 `rwh->ForwardMouseEvent`, 키보드는 `rwh->ForwardKeyboardEvent`로 가서 두 이벤트를 **일으킨다**. 공식 테스트도 `sendInputEvent`로 `before-mouse-event`를 검증한다. 휠은 PreHandle이 없어서 일으키지 않는다. [소스] electron_api_web_contents.cc, PR #47280 spec
- 렌더러가 메인 없이 `sendInputEvent`를 부를 수 있는 공식 경로 하나가 `<webview>.sendInputEvent`다. `webviewTag` 기본값은 `false`이고, 대상은 임베더가 아니라 guest webContents다. https://www.electronjs.org/docs/latest/api/webview-tag , https://www.electronjs.org/docs/latest/api/structures/web-preferences [공식]
- 다른 경로는 우리가 만든 IPC 핸들러가 `sendInputEvent`나 `debugger`를 대신 불러 주는 경우다. 보안 체크리스트 17번(발신자 검증), 20번(Electron API 노출 금지)이 관련된다. https://www.electronjs.org/docs/latest/tutorial/security [공식]

---

## Q3. `SendInput` 합성 입력은 구분되는가

**결론.** Electron/Chromium에서는 구분되지 않는다. Electron에 이를 노출하는 API도 없다. (확신도: API 없음은 높음, Chromium 동작은 중간)

- Electron 자체 Windows 테스트 헬퍼가 "SendInput()으로 넣은 이벤트는 물리 마우스와 똑같이 시스템 입력 큐에 들어가고, WM_MOUSEMOVE/WM_*BUTTON*으로 전달된다"고 적어 두었다. 같은 주석에 "`webContents.sendInputEvent()`는 Blink에 직접 넣으므로 Win32를 거치지 않는다"고 구분해 두었다. https://github.com/electron/electron/blob/main/spec/fixtures/native-addon/mouse-input/src/main_win.cc [소스]
- Chromium Windows 이벤트 변환은 `GetMessageExtraInfo()`로 `MOUSEEVENTF_FROMTOUCH`(터치/펜에서 합성된 마우스)만 구분한다. `LLMHF_INJECTED` 검사는 찾지 못했다. https://github.com/chromium/chromium/blob/main/ui/events/win/events_win_utils.cc [소스]
- `LLMHF_INJECTED`는 저수준 훅(`WH_MOUSE_LL`)의 `MSLLHOOKSTRUCT.flags`에만 있다. 창 프로시저가 받는 WM_ 메시지에는 없다. https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-msllhookstruct [공식]
  - 네이티브 애드온으로 `WH_MOUSE_LL` 훅을 걸어 주입 여부를 확인하는 것은 이론상 가능하다. Electron이 제공하지 않으므로 직접 만들어야 한다. [추론]
- `SendInput`은 UIPI 제약을 받는다. 같거나 낮은 무결성 수준의 앱에만 주입할 수 있다. 같은 사용자·같은 무결성 프로세스는 주입 가능하다. https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput [공식]
- UI Automation/MSAA의 `Invoke/DoDefaultAction`은 마우스 이벤트를 만들지 않을 것으로 본다. 이 경우 `before-mouse-event`는 안 뜨고 DOM click만 렌더러에서 일어난다. 승인 증거를 DOM click이 아니라 메인의 `before-mouse-event`로 잡는 설계의 장점이다. [추론, 미확인]

---

## Q4. `WebContentsView` 오버레이 (후보 c)

| 항목 | 답 | 근거·확신도 |
|---|---|---|
| Z-order | `BrowserWindow`의 자체 webContents는 `contentView`의 **형제로, 자식들보다 앞(아래)에 삽입**돼서, `win.contentView`의 자식 뷰는 항상 그 위에 그려진다(Electron 30, PR #41256). 같은 부모에 나중에 추가된 자식이 위. 이미 있는 뷰를 다시 `addChildView`하면 최상단으로 재정렬된다. 네이티브 형제 뷰 위에 페이지 DOM이 그릴 수는 없다. | PR https://github.com/electron/electron/pull/41256 , 문서 https://www.electronjs.org/docs/latest/api/view [공식·소스], 높음. 페이지의 `<select>` 팝업, 컨텍스트 메뉴, DevTools 같은 별도 위젯이 오버레이를 덮을 수 있는지는 **미확인** |
| 클릭 가로채기 | 위 뷰는 자기 bounds 안의 포인터를 모두 받는다. 투명 영역도 마찬가지고, **클릭 투과(click-through) 기능은 없다**(기능 요청 #49039 오픈, 사용자 보고: "상단 투명 뷰가 하위 레이어로의 포인터를 막는다"). `View.setBorderRadius` 문서도 "잘라낸 영역도 클릭을 캡처한다"고 적었다. 따라서 오버레이 위의 클릭은 채팅 webContents에 가지 않고, 채팅의 `before-mouse-event`도 뜨지 않는다. | https://github.com/electron/electron/issues/49039 [소스], 중간~높음 |
| `setBounds` 단위 | 문서에 단위 설명이 없다. 소스는 `views::View::SetBoundsRect(gfx::Rect)`를 그대로 호출하므로 **부모 기준 DIP, 정수**다. | `electron_api_view.cc` [소스+추론], 높음 |
| 창 리사이즈 | 자동 리사이즈 없음(`setAutoResize` 요청 #43802 오픈). `resize` 이벤트에서 직접 `setBounds`해야 한다. | https://www.electronjs.org/blog/migrate-to-webcontentsview , https://github.com/electron/electron/issues/43802 [공식·소스] |
| 투명/배경 | 기본은 **흰 배경**. 투명은 `setBackgroundColor('#00000000')`처럼 알파가 있는 헥스로만 된다. `'transparent'`는 허용 색이 아니다. | 위 블로그, 이슈 #44914 [공식·소스], 높음 |
| `webPreferences` | 생성자가 BrowserWindow와 같은 `WebContents::CreateFromWebPreferences`를 쓰므로 `javascript:false`, `sandbox:true`(기본 true), `partition/session`, 프리로드 없음이 모두 된다. | `electron_api_web_contents_view.cc` `WebContentsView::New`, web-preferences 문서 [소스·공식], 높음 |
| 포커스 | 오버레이를 클릭하면 채팅 textarea의 포커스를 **가져간다**. WebContentsView에는 `focusable` 옵션이 없고(#42922 오픈), 사용자 우회법은 오버레이 포커스 직후 메인 뷰에 `webContents.focus()` 재호출이다. 키보드 이벤트는 포커스를 가진 webContents로 간다. 탐색 커밋 시 포커스를 가져가는 동작은 `webPreferences.focusOnNavigation:false`(Electron 40+, PR #49425)로 끈다. | https://github.com/electron/electron/issues/42922 , https://github.com/electron/electron/issues/42339 , https://github.com/electron/electron/pull/49425 [소스], 중간~높음 |
| 접근성 | 오버레이는 일반 웹 콘텐츠라 자체 접근성 트리를 가진다. [추론] 별개로 **Electron 30부터 NVDA/JAWS 마우스 호버 읽기가 BrowserWindow 전반에서 깨져 있다**(이슈 #42945 오픈, 수정 PR #53460 오픈). 원인은 `contentView`가 접근성 hit-test를 가로채는 것이다. 키보드 탐색 영향은 미확인. | https://github.com/electron/electron/issues/42945 , https://github.com/electron/electron/pull/53460 [소스], 중간 |
| 드래그 영역 함정 | 프레임리스 창에서 채팅 페이지의 `-webkit-app-region: drag` 영역 위에 뷰를 놓으면, 그 좌표가 드래그 영역으로 판정돼 오버레이 클릭이 창 드래그가 될 수 있다("어느 뷰든 그 좌표 아래에 draggable이 있으면 draggable"이라는 메인테이너 설명). 오버레이를 드래그 영역 밖에 두면 된다. | https://github.com/electron/electron/issues/43320 [소스], 중간 |
| 겹친 뷰 마우스 오류 | macOS 보고(#48098: 겹친 뷰에서 드래그 후 hover 관통, 메인테이너가 재현했으나 정책 미결 상태로 비활성 종료). Windows 전용 오라우팅 보고는 찾지 못했다. | https://github.com/electron/electron/issues/48098 [소스], 중간 |
| 분수 DPI(125/150%) | WebContentsView 전용 버그는 **찾지 못했다**. 관련 약한 신호: #54627(Electron 43, Windows 11, 모니터 간 이동 뒤 **그려진 위치와 hit-test 위치가 어긋남**, 재현 코드 없어 종료), #55245(분수 배율에서 창 상태 복원이 1~2px씩 드리프트, 오픈), #51730(창 `setBounds`가 100% 초과 배율에서 부정확, 중복 처리). | https://github.com/electron/electron/issues/54627 , /55245 , /51730 [소스, 약함] |

보태는 말: 오버레이를 쓰려면 `addChildView`는 클릭 직전에 하지 말고 미리 만들어 두고, 보이기/숨기기는 `setVisible`로 할 것을 권한다. 숨겨진 뷰가 탐색 커밋 때 키보드 포커스를 가져간 보고(#54321, Linux, Electron 44.4.5)가 있다. [소스, 추론]

---

## Q5. Electron 내장 Windows Hello/생체 API

**없다.** `systemPreferences.canPromptTouchID()`와 `promptTouchID(reason)`은 **macOS 전용**이다. Windows용 대응 API는 45-x-y 문서에 없다. (확신도 높음)
- https://www.electronjs.org/docs/latest/api/system-preferences [공식]
- 관련 오픈 이슈로 WebAuthn/FIDO2 지원(#24573)이 있다. https://github.com/electron/electron/issues/24573 [소스]

---

## Q6. `UserConsentVerifier`

**`CheckAvailabilityAsync()` 값.** 공식 정의는 다음과 같다. [공식] https://learn.microsoft.com/en-us/uwp/api/windows.security.credentials.ui.userconsentverifieravailability
| 값 | 공식 설명 |
|---|---|
| Available(0) | An authentication device is available. |
| DeviceNotPresent(1) | There is no authentication device available. |
| NotConfiguredForUser(2) | An authentication device is not configured for this user. |
| DisabledByPolicy(3) | Group policy has disabled the authentication device. |
| DeviceBusy(4) | The authentication device is performing an operation and is unavailable. |

- **PIN만 있어도 Available인가?** 클래스 설명이 "authentication device, such as a Microsoft Passport PIN, Windows Hello biometric, or fingerprint reader"라고 PIN을 장치로 열거한다. NotConfiguredForUser 예제 문구도 "set up a PIN or other advanced authentication"이다. 따라서 PIN만 설정된 경우도 Available로 보는 게 맞다. (확신도 중간. 실기 확인 필요) https://learn.microsoft.com/en-us/uwp/api/windows.security.credentials.ui.userconsentverifier [공식]
- **Hello 미구성 PC/VM의 반환값.** 공식 문서에 명시가 없다. 관측한 `DeviceNotPresent`는 정의("no authentication device available")와 모순되지 않는다. DeviceNotPresent와 NotConfiguredForUser를 가르는 정확한 조건은 **미확인**이다. 가상 TPM + PIN을 설정한 VM으로 확인할 일이다. Chromium은 `Available`만 "사용 가능"으로 취급한다. https://github.com/chromium/chromium/blob/main/device/fido/win/util.cc [소스]
- Bitwarden은 `Available`과 `DeviceBusy`를 가용으로 본다. https://github.com/bitwarden/clients/blob/main/apps/desktop/desktop_native/biometric/src/windows.rs [2차]

**`RequestVerificationAsync(message)` 결과값.** Verified(0), DeviceNotPresent(1), NotConfiguredForUser(2), DisabledByPolicy(3), DeviceBusy(4), RetriesExhausted(5, "After 10 attempts..."), Canceled(6)다. [공식] https://learn.microsoft.com/en-us/uwp/api/windows.security.credentials.ui.userconsentverificationresult

**Win32/비패키지 앱.** (확신도 높음)
- 일반 `RequestVerificationAsync`는 "UWP 앱용"이라고 공식 문서가 명시한다. 데스크톱은 `IUserConsentVerifierInterop::RequestVerificationForWindowAsync(HWND, message, riid, **op)`를 쓰라고 한다. https://learn.microsoft.com/en-us/uwp/api/windows.security.credentials.ui.userconsentverifier.requestverificationasync , https://learn.microsoft.com/en-us/windows/win32/api/userconsentverifierinterop/nf-userconsentverifierinterop-iuserconsentverifierinterop-requestverificationforwindowasync [공식]
- 평범한 `Request*` 메서드는 데스크톱 앱에서 지원되지 않는다. 내부가 `Windows.UI.Popups`와 CoreWindow를 요구하기 때문이다. 실제 증상은 프롬프트가 앱 창 뒤에 뜨는 것이다(WindowsAppSDK 토론 #1265, JavaFX 사례). https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/desktop-to-uwp-supported-api , https://github.com/microsoft/WindowsAppSDK/discussions/1265 [공식·소스]
- **패키지 ID는 불필요**해 보인다. 패키지 ID가 필요한 WinRT 목록에 `UserConsentVerifier`/`KeyCredential*`이 없다(목록이 완전하다고는 안 한다). 비패키지 Win32 앱인 Chromium, Bitwarden, Telegram이 실제로 쓴다. Chromium은 브라우저 창의 HWND로 `RequestVerificationForWindowAsync(hwnd, message)`를 호출한다. https://github.com/chromium/chromium/blob/main/chrome/browser/device_reauth/win/authenticator_win.cc [소스+2차]
- 최소 지원 OS: 인터롭 인터페이스 문서는 "Windows Build 22000"(Windows 11)이라 적었다. 신규 npm 패키지 README는 Windows 10에서도 동작한다는 근거(CsWinRT, Microsoft 샘플)를 든다. Windows 11 중심이면 문제없다. [공식·2차]

**`message`가 대화상자에 보이는가.** (확신도 낮음)
- 공식 문서는 "A message to display to the user for this verification request."라고만 한다. **길이 제한은 문서에 없다.** 표시 위치·잘림·Windows 11 22H2~25H2별 UI 변화는 **미확인**이다. 공식·2차 어디에서도 "Windows 11에서 메시지가 안 보인다"는 보고를 찾지 못했지만, "보인다"고 확인해 주는 문서도 못 찾았다.
- "A상사 3,630,000원 세금계산서 발급" 같은 문구가 한글 포함 그대로 표시·유지되는지는 Windows 테스트 기기(22H2/23H2/24H2/25H2)에서 실제로 봐야 한다.
- 이 대화상자의 창 클래스명은 "Credential Dialog Xaml Host"로 알려져 있다. [2차] Bitwarden/Telegram 소스

**암호학적 증거 없음.** (확신도 높음) 반환형이 열거형 하나뿐이다. 서명·토큰·nonce가 없다. Microsoft의 Raymond Chen은 이를 "user consent verifier, not a data protector"라 하며, "프로그램이 침해됐다고 가정하면 이 프롬프트는 아무것도 보호하지 않는다. 침해 코드가 `UserConsentVerifier` 호출을 건너뛰도록 패치할 수 있기 때문"이라고 쓴다. 결과의 신뢰도는 호출 프로세스의 신뢰도와 같다. https://devblogs.microsoft.com/oldnewthing/20240924-00/?p=110308 [공식 개발자 블로그]. Bitwarden 소스 주석도 "yes/no authorization without any cryptographic backing"이라 적었다. [2차]

**Remote Desktop / 잠금.** (미확인)
- 공식 문서에 `UserConsentVerifier`의 RDP 세션 동작이나 PC 잠금 중 동작이 적혀 있지 않다.
- Chromium은 `WTSQuerySessionInformation(WTSClientProtocolType) != WTS_PROTOCOL_TYPE_CONSOLE`로 RDP 세션을 감지한다. 앱이 RDP를 감지해 승인을 거부하거나 별도 처리하는 방법으로 참고할 만하다. https://github.com/chromium/chromium/blob/main/device/fido/win/util.cc [소스]
- 잠긴 상태는 보안 데스크톱이 달라 프롬프트 자체가 뜰 수 없다고 보지만 그 근거 문서는 못 찾았다. [추론]

**포커스 문제.** Bitwarden은 `UserConsentVerifier`가 "better focusing behavior"라 쓰고, 호출 시점의 `GetForegroundWindow()`를 HWND로 넘긴다. Hello 프롬프트가 포그라운드가 아니면 얼굴·지문 인식이 안 된다고 적었다. [2차] 새 npm 패키지 README도 "호출 전에 소유 창이 활성 상태여야 하고, `show()/focus()`만으로 포그라운드가 보장되진 않는다"고 쓴다. https://github.com/huhuanming/electron-windows-hello [2차]

---

## Q7. `KeyCredentialManager` / `KeyCredential.RequestSignAsync`

**서명 때마다 Hello 프롬프트가 뜨는가.** 공식 개발자 문서: 키 접근 API는 "explicit validation through a user gesture"를 요구하며, 앱은 키 재료를 보지 못하고 "서명" 같은 동작만 요청한다. `RequestSignAsync` 호출이 PIN/생체 입력을 요청하게 한다고 설명한다. 호출당 프롬프트가 기본이라고 보는 게 맞지만 캐시 의미는 미확인이다. (확신도 중간) https://learn.microsoft.com/en-us/windows/uwp/security/microsoft-passport [공식]
- 새 오버로드에 `KeyCredentialCacheConfiguration(cacheOption, timeout, usageCount)`와 `KeyCredentialCacheOption { NoCache, CacheWhenUnlocked }`가 있다. 문서 설명은 없고 windows-rs 메타데이터에만 보인다. 이 옵션을 켜지 않으면 기본이 NoCache일 것으로 추정하지만 **확인이 필요하다**. https://github.com/microsoft/windows-rs/blob/master/crates/libs/windows/src/Windows/Security/Credentials/mod.rs [소스, 문서 없음]

**사용자 메시지 지정.** `RequestSignAsync(IBuffer data)`에는 **메시지 파라미터가 없다.** 공식 문서 시그니처가 `data` 하나다. https://learn.microsoft.com/en-us/uwp/api/windows.security.credentials.keycredential.requestsignasync [공식]
- 새 API 표면(Windows 11 24H2 이상)에는 `message`가 있는 것이 보인다: `KeyCredentialManager.RequestCreateAsync(name, option, algorithm, message, cacheConfiguration, windowId, ChallengeResponseKind, attestationCallback)`와 `KeyCredential.RequestDeriveSharedSecretAsync(windowId, message, encryptedRequest)`. 하지만 **`RequestSignForWindowAsync(WindowId, IBuffer)`에는 message가 없다.** 이들 새 API는 MS Learn에 설명이 비어 있다. [소스, 문서 없음, 확신도 낮음]

**비패키지 Win32 / HWND 인터롭.**
- 일반 `RequestCreateAsync/OpenAsync/RequestSignAsync`는 비패키지 앱에서도 동작한다. 단 프롬프트가 **앱 뒤에 뜨고 포커스를 못 받는** 문제가 있다. Bitwarden(Electron+Rust)은 "서명 프롬프트가 즉시 포커스돼야 하는데 스스로 포커스하지 않는다"며 "Credential Dialog Xaml Host" 창을 `FindWindow`로 찾아 반복 포커스하는 우회를 쓴다. Telegram Desktop도 같은 우회를 쓴다. [2차]
- **Windows 11 24H2부터** HWND에서 얻은 `WindowId`(`Windows.UI.dll`의 `GetWindowIdFromWindow` 익스포트)를 받는 `RequestCreateForWindowAsync`/`RequestSignForWindowAsync`가 있다. MS Learn 모니커는 26100(24H2)과 28000만 표시하고, Telegram 소스 주석도 "from Windows 11 24H2"라 한다. 공식 문서 설명은 비어 있다. [공식 목록+2차, 확신도 중간]
  - https://learn.microsoft.com/en-us/uwp/api/windows.security.credentials.keycredential.requestsignforwindowasync
  - https://github.com/telegramdesktop/tdesktop/blob/dev/Telegram/SourceFiles/platform/win/wallet_protection_win.cpp
  - https://github.com/bitwarden/clients/blob/main/apps/desktop/desktop_native/biometric/src/windows_focus.rs

**다른 프로세스가 공개키로 서명을 검증할 수 있는가.** 가능하다. (확신도 높음, 형식은 중간)
- 공식 흐름이 정확히 그렇다. 앱이 `RetrievePublicKey()`를 서버에 등록하고, 서버가 챌린지를 보내면 앱이 `RequestSignAsync`로 서명하고, 서버가 표준 암호 API로 검증한다. https://learn.microsoft.com/en-us/windows/uwp/security/microsoft-passport [공식]
- 키는 RSA 2048이다. [공식] 서명 형식에서 **문서와 실측이 충돌한다.** MS Learn `KeyCredentialManager` 설명은 "PKCS #1 RSA PSS with SHA256"이다. 그러나 Telegram은 "RSASSA-PKCS1-v1_5 over SHA-256이며 결정적이다. 플랫폼 문서가 약속한 게 아니라 discrete-TPM 호스트에서 측정한 것"이라 적었다. Bitwarden도 "deterministic signature"에 의존한다. passport-desktop 예제도 Node `createVerify('SHA256')`(PKCS1 v1.5)로 검증한다. (PSS는 솔트 때문에 결정적이지 않다.) **검증기는 실기에서 두 방식을 모두 시도해 확정해야 한다.** [공식 vs 2차]
- 의미: 서버(송장 발급을 최종 승인하는 쪽)가 등록된 공개키로 "액션 해시에 대한 서명"을 검증하면, 이 증거는 호출 프로세스와 독립된 신뢰 영역에서 확인된다. 반대로 Electron 메인이 그 서명을 로컬에서 검증하는 구조는 "메인이 믿을 수 있는 증거"에 새로운 것을 더하지 않는다. 메인이 침해되면 같은 프로세스가 키를 쓸 수 있기 때문이다(단 매번 사용자 제스처는 필요). [추론]
- 키는 "현재 사용자 + 애플리케이션" 범위다. 다른 앱의 키는 못 쓴다. 비패키지 앱에서 "애플리케이션"이 무엇으로 식별되는지는 **미확인**이다. [공식, 일부 미확인]
- 증명(attestation): 선택 사항이며 TPM 필요. Telegram은 "TPM 보증 인증서와 Microsoft 온라인 서비스 증명서가 많은 PC에 없어서" 증명을 요구하면 PIN 입력 직후 실패가 났다고 적었다. 증명을 필수로 삼으면 안 된다. [2차]

**Windows 11 24H2+ 변화.** (확신도 낮음)
- 위의 `*ForWindowAsync` 오버로드, 캐시 설정, VBS enclave 챌린지(`ChallengeResponseKind.VirtualizationBasedSecurityEnclave`) 등 문서화되지 않은 API 표면이 늘었다. [소스]
- Enhanced Sign-in Security(ESS): VBS+TPM 2.0 기반으로 생체 데이터 경로를 격리한다. 매칭 성공 시 VBS 구성요소가 TPM에 보안 채널로 Hello 키 사용을 승인한다. 하드웨어 의존적이며(Copilot+ PC는 기본 활성), `UserConsentVerifier`의 반환 형태는 바꾸지 않는다. https://learn.microsoft.com/en-us/windows-hardware/design/device-experiences/windows-hello-enhanced-sign-in-security [공식]
- 패스키 관련 변경이 `UserConsentVerifier`/`KeyCredentialManager`의 동작을 바꿨다는 문서는 찾지 못했다. **미확인.**
- MS 문서는 "Windows Hello를 켜려면 Microsoft Entra ID 계정 또는 Microsoft 계정이 연결돼 있어야 한다"고 쓴다. 로컬 계정 PC에서 `KeyCredentialManager.IsSupportedAsync()`가 어떻게 나오는지는 **미확인**이다. 테스트 기기에서 확인한다. [공식 문구, 동작 미확인]

---

## Q8. Electron/Node에서 WinRT 호출 방법

| 방법 | 현황 | 평가 |
|---|---|---|
| **Rust `windows` 크레이트 + napi-rs (프로세스 내 애드온)** | Bitwarden 데스크톱(Electron)이 `UserConsentVerifier`(HWND 인터롭)와 `KeyCredentialManager`를 이 방식으로 쓴다(2026-10-15 커밋). https://github.com/bitwarden/clients/tree/main/apps/desktop/desktop_native/biometric | 검증된 방식. Node-API는 Electron 버전마다 재빌드가 필요 없는 ABI 안정 API다. 직접 유지보수 비용이 든다. [2차] |
| **C++/WinRT** | Chromium과 Telegram Desktop이 사용(Telegram은 2026-10-09 커밋). | 같은 취지. |
| **신규 npm: `electron-windows-hello` 0.1.0** | 2026-10-15 최초 공개, GitHub 별 0, MIT, Rust Node-API, x64/ARM64 프리빌드. `requestVerification({windowHandle: win.getNativeWindowHandle(), message})`가 HWND 인터롭 경로. 서명·키 생성 기능은 없다. 같은 설명의 `@onekeyfe/electron-windows-hello 44.0.2-alpha.1`도 있다. https://github.com/huhuanming/electron-windows-hello | 우리 용도에 가장 가깝지만 **2주 된 1인 프로젝트**다. Windows 10 상호작용 미시험을 README가 스스로 밝힌다. 그대로 의존하기보다 소스를 읽고 포크/참고용으로 보는 게 안전하다. Electron 45 호환은 "Node-API 8 지원 런타임" 주장뿐이고 직접 확인하지 않았다. |
| **`@microsoft/dynwinrt`** | Microsoft 저장소(MIT, 별 64), JS에서 WinRT를 코드 생성 없이 호출. Electron용 Windows Hello 샘플이 있다(`UserConsentVerifier` 가용성 + 인터롭으로 HWND 소유 대화상자). 최신 `0.1.0-preview.23`(2026-10-10), 릴리스 preview.24(2026-10-30). https://github.com/microsoft/dynwinrt/tree/main/samples/js/windows-hello | **프리뷰**다. 안정성 약속이 없다. 사용하면 인터롭 COM 접근도 쓰는 것이라 신뢰 코드가 늘어난다. [2차] |
| **NodeRT (`@nodert-win10-*`, `@nodert-win11*`)** | NAN 기반(`node-gyp rebuild`), 비공식 재게시본의 마지막 게시가 2022-09, NodeRT 본 저장소 마지막 커밋은 2023-06. https://github.com/NodeRT/NodeRT | 사실상 방치. Electron 45 호환 근거 없음. 생성된 `UserConsentVerifier` 래퍼에 HWND 인터롭이 있는지 확인하지 못했고, 없다면 "프롬프트가 창 뒤에 뜨는" 문제를 그대로 겪을 것이다. [추론] |
| **`passport-desktop`** (MarkusJx) | Rust napi-rs, `KeyCredentialManager` 서명+공개키 반환. 마지막 커밋 2023-08, 별 4. | 방치. HWND 소유 없음. [2차] |
| **`win-hello`** (npm 1.1.1) | node-gyp 설치 빌드, 소스 저장소·README 없음. | 신뢰할 근거가 부족하다. |
| **C#/.NET 헬퍼 exe, PowerShell** | 조사하지 않았다. | 호출 프로세스가 Electron 메인이 아니게 된다. 헬퍼가 "Verified"를 메인에 알리는 통로(파이프 등)를 인증하지 않으면 같은 사용자의 아무 프로세스가 위조할 수 있다. PowerShell은 HWND 인터롭이 없어 프롬프트가 powershell.exe 소유로 뜰 가능성이 높다. [추론, 미시험] |

---

## 설계에 주는 함의

1. **(a) Windows Hello 단독은 "메인 프로세스 안의 불리언"이다.** 침해된 **렌더러**는 WinRT를 부를 수 없으므로 렌더러 침해에는 의미가 있다. 반환값에 서명이 없고 메인이 침해되면 호출을 건너뛸 수 있다(Raymond Chen). 또한 메시지가 대화상자에 어떻게 보이는지 확인되지 않았다. 그래서 "무엇을 승인했는가"를 Hello 메시지에만 맡기면 안 된다. (Q6)
2. **(b) 채팅 창에서 `before-mouse-event`만 보는 방식은 "사용자가 클릭했다"만 증명하고 "무엇을 눌렀는가"는 증명하지 못한다.** 메인은 좌표만 본다. 그 좌표에 무엇이 그려지는지는 침해된 렌더러가 정한다. 키보드(Enter/Space) 활성화와 터치 탭도 이 이벤트로 잡히지 않을 가능성이 크다. (Q1, Q2)
3. **(c) 오버레이는 (b)의 약점을 메운다.** 오버레이의 픽셀·텍스트는 메인이 만들고, `win.contentView`의 자식 뷰는 BrowserWindow의 자체 페이지 위에 항상 그려지며, 오버레이 위 클릭은 채팅 webContents로 가지 않는다. 기존 PoC(`javascript:false` 창 + 두 훅)와 동일한 패턴이 그대로 쓰이고, `javascript:false`·`sandbox`·`partition`은 WebContentsView에서도 지원된다. (Q4)
4. **(c)를 쓸 때 설계가 감수할 항목:** 클릭 시 채팅 입력 포커스를 빼앗김(`chatView.webContents.focus()`로 복원), 채팅 페이지의 `app-region: drag` 위에 두면 클릭이 창 드래그가 될 수 있음, 클릭 투과 없음, 창 리사이즈 시 직접 `setBounds`, 스크린리더 호버 이슈(#42945), 터치 비지원 가능성. 이 모두는 별도 승인 창(현재 PoC)에서는 훨씬 덜 문제다. 오버레이를 정말 써야 하는 UX 이유가 있는지 먼저 따져볼 가치가 있다. (Q4)
5. **"메인이 믿을 수 있는" 증거라 해도 CDP/`sendInputEvent`는 메인 쪽 경로다.** 이 둘로 주입한 마우스 이벤트도 `before-mouse-event`를 일으킨다. 같은 사용자의 다른 프로세스는 `SendInput`으로 합성 입력을 넣을 수 있고, Electron/Chromium은 이를 구분하지 않는다. 즉 (b)·(c)의 신뢰 경계는 "침해된 렌더러"까지이고, "침해된 메인" 또는 "같은 사용자 권한의 악성 프로세스"는 막지 못한다. `--remote-debugging-port` 같은 스위치로 CDP가 열리지 않게 할 방법(검사·퓨즈)은 별도 확인이 필요하다. (Q2, Q3)
6. **렌더러 침해를 넘어선 "서버가 검증 가능한" 증거가 필요하면 `KeyCredential` 서명뿐이다.** 서명 대상은 액션 해시, 공개키는 등록 단계에서 서버에 두고 서버가 검증해야 의미가 있다. `RequestSignAsync`는 메시지를 못 받으므로 어떤 액션인지 화면에 보이는 것은 별도 UI(오버레이)의 몫이다. 비패키지 앱의 프롬프트 포커스 문제(Bitwarden/Telegram 우회)와 24H2 이상 `*ForWindowAsync`가 쓸 만한지는 실기 확인이 필요하다. 서명 형식이 문서와 실측에서 어긋난다. (Q7)
7. **구현 쪽 결정:** Hello 연동은 `IUserConsentVerifierInterop` + `BrowserWindow.getNativeWindowHandle()`로 해야 한다(일반 `RequestVerificationAsync`는 데스크톱에서 창 뒤에 뜸). 구현은 Rust/C++ 프로세스 내 Node-API 애드온이 검증된 선례(Bitwarden, Chromium, Telegram)다. 신규 npm `electron-windows-hello`는 구조가 맞지만 아직 어리다. NodeRT는 쓰지 않는 게 좋다. 헬퍼 exe로 분리하면 호출 프로세스가 바뀌어 그 통신을 따로 인증해야 한다. (Q6, Q8)
8. **Windows 테스트 기기에서 확인할 목록**
   - 가상 TPM + PIN을 설정한 VM과 설정 안 한 VM에서 `CheckAvailabilityAsync`가 `Available` / `NotConfiguredForUser` / `DeviceNotPresent` 중 무엇인지. PIN만 있을 때 Available인지. 로컬 계정에서의 동작.
   - `message`(한글, 긴 문자열, 줄바꿈)가 Windows 11 22H2/23H2/24H2/25H2에서 보이는지와 잘림.
   - 오버레이 클릭 직후 `getNativeWindowHandle()` HWND로 Hello를 불렀을 때 프롬프트가 앞에 뜨고 포커스를 받는지(포커스가 자식 WebContentsView에 있을 때). 최소화·비활성 상태 포함.
   - RDP 세션과 PC 잠금 중 반응.
   - 100/125/150% 및 모니터 간 DPI 이동 후 `before-mouse-event`의 `x,y`가 오버레이 DIP bounds와 맞는지, 페이지 줌을 바꿨을 때 달라지는지, 그려진 위치와 hit-test 위치가 일치하는지.
   - 터치스크린·펜 탭이 `before-mouse-event`를 일으키는지, Enter/Space 키 활성화의 `before-input-event` 동작.
   - 채팅 페이지의 `<select>` 팝업, 컨텍스트 메뉴가 오버레이를 덮는지.
   - 패키지된 앱에 `--remote-debugging-port`를 붙여 실행하면 CDP가 열리는지(그리고 CDP로 `Input.dispatchMouseEvent`가 `before-mouse-event`를 일으키는지).
   - `RequestSignAsync` 서명이 PKCS#1 v1.5인지 PSS인지, 호출마다 프롬프트가 뜨는지(캐시 옵션 미사용 시), `*ForWindowAsync`가 24H2 이상에서 포커스 문제를 푸는지.
