// 금고 바이너리 상수(D05 §3). 플레이북·운영 정책·환경 변수로 바꿀 수 없다.
// 테스트는 Vault 생성자에 정책 객체를 주입하고, 앱 진입점(entry.ts)은 이 상수만 쓴다.

/** 사용자 설치 Chrome 위치(인자로 받지 않는다). */
export const CHROME_CANDIDATES: Partial<Record<NodeJS.Platform, string[]>> = {
  // ~/Applications: 관리자 권한 없이 사용자 폴더에 깐 Chrome(고객 PoC, CUSTOMER-DIST §1.2). Edge 등 다른 Chromium은 넣지 않는다(검증 안 됨).
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '~/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  linux: ['/opt/google/chrome/chrome', '/usr/bin/google-chrome'],
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
// --disable-default-apps: Chrome 기본 앱(Web Store 결제 구성요소 nmmhkkegccagdldgiimedpiccmgmieda 등)이 전용 프로필에 깔리지 않게 한다.
// 깔리면 확장 검사(extension_not_allowed, 실패 닫힘)가 비밀 창을 막아 발급이 멈춘다. 확장을 줄이는 쪽이라 보안을 약하게 하지 않는다(D05 §3.1, 팀장 결정 2026-11-06).
export const CHROME_ARG_ALLOWLIST = [
  '--remote-debugging-pipe', '--user-data-dir', '--no-first-run', '--disable-breakpad', '--disable-default-apps',
  // 홈택스 Chrome이 앱 뒤에 가려져도(#305) 렌더러·타이머를 늦추지 않는다(부장 지시 2026-11-13).
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
  // 창 없는 Chrome(대표 요청 2026-11-13 "크롬이 아예 안 뜨게"). 진행은 앱 패널 중계(B3)로 본다. 사람이 페이지를 만져야 할 때만 창 있는 Chrome으로 다시 띄운다.
  '--headless', '--window-size',
  // 실행 창을 앱 모드로(탭줄·주소창 없음, 대표 지시 2026-11-13 "앱 안 브라우저처럼"). 시작 문서는 CHROME_APP_START_URL 고정. 기본 브라우저 확인 안내 끔.
  '--app', '--no-default-browser-check',
] as const;
/**
 * 앱 모드 창의 시작 문서. 금고가 이 창(탭줄·주소창 없음)을 실행 탭으로 쓴다(relay createRunPage). 페이지는 최상위 data: 문서를 열 수 없으니
 * 금고가 연 것이 아닌 data: 창이 실행 탭으로 잡힐 일은 없다. 제목은 창 제목줄에 잠깐 보인다.
 */
export const CHROME_APP_START_URL = 'data:text/html;charset=utf-8,%3Ctitle%3E%ED%99%88%ED%83%9D%EC%8A%A4%3C%2Ftitle%3E';
/**
 * 창 없는 Chrome 인자(설치된 Chrome의 new headless, 같은 전용 프로필). 창 크기를 정하지 않으면 800x600이라 홈택스가 좁은 화면 배치로 뜬다
 * (셀렉터 사전·캡처는 데스크톱 폭 기준, 2026-11-13 측정). 중계 화면도 이 크기다.
 */
export const CHROME_HEADLESS_ARGS = ['--headless=new', '--window-size=1400,1000'] as const;
/**
 * 이 PC의 보안 프로그램(공동인증서 MagicLine4NX, 127.0.0.1)에 닿아도 되는 출처. 실행 때 금고가 Chrome에 이 출처만 loopback 권한을 준다.
 * headless에는 Chrome 허용 말풍선을 띄울 곳이 없어 거부되고 홈택스가 "보안프로그램 설치"를 띄운다(측정 2026-11-13, Chrome 157).
 * 창 있는 Chrome에서도 같은 말풍선을 사람이 누르지 않게 미리 준다. 이름은 Chrome 157의 PermissionDescriptor(loopback-network),
 * 옛 Chrome은 local-network-access 하나였다.
 */
export const LOOPBACK_ORIGINS = ['https://hometax.go.kr'] as const;
export const LOOPBACK_PERMISSION_NAMES = ['loopback-network', 'local-network-access'] as const;
export const FORBIDDEN_CHROME_ARGS = ['--remote-debugging-port', '--remote-allow-origins', '--no-sandbox', '--disable-extensions'];

/** Chrome 자식 프로세스 환경 변수 화이트리스트(디버그·로깅·프록시 변수 제거). */
export const CHROME_ENV_ALLOWLIST = [
  'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'PATH', 'DISPLAY', 'XAUTHORITY', '__CF_USER_TEXT_ENCODING',
  'SystemRoot', 'SystemDrive', 'windir', 'USERPROFILE', 'USERNAME', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP',
  'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData', 'COMPUTERNAME', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
];

/**
 * 엔진 쪽 포털 eTLD+1 내장 허용 목록(D05 §3.7). PoC 범위는 홈택스뿐이다.
 * gov.kr(정부24)은 사전 허락 회신 전 자동화 금지(ADR-011·017)라 넣지 않는다.
 * 간편인증·서명 모듈 도메인은 S1 결과로 채운다.
 */
export const PORTAL_ETLD1 = ['hometax.go.kr'];

/**
 * 비밀 종류별 origin 허용 목록(D05 §3.7). 공동·금융인증서 비밀번호는 홈택스에서 금고 비밀 창으로 받고, 처음 넣은 값을 기억해
 * 다음부터 금고가 넣는다(대표 지시 2026-11-13, ADR-020 결정 2 고침). 시험 구성은 따로 준다.
 */
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
export const RELAY_ALLOWED_DOMAINS = ['Page', 'Runtime', 'DOM', 'Accessibility', 'Input', 'Network', 'Fetch', 'Emulation', 'Log', 'Target', 'CSS', 'DOMSnapshot', 'Inspector'] as const;

/**
 * 도메인 안에서도 메서드 단위 허용 목록이다(도메인 전체 허용 '*'는 두지 않는다). 근거: S6b 관측 + playwright-core 1.64 coreBundle이 부르는 명령.
 * 표 밖 명령(예: Page.startScreenRecording·searchInResource·getAnnotatedPageContent·setDocumentContent, Runtime.compileScript·runScript·queryObjects,
 * DOM.getOuterHTML)은 기본 거부다. 스크린샷 거부·값 접근 패턴 검사를 우회하는 경로이기 때문이다. 표 대조 시험: tests/vault-relay-table.test.ts.
 */
// Page.bringToFront는 열지 않는다: Chrome 창을 앱 앞으로 올리는 길이다(대표 지시 2026-11-14, 사람 차례는 앱 패널에서).
export const RELAY_DOMAIN_METHOD_ALLOWLIST: Record<string, string[]> = {
  Page: [
    'enable', 'disable', 'getFrameTree', 'setLifecycleEventsEnabled', 'addScriptToEvaluateOnNewDocument', 'removeScriptToEvaluateOnNewDocument',
    'createIsolatedWorld', 'navigate', 'reload', 'stopLoading', 'getNavigationHistory', 'navigateToHistoryEntry', 'getLayoutMetrics', 'setFontFamilies',
    'captureScreenshot', 'startScreencast', 'stopScreencast', 'screencastFrameAck', 'handleJavaScriptDialog', 'close', 'getResourceTree',
  ],
  Runtime: ['enable', 'disable', 'evaluate', 'callFunctionOn', 'getProperties', 'releaseObject', 'releaseObjectGroup', 'runIfWaitingForDebugger', 'awaitPromise', 'discardConsoleEntries'],
  DOM: [
    'enable', 'disable', 'getDocument', 'describeNode', 'resolveNode', 'requestNode', 'requestChildNodes', 'pushNodesByBackendIdsToFrontend', 'querySelector', 'querySelectorAll',
    'getAttributes', 'getBoxModel', 'getContentQuads', 'scrollIntoViewIfNeeded', 'getFrameOwner', 'focus',
  ],
  CSS: ['enable', 'disable'],
  Accessibility: ['enable', 'disable', 'getFullAXTree', 'getPartialAXTree', 'getRootAXNode', 'getChildAXNodes', 'queryAXTree', 'getAXNodeAndAncestors'],
  DOMSnapshot: ['enable', 'disable', 'captureSnapshot'],
  Input: ['dispatchKeyEvent', 'dispatchMouseEvent', 'dispatchTouchEvent', 'dispatchDragEvent', 'insertText', 'setInterceptDrags', 'cancelDragging', 'setIgnoreInputEvents'],
  Log: ['enable', 'disable', 'clear'],
  Inspector: ['enable', 'disable'],
  // 응답 바디는 엔진에 주지 않는다(N-51: 로그인 응답·세션 토큰). 엔진 신호는 상태·URL만 쓴다.
  Network: ['enable', 'disable', 'getRequestPostData', 'setCacheDisabled', 'setExtraHTTPHeaders', 'setBypassServiceWorker'],
  Fetch: ['enable', 'disable', 'continueRequest', 'failRequest', 'getRequestPostData', 'continueWithAuth'],
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
  'Network.getResponseBodyForInterception', 'Network.streamResourceContent',
  // 페이지 통째 캡처(MHTML)·리소스 원문·옛 스냅숏은 상시 거부(N-12). Playwright 기본 흐름은 쓰지 않는다.
  'Page.captureSnapshot', 'Page.getResourceContent', 'DOMSnapshot.getSnapshot',
  'Fetch.fulfillRequest', 'Fetch.takeResponseBodyAsStream',
  'DOM.setFileInputFiles', 'DOM.getFileInfo',
  'Runtime.addBinding', // D05 §4.1 비밀 origin 거부는 Phase 2. PoC는 엔진 바인딩 자체를 허용하지 않는다(S6b에서 영향 측정).
]);

