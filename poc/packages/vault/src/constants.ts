// 금고 바이너리 상수(D05 §3). 플레이북·운영 정책·환경 변수로 바꿀 수 없다.
// 테스트는 Vault 생성자에 정책 객체를 주입하고, 앱 진입점(entry.ts)은 이 상수만 쓴다.

/** 사용자 설치 Chrome 위치(인자로 받지 않는다). */
export const CHROME_CANDIDATES: Partial<Record<NodeJS.Platform, string[]>> = {
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
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
export const CHROME_ARG_ALLOWLIST = ['--remote-debugging-pipe', '--user-data-dir', '--no-first-run', '--disable-breakpad', '--disable-default-apps'] as const;
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
 * 비밀 종류별 origin 허용 목록(D05 §3.7). 공동·금융인증서 비밀번호는 사용자가 브라우저에 직접 넣고 타이피스트는
 * 넣지 않는다(ADR-020 결정 2, D05 §2): 실 포털 origin이 없으니 타이피스트·비밀 창이 열리지 않는다. 시험 구성은 따로 준다.
 */
export const SECRET_ORIGINS: Record<string, string[]> = {
  cert_password: [],
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
export const RELAY_DOMAIN_METHOD_ALLOWLIST: Record<string, string[]> = {
  Page: [
    'enable', 'disable', 'getFrameTree', 'setLifecycleEventsEnabled', 'addScriptToEvaluateOnNewDocument', 'removeScriptToEvaluateOnNewDocument',
    'createIsolatedWorld', 'navigate', 'reload', 'stopLoading', 'getNavigationHistory', 'navigateToHistoryEntry', 'getLayoutMetrics', 'setFontFamilies',
    'captureScreenshot', 'startScreencast', 'stopScreencast', 'screencastFrameAck', 'handleJavaScriptDialog', 'bringToFront', 'close', 'getResourceTree',
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
  // PDF 저장(save_pdf): 경로·종류·사유·크기만(파일 이름·URL·내용 없음)
  | 'vault.pdf_saved' | 'vault.pdf_refused' | 'vault.download_armed' | 'vault.download_arm_refused' | 'vault.download_unexpected';

/** 전용 프로필 Preferences 필수 값(D05 §3.6). */
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
