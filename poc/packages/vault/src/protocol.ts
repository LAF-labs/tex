// 금고 포트 메시지(D01 §2.1: MessagePort 기반 타입드 IPC). 포트는 세 종류다.
// - engine: CDP 프레임(cdp)과 RPC(typist·secretWindow·browser·commitGuard·pdf·download·getDbKeyOnce). 장기 키 연산(crypto.*)은 없다(아래 RPC_BY_PORT 주석)
// - control(main): 실행 트리거 통지, 사용자 "입력 완료", Windows 세션 상태, 저장된 비밀 목록·삭제, 계정 갱신 토큰, 상태
// - secretInput(금고 직결 입력 창): 한 번 쓰는 비밀 제공(oneshot) 또는 등록 창(T-06)의 저장(store). main은 이 포트의 내용을 보지 않는다.
//
// 이 파일이 금고 IPC 계약의 정본이다. 바꾸면 PR 본문과 팀장 보고에 적는다(D05 §3.8, ADR-005 v3·020·025·026·029).
import { createHash } from 'node:crypto';

export type PortKind = 'engine' | 'control' | 'secretInput';

export type InboundMessage =
  | { t: 'cdp'; m: string }
  | { t: 'rpc'; id: number; method: string; params?: Record<string, unknown> };

export type OutboundMessage =
  | { t: 'cdp'; m: string }
  | { t: 'rpc'; id: number; result?: unknown; error?: string }
  | { t: 'ev'; name: string; data: Record<string, unknown> }
  /** 금고가 Chrome을 내렸거나 Chrome이 끝났다. 엔진은 CDP transport를 닫는다. */
  | { t: 'cdp_closed' };

/** 포트별 RPC 허용 목록. 목록 밖 메서드는 vault.rpc_denied로 거부한다. */
export const RPC_BY_PORT: Record<PortKind, readonly string[]> = {
  engine: [
    'browser.launch', 'browser.shutdown',
    // typist.authOk: 인증서 비밀번호를 넣은 뒤 로그인이 확인됐다(그때만 금고가 그 값을 기억한다, 부장 지시 2026-11-13)
    'typist.fill', 'typist.authFailed', 'typist.authOk',
    'secretWindow.openForHuman', 'secretWindow.requestClose',
    'commitGuard.arm', 'commitGuard.disarm',
    // crypto.*(Sd·Vd·AIK·Qd 연산)는 엔진 포트에 열지 않는다(팀장 결정 2026-11-06, 게이트웨이 인증 설계 ADR-040 예정).
    // 엔진 소스는 쓰지 않는다. 열려 있으면 엔진이 뚫렸을 때 기기 키로 DPoP·기기 목록·계정 작업(acct-op)에 서명할 수 있다.
    // 키 연산은 main(control)만 하고, 엔진은 main이 만들어 주는 게이트웨이 범위 헤더만 받는다.
    'getDbKeyOnce',
    'pdf.print', 'download.arm', 'download.disarm',
    // 계좌 자동조회(CODEF): 고른 인증서 하나 + 금고 창 비밀번호 → CODEF 공개키로 감싼 로그인 묶음. 평문 비밀번호는 엔진에 가지 않는다.
    'codef.seal', 'codef.cancel', 'codef.forget',
  ],
  control: [
    'run.begin', 'run.end', 'secretWindow.userDone', 'status',
    // [홈택스 창 보기](main): 실행 탭을 앞으로. 값을 읽거나 바꾸지 않는다.
    'browser.focus',
    // 홈택스 창 자리(main): 실행 창을 앱 옆에 둔다. front면 앞으로도. 창 크기·위치만 바꾸고 페이지는 건드리지 않는다.
    'browser.place',
    // 진행 화면(B3): 실행 탭 화면을 main에 중계한다(가만히 있으면 초당 3장 남짓, 조작 중 10장 안팎). 비밀 창이 열린 동안은 멈춘다.
    // screen.input(대표 지시 2026-11-13 "인앱 브라우저에서 조작"): 사람이 앱 패널에서 한 마우스·키·글자를 그 탭에 CDP Input으로 넣는다.
    // 중계 중인 탭에만, 비밀 창이 열린 동안은 거부한다(ACTIVE_WINDOW_DENY_PREFIXES Input.과 같은 뜻). 값을 읽어 돌려주지 않는다.
    'screen.start', 'screen.stop', 'screen.input',
    'session.event', 'session.idle', 'vault.unlock', 'vault.setStrict',
    'secret.list', 'secret.has', 'secret.forget',
    'npki.list',
    // CODEF 비밀번호 창이 값 없이 닫혔다(main이 알린다). 기다리던 codef.seal을 cancelled로 끝낸다.
    'codef.windowClosed',
    // 계정 갱신 토큰(ADR-038 (f) 자동 로그인). main만 읽고 쓴다. 엔진·비밀 입력 창은 계정 자격을 다루지 않는다.
    'account.refresh.read', 'account.refresh.write', 'account.refresh.forget',
    // 장기 키 연산: main의 계정·기기·페어링(D08 §4.2, remote-ports.ts VaultKeysFactory, 팀장 결정 2026-11-06 (가))만 부른다. 개인키는 그대로 금고 안이다.
    'crypto.publicKeys', 'crypto.noiseDH', 'crypto.signVd', 'crypto.signAik', 'crypto.hpkeOpen',
  ],
  secretInput: ['secret.provide', 'secret.store'],
};

