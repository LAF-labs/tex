// 금고 포트 메시지(D01 §2.1: MessagePort 기반 타입드 IPC). 포트는 세 종류다.
// - engine: CDP 프레임(cdp)과 RPC(typist·secretWindow·browser·commitGuard·crypto·getDbKeyOnce)
// - control(main): 실행 트리거 통지, 사용자 "입력 완료", Windows 세션 상태, 저장된 비밀 목록·삭제, 상태
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
    'typist.fill', 'typist.authFailed',
    'secretWindow.openForHuman', 'secretWindow.requestClose',
    'commitGuard.arm', 'commitGuard.disarm',
    'crypto.publicKeys', 'crypto.noiseDH', 'crypto.signVd', 'crypto.hpkeOpen',
    'getDbKeyOnce',
  ],
  control: [
    'run.begin', 'run.end', 'secretWindow.userDone', 'status',
    'session.event', 'session.idle', 'vault.unlock', 'vault.setStrict',
    'secret.list', 'secret.has', 'secret.forget',
  ],
  secretInput: ['secret.provide', 'secret.store'],
};

// ───────────────────────── 비밀 종류·범위 ─────────────────────────

/** 비밀 종류(ADR-026 결정 6 `secretKind`). */
export const SECRET_KINDS = ['cert_password', 'portal_password', 'security_card'] as const;
export type SecretKind = (typeof SECRET_KINDS)[number];

/**
 * 저장할 수 있는 종류(ADR-020 결정 2·3, ADR-026 결정 2). 공동·금융인증서 비밀번호는 저장 기능 자체가 없다.
 * - portal_password: 칸 `portal/<scope>/id`·`portal/<scope>/pw`
 * - security_card: 칸 `securitycard/<scope>/<row>`(row 1~35)
 */
export const STORABLE_KINDS = ['portal_password', 'security_card'] as const satisfies readonly SecretKind[];
export type StorableKind = (typeof STORABLE_KINDS)[number];

/**
 * 프로필 범위(칸 이름의 <profile>). PoC·Phase 1 초기는 프로필 2개(사업자·개인)라 이 두 값만 받는다(audit-v V5).
 * 프로필 ID로 넓히는 것은 질문 Q-2(D05 §2 `ProfileId`).
 */
export const SECRET_SCOPES = ['business', 'personal'] as const;
export type SecretScope = (typeof SECRET_SCOPES)[number];
export const isSecretScope = (s: unknown): s is SecretScope => typeof s === 'string' && (SECRET_SCOPES as readonly string[]).includes(s);

/** 보안카드 칸 번호 범위. */
export const SECURITY_CARD_ROWS = { min: 1, max: 35 } as const;

/** 포털 자격 칸. 타이피스트는 type=password 칸에만 넣으므로 Phase 1에서 자동 입력하는 것은 pw다(id는 저장만, 질문 Q-1). */
export type PortalField = 'id' | 'pw';

// ───────────────────────── secretInput 포트 ─────────────────────────

/**
 * 1회용 비밀 입력 결속(I-1, N-44). main이 secretInput 포트를 넘길 때 함께 준다.
 * 금고는 이 포트에서 이 값으로 secret.provide를 한 번만 받는다. 결속이 없거나 틀리면 포트를 붙이지 않는다.
 * `mode`가 없으면 oneshot이다(PoC 호환).
 */
export type OneShotBind = {
  mode?: 'oneshot';
  runId: string;
  kind: SecretKind;
  scope: SecretScope;
  row?: number;
};

/**
 * 등록 창(T-06) 결속(ADR-026 결정 2·5). main이 OS 프레임 창을 열 때 넘긴다. 금고는 secret.store를 한 번만 받는다.
 * `notice`는 등록 화면에 실제로 보인 고지 묶음 판(동의 레코드에 그대로 남긴다).
 */
export type StoreBind = {
  mode: 'store';
  kind: StorableKind;
  scope: SecretScope;
  notice: { version: string };
};

export type SecretInputBind = OneShotBind | StoreBind;

