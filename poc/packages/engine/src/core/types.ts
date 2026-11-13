// D02 IR·셀렉터 사전·manifest·핫픽스·정책의 TS 모양. 정본은 sovereign-ax/design/schemas/*.schema.json이고
// 이 파일은 그 사본(packages/engine/schemas)과 같은 모양이어야 한다(tests/core-schemas.test.ts가 픽스처로 대조).

export const PORTALS = ['hometax', 'gov24', 'wetax', 'sminfo', 'insure4', 'iros', 'public_api'] as const;
export type Portal = (typeof PORTALS)[number];
/**
 * 패키지(manifest·IR·셀렉터 사전)의 portal. `fixture`는 엔진 시험용 가짜 페이지(127.0.0.1·[::1])만이다(ADR-039).
 * 정책(portalMap)·실행 한도는 Portal만 받는다. fixture는 정적 검증(V-25)·제품 로더·레지스트리가 각각 거부한다.
 */
export const FIXTURE_PORTAL = 'fixture';
export const PACKAGE_PORTALS = [...PORTALS, FIXTURE_PORTAL] as const;
export type PackagePortal = (typeof PACKAGE_PORTALS)[number];
export type Effect = 'issue_document' | 'send' | 'sign' | 'pay';
export type ProfileKind = 'personal' | 'business';
export type SecretKind = 'cert_password' | 'portal_password' | 'security_card';
export type SecretPurpose = 'login' | 'sign';
export type SignMethod = 'cert' | 'simple_auth' | 'security_card';

// ---- 조건식(D02 §4.1) ----

export type Cond =
  | { exists: string }
  | { textMatches: { target: string; patternRef: string } }
  | { varEquals: { name: string; value: unknown } }
  | { varSet: string }
  | { inputPresent: string }
  | { inputVerified: string }
  | { profileHas: string }
  | { artifact: string }
  /** readback 값 산술(D02 §8 s19d): parts의 합 = total. 둘 다 readback fieldKey이고 화면을 다시 읽지 않는다(IR rev v1.3.2). */
  | { sumEquals: { parts: string[]; total: string } }
  /** ifAbsent 'empty'(IR rev v1.3.3): 선택 입력이 비었으면 되읽은 값도 비어야 참(fill ifAbsent:'clear'의 짝). 없으면 참조가 비면 오류. */
  | { readbackEquals: { fieldKey: string; ref: string; ifAbsent?: 'empty' } }
  /** 되읽은 값이 비었는가(IR rev v1.3.3). 플레이북에 그 입력이 없을 때 칸이 비었음을 확인한다(V-03m). */
  | { readbackEmpty: string }
  | { fieldsFilled: { fields: string[] } }
  | { all: Cond[] }
  | { any: Cond[] }
  | { not: Cond };

export type OnFailThen = 'recover' | 'handoff' | 'abort' | 'human:secret' | `checkpoint:${string}`;
export interface OnFail {
  retry?: number;
  then?: OnFailThen;
}
export type OutcomeTarget = string; // stepRef | 'handoff' | 'abort'

export type From = { selector: string } | { regex: { target: string; patternRef: string } } | { a11y: { target: string } };

export interface FailSignal {
  css: string;
  text: string;
}

export interface Lookup {
  playbook: string;
  match: Record<string, string>;
  window: 'issueDate' | 'today' | 'last7d';
  baseline: 'pre_gate_snapshot' | 'none';
  notCommittedPolicy: { minElapsedMs: number; lookups: number };
  bind?: { approvalNo?: string };
  /** 새 행 하나의 상태 문구 판정(v1.3.4): notSent 패턴 → not_committed 근거(먼저 본다), sent → committed, 그 밖 unknown. */
  rowVerdict?: { column: string; sent: string; notSent: string };
  /** 이 verify만의 다시 보기 상한(v1.3.4, baseline:none 사후 확인만, V-03n). 없으면 policy.verify.maxMs. */
  maxMs?: number;
}