// ───────────────────────── 비밀 종류·범위 ─────────────────────────

/** 비밀 종류(ADR-026 결정 6 `secretKind`). */
export const SECRET_KINDS = ['cert_password', 'portal_password', 'security_card'] as const;
export type SecretKind = (typeof SECRET_KINDS)[number];

/**
 * 저장할 수 있는 종류(ADR-020 결정 2·3, ADR-026 결정 2). 공동·금융인증서 비밀번호는 저장 기능 자체가 없다.
 * - portal_password: 칸 `portal/<scope>/pw` 하나(D05 §2, ADR-035). 포털 아이디는 비밀이 아니라 저장하지 않는다(DB `profiles.portal_login_id`, 엔진 fill)
 * - security_card: 칸 `securitycard/<scope>/<row>`(row 1~35)
 */
// 인증서 비밀번호도 기억한다(대표 지시 2026-11-13, ADR-020 결정 2 고침): 처음 금고 비밀 창에 넣은 값을 저장하고 다음부터 금고가 칸에 넣는다.
export const STORABLE_KINDS = ['portal_password', 'security_card', 'cert_password'] as const satisfies readonly SecretKind[];

/**
 * 타이피스트가 넣는 종류(D05 §2 표·§4, ADR-020 결정 2, ADR-025 결정 10). 공동·금융인증서 비밀번호는 사용자가 전용 Chrome의
 * 포털 칸(가상키패드)에 직접 넣는다(`human:secret`, 비밀 창 (b)). 금고는 정책·허용 호스트와 상관없이 타이피스트 입력과
 * 1회용 입력 창(secretInput oneshot)에서 이 밖의 종류를 받지 않는다.
 */
export const TYPIST_KINDS = ['portal_password', 'security_card'] as const satisfies readonly SecretKind[];
export type TypistKind = (typeof TYPIST_KINDS)[number];
export const isTypistKind = (k: unknown): k is TypistKind => typeof k === 'string' && (TYPIST_KINDS as readonly string[]).includes(k);
export type StorableKind = (typeof STORABLE_KINDS)[number];

/**
 * 프로필 범위(칸 이름의 <profile>, D05 §2·§4 `scope`).
 * Phase 1은 프로필 1개(사업자)로 운영한다. scope는 run.begin 때 활성 프로필로 고정하고 run 중에는 바꾸지 않는다.
 * 프로필 전환은 설정에서 run이 없고 금고가 잠긴 때만(main). 'personal'은 PoC 시험(audit-v V5) 호환으로 남긴다.
 * Phase 2(프로필 2개 동시 운영)에 `ProfileId`로 넓힌다.
 */
export const PROFILE_SCOPES = ['business', 'personal'] as const;
export type ProfileScope = (typeof PROFILE_SCOPES)[number];
export const isProfileScope = (s: unknown): s is ProfileScope => typeof s === 'string' && (PROFILE_SCOPES as readonly string[]).includes(s);

/** 보안카드 칸 번호 범위. */
export const SECURITY_CARD_ROWS = { min: 1, max: 35 } as const;

/**
 * 포털 자격 칸. 금고에 두는 것은 비밀번호뿐이다(D05 §2·§4, ADR-035). 타이피스트는 type=password 칸에만 넣는다.
 * 아이디는 비밀이 아니다: DB `profiles.portal_login_id`에 두고 엔진 fill 스텝이 넣는다.
 */
export type PortalField = 'pw';

/** 등록 창이 함께 받은 포털 아이디의 최대 길이(비밀 아님, 금고는 저장하지 않고 secret.store 결과로 돌려준다). */
export const PORTAL_LOGIN_ID_MAX = 64;

// ───────────────────────── secretInput 포트 ─────────────────────────