/** secret.provide(oneshot) 인자. kind·scope·row는 생략하거나 결속값과 같아야 한다. */
export interface SecretProvideParams {
  bytes: Uint8Array;
  kind?: SecretKind;
  scope?: SecretScope;
  row?: number;
}

/** secret.store 인자(store 결속). 보안카드는 row만, 포털은 field만 쓴다. 값은 TextEncoder 바이트. */
export interface SecretStoreParams {
  entries: Array<{ row?: number; field?: PortalField; bytes: Uint8Array }>;
}

/** secret.store 결과. 값·길이 없음. */
export interface SecretStoreResult {
  handle: SecretHandle;
  tier: KeyTier;
  consent: ConsentRecord;
}

/** 저장된 비밀의 손잡이(종류·범위만, 값 없음). */
export interface SecretHandle {
  kind: StorableKind;
  scope: SecretScope;
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
  scope: SecretScope;
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
  scope: SecretScope;
  items: number;
  tier: KeyTier;
  /** 포털이 명시적 인증 실패를 알린 뒤 사용자가 다시 등록하지 않았다(vault.credential_suspect, ADR-026 결정 7). */
  suspect: boolean;
  consentAt: string;
}

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

// ───────────────────────── 타이피스트(engine) ─────────────────────────

export type FillReason = 'denied' | 'not_found' | 'blocked_by_module' | 'origin_not_allowed' | 'not_secret_slot' | 'secret_window_refused' | 'secret_missing' | 'vault_locked' | 'credential_suspect';

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
  secret: { kind: string; scope: string; row?: number };
  slot: { secretKind: SecretKind; purpose: 'login' | 'sign' };
  startGate?: boolean;
}

/** typist.authFailed 인자: 포털의 명시적 인증 실패(auth_failed) 1회 뒤 그 kind·scope를 suspect로(ADR-026 결정 7). */
export interface AuthFailedParams {
  runId: string;
  kind: StorableKind;
  scope: SecretScope;
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

// ───────────────────────── 장기 키 연산(engine) ─────────────────────────

/**
 * Vd 서명 용도 허용 목록(D05 §5.1, D08 §2.1). 목록 밖 purpose는 거부한다. 서명 대상은 purpose‖0x00‖msg.
 * `SAX-consent-v1`은 로컬 동의(Vd) 서명이다.
 */
export const VD_PURPOSES = ['SAX-qbundle-v1', 'SAX-ckpt-v1', 'SAX-docrec-v1', 'SAX-consent-v1', 'SAX-dpop-v1', 'SAX-rotate-v1', 'SAX-kv-v1'] as const;
export type VdPurpose = (typeof VD_PURPOSES)[number];

/** Noise DH 문맥(D08 §4·§5). */
export const NOISE_CONTEXTS = ['SAX-pair-v1', 'SAX-session-v1'] as const;
export type NoiseContext = (typeof NOISE_CONTEXTS)[number];

/** crypto.publicKeys 결과: 공개키만(32B). Sd=Noise 정적키(X25519), Vd=서명(Ed25519), Qd=우편함 HPKE(X25519), Kv=금고 비밀 봉인(X25519). */
export interface VaultPublicKeys {
  noiseStatic: Uint8Array;
  vd: Uint8Array;
  qd: Uint8Array;
  kv: Uint8Array;
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
/** HPKE Base(RFC 9180, DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, ChaCha20-Poly1305) 개봉. info는 고정, aad = "SAX-env-v1"‖mbx_epoch. */
export interface HpkeOpenParams {
  enc: Uint8Array;
  ct: Uint8Array;
  info: 'SAX-env-v1';
  aad: Uint8Array;
}

// ───────────────────────── 금고 이벤트 ─────────────────────────

/**
 * 금고 → main(control)·엔진 이벤트(I-2·I-3).
 * - 엔진 포트: secret_window.refused·secret_window.leak_suspected·secret_window.closed·commit.body_compared
 * - control 포트: secret.needed·secret.expired·secret_window.refused·secret_window.leak_suspected·vault.state·secret.suspect
 */
export type VaultEventName =
  | 'secret.needed' | 'secret.expired' | 'secret_window.refused' | 'secret_window.leak_suspected'
  | 'commit.body_compared' | 'vault.state' | 'secret.suspect';