export type SignFlowAction = 'human:secret' | 'secret_fill:security_card' | 'wait:push';
export interface SignFlow {
  method: SignMethod | '$profile.signMethod';
  steps?: Partial<Record<SignMethod, SignFlowAction[]>>;
  rowLabel?: string;
  confirmTarget?: string;
  /** IR rev v1.3.5: submit 클릭 뒤 차례로 한 번씩 누르는 commits:true 항목(포털 확인 창의 [인증 화면 이동] 등). */
  openTargets?: string[];
  /** IR rev v1.3.5: 방식별로 openTargets 뒤 한 번 누르는 commits:true 항목(인증유형 선택). */
  methodTargets?: Partial<Record<SignMethod, string>>;
  /** IR rev v1.3.5: 서명 화면이 떴다는 표지(비커밋, 방식 동작 전에 기다린다. 홈택스 iframe#dscert 보임). */
  readyTarget?: string;
  /** IR rev v1.3.5: 서명이 끝났다는 표지(비커밋, human:secret 뒤·confirmTarget 없는 wait:push가 기다린다. 발급 완료 창). */
  doneTarget?: string;
  /** IR rev v1.3.6: 서명 화면이 뜬 뒤 방식 동작 전에 고르는 목록 항목(rows 항목, 인증서 창). 행이 하나면 그것, 여럿이면 by 값과 이름 칸이 같은 행. 못 고르면 서명 차례(사람). */
  certPick?: { target: string; by: string };
  maxWaitMs: number;
}

interface StepBase {
  id: string;
  label?: string;
  pace?: 'normal' | 'slow';
  timeoutMs?: number;
  onFail?: OnFail;
  loopGuard?: { max: number };
  code?: string;
}

export type GotoStep = StepBase & { type: 'goto'; url: string };
export type ClickStep = StepBase & { type: 'click'; target: string };
export type FillStep = StepBase & { type: 'fill'; target: string; value: string; keyEvents?: boolean; ifAbsent?: 'fail' | 'clear' };
export type SelectStep = StepBase & { type: 'select'; target: string; option: string };
export type PressStep = StepBase & { type: 'press'; key: 'Enter' | 'Tab' | 'Escape' | 'ArrowDown' | 'ArrowUp'; target?: string };
/**
 * wait. for 'dialog'(IR rev v1.3.5): 마지막 동작 뒤 뜬 네이티브 대화상자(alert 등)를 기다리고, 그 문구가 value(strings 패턴, ^…$)에 맞아야 통과.
 * 다른 문구면 step.dialog_mismatch(재시도 없이 onFail), 시간 안에 안 뜨면 step.timeout. 대화상자는 엔진 정책대로 이미 닫혔다(alert = 확인).
 */
export type WaitStep = StepBase & { type: 'wait'; for: 'selector' | 'navigation' | 'text' | 'idle' | 'dialog' | 'gone'; value?: string };
/**
 * pick(IR rev v1.3.6): rows 항목(목록) 안에서 행 하나를 고른다(홈택스 인증서 창의 인증서 목록).
 * - use 'selected': 지금 선택된 행(사람이 고른 행). 정확히 하나여야 한다.
 * - 그 밖: 행이 하나면 그 행, 여럿이면 by 값(정규화)과 이름 칸 글이 같은 행이 정확히 하나일 때. 못 고르면 ifNone으로 간다(없으면 pick.none 실패).
 * 고른 행이 선택돼 있지 않으면 누르고, 선택 표지(rows.selected)가 그 행으로 바뀌는지 확인한다(사후 조건).
 * remember: 고른 행의 이름을 프로필 칸에 저장한다(다음 실행의 by). 성공하면 then(있으면)으로, 없으면 다음 스텝.
 */