/**
 * 1회용 비밀 입력 결속(I-1, N-44). main이 secretInput 포트를 넘길 때 함께 준다.
 * 금고는 이 포트에서 이 값으로 secret.provide를 한 번만 받는다. 결속이 없거나 틀리면 포트를 붙이지 않는다.
 * `mode`가 없으면 oneshot이다(PoC 호환).
 * - kind는 TYPIST_KINDS와, 금고가 부른 cert_password(row 없음, 앱 입력 창). 보안카드는 row 필수, 포털 비밀번호는 row 없음.
 * - 금고가 먼저 보낸 `secret.needed{runId, kind, scope, row?}`와 같은 결속만 붙인다(비밀 창은 금고가 부른다, ADR-025 결정 10).
 *   요청은 SECRET_TTL_MS 동안 살아 있고, 값을 받거나 run.end면 지운다. 요청 없는 결속은 `vault.secret_input_unrequested`.
 */
export type OneShotBind = {
  mode?: 'oneshot';
  runId: string;
  kind: SecretKind;
  scope: ProfileScope;
  row?: number;
};

/**
 * 등록 창(T-06) 결속(ADR-026 결정 2·5). main이 OS 프레임 창을 열 때 넘긴다. 금고는 secret.store를 한 번만 받는다.
 * `notice`는 등록 화면에 실제로 보인 고지 묶음 판(동의 레코드에 그대로 남긴다).
 */
export type StoreBind = {
  mode: 'store';
  kind: StorableKind;
  scope: ProfileScope;
  notice: { version: string };
};

/**
 * 계좌 자동조회(CODEF) 인증서 비밀번호 창 결속. 금고가 보낸 `secret.needed{mode:'codef', reqId, scope, remember}`와 같은 reqId만 붙는다.
 * 창은 secret.provide를 한 번 보낸다(`remember: true`면 사장님이 [이 PC에 기억]을 고른 것). 값은 금고가 CODEF 공개키로 감싸고 지운다.
 */
export type CodefBind = { mode: 'codef'; reqId: string; scope: ProfileScope };

export type SecretInputBind = OneShotBind | StoreBind | CodefBind;

/** codef.seal 결속 요청 id(32 hex) */
export const CODEF_REQ_ID_RE = /^[0-9a-f]{32}$/;
/** 비밀번호 창을 기다리는 시간 */
export const CODEF_SEAL_TTL_MS = 180_000;

/**
 * `codef.seal{certId, publicKey, scope, mode}` (engine). mode: 'ask'면 금고 창을 연다, 'stored'면 기억해 둔 비밀번호만 쓴다(없으면 missing).
 * publicKey는 게이트웨이가 준 CODEF RSA 공개키(base64 DER SPKI).
 */
export interface CodefSealParams {
  certId: string;
  publicKey: string;
  scope: ProfileScope;
  mode: 'ask' | 'stored' | 'auto';
}
/** 성공이면 CODEF 계정 등록 accountList 원소에 그대로 넣을 base64 세 칸. 실패 사유는 값 없이 */
export type CodefSealResult =
  | { ok: true; derFile: string; keyFile: string; password: string; remembered: boolean }
  | { ok: false; reason: 'cancelled' | 'timeout' | 'busy' | 'not_found' | 'no_key' | 'unreadable' | 'bad_public_key' | 'missing' | 'vault_locked' };

/** secret.provide(oneshot) 인자. kind·scope·row는 생략하거나 결속값과 같아야 한다. */
export interface SecretProvideParams {
  bytes: Uint8Array;
  kind?: SecretKind;
  scope?: ProfileScope;
  row?: number;
}

/**
 * secret.store 인자(store 결속). 보안카드는 row만, 포털은 field만 쓴다. 값은 TextEncoder 바이트.
 * `portalLoginId`: 포털 등록 창이 아이디를 같은 화면에서 받았을 때만(portal_password 결속). 비밀이 아니다.
 * 금고는 저장·로그하지 않고 결과에 그대로 돌려준다(main이 DB `profiles.portal_login_id`에 쓴다, ADR-035).
 */
export interface SecretStoreParams {
  entries: Array<{ row?: number; field?: PortalField; bytes: Uint8Array }>;
  portalLoginId?: string;
}

/** secret.store 결과. 비밀 값·길이 없음. `portalLoginId`는 인자로 받은 비밀 아닌 아이디를 돌려준 것. */
export interface SecretStoreResult {
  handle: SecretHandle;
  tier: KeyTier;
  consent: ConsentRecord;
  portalLoginId?: string;
}

/** 저장된 비밀의 손잡이(종류·범위만, 값 없음). */
export interface SecretHandle {
  kind: StorableKind;
  scope: ProfileScope;
}

// ───────────────────────── 키체인 등급·동의 레코드 ─────────────────────────

/**
 * 슬롯 KEK 보호 방식(ADR-026 결정 2, D05 §7).
 * - tpm: Microsoft Platform Crypto Provider 내보낼 수 없는 키(UI 정책 없음) — Windows, S10c
 * - dpapi: DPAPI(CurrentUser) — TPM 없는 Windows
 * - keychain-dev: macOS 개발용(Keychain 항목의 기기 키로 래핑. 하드웨어 결박 아님)
 * - memory: 시험용
 */