/** 비밀 창 활성 상태에서 대상 타깃에 대해 거부하는 메서드(D05 §3.5 ①). 접두사 일치. */
export const ACTIVE_WINDOW_DENY_PREFIXES = [
  'Input.', 'DOM.focus', 'Target.activateTarget', 'Emulation.', 'Page.captureScreenshot', 'Page.startScreencast',
  'Page.captureSnapshot', 'Page.getResourceContent', 'Accessibility.', 'DOMSnapshot.', 'Runtime.',
];
/**
 * 엔진에 늘 전달하지 않는 이벤트. 다운로드는 금고가 받는다(D05 §3.3): 엔진은 guid(staging 파일 이름)·원래 파일 이름 대신
 * download.completed{fileId}·download.failed{reason}만 받는다.
 */
export const RELAY_DROPPED_EVENTS = new Set(['Page.downloadWillBegin', 'Page.downloadProgress']);
/** 활성 상태에서 엔진에 전달하지 않는 이벤트. */
export const ACTIVE_WINDOW_DROP_EVENTS = new Set(['Runtime.bindingCalled', 'Runtime.consoleAPICalled']);

/** 오염 상태에서 값 접근으로 보이는 Runtime 표현식 거부 패턴(시도일 뿐 경계가 아니다, D05 §3.4). */
export const TAINT_RUNTIME_DENY_PATTERNS = [/\.value\b/, /\binputValue\b/, /getAttribute\(\s*['"]value['"]\s*\)/, /\bFormData\b/, /\.innerText\b/, /\.outerHTML\b/, /\.selectionStart\b/];

/**
 * 오염 상태에서도 거부 패턴 검사에서 빼는 고정 식(SHA-256, 정확 일치, I-4·N-20).
 * 엔진 `SIGNAL_INSPECT_EXPR`(document.body.innerText + 문서 응답 상태): innerText는 입력 칸 값을 싣지 않는다.
 */
export const TAINT_RUNTIME_EXACT_ALLOW_SHA256 = ['712e733067b2ccebb89ea8e1da5089577095c3954da089592bbb9ee3ec598944'];

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

/** 1회용 비밀 수명(N-44). 쓰지 않으면 0으로 덮어 지우고 secret.expired를 보낸다. */
export const SECRET_TTL_MS = 300_000;

/** 사람 입력 창 종료 조건 (나): blur + 값 있음이 이만큼 그대로일 때만 닫는다(N-47, 가상키패드 클릭 대비). */
export const HUMAN_SETTLE_MS = 1_500;

/** 비밀 사용 직후 그 값으로 logs·staging을 스캔해 건수만 남긴다(N-17, PoC 빌드). */
export const VAULT_SELF_SCAN = true;
/** 자기 스캔 대기 상한. 넘으면 결과를 기다리지 않고 vault.leak_scan_skipped. */
export const SELF_SCAN_TIMEOUT_MS = 3_000;

/** 금고 보안 이벤트 코드(D05 §8). 인자·값 없이 코드와 타깃 ID만 남긴다. */
export type VaultEvent =
  | 'vault.cdp_denied' | 'vault.origin_left' | 'vault.profile_prefs_mismatch' | 'vault.extension_not_allowed'
  | 'vault.google_signin_detected' | 'vault.secret_window_refused' | 'vault.dbkey_requested_twice'
  | 'vault.secret_window_close_denied' | 'vault.webdriver_selfcheck_failed' | 'vault.user_tab_hidden'
  | 'vault.chrome_dump_removed' | 'vault.chrome_dump_dir_link' | 'vault.chrome_residue_removed' | 'vault.chrome_residue_link' | 'vault.chrome_residue_busy' | 'vault.chrome_dump_busy' | 'vault.dir_check_warm' | 'vault.secret_input_unbound' | 'vault.leak_scan' | 'vault.leak_scan_skipped'
  | 'vault.keystore_mismatch' | 'vault.dbkey_missing' | 'vault.net_deny_unavailable'
  // 사람 비밀 세션 결박(ADR-026): 값·칸 번호 없이 종류·등급·건수만
  | 'vault.credential_suspect' | 'vault.locked' | 'vault.secret_stored' | 'vault.secret_forgotten' | 'vault.kek_unwrap_failed'
  | 'vault.item_corrupt' | 'vault.index_corrupt' | 'vault.restore_failed'
  // run에 고정된 프로필과 다른 scope의 입력 요청(Q-2)
  | 'vault.profile_mismatch'
  // 종류별 입력 규칙(ADR-020 결정 2·ADR-025 결정 10·D05 §4): 값·칸 번호 없이
  | 'vault.typist_kind_refused' | 'vault.card_row_mismatch' | 'vault.secret_input_unrequested'
  // R-C1 커밋 본문 대조(D05 §3.3): 결과·필드 수·사유만(본문·값 없음)
  | 'vault.commit_armed' | 'vault.commit_arm_refused' | 'vault.commit_compared' | 'vault.commit_block_failed'
  // 장기 키 연산(D05 §5.1): 연산·용도·건수만(키·입력·출력 없음)
  | 'vault.key_created' | 'vault.crypto_op' | 'vault.crypto_rate_anomaly' | 'vault.crypto_purpose_denied' | 'vault.hpke_open_failed'
  | 'vault.npki_listed'
  // 계좌 자동조회(CODEF) 로그인 봉인: 결과·사유만(인증서 id·경로·비밀번호·길이 없음)
  | 'vault.codef_sealed' | 'vault.codef_seal_refused' | 'vault.codef_password_stored' | 'vault.codef_password_forgotten'
  // PDF 저장(save_pdf): 경로·종류·사유·크기만(파일 이름·URL·내용 없음)
  | 'vault.pdf_saved' | 'vault.pdf_refused' | 'vault.download_armed' | 'vault.download_arm_refused' | 'vault.download_unexpected' | 'vault.download_stalled'
  | 'vault.staging_swept'
  // 계정 갱신 토큰(ADR-038 (f)): 이벤트 이름만(토큰 값·길이·해시 없음)
  | 'vault.account_refresh_stored' | 'vault.account_refresh_forgotten' | 'vault.account_refresh_write_failed' | 'vault.account_refresh_corrupt';

/** 전용 프로필 Preferences 필수 값(D05 §3.6). */
/**
 * Chrome 자체 안내를 끈다(대표 지시 2026-11-13: 앱 안 브라우저처럼). 동기화 로그인 안내, 기본 브라우저 확인, 번역 말풍선 같은 것이다.
 * 기록만 하고 비밀 창 개시 조건(verifyProfileSettings)에는 넣지 않는다. Chrome이 판에 따라 값을 고쳐 써도 발급이 멈추지 않게.
 */
export const QUIET_PREFERENCES: Array<[string, unknown]> = [
  ['signin.allowed', false],
  ['browser.check_default_browser', false],
  ['translate.enabled', false],
  ['browser.show_home_button', false],
  ['search.suggest_enabled', false],
];
export const REQUIRED_PREFERENCES: Array<[string, unknown]> = [
  ['credentials_enable_service', false],
  ['profile.password_manager_enabled', false],
  ['autofill.profile_enabled', false],
  ['autofill.credit_card_enabled', false],
];
/**
 * 다운로드·저장 대화 상자 폴더를 staging으로 고정한다(D05 §3.3). 기록하고 비밀 창을 열 때마다 확인한다(프로필 점검).
 * 실제 다운로드는 금고 세션의 Browser.setDownloadBehavior(allowAndName, staging)가 정한다. 이것은 그 밖의 경로(사용자 저장 대화 상자)용이다.
 */
export function downloadPreferences(staging: string): Array<[string, unknown]> {
  return [
    ['download.default_directory', staging],
    ['savefile.default_directory', staging],
    ['download.prompt_for_download', false],
  ];
}
/** Local State 보고 설정(D05 §3.6). */
export const REQUIRED_LOCAL_STATE: Array<[string, unknown]> = [
  ['user_experience_metrics.reporting_enabled', false],
];

/** 확장 허용 목록(보안 모듈 공식 확장 ID). S6i 전이라 비어 있다. Chrome 기본 내장(component) 확장은 열거에서 제외한다. */
export const EXTENSION_ALLOWLIST: string[] = [];