export type PickStep = StepBase & { type: 'pick'; target: string; by?: string; use?: 'selected'; remember?: 'certName'; ifNone?: OutcomeTarget; then?: string };
export type AssertStep = StepBase & { type: 'assert'; cond: Cond };
export type ExtractStep = StepBase & { type: 'extract'; name: string; from: From; readback?: boolean };
export type DecideStep = StepBase & { type: 'decide'; bundle: string; scope: string; on: Record<string, OutcomeTarget> };
export type CheckpointStep = StepBase & { type: 'checkpoint'; name: string; expect: Cond; url?: string; sessionRequired?: boolean; reentry?: 'reuse' | 'reload' };
export type ReadbackStep = StepBase & { type: 'readback'; fields: string[] };
export type GateStep = StepBase & { type: 'gate'; card: string; authorizes: string[]; waitMs?: number };
export type HumanStep = StepBase & { type: 'human'; kind: 'captcha' | 'otp' | 'secret' | 'manual'; prompt: string; region?: string; target?: string; inputSpec?: { pattern?: string; maxLength?: number }; ttlMs: number };
export type HumanCommitStep = StepBase & { type: 'human_commit'; prompt: string; intent: '$intent.id'; verify: string; followUpOf?: string };
export type SecretFillStep = StepBase & { type: 'secret_fill'; target: string; secret: SecretKind; rowFrom?: string };
export type SignStep = StepBase & { type: 'sign'; method: SignMethod | '$profile.signMethod'; then?: Array<'human:secret' | 'secret_fill:security_card'> };
export type SubmitStep = StepBase & { type: 'submit'; target: string; intent: '$intent.id'; verify: string; expectConfirm?: string; signFlow?: SignFlow };
export type VerifyStep = StepBase & { type: 'verify'; lookup: Lookup; failSignals?: FailSignal[]; on: { committed: OutcomeTarget; not_committed: OutcomeTarget; unknown: OutcomeTarget } };
export type CaptureStep = StepBase & { type: 'capture'; name: string; from: From };
export type SavePdfStep = StepBase & { type: 'save_pdf'; strategy: 'original' | 'print' | 'page_pdf' | 'wallet'; docType: string; nameTemplate?: string };
export type SendEmailStep = StepBase & { type: 'send_email'; via: 'portal' | 'local'; to: string; attach?: string; intent?: '$intent.id'; followUpOf: string; verify: string };
export type BranchStep = StepBase & { type: 'branch'; on: Cond; cases: Record<string, string>; default: OutcomeTarget };
export type RepeatStep = StepBase & { type: 'repeat'; max: number; until: Cond; steps: Step[] };
export type HandoffStep = StepBase & { type: 'handoff'; reason: string; resumeAt: string };
export type EndStep = StepBase & { type: 'end'; status: 'success' | 'completed_with_issues' | 'failed' };

export type Step =
  | GotoStep | ClickStep | FillStep | SelectStep | PressStep | WaitStep | AssertStep | ExtractStep | DecideStep | CheckpointStep
  | ReadbackStep | GateStep | HumanStep | HumanCommitStep | SecretFillStep | SignStep | SubmitStep | VerifyStep | CaptureStep
  | SavePdfStep | SendEmailStep | BranchStep | RepeatStep | HandoffStep | EndStep | PickStep;
export type StepType = Step['type'];
export type StepOf<T extends StepType> = Extract<Step, { type: T }>;

export const STEP_TYPES = [
  'goto', 'click', 'fill', 'select', 'press', 'wait', 'assert', 'extract', 'decide', 'checkpoint', 'readback', 'gate', 'human',
  'human_commit', 'secret_fill', 'sign', 'submit', 'verify', 'capture', 'save_pdf', 'send_email', 'branch', 'repeat', 'handoff', 'end', 'pick',
] as const satisfies readonly StepType[];

export interface InputDecl {
  type: 'counterparty' | 'amounts' | 'line_items' | 'date' | 'email' | 'enum' | 'string' | 'number' | 'boolean' | 'secret_ref';
  required?: boolean;
  default?: unknown;
  minItems?: number;
  values?: string[];
}