export type KeyTier = 'tpm' | 'dpapi' | 'keychain-dev' | 'memory';

/**
 * 동의 레코드(D05 §9, ADR-026). 등록 창에서 저장할 때 금고가 만든다. 값·길이·칸 번호 없이 무엇을·어디에·어떻게 저장했는지만.
 * 키체인 항목 `consent/<kind>/<scope>`에 둔다(덤프·로그·텔레메트리 제외). 서명은 Phase 2(`SAX-consent-v1`, Vd 로컬).
 */
export interface ConsentRecord {
  v: 1;
  kind: StorableKind;
  scope: ProfileScope;
  /** 저장한 칸 수(보안카드 30, 포털 1~2). 어떤 칸인지는 남기지 않는다. */
  items: number;
  tier: KeyTier;
  /** Hello 결박 사본을 함께 두었는가. */
  helloCopy: boolean;
  /** 엄격 모드(발급마다 Hello)였는가. */
  strict: boolean;
  noticeVersion: string;
  /** ISO 8601 UTC. */
  at: string;
  via: 'T-06';
}

/** secret.list 항목(control). 값·칸 번호 없음. */
export interface StoredSecretInfo {
  kind: StorableKind;
  scope: ProfileScope;
  items: number;
  tier: KeyTier;
  /** 포털이 명시적 인증 실패를 알린 뒤 사용자가 다시 등록하지 않았다(vault.credential_suspect, ADR-026 결정 7). */
  suspect: boolean;
  consentAt: string;
}

// ───────────────────────── 계정 갱신 토큰(control 전용) ─────────────────────────

/**
 * 계정 갱신 토큰(ADR-038 (f) 자동 로그인). 사이트 비밀(secret.*, 사람 비밀 세션 결박)과 따로 둔다:
 * secret.list에 나오지 않고, 사이트 비밀 슬롯·엄격 모드 전환과 섞이지 않는다.
 * 등급(팀장 결정 2026-11-09, D05 §2): 규칙 ②(평문이 금고 밖으로 나가지 않음)는 사이트 비밀에 대한 것이다. 계정 자격은 main이 계정 세션을
 * 메모리에 드는 것과 같은 등급으로 보고 main(control)에게 값을 준다. 엔진 포트·비밀 입력 포트에는 없다.
 * - 이 PC에 로그인한 계정의 토큰 하나만 둔다(데스크톱 신원 파일에 계정 ID가 없고, 이메일을 키체인 항목 이름에 넣지 않는다). 다른 계정으로 쓰면 바뀐다.
 * - `account.refresh.read {}` → AccountRefreshReadResult. 금고가 잠겨 있으면 vault_locked(main은 로그인 화면으로 간다).
 * - `account.refresh.write {token}` → AccountRefreshWriteResult. 회전 쓰기: 새 값을 다른 칸에 쓰고 되읽어 확인한 뒤 옛 칸을 지운다.
 *   중간에 실패하면 옛 값이 남는다. 서버는 이미 회전했으므로 main은 실패하면 새 토큰을 메모리에 든 채 다시 쓰거나 forget한다(옛 토큰 재사용은 서버의 복제 감지로 계정 전체 폐기).
 * - `account.refresh.forget {}` → `{removed}`. [로그인 상태 유지 끄기]·[모든 기기에서 로그아웃]·서버 거부 때. 잠겨 있어도 지운다.
 * - 로그는 이벤트 이름만 남긴다(값·길이·해시 없음).
 */
export type AccountRefreshReadResult =
  | { ok: true; token: string }
  | { ok: false; reason: 'missing' | 'vault_locked' | 'corrupt' | 'kek_unavailable' };
export type AccountRefreshWriteResult = { ok: true } | { ok: false; reason: 'vault_locked' | 'kek_unavailable' | 'write_failed' };
export interface AccountRefreshWriteParams {
  token: string;
}
/** 계정 서비스 갱신 토큰 모양(`services/account` REFRESH_RE). 이 밖은 bad_params로 받지 않는다. */
export const ACCOUNT_REFRESH_TOKEN_RE = /^sxa1\.[A-Za-z0-9_-]{43}$/;

// ───────────────────────── Windows 세션 추종(control) ─────────────────────────

/**
 * main이 Electron powerMonitor·WTS에서 받은 세션 이벤트(ADR-026 결정 3). utilityProcess에는 powerMonitor가 없어 main이 넘긴다.
 * - lock-screen·suspend·session-switch·remote-switch: 즉시 잠그고 슬롯 KEK를 지운다
 * - unlock-screen: Windows가 사람을 확인했으므로 프롬프트 없이 다시 연다(유휴 잠금 뒤 포함)
 * - resume: 잠금 상태 그대로(Windows가 잠금 화면을 거치면 unlock-screen이 따로 온다)
 */
