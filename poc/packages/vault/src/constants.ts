// 금고 바이너리 상수(D05 §3). 플레이북·운영 정책·환경 변수로 바꿀 수 없다.
// 테스트는 Vault 생성자에 정책 객체를 주입하고, 앱 진입점(entry.ts)은 이 상수만 쓴다.

/** 사용자 설치 Chrome 위치(인자로 받지 않는다). */
export const CHROME_CANDIDATES: Partial<Record<NodeJS.Platform, string[]>> = {
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  win32: [
    '%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe',
    '%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe',
    '%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe',
  ],
};

/**
 * Chrome 기동 인자 허용 목록(D05 §3.1). 이 밖의 인자는 붙이지 않는다.
 * `--kiosk-printing`은 S3a 결과 전이라 넣지 않았다.
 */
export const CHROME_ARG_ALLOWLIST = ['--remote-debugging-pipe', '--user-data-dir', '--no-first-run'] as const;
export const FORBIDDEN_CHROME_ARGS = ['--remote-debugging-port', '--remote-allow-origins', '--no-sandbox', '--disable-extensions'];

/** Chrome 자식 프로세스 환경 변수 화이트리스트(디버그·로깅·프록시 변수 제거). */
export const CHROME_ENV_ALLOWLIST = [
  'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'PATH', 'DISPLAY', '__CF_USER_TEXT_ENCODING',
  'SystemRoot', 'SystemDrive', 'windir', 'USERPROFILE', 'USERNAME', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP',
  'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData', 'COMPUTERNAME', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
];

/**
 * 엔진 쪽 포털 eTLD+1 내장 허용 목록(D05 §3.7). PoC 범위는 홈택스뿐이다.
 * gov.kr(정부24)은 사전 허락 회신 전 자동화 금지(ADR-011·017)라 넣지 않는다.
 * 간편인증·서명 모듈 도메인은 S1 결과로 채운다.
 */
export const PORTAL_ETLD1 = ['hometax.go.kr'];

/** 비밀 종류별 origin 허용 목록(D05 §3.7). */
export const SECRET_ORIGINS: Record<string, string[]> = {
  cert_password: ['hometax.go.kr'],
  portal_password: ['hometax.go.kr'],
  security_card: ['hometax.go.kr'],
};

/**
 * 중계 허용 목록(D05 §3.3 초기값 + S6b 측정 반영). 기본 거부: 여기 없는 도메인은 전부 거부한다.
 * - Network는 이벤트 수신·읽기 전용 메서드만, Fetch는 commitEndpoints 패턴에 한함(PoC-6에서 연결).
 * - Emulation은 포커스 관련만.
 * - Target은 page 세션 수준의 자식 자동 부착·분리만 허용하고(자식 세션은 금고가 origin으로 거른다),
 *   브라우저 수준 Target은 가상 루트(relay.ts)가 합성 응답으로 처리한다.
 */
export const RELAY_ALLOWED_DOMAINS = ['Page', 'Runtime', 'DOM', 'Accessibility', 'Input', 'Network', 'Fetch', 'Emulation', 'Log', 'Target', 'CSS', 'DOMSnapshot'] as const;

export const RELAY_DOMAIN_METHOD_ALLOWLIST: Record<string, string[] | '*'> = {
  Page: '*',
  Runtime: '*',
  DOM: '*',
  CSS: ['enable', 'disable'],
  Accessibility: '*',
  DOMSnapshot: '*',
  Input: '*',
  Log: '*',
  Inspector: ['enable', 'disable'],
  Network: ['enable', 'disable', 'getResponseBody', 'getRequestPostData', 'setCacheDisabled', 'setExtraHTTPHeaders', 'setBypassServiceWorker'],
  Fetch: ['enable', 'disable', 'continueRequest', 'failRequest', 'getRequestPostData', 'getResponseBody', 'continueWithAuth'],
  Emulation: ['setFocusEmulationEnabled', 'setEmulatedMedia', 'setAutoDarkModeOverride'],
  Target: ['setAutoAttach', 'detachFromTarget'],
};