export interface PlaybookIR {
  ir: 2;
  id: string;
  version: string;
  portal: PackagePortal;
  profileKinds: ProfileKind[];
  effects: Effect[];
  inputs: Record<string, InputDecl>;
  preconditions?: Cond[];
  steps: Step[];
  postconditions: Cond[];
  recovery?: { default?: OnFail };
  pacing?: { profile?: 'interactive' | 'daemon' };
  /** IR rev v1.3.6: 실행 중 새 창(팝업)이 뜨면 제목이 이 strings 패턴(^…$)에 맞을 때 닫는다(커밋 없는 안내 창). 다른 창은 두고 저널만. */
  closeWindows?: string[];
  /**
   * IR rev v1.3.7: 공지 레이어 닫기. 첫 스텝부터 until 스텝(또는 첫 게이트) 전까지 스텝마다 targets(closeAffordance 항목)를 본다.
   * 보이고 동일성이 맞고 하나뿐이면 누른다. 없거나 틀리거나 여럿이면 건너뛴다(실행을 멈추지 않는다).
   */
  closeLayers?: { targets: string[]; until: string };
}

// ---- 셀렉터 사전(D02 §2.1) ----

export type Candidate = { kind: 'role'; role: string; name: string } | { kind: 'css'; value: string } | { kind: 'label'; value: string };

export interface SelectorEntry {
  candidates: Candidate[];
  /** editable(IR rev v1.3.6): 입력할 수 있는(readonly·disabled 아닌) 요소만 받는다. 아니면 없는 것으로 본다. */
  expect?: { visible?: boolean; enabled?: boolean; editable?: boolean };
  role: string;
  namePattern: string;
  frame: string;
  landmark: string;
  commits: boolean;
  commitEffect?: Effect;
  inputType?: 'text' | 'password' | 'number' | 'email' | 'date' | 'checkbox' | 'radio' | 'select' | 'textarea' | 'button' | 'link' | 'other';
  secretKind?: SecretKind;
  secretPurpose?: SecretPurpose;
  closeAffordance?: boolean;
  navigationOnly?: boolean;
  fieldKey?: string;
  readbackOf?: string;
  /** IR rev v1.3.5: readback 값 = 이 요소 하위에서 이 CSS에 맞고 글이 빈칸이 아닌 요소의 수(품목 행 수 등). fieldKey가 있을 때만. */
  countOf?: string;
  /**
   * IR rev v1.3.6: 이 요소는 목록이다(pick·signFlow.certPick). item = 행(하위 CSS), name = 행 안 이름 칸(행 하위 CSS),
   * selected = 선택된 행(이 요소 하위 CSS, 정확히 하나). 값은 저널·로그에 남기지 않는다.
   */
  rows?: { item: string; name: string; selected: string };
  allowedConstants?: string[];
  reviewNote?: { by: string; reason: string };
  lastVerified: string;
}

export interface EndpointMatch {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** IR rev v1.3.5: 요청이 가야 하는 URL host(소문자, 포트 포함). 없으면 manifest.domains 어디든. 홈택스 발급 요청은 teet.hometax.go.kr이다. */
  host?: string;
  pathPattern: string;
  actionParam?: { name: string; value: string };
}
export interface CommitEndpoint {
  match: EndpointMatch;
  effect: Effect;
  maxRequests: number;
  encoding?: 'form' | 'json' | 'xml' | 'opaque';
  bodyFieldMap?: Record<string, string>;
}

export interface SelectorDict {
  portal: PackagePortal;
  entries: Record<string, SelectorEntry>;
  commitEndpoints: CommitEndpoint[];
  knownEndpoints: EndpointMatch[];
}

/** 비밀 칸(V-20): secretKind가 있거나 inputType이 password인 항목. */
export const isSecretEntry = (e: Pick<SelectorEntry, 'secretKind' | 'inputType'> | undefined): boolean => !!e && (e.secretKind !== undefined || e.inputType === 'password');

// ---- 패키지(D02 §2) ----

export interface Signature {
  keyId: string;
  alg: 'ed25519';
  sig: string;
}