export const SESSION_EVENTS = ['lock-screen', 'unlock-screen', 'suspend', 'resume', 'session-switch', 'remote-switch'] as const;
export type SessionEventKind = (typeof SESSION_EVENTS)[number];

/** session.event 인자. */
export interface SessionEventParams {
  kind: SessionEventKind;
}

/**
 * session.idle 인자: main이 powerMonitor.getSystemIdleTime()을 SESSION_IDLE_REPORT_MS마다 보낸다.
 * 금고는 마지막 보고가 SESSION_IDLE_STALE_MS보다 오래되면 유휴를 모르는 것으로 보고 잠근다(fail-closed).
 */
export interface SessionIdleParams {
  idleSec: number;
}
export const SESSION_IDLE_REPORT_MS = 30_000;
export const SESSION_IDLE_STALE_MS = 120_000;

/**
 * vault.unlock 인자: 유휴 잠금 뒤·엄격 모드의 발급에서 main이 Hello 사본을 열어 달라고 한다(ADR-026 결정 3·4).
 * 승인 바 Hello와 금고 Hello는 한 번의 프롬프트로 합친다: 결과의 `presence`를 main 승인 바의 Hello 확인으로 쓴다.
 * 프롬프트 문구에 작업명·포털명을 넣는다(vault.helloPromptShowsTaskAndPortal).
 */
export interface VaultUnlockParams {
  reason: 'idle' | 'strict_issue';
  task: string;
  portal: string;
}
export interface VaultUnlockResult {
  ok: boolean;
  /** Hello로 사용자 존재를 확인했다. */
  presence: boolean;
  reason?: 'hello_unavailable' | 'hello_cancelled' | 'no_stored_secret' | 'session_locked';
}

/** 금고 열림 상태(control 이벤트 vault.state). */
export type VaultLockReason = 'session_locked' | 'idle' | 'max_open' | 'idle_unknown' | 'strict' | 'startup';
export interface VaultStateEvent {
  open: boolean;
  reason?: VaultLockReason;
}

// ───────────────────────── 실행 트리거 ─────────────────────────

/** 실행 트리거(I-9). 금고는 이 밖을 bad_trigger로 거부한다. */
export const RUN_TRIGGERS = ['local', 'remote', 'daemon'] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

/**
 * run.begin 인자. `profile`은 이 run의 활성 프로필(Q-2): 주면 run 동안 다른 scope의 typist.fill을 거부한다(denied).
 * Phase 1 main은 항상 준다. 생략은 PoC 호환(고정 없음).
 */
export interface RunBeginParams {
  runId: string;
  trigger: RunTrigger;
  profile?: ProfileScope;
}

// ───────────────────────── 타이피스트(engine) ─────────────────────────

/**
 * typist.fill 실패 사유. `row_mismatch`: 보안카드 요청 칸 번호와 화면에 보인 칸 번호(`rowLabel`)가 다르거나 읽을 수 없다
 * (셀렉터·화면 문제, 입력하지 않는다, D05 §4 2).
 */
export type FillReason = 'denied' | 'not_found' | 'blocked_by_module' | 'origin_not_allowed' | 'not_secret_slot' | 'secret_window_refused' | 'secret_missing' | 'vault_locked' | 'credential_suspect' | 'row_mismatch';

/**
 * typist.fill 인자(D05 §3.8·§4).
 * - `slot`은 셀렉터 사전 칸의 비밀 종류·용도(ADR-026 결정 6). 요청 kind와 같을 때만 입력한다.
 * - `startGate`: trigger=remote 실행에서 시작 게이트(`SAX-start-v1`)를 통과했다는 엔진 플래그(ADR-029 결정 2). 없으면 remote 실행은 거부.
 */
export interface FillRequest {
  runId: string;
  targetId: string;
  /** 'main' 또는 CDP frameId. */
  frame: string;
  /** CSS 셀렉터(PoC). Phase 1은 셀렉터 사전 ElementLocator. */
  element: string;
  /** kind는 TYPIST_KINDS만. 보안카드는 row(1~35)가 꼭 있고, 포털 비밀번호는 row가 없다. */
  secret: { kind: string; scope: string; row?: number };
  slot: { secretKind: SecretKind; purpose: 'login' | 'sign' };
  startGate?: boolean;
  /**
   * 보안카드 전용(필수): 화면에서 요청 칸 번호를 보여 주는 요소의 셀렉터(element와 같은 프레임). 금고가 자기 세션으로 그 글자를
   * 읽어 숫자가 하나만 있고 secret.row와 같을 때만 넣는다(D05 §4 2). "앞 2자리" 같은 다른 숫자가 함께 있으면 읽지 못한 것으로 본다.
   */
  rowLabel?: string;
}