/** 허용 도메인 안에서도 명시 거부(D05 §3.3 deniedMethods + 다운로드·파일 경로 관련). */
export const RELAY_DENIED_METHODS = new Set([
  'Target.createBrowserContext', 'Target.exposeDevToolsProtocol', 'Target.attachToBrowserTarget', 'Target.createTarget',
  'Target.attachToTarget', 'Target.setDiscoverTargets', 'Target.getTargets', 'Target.setRemoteLocations',
  'Page.setDownloadBehavior', 'Page.setInterceptFileChooserDialog', 'Page.printToPDF',
  'Network.getAllCookies', 'Network.getCookies', 'Network.setCookie', 'Network.setCookies', 'Network.deleteCookies', 'Network.clearBrowserCookies',
  'Network.clearBrowserCache', 'Network.loadNetworkResource', 'Network.replayXHR', 'Network.setRequestInterception', 'Network.takeResponseBodyForInterceptionAsStream',
  'Fetch.fulfillRequest', 'Fetch.takeResponseBodyAsStream',
  'DOM.setFileInputFiles', 'DOM.getFileInfo',
  'Runtime.addBinding', // D05 §4.1 비밀 origin 거부는 Phase 2. PoC는 엔진 바인딩 자체를 허용하지 않는다(S6b에서 영향 측정).
]);

/** 비밀 창 활성 상태에서 대상 타깃에 대해 거부하는 메서드(D05 §3.5 ①). 접두사 일치. */
export const ACTIVE_WINDOW_DENY_PREFIXES = [
  'Input.', 'DOM.focus', 'Target.activateTarget', 'Emulation.', 'Page.captureScreenshot', 'Page.startScreencast',
  'Accessibility.', 'DOMSnapshot.', 'Runtime.',
];
/** 활성 상태에서 엔진에 전달하지 않는 이벤트. */
export const ACTIVE_WINDOW_DROP_EVENTS = new Set(['Runtime.bindingCalled', 'Runtime.consoleAPICalled']);

/** 오염 상태에서 값 접근으로 보이는 Runtime 표현식 거부 패턴(시도일 뿐 경계가 아니다, D05 §3.4). */
export const TAINT_RUNTIME_DENY_PATTERNS = [/\.value\b/, /\binputValue\b/, /getAttribute\(\s*['"]value['"]\s*\)/, /\bFormData\b/, /\.innerText\b/, /\.outerHTML\b/, /\.selectionStart\b/];

/**
 * 타이피스트 입력 방식. 실측(S6 보고서): Input.setIgnoreInputEvents(true)는 CDP Input.dispatchKeyEvent도 막고
 * Input.insertText만 통과시킨다. D05 §4 3단계(입력 차단 + dispatchKeyEvent)는 함께 성립하지 않는다.
 * - 'insertText': 사용자 입력 차단 유지, 글자 단위 insertText(키 이벤트 없음). PoC 기본값.
 * - 'keyEvents': 글자 단위 keyDown/keyUp, 사용자 입력 차단 없음.
 * 결정은 보드 PoC-4 스레드 질문으로 남겼다.
 */
export const TYPIST_INPUT_MODE: 'insertText' | 'keyEvents' = 'insertText';

/** 비밀 타이피스트 글자 간격(policy.pace.*.keyEventDelayMs 초기값, D05 §4). */
export const TYPIST_KEY_DELAY_MS = 150;

/** 금고 보안 이벤트 코드(D05 §8). 인자·값 없이 코드와 타깃 ID만 남긴다. */
export type VaultEvent =
  | 'vault.cdp_denied' | 'vault.origin_left' | 'vault.profile_prefs_mismatch' | 'vault.extension_not_allowed'
  | 'vault.google_signin_detected' | 'vault.secret_window_refused' | 'vault.dbkey_requested_twice'
  | 'vault.secret_window_close_denied' | 'vault.webdriver_selfcheck_failed' | 'vault.user_tab_hidden';

/** 전용 프로필 Preferences 필수 값(D05 §3.6). */
export const REQUIRED_PREFERENCES: Array<[string, unknown]> = [
  ['credentials_enable_service', false],
  ['profile.password_manager_enabled', false],
  ['autofill.profile_enabled', false],
  ['autofill.credit_card_enabled', false],
];
/** Local State 보고 설정(D05 §3.6). */
export const REQUIRED_LOCAL_STATE: Array<[string, unknown]> = [
  ['user_experience_metrics.reporting_enabled', false],
];

/** 확장 허용 목록(보안 모듈 공식 확장 ID). S6i 전이라 비어 있다. Chrome 기본 내장(component) 확장은 열거에서 제외한다. */
export const EXTENSION_ALLOWLIST: string[] = [];