export interface Manifest {
  id: string;
  version: string;
  kind: 'playbook' | 'lookup';
  portal: PackagePortal;
  title: string;
  profileKinds: ProfileKind[];
  engineRange: string;
  domains: string[];
  effects: Effect[];
  bundlesUsed: Array<{ id: string; ver: number; digest: string }>;
  lookupsUsed: Array<{ id: string; version: string; digest: string }>;
  contentDigests: { playbook: string; selectors: string; strings: string };
  createdAt: string;
  signatures: Signature[];
}

export type Strings = Record<string, string>;

/** 검증 단위: 한 패키지의 네 파일. 조회 하위 패키지는 lookups로 같이 받는다(V-22). */
export interface PackageFiles {
  manifest: Manifest;
  playbook: PlaybookIR;
  selectors: SelectorDict;
  strings: Strings;
}

export interface Hotfix {
  appliesTo: { id: string; version: string; packageDigest: string };
  version: number;
  monotonic: number;
  keyEpoch: number;
  issuedAt: string;
  expiresAt: string;
  entries: Record<string, { candidates: Candidate[] }>;
  commitEndpointsAdd?: CommitEndpoint[];
  reason?: string;
  signatures: Signature[];
}

// ---- 정책(D03 §7) ----

export type PortalMode = 'postprocess' | 'assisted' | 'auto';
export type CaptchaRelay = 'allowed' | 'disabled_until_permission' | 'disabled';
export type PortalMap<T> = Partial<Record<Portal, T>> & Record<'hometax' | 'gov24' | 'sminfo' | 'insure4', T>;

export interface PacePolicy {
  stepDelayMs: [number, number];
  keyEventDelayMs: number;
  afterNavSettleMs: [number, number];
  slowFactor: number;
}
export interface PortalLimits {
  runsPerDayPerProfile: number;
  irreversiblePerDayPerProfile: number;
  runsPerLoginSession: number;
  navigationsPerMin: number;
  loginsPerDay: number;
  loginFailuresPerDay?: number;
  concurrent: 1;
}

export interface Policy {
  version: string;
  monotonic: number;
  keyEpoch: number;
  issuedAt: string;
  expiresAt: string;
  timestamp: Signature;
  pace: { interactive: PacePolicy; daemon: PacePolicy };
  limits: PortalMap<PortalLimits>;
  retries: { stepMax: number; backoff: 'equal_jitter'; baseMs: number; capMs: number };
  run: { maxActuationsPerRun: number; maxWallClockMs: number; commitWindowMs: number; l2MaxAttempts: number };
  cooldown: {
    onBlockSignalHours: number;
    onCaptchaBurst: { windowMin: number; count: number; action: 'slow+notify' | 'pause' };
    positiveDetectionsForCooldown: number;
    blockSignalsAdd?: { urlPatterns?: string[]; phrases?: string[] };
  };
  daemon: { windowJitterMin: number; gapBetweenRunsMin: [number, number]; startupGraceMin: number; retryAfterMin: number; autoAllowed: false };
  portalMode: PortalMap<PortalMode>;
  captchaRelay: PortalMap<CaptchaRelay>;
  browser: { remoteDebuggingPort: 'forbidden'; webdriverSelfCheck: true };
  verify: { minElapsedMs: number; lookups: number; maxMs?: number };
  remote: { irreversiblePerDay: number; newCounterpartyRequiresLocal: true; notifyOnIrreversible: Array<'desktop' | 'email'>; minProtocolVersion: number; disabledFeatures: string[] };
  queue: { maxIntentsPerPair: number; ttlHours: number };
  signatures: Signature[];
}

// ---- 검증 결과 ----

/** 규칙 번호(V-01~24, V-03a~l·V-03c′·V-03j′·V-03j″, SV-01~06, HF-*, LD-*) 하나와 위치. 값은 담지 않는다. */
export interface Violation {
  rule: string;
  step?: string;
  target?: string;
  message: string;
}