/**
 * typist.authFailed 인자: 포털의 명시적 인증 실패(auth_failed) 1회 뒤 그 kind·scope를 suspect로(ADR-026 결정 7).
 * 인증서 비밀번호(cert_password)는 suspect가 아니라 기억값을 지우고, 이 실행에서 확인을 기다리던 값도 버린다(연속 오류 잠금 방지).
 * typist.authOk도 같은 인자: 인증서 비밀번호를 넣은 뒤 로그인 확인(첫 기다림 스텝 통과) → 기다리던 값을 그때 기억한다.
 */
export interface AuthFailedParams {
  runId: string;
  kind: StorableKind;
  scope: ProfileScope;
}

// ───────────────────────── R-C1 커밋 본문 대조(engine) ─────────────────────────

/**
 * commitGuard.arm 인자(D05 §3.3, D03 §5.4, ADR-005 v3 결정 10).
 * 엔진은 무장할 때 이것을 보내고, 금고는 그 타깃의 다음 일치 요청 1건 본문을 같은 규칙으로 해시해 비교한다.
 * 결과는 이벤트 `commit.body_compared`로만 온다. 본문은 엔진에 가지 않는다(일치 요청의 postData는 엔진행 이벤트에서도 지운다).
 * - `endpoint`: Fetch urlPattern(`*` 와일드카드). 호스트가 엔진 허용 목록(PORTAL_ETLD1) 안이어야 한다.
 * - `bodyFieldMap`: fieldKey → 요청 파라미터 경로. form은 이름, json은 `a.b[0].c`, xml은 `xml:/root/a/b`(요소 텍스트).
 * - `expectedHash`: commitExpectedHash(readback 기대값, bodyFieldMap)의 hex. 비밀 아님.
 */
export interface CommitArmParams {
  runId: string;
  intentId: string;
  stepId: string;
  targetId: string;
  endpoint: string;
  method?: string;
  bodyFieldMap: Record<string, string>;
  expectedHash: string;
}
export interface CommitArmResult {
  armed: boolean;
  reason?: 'bad_params' | 'endpoint_not_allowed' | 'target_not_exposed' | 'already_armed';
}
export interface CommitDisarmParams {
  intentId: string;
  stepId: string;
}

/**
 * 대조 결과. `false`면 금고가 요청을 Fetch.failRequest로 중단했다(엔진: security.commit_payload_mismatch, 원장 not_committed(payload_mismatch)).
 * `opaque`면 본문이 평문 형식(form·json·xml)이 아니거나 비어 대조하지 못했고 요청은 그대로 나갔다(D03 §5.4 잔여 위험).
 * `expired`면 무장 뒤 COMMIT_ARM_TTL_MS 안에 일치 요청이 없었다.
 */
export type CommitMatch = true | false | 'opaque' | 'expired';
export interface CommitBodyComparedEvent {
  intentId: string;
  stepId: string;
  match: CommitMatch;
}

/** 무장 유효 시간. 넘으면 해제하고 expired를 보낸다(Phase 2 commitWindowMs 전까지의 상한). */
export const COMMIT_ARM_TTL_MS = 120_000;

/** R-C1 값 정규화: NFC, 앞뒤 공백 제거, 안쪽 공백 연속은 한 칸. 숫자 형식(쉼표 등)은 엔진이 본문 형식으로 맞춰 넘긴다. */
export function normalizeCommitValue(v: string): string {
  return v.normalize('NFC').trim().replace(/\s+/g, ' ');
}

/**
 * R-C1 해시(엔진·금고 공통). 키는 코드 단위 순으로 정렬한다(맵 삽입 순서에 기대지 않는다).
 * sha256("SAX-rc1-v1\n" ‖ JSON.stringify([[fieldKey, normalized]...])) hex.
 * 엔진은 readback 기대값으로, 금고는 요청 본문에서 꺼낸 값으로 같은 함수를 부른다.
 */
export function commitExpectedHash(values: Record<string, string>, bodyFieldMap: Record<string, string>): string {
  const keys = Object.keys(bodyFieldMap).sort();
  const pairs = keys.map((k) => {
    const v = values[k];
    if (typeof v !== 'string') throw new Error(`missing field ${k}`);
    return [k, normalizeCommitValue(v)];
  });
  return createHash('sha256').update('SAX-rc1-v1\n' + JSON.stringify(pairs), 'utf8').digest('hex');
}

// ───────────────────────── 장기 키 연산(control 전용) ─────────────────────────

/**
 * Vd 서명 용도 허용 목록(D05 §5.1, D08 §2.1). 목록 밖 purpose는 거부한다.
 * 서명 대상은 `utf8(purpose) ‖ msg`이고 구분 바이트가 없다(schemas/SIGNING.md §8). `SAX-consent-v1`은 로컬 동의(Vd) 서명이다.
 * 클라우드가 검증하는 Vd 맥락은 `SAX-dpop-v1`뿐이다. 서버 전용 맥락(SAX-token-v1·SAX-run-token-v1)은 넣지 않는다.
 */
export const VD_PURPOSES = ['SAX-qbundle-v1', 'SAX-ckpt-v1', 'SAX-docrec-v1', 'SAX-consent-v1', 'SAX-dpop-v1', 'SAX-rotate-v1', 'SAX-kv-v1'] as const;
export type VdPurpose = (typeof VD_PURPOSES)[number];

/**
 * AIK(계정 신원 키, Ed25519) 서명 용도 허용 목록(D08 §2.1). 서명 대상은 `utf8(purpose) ‖ msg`이고 구분 바이트가 없다.
 * msg는 호출자가 만든 대상 객체의 JCS 바이트다(금고는 바이트만 서명한다, schemas/SIGNING.md §8).
 * 서버가 검증하는 것은 acct-op·devlist·revoke·cert이고, aik-rotate·kek은 Phase 1 서버 미사용이다.
 * AIK는 RK에서 HKDF("aik")로 파생하고 개인키는 금고 밖으로 나가지 않는다.
 * Phase 1 잔여 위험: 매 호출 사용자 존재 확인(Hello)과 trigger=daemon 거부는 Phase 2다(C-22, D05 §5.1).
 */
export const AIK_PURPOSES = ['SAX-devlist-v1', 'SAX-revoke-v1', 'SAX-cert-v1', 'SAX-aik-rotate-v1', 'SAX-kek-v1', 'SAX-acct-op-v1'] as const;
export type AikPurpose = (typeof AIK_PURPOSES)[number];

/** Noise DH 문맥(D08 §4·§5). */
export const NOISE_CONTEXTS = ['SAX-pair-v1', 'SAX-session-v1'] as const;
export type NoiseContext = (typeof NOISE_CONTEXTS)[number];

/**
 * crypto.publicKeys 결과: 공개키만(32B). Sd=Noise 정적키(X25519), Vd=서명(Ed25519), Qd=우편함 HPKE(X25519),
 * Kv=금고 비밀 봉인(X25519), aik=계정 신원 키(Ed25519, RK 파생).
 */
export interface VaultPublicKeys {
  noiseStatic: Uint8Array;
  vd: Uint8Array;
  qd: Uint8Array;
  kv: Uint8Array;
  aik: Uint8Array;
}

/**
 * crypto.noiseDH 결과. 정적키(Sd) DH 출력 32B이며 핸드셰이크 상태(MixKey)에 바로 쓰인다.
 * 개인키는 금고 밖으로 나가지 않는다. 출력은 그 핸드셰이크 하나에만 쓸모가 있다(D05 §1 오라클 한계).
 */
export interface NoiseDhParams {
  remotePub: Uint8Array;
  ctx: NoiseContext;
}
export interface SignVdParams {
  purpose: VdPurpose;
  msg: Uint8Array;
}
export interface SignAikParams {
  purpose: AikPurpose;
  msg: Uint8Array;
}
/** crypto.* 서명·DH·개봉 입력 상한(바이트). */
export const CRYPTO_MSG_MAX = 65_536;
/**
 * HPKE Base(RFC 9180, DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, ChaCha20-Poly1305) 단발 개봉(seq 0). info는 고정,
 * aad = utf8("SAX-env-v1")‖mbx_epoch(앞 10바이트가 다르면 bad_params). 결과는 평문 바이트(의도 봉투, 비밀 봉투는 큐 금지).
 */
export interface HpkeOpenParams {
  enc: Uint8Array;
  ct: Uint8Array;
  info: 'SAX-env-v1';
  aad: Uint8Array;
}

// ───────────────────────── 공동인증서 탐지(control) ─────────────────────────

/** signCert.der 읽기 상한(바이트). 실제 인증서는 2KB 안팎이다. */
export const NPKI_CERT_MAX_BYTES = 8192;
export type NpkiRootKind = 'locallow' | 'program_files' | 'preferences' | 'documents' | 'home';
/**
 * `npki.list{}` → NpkiListResult(D05 §6 허용 동작 (1)~(3), A-28).
 * - 금고는 signCert.der를 **파싱하지 않는다**. main이 `certDer`를 docparse 샌드박스 `certInfo(der)`에 넘기고
 *   고정 4필드 `{subject, issuer, notBefore, notAfter}`를 스키마로 검증해 쓴다(ADR-014, D17 §3).
 * - signPri.key는 열지 않는다. 같은 폴더에 그 이름의 일반 파일 항목이 있는지만 `hasKey`로 알린다.
 * - `dir`·`certFile`은 화면·S1b 파일 선택에만 쓴다. 텔레메트리·모델·로그로 보내지 않는다(D05 §6 (5)).
 * - 심볼릭 링크·하드링크·특수 파일·8KB 초과·열거 뒤 바꿔치기는 건너뛰고 `skipped`에 이유별 개수만 센다.
 */
export interface NpkiCertEntry {
  /** sha256(dir) 앞 16 hex. 같은 PC에서 다시 불러도 같다. */
  id: string;
  root: NpkiRootKind;
  /** CA 폴더 이름(yessign 등, 비신뢰 문자열 — 표시 전 이스케이프) */
  ca: string;
  /** 인증서 폴더 절대 경로(`<root>/<ca>/USER/<cn=…>`) */
  dir: string;
  certFile: string;
  certDer: Uint8Array;
  hasKey: boolean;
}
export interface NpkiListResult {
  certs: NpkiCertEntry[];
  skipped: Partial<Record<'symlink' | 'not_file' | 'too_large' | 'empty' | 'changed' | 'linked' | 'unreadable' | 'limit' | 'bad_name', number>>;
}

// ───────────────────────── PDF 저장(engine, save_pdf) ─────────────────────────

/**
 * 엔진 save_pdf 핸들러의 금고 쪽(D05 §3.3 다운로드·인쇄 경로, ADR-025, 팀장 결정 2026-11-06).
 * 엔진의 `Page.printToPDF`·`Page.setDownloadBehavior`·`Browser.setDownloadBehavior`는 중계가 계속 거부한다.
 * 금고가 자기 세션에서 인쇄하거나 무장된 다운로드 1건을 받고, 검사를 통과하면 staging에 `<fileId>.pdf`(무작위 이름,
 * 사용자 전용 권한)로 둔다. 엔진에는 fileId만 간다(바이트·원래 파일 이름·URL 없음). 보관함 이동은 엔진 문서 가져오기가
 * `stagedPdfPath(paths.staging, fileId)`로 읽어 docparse를 거친 뒤 지운다(D05 §3.3, D07 §1).
 *
 * - `pdf.print {runId, targetId, landscape?}` → PdfPrintResult. 성공하면 `download.completed{fileId}` 이벤트도 같은 fileId로 간다.
 * - `download.arm {runId, targetId}` → DownloadArmResult. 그 타깃(하위 프레임 포함)의 다음 다운로드 1건만 받는다.
 *   결과는 이벤트로만: `download.completed{fileId}` 또는 `download.failed{reason}`. DOWNLOAD_ARM_TTL_MS 안에 시작되지 않으면 expired.
 *   무장 없이 시작된 다운로드는 취소하고 지운다(vault.download_unexpected).
 * - `download.disarm {}` → {}.
 */
export interface PdfPrintParams {
  runId: string;
  targetId: string;
  landscape?: boolean;
}
export type PdfRefuseReason = 'bad_params' | 'target_not_exposed' | 'secret_window_open' | 'busy' | 'print_failed' | 'too_large' | 'not_pdf';
export type PdfPrintResult = { ok: true; fileId: string } | { ok: false; reason: PdfRefuseReason };
export interface DownloadArmParams {
  runId: string;
  targetId: string;
}
export type DownloadArmResult = { armed: true } | { armed: false; reason: 'bad_params' | 'target_not_exposed' | 'already_armed' };
/** download.failed 사유. unreadable: 링크·특수 파일·하드링크이거나 읽지 못했다. */
export type DownloadFailReason = 'too_large' | 'not_pdf' | 'canceled' | 'expired' | 'unreadable';
export interface DownloadCompletedEvent {
  fileId: string;
}
export interface DownloadFailedEvent {
  reason: DownloadFailReason;
}
/** PDF 상한(docparse MAX_INPUT_BYTES와 같다: 넘으면 어차피 가져오지 못한다). */
export const PDF_MAX_BYTES = 15 * 1024 * 1024;
/** download.arm 유효 시간. */
export const DOWNLOAD_ARM_TTL_MS = 60_000;

// ───────────────────────── 금고 이벤트 ─────────────────────────

/**
 * 금고 → main(control)·엔진 이벤트(I-2·I-3).
 * - 엔진 포트: secret_window.refused·secret_window.leak_suspected·secret_window.closed·commit.body_compared·download.completed·download.failed
 * - control 포트: secret.needed·secret.expired·secret_window.refused·secret_window.leak_suspected·vault.state·secret.suspect
 */
export type VaultEventName =
  | 'secret.needed' | 'secret.expired' | 'secret_window.refused' | 'secret_window.leak_suspected'
  | 'commit.body_compared' | 'vault.state' | 'secret.suspect' | 'download.completed' | 'download.failed'
  | 'screen.frame' | 'screen.paused'
  // 실행 Chrome이 사람 손으로 닫혔다(탭 전부 또는 프로세스, reason tab|chrome). main이 제출 전 실행을 멈춘다.
  | 'browser.closed' | 'browser.launched';
