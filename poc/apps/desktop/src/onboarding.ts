// 온보딩(08 §4 O-01~O-06, D14 M4-2)과 동의 화면 4종(D15 F-06, 팀장 승인 2026-11-05). Electron 없이 도는 상태 기계다.
// - 온보딩은 메인 대화의 첫 부분이다. 한 번에 하나씩 묻고, 사용자는 카드의 칩·버튼을 누른다(08 §4 공통 규칙).
// - 첫 실행은 짧게(B4, 대표 지시 2026-11-13 "승인·동의 단계를 늘리지 않는다"): 약관과 모델 처리 고지를 한 화면 한 클릭으로 받고(동의 레코드는 둘 다 남긴다),
//   사용 기록(기본 꺼짐)·맡길 업무(지금 되는 일은 세금계산서뿐)·거래처·요약 확인 화면은 묻지 않는다. 인증 단계는 "홈택스 인증서"(이 PC 인증서 고르기)다.
//   옛 이어 하기 저장이 없어진 화면(telemetry·tasks·counterparties)에 멈춰 있으면 요약으로 옮긴다.
// - 문구는 전부 "F-06 초안 전" 자리표시이고 키에 판을 붙인다(F-06이 오면 문구만 바꾼다).
// - 비밀(홈택스 비밀번호·보안카드)은 여기를 지나지 않는다. ①은 금고 등록 창(T-06)을 여는 결속값(notice 판)만 만들고, 값은 금고 창에서 금고로 직접 간다(ADR-025·026).
// - 사업자번호는 DB와 같은 체크섬으로 본다(@sax/db isValidBizNo, profile.upsert가 같은 규칙으로 거부한다).
// - 바깥 일(등록증 읽기·진위확인·인증서 찾기·금고 등록·동의 기록·프로필 저장·이어 하기 저장)은 OnboardingPorts 뒤에 둔다. 지금은 목업 어댑터(onboarding-mock.ts).

import type { ConsentRecord, SecretStoreResult, StoreBind } from '@sax/vault';
import { isValidBizNo } from '@sax/db';

export const ONB_STEPS = ['terms', 'welcome', 'biz-number', 'biz-confirm', 'auth', 'delegation', 'model', 'telemetry', 'tasks', 'counterparties', 'summary', 'first', 'done'] as const;
export type OnbStep = (typeof ONB_STEPS)[number];

/** 단계마다 받을 수 있는 답. 표에 없는 답은 bad_choice. "나중에"(later)가 있는 단계는 건너뛴 항목으로 판에 남는다(08 §4). */
export const ONB_CHOICES = {
  terms: ['agree'],
  welcome: ['upload', 'number', 'later'],
  'biz-number': ['submit', 'back'],
  'biz-confirm': ['confirm', 'confirm_unverified', 'edit', 'recheck', 'later'],
  auth: ['card', 'simple', 'cert', 'fincert', 'unsure', 'later'],
  delegation: ['agree', 'switch'],
  // ② 모델 처리 동의는 필수다(약관과 같은 취급, 사용자 결정 2026-11-10 "오프라인 해석은 없다"). 거절 선택지는 없다.
  model: ['agree'],
  telemetry: ['on', 'off'],
  tasks: ['submit', 'later'],
  counterparties: ['done', 'later'],
  summary: ['ok'],
  first: ['try', 'later'],
} as const satisfies Record<Exclude<OnbStep, 'done'>, readonly string[]>;
export type OnbChoice = (typeof ONB_CHOICES)[keyof typeof ONB_CHOICES][number];
export const ONB_ALL_CHOICES = [...new Set(Object.values(ONB_CHOICES).flat())] as OnbChoice[];

// ---- 동의 화면 4종 ----

/** O-06 [지금 해 보기]가 입력창에 채우는 문장(보내지 않는다). 보내면 거래처·금액·품목을 되묻는다. */
export const TRY_FIRST_FILL = '세금계산서 발급해 줘';

export const CONSENT_KINDS = ['terms', 'model', 'telemetry', 'delegation'] as const;
export type ConsentKind = (typeof CONSENT_KINDS)[number];

/** 고지 묶음 하나. key·version이 동의 레코드에 그대로 남는다. 문구는 F-06이 오기 전 자리표시다. */
export interface ConsentNotice {
  kind: ConsentKind;
  key: `consent.${ConsentKind}`;
  version: string;
  title: string;
  lines: string[];
  /** 화면 구석에 보이는 표시. F-06 확정 문구가 오면 null. */
  draft: string | null;
}

const DRAFT = 'F-06 초안 전 문구';
const V = 'f06-pre.1';
export const CONSENT_NOTICES: Readonly<Record<ConsentKind, ConsentNotice>> = {
  // ④ 약관·처리방침(이용약관: 프로필 2개·대리 사용 금지, 처리방침: 수탁자·국외이전 표)
  terms: {
    kind: 'terms',
    key: 'consent.terms',
    // 모델 처리 고지(②)와 한 화면이 되며 판을 올렸다(B4). ②의 동의 레코드는 ② 판으로 따로 남는다.
    version: 'f06-pre.2',
    title: '이용약관·개인정보 처리방침·AI 모델 이용',
    lines: [
      '계정 하나에 사업자 프로필 1곳과 개인 프로필 1곳까지 쓸 수 있어요. 다른 사람의 사업자를 대신 맡아 쓰는 것은 허용하지 않아요.',
      '대화는 AI 모델로 해석해요. 이름·번호를 가린 문장만 아래 곳으로 보내고, 비밀번호·보안카드 번호는 보내지 않아요.',
      '사용 기록은 보내지 않아요.',
    ],
    draft: DRAFT,
  },
  // ② 모델 국외 이전(처리자 표는 설정 데이터 ConsentConfig.processors에서 온다. 모델 상류가 바뀔 수 있어 고정하지 않는다)
  model: {
    kind: 'model',
    key: 'consent.model',
    // 문구가 바뀌어(거절 선택지 없음) 판을 올렸다. 동의 레코드에 이 판이 남는다.
    version: 'f06-pre.2',
    title: '문장 해석에 쓰는 모델(국외 이전)',
    lines: ['입력한 문장을 해석할 때 이름·번호를 가린 문장만 모델에 보내요. 비밀번호·보안카드 번호는 보내지 않아요.', '아래 곳에서 처리하고, 보관 기간은 표에 적힌 대로예요.', '대화는 모델로 해석해요. 동의해야 앱을 쓸 수 있어요.'],
    draft: DRAFT,
  },
  // ③ 텔레메트리(선택, 기본 꺼짐)
  telemetry: {
    kind: 'telemetry',
    key: 'consent.telemetry',
    version: V,
    title: '사용 기록 보내기(선택)',
    lines: ['오류 종류와 단계별 걸린 시간만 보내요. 서류·금액·거래처·사업자번호는 보내지 않아요.', '기본은 꺼져 있어요.'],
    draft: DRAFT,
  },
  // ① 보안카드·홈택스 아이디/비밀번호 위임 등록(범위 고지, 인증서 비밀번호는 저장하지 않음, D05 §9)
  delegation: {
    kind: 'delegation',
    key: 'consent.delegation',
    version: V,
    title: '홈택스 아이디·비밀번호와 보안카드 등록',
    lines: [
      '홈택스 아이디·비밀번호와 보안카드 번호를 이 PC 금고에 한 번 등록하면, 발급할 때마다 앱이 대신 입력해요.',
      '값은 앱 화면이 아니라 따로 뜨는 금고 창에서만 받아요. 모델·서버로 보내지 않아요.',
      '같은 PC에 들어온 악성코드로부터는 보호하지 못해요.',
      '인증서 비밀번호는 저장하지 않아요.',
      '저장하지 않으려면 사업자 간편인증이나 인증서로 바꿀 수 있어요.',
    ],
    draft: DRAFT,
  },
};

/** ② 화면의 처리자 표 한 줄. 설정 데이터로 받는다(모델 상류 OpenRouter의 공급사 목록이 바뀔 수 있다). */
export interface ModelProcessor {
  name: string;
  role: string;
  country: string;
  retention: string;
}
export interface ConsentConfig {
  /** 이 표의 판(설정 데이터가 바뀌면 올라간다). 동의 레코드에 남는다. */
  processorsVersion: string;
  processors: ModelProcessor[];
}

/**
 * ② 처리자 표(앱 내장 판). 서명된 운영 설정으로 받게 되면 바뀐다. 모델 상류가 OpenRouter라 공급사 목록이 바뀔 수 있어
 * 렌더러·상태 기계에 고정하지 않는다(팀장 조건 (c)). 시연·시험은 onboarding-mock.ts의 MOCK_CONSENT_CONFIG(같은 표, 다른 판)를 쓴다.
 */
export const CONSENT_CONFIG: ConsentConfig = {
  processorsVersion: '2026-11-05',
  processors: [
    { name: 'OpenRouter', role: '모델 중계', country: '미국', retention: '보관하지 않음(설정 확인 전 30일)' },
    { name: '모델 공급사(라우팅 대상)', role: '문장 해석', country: '미국·EU', retention: 'ZDR 승인 전 30일' },
  ],
};

/** 앱이 남기는 동의 레코드(②③④). ①은 금고가 만든다(금고 ConsentRecord). */
export interface AppConsentRecord {
  v: 1;
  kind: Exclude<ConsentKind, 'delegation'>;
  noticeKey: string;
  noticeVersion: string;
  /** ②만: 그때 보인 처리자 표의 판. */
  processorsVersion?: string;
  choice: 'agreed' | 'declined';
  /** ISO 8601 UTC. */
  at: string;
  via: 'onboarding';
}

/**
 * 금고 등록 창(T-06) 결속은 금고 프로토콜의 StoreBind(#42) 그대로다. 아이디·비밀번호·보안카드를 한 화면에서 받는다(팀장 결정): 결속 두 개를 한 창에.
 * 동의 레코드(①)는 금고가 저장 때 만드는 ConsentRecord(D05 §9)다. 값·길이·칸 번호 없음.
 */
export type StoreBindRequest = StoreBind;
export type VaultConsentRecord = ConsentRecord;
/** portalLoginId: 금고 secret.store 결과의 비밀 아닌 포털 아이디(SecretStoreResult). DB `profiles.portal_login_id`에 쓴다. */
export type RegisterResult = { ok: true; consents: VaultConsentRecord[]; portalLoginId?: SecretStoreResult['portalLoginId'] } | { ok: false; reason: string };

// ---- 온보딩 데이터 ----

export interface BizFields {
  name: string;
  bizNo: string;
  rep: string;
  bizType: string;
  bizItem: string;
  address: string;
  email: string;
}
export const BIZ_FIELD_KEYS = ['name', 'bizNo', 'rep', 'bizType', 'bizItem', 'address', 'email'] as const satisfies ReadonlyArray<keyof BizFields>;
/** 사업자 칸 길이 상한. IPC 표(ipc.ts)와 입력 폼 maxlength가 같은 값을 쓴다. 상한 안의 값은 자르지 않는다. */
export const BIZ_FIELD_MAX: Record<(typeof BIZ_FIELD_KEYS)[number], number> = { name: 100, bizNo: 20, rep: 100, bizType: 100, bizItem: 100, address: 200, email: 320 };
/** DB(packages/db repo.ts checkEmail)와 같은 이메일 모양. 받을 때 보고, 요약 저장에서 처음 걸리지 않게 한다. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const emailOk = (s: string) => s === '' || EMAIL_SHAPE.test(s);
/** O-02에서 상호가 비었을 때(번호로 등록·등록증에서 못 읽음). 확정 버튼 대신 [고칠게요]로 채우게 한다. */
export const BIZ_NAME_NOTICE = '상호가 비어 있어요. [고칠게요]에서 상호를 넣어 주세요.';
const EMPTY_BIZ: BizFields = { name: '', bizNo: '', rep: '', bizType: '', bizItem: '', address: '', email: '' };

/** 국세청 진위확인 결과(ADR-029: 사업자번호만 보낸다). label은 화면 배지 글자, source는 배지 옆 출처. */
export interface BizCheck {
  status: 'active' | 'suspended' | 'closed' | 'unknown';
  label: string;
  taxType: string | null;
  source: '국세청 조회';
}

/**
 * 이 PC에서 찾은 공동인증서(NPKI) 한 장(표시용, npki-certs.ts). 비밀번호·키·경로·주체 전체는 없다.
 * id는 금고 열거 id(폴더 경로의 해시 앞부분). owner는 CN의 이름 부분, usage는 발급자.
 */
export interface NpkiCert {
  id: string;
  owner: string;
  usage: string;
  expiresOn: string;
  /** 고를 수 있는가. 개인키 파일이 없거나(no_key) 만료됐으면(expired) 보이되 고를 수 없다. 옛 이어 하기 값(칸 없음)은 고를 수 있는 것으로 본다. */
  usable?: boolean;
  why?: 'no_key' | 'expired';
}
export const CERT_EXPIRY_WARN_DAYS = 30;

export type AuthKind = 'card' | 'simple' | 'cert' | 'fincert';
/** DB profiles.sign_method 값(packages/db SignMethod). 금융인증서는 cert와 같은 칸(D07 열이 하나). */
export const AUTH_SIGN_METHOD: Record<AuthKind, 'security_card' | 'simple_auth' | 'cert'> = { card: 'security_card', simple: 'simple_auth', cert: 'cert', fincert: 'cert' };
export const AUTH_LABEL: Record<AuthKind, string> = { card: '보안카드', simple: '사업자 간편인증', cert: '공동인증서', fincert: '금융인증서' };

/** O-04 맡길 업무. now: 이 빌드에서 켠 일(08 §4). H-03·H-04는 민원증명 실행이 들어오면 켠다. 꺼진 일은 회색 칩(누르면 "지원되면 알림"). O-06 "지금 되는 일"도 이 표에서 만든다. */
export const ONB_TASKS: ReadonlyArray<{ id: string; label: string; now: boolean }> = [
  { id: 'H-01', label: '세금계산서 발급·메일 전송', now: true },
  { id: 'H-03', label: '사업자등록증명', now: false },
  { id: 'H-04', label: '납세증명서', now: false },
  { id: 'H-02', label: '발급한 세금계산서 조회·PDF 보관', now: false },
  { id: 'H-10', label: '사실증명', now: false },
  { id: 'G-01', label: '주민등록 등·초본(직접 발급 안내)', now: false },
];
const NOW_TASKS = new Set(ONB_TASKS.filter((t) => t.now).map((t) => t.id));

/** 건너뛴 항목(판의 "할 일", 08 §4). */
export type SkipItem = 'biz' | 'auth' | 'tasks' | 'counterparties';
export const SKIP_LABEL: Record<SkipItem, string> = { biz: '사업자 등록 마치기', auth: '발급 인증 고르기', tasks: '맡길 업무 고르기', counterparties: '거래처 등록하기' };

export interface OnbState {
  step: OnbStep;
  biz: BizFields | null;
  check: BizCheck | null;
  /** 등록증을 읽지 못했을 때 등 바로 앞 단계의 안내 한 줄. */
  notice: string | null;
  auth: AuthKind | null;
  certId: string | null;
  certs: NpkiCert[];
  /** "잘 모르겠어요"를 눌러 수단 설명을 펼쳤는가. */
  explain: boolean;
  /** ①: 금고 등록이 끝났다(값 없음). */
  registered: { at: string; noticeVersion: string; items: number } | null;
  consents: Partial<Record<ConsentKind, { version: string; choice: 'agreed' | 'declined'; at: string }>>;
  tasks: string[];
  skipped: SkipItem[];
  /** 지나간 답(대화의 "나" 말풍선). 비밀·사업자번호 외 개인정보는 넣지 않는다. */
  log: Array<{ step: OnbStep; text: string }>;
  /** ②를 다시 묻는 중이면 동의한 뒤 돌아갈 단계(모델 거절이 저장된 프로필, reaskModel). 아니면 null. */
  resumeStep: OnbStep | null;
  /** 끝낸 온보딩에서 건너뛴 사업자·인증을 다시 여는 중(reopen). 그 단계만 묻고 요약(프로필 저장) 뒤 바로 끝낸다. */
  redo: 'biz' | 'auth' | null;
  /** 다시 연 때의 대화 기록 길이(렌더러는 그 뒤 답만 새 자리에 그린다). */
  redoFrom: number | null;
  /** 이미 고른 발급 인증을 바꾸려고 다시 연 것이면 그 전 인증(O-03에서 [나중에]면 이것으로 되돌린다). 아니면 null. */
  redoPrev: { auth: AuthKind; certId: string | null } | null;
  /**
   * ①에서 금고가 돌려준 포털 아이디(비밀 아님, #42 계약). 이어 하기 저장에 넣어 요약에서 프로필에 쓴다(DB profiles.portal_login_id).
   * 렌더러로 가는 view와 대화 기록(log)에는 넣지 않는다.
   */
  portalLoginId: string | null;
}

/**
 * 이어 하기 저장에서 읽은 값(앱 폴더 JSON, 비밀 없음)을 OnbState로 받는다. 모양이 틀리면 null(처음부터).
 * 단계·동의·건너뛴 항목·업무·대화 기록만 확인하고, 모르는 키는 버린다.
 */
export function parseOnbState(x: unknown): OnbState | null {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;
  if (typeof o.step !== 'string' || !(ONB_STEPS as readonly string[]).includes(o.step)) return null;
  const strs = (v: unknown) => Array.isArray(v) && v.every((t) => typeof t === 'string');
  if (!strs(o.tasks) || !strs(o.skipped) || !(o.skipped as string[]).every((t) => Object.hasOwn(SKIP_LABEL, t))) return null;
  if (!Array.isArray(o.log) || !o.log.every((l) => typeof l === 'object' && l !== null && typeof (l as { text?: unknown }).text === 'string')) return null;
  if (typeof o.consents !== 'object' || o.consents === null || Array.isArray(o.consents)) return null;
  if (o.redo !== undefined && o.redo !== null && o.redo !== 'biz' && o.redo !== 'auth') return null;
  if (o.redoFrom !== undefined && o.redoFrom !== null && !(Number.isSafeInteger(o.redoFrom) && (o.redoFrom as number) >= 0)) return null;
  if (o.redoPrev !== undefined && o.redoPrev !== null) {
    const r = o.redoPrev as Record<string, unknown>;
    if (typeof r !== 'object' || Array.isArray(r) || typeof r.auth !== 'string' || !Object.hasOwn(AUTH_LABEL, r.auth) || !(r.certId === null || typeof r.certId === 'string')) return null;
  }
  if (o.resumeStep !== undefined && o.resumeStep !== null && !(typeof o.resumeStep === 'string' && (ONB_STEPS as readonly string[]).includes(o.resumeStep))) return null;
  const base = initialOnbState();
  const picked = Object.fromEntries(Object.keys(base).filter((k) => Object.hasOwn(o, k)).map((k) => [k, o[k]]));
  const s = { ...base, ...structuredClone(picked) } as OnbState;
  // 예전 판은 보안카드를 고르면 ① 위임 등록(금고에 넣고 앱이 대신 입력)으로 갔다. 그 약속은 이제 사실이 아니다.
  // ①에 멈춘 저장은 발급 인증을 다시 묻는다(O-03, 지금 문구). 고른 인증은 비운다.
  // 없어진 화면(B4)에 멈춘 저장은 요약에서 마친다
  const GONE: readonly OnbStep[] = ['telemetry', 'tasks', 'counterparties'];
  if (GONE.includes(s.step)) s.step = 'summary';
  if (s.resumeStep && GONE.includes(s.resumeStep)) s.resumeStep = 'summary';
  if (s.step === 'delegation' || s.resumeStep === 'delegation') {
    if (s.step === 'delegation') s.step = 'auth';
    else s.resumeStep = 'auth';
    Object.assign(s, { auth: null, certId: null, registered: null, notice: null, explain: false });
  }
  return s;
}

export const initialOnbState = (): OnbState => ({ step: 'terms', biz: null, check: null, notice: null, auth: null, certId: null, certs: [], explain: false, registered: null, consents: {}, tasks: [], skipped: [], log: [], resumeStep: null, redo: null, redoFrom: null, redoPrev: null, portalLoginId: null });

/** 끝난 온보딩이 저장할 프로필(DB profile.upsert에 넘긴다, 비밀 없음). */
export interface OnbProfile {
  kind: 'business';
  displayName: string;
  bizNo: string;
  repName: string | null;
  bizType: string | null;
  bizItem: string | null;
  address: string | null;
  email: string | null;
  signMethod: 'security_card' | 'simple_auth' | 'cert' | null;
  /** [홈택스 인증서]에서 고른 인증서(금고 열거 id). 저장소가 main 안의 표로 CN을 찾아 프로필 cert_name에 쓴다(H-01 2.3.0이 이 이름으로 고른다). */
  certId: string | null;
  /** ①에서 금고가 돌려준 포털 아이디(비밀 아님, DB profiles.portal_login_id, 금고 프로토콜 v1). */
  portalLoginId?: string;
}

export interface OnboardingPorts {
  /** O-02 등록증 읽기(docparse 샌드박스, ADR-014). 사용자가 고른 파일만. 고르지 않거나 못 읽으면 null. */
  recognizeBizCert(): Promise<BizFields | null>;
  /** 국세청 진위확인(사업자번호만, ADR-029). 실제 호출은 packages/net egress만. */
  checkBizNo(bizNo: string): Promise<BizCheck>;
  /** 이 PC의 NPKI 인증서 목록(메타만). */
  findCerts(): Promise<NpkiCert[]>;
  /** ①: 금고 등록 창(T-06)을 연다. 값은 금고 창 → 금고로만 간다. */
  registerSecrets(binds: StoreBindRequest[]): Promise<RegisterResult>;
  /** ② 처리자 표 등 설정 데이터. */
  consentConfig(): Promise<ConsentConfig>;
  recordConsent(rec: AppConsentRecord): Promise<void>;
  saveProfile(p: OnbProfile): Promise<void>;
  /** 이어 하기 저장(앱을 껐다 켜면 멈춘 질문부터, 08 §4). */
  save(s: OnbState): Promise<void>;
}

export interface OnbAnswer {
  step: OnbStep;
  choice: OnbChoice;
  fields?: Partial<BizFields>;
  certId?: string;
  tasks?: Record<string, boolean>;
}

/** 답을 처리한 결과. fill이 있으면 렌더러가 입력창에 채우기만 한다(보내지 않음). */
export interface OnbResult {
  state: OnbState;
  fill?: string;
}

const onlyDigits = (s: string) => s.replace(/[^0-9]/g, '');
const clip = (s: unknown, n: number) => (typeof s === 'string' ? s.trim().slice(0, n) : '');

/** 화면에 같이 보낼 것(지금 단계의 고지·처리자 표). */
export interface OnbView extends Omit<OnbState, 'portalLoginId'> {
  consent: ConsentNotice | null;
  config: ConsentConfig | null;
  tasksCatalog: typeof ONB_TASKS;
}
const CONSENT_STEP: Partial<Record<OnbStep, ConsentKind>> = { terms: 'terms', model: 'model', telemetry: 'telemetry', delegation: 'delegation' };

export class OnboardingFlow {
  private s: OnbState;
  private busy = false;
  private readonly ports: OnboardingPorts;
  private readonly now: () => Date;
  constructor(ports: OnboardingPorts, initial: OnbState | null = null, now: () => Date = () => new Date()) {
    this.ports = ports;
    this.now = now;
    this.s = initial ? reaskModel({ ...initialOnbState(), ...structuredClone(initial) }) : initialOnbState();
  }

  get state(): OnbState {
    return structuredClone(this.s);
  }
  get done(): boolean {
    return this.s.step === 'done';
  }
  /** ②에 동의했는가(모델 해석을 써도 되는가). 온보딩 전 기존 사용자는 부르는 쪽이 판단한다. */
  modelAllowed(): boolean {
    return this.s.consents.model?.choice === 'agreed';
  }

  /** 무엇이 빠졌나(세금계산서·증명서를 하려면 사업자 등록과 발급 인증이 필요하다). 끝낸 온보딩에서만 다시 열 수 있다. */
  missing(): Array<'biz' | 'auth'> {
    const s = this.s;
    return [...(!s.biz || s.skipped.includes('biz') ? (['biz'] as const) : []), ...(!s.auth || s.skipped.includes('auth') ? (['auth'] as const) : [])];
  }

  /**
   * 끝낸 온보딩에서 건너뛴 사업자(O-02)·인증(O-03)을 다시 연다(0.1.5 실사용: 사업자를 건너뛰면 발급 카드가 profile_missing으로 멈췄다).
   * 그 단계만 묻고, 동의(②③)는 다시 묻지 않으며, 요약에서 프로필을 저장한 뒤 첫 작업 제안 없이 끝낸다. 빠진 것이 아니면 nothing_to_reopen.
   * 발급 인증은 이미 골랐어도 바꾸려고 다시 열 수 있다(내 사업장 [발급 인증 바꾸기]): O-03에서 [나중에]면 그 전 인증 그대로 끝낸다.
   */
  async reopen(item: 'biz' | 'auth'): Promise<OnbResult> {
    if (this.s.step !== 'done') throw new Error('onboarding_not_done');
    const change = item === 'auth' && !this.missing().includes('auth');
    if (!change && !this.missing().includes(item)) throw new Error('nothing_to_reopen');
    if (this.busy) throw new Error('busy');
    this.busy = true;
    const before = structuredClone(this.s);
    try {
      this.s.redo = item;
      this.s.redoFrom = this.s.log.length;
      this.s.redoPrev = change && this.s.auth ? { auth: this.s.auth, certId: this.s.certId } : null;
      this.s.notice = null;
      if (item === 'biz') this.s.step = 'welcome';
      else await this.toAuth();
      await this.ports.save(this.state);
      return { state: this.state };
    } catch (e) {
      this.s = before;
      throw e;
    } finally {
      this.busy = false;
    }
  }

  /**
   * 내 사업장(D-03)에서 고친 사업자 칸을 온보딩 상태에도 맞춘다(profile-edit.ts). 요약이 프로필을 저장할 때(인증을 다시 고른 뒤 등)
   * 예전 칸으로 덮어쓰지 않게 하고, 건너뛴 사업자 할 일을 지운다. 끝낸 온보딩에서만(진행 중이면 onboarding_open).
   */
  async syncBiz(biz: BizFields): Promise<void> {
    if (this.s.step !== 'done') throw new Error('onboarding_open');
    if (!isValidBizNo(biz.bizNo)) throw new Error('bad_biz_no');
    const before = structuredClone(this.s);
    try {
      if (this.s.biz?.bizNo !== biz.bizNo) this.s.check = null;
      this.s.biz = { ...EMPTY_BIZ, ...biz };
      this.unskip('biz');
      await this.ports.save(this.state);
    } catch (e) {
      this.s = before;
      throw e;
    }
  }

  async view(): Promise<OnbView> {
    const kind = CONSENT_STEP[this.s.step] ?? null;
    const st: Partial<OnbState> = this.state;
    delete st.portalLoginId; // 포털 아이디는 렌더러로 보내지 않는다
    return { ...(st as Omit<OnbState, 'portalLoginId'>), consent: kind ? CONSENT_NOTICES[kind] : null, config: this.s.step === 'model' || this.s.step === 'terms' ? await this.ports.consentConfig() : null, tasksCatalog: ONB_TASKS };
  }

  /** 답 하나를 처리한다. 지금 단계가 아닌 답은 stale_step(두 번 누름·지난 카드), 표에 없는 답은 bad_choice. 한 번에 하나만. */
  async answer(a: OnbAnswer): Promise<OnbResult> {
    if (this.s.step === 'done') throw new Error('onboarding_done');
    if (a.step !== this.s.step) throw new Error('stale_step');
    const allowed = ONB_CHOICES[this.s.step] as readonly string[];
    if (!allowed.includes(a.choice)) throw new Error('bad_choice');
    if (this.busy) throw new Error('busy');
    this.busy = true;
    const before = structuredClone(this.s);
    try {
      const fill = await this.apply(a);
      await this.ports.save(this.state);
      return { state: this.state, fill };
    } catch (e) {
      this.s = before; // 실패한 답은 상태를 바꾸지 않는다
      throw e;
    } finally {
      this.busy = false;
    }
  }

  private at = () => this.now().toISOString();
  private say(text: string) {
    this.s.log.push({ step: this.s.step, text });
  }
  private skip(item: SkipItem) {
    if (!this.s.skipped.includes(item)) this.s.skipped.push(item);
  }
  private unskip(item: SkipItem) {
    this.s.skipped = this.s.skipped.filter((x) => x !== item);
  }
  private async consent(kind: Exclude<ConsentKind, 'delegation'>, choice: 'agreed' | 'declined', processorsVersion?: string) {
    const n = CONSENT_NOTICES[kind];
    const at = this.at();
    await this.ports.recordConsent({ v: 1, kind, noticeKey: n.key, noticeVersion: n.version, ...(processorsVersion ? { processorsVersion } : {}), choice, at, via: 'onboarding' });
    this.s.consents[kind] = { version: n.version, choice, at };
  }
  private async toAuth() {
    this.s.step = 'auth';
    this.s.certs = await this.ports.findCerts().catch(() => []);
  }
  /** 사업자 단계를 마쳤다(또는 건너뛰었다). 다시 여는 중이면 인증이 이미 있으면 요약으로, 없으면 인증을 묻는다. 건너뛰면 끝낸다. */
  private async afterBiz(skipped: boolean) {
    const s = this.s;
    if (!s.redo) return this.toAuth();
    if (skipped) return this.endRedo();
    if (s.auth && !s.skipped.includes('auth')) s.step = 'summary';
    else await this.toAuth();
  }
  /**
   * 인증을 골랐다(또는 건너뛰었다). 처음이면 바로 마친다(프로필 저장 → 첫 발급 제안). 모델 동의가 없는 옛 저장이면 ②를 먼저 묻는다.
   * 다시 여는 중이면 프로필을 저장하고 끝낸다(건너뛰었으면 그대로 끝낸다).
   */
  private async afterAuth(skipped = false) {
    const s = this.s;
    if (s.redo && skipped && s.redo === 'auth') return this.endRedo();
    if (!s.redo && s.consents.model?.choice !== 'agreed') {
      s.step = 'model';
      return;
    }
    await this.finish();
  }
  /** 마치기(요약 확인 화면 없이): 사업자 프로필을 저장하고 첫 발급 제안으로(다시 연 것이면 끝). 맡길 업무는 지금 되는 일(세금계산서)이다. */
  private async finish() {
    const s = this.s;
    if (!s.tasks.length && !s.skipped.includes('tasks')) s.tasks = ONB_TASKS.filter((t) => t.now).map((t) => t.id);
    await this.saveProfile();
    if (s.redo) this.endRedo();
    else s.step = 'first';
  }
  private async saveProfile() {
    const s = this.s;
    if (!s.biz || s.skipped.includes('biz')) return;
    await this.ports.saveProfile({
      kind: 'business',
      displayName: s.biz.name || s.biz.bizNo,
      bizNo: s.biz.bizNo,
      repName: s.biz.rep || null,
      bizType: s.biz.bizType || null,
      bizItem: s.biz.bizItem || null,
      address: s.biz.address || null,
      email: s.biz.email || null,
      signMethod: s.auth ? AUTH_SIGN_METHOD[s.auth] : null,
      certId: s.auth === 'cert' ? s.certId : null,
      ...(s.portalLoginId ? { portalLoginId: s.portalLoginId } : {}),
    });
  }
  private endRedo() {
    this.s.step = 'done';
    this.s.redo = null;
    this.s.redoPrev = null;
  }

  private async apply(a: OnbAnswer): Promise<string | undefined> {
    const s = this.s;
    s.notice = null;
    switch (s.step) {
      case 'terms': {
        // 약관과 모델 처리 고지는 한 화면 한 클릭이다(B4). 레코드는 각 고지의 키·판으로 따로 남긴다.
        await this.consent('terms', 'agreed');
        const cfg = await this.ports.consentConfig();
        await this.consent('model', 'agreed', cfg.processorsVersion);
        this.say('동의하고 시작할게요');
        s.step = 'welcome';
        return;
      }
      case 'welcome':
        if (a.choice === 'later') {
          this.say('나중에 할게요');
          this.skip('biz');
          await this.afterBiz(true);
          return;
        }
        if (a.choice === 'number') {
          this.say('사업자번호로 입력할게요');
          s.step = 'biz-number';
          return;
        }
        this.say('사업자등록증 올리기');
        {
          const got = await this.ports.recognizeBizCert();
          if (!got) {
            s.step = 'biz-number';
            s.notice = '등록증을 읽지 못했어요. 사업자번호로 입력해 주세요.';
            return;
          }
          await this.setBiz(got);
        }
        return;
      case 'biz-number':
        if (a.choice === 'back') {
          s.step = 'welcome';
          return;
        }
        {
          const no = onlyDigits(clip(a.fields?.bizNo, BIZ_FIELD_MAX.bizNo));
          if (!isValidBizNo(no)) throw new Error('bad_biz_no');
          // 상호도 같은 화면에서 받는다(B4: 번호만 받으면 다음 화면에서 [고칠게요]로 상호를 다시 채워야 했다)
          const name = clip(a.fields?.name, BIZ_FIELD_MAX.name);
          this.say(`${name ? `${name} · ` : ''}${no.slice(0, 3)}-${no.slice(3, 5)}-${no.slice(5)}`);
          await this.setBiz({ ...EMPTY_BIZ, name, bizNo: no });
        }
        return;
      case 'biz-confirm':
        if (a.choice === 'later') {
          this.say('나중에 할게요');
          this.skip('biz');
          await this.afterBiz(true);
          return;
        }
        if (a.choice === 'edit') {
          const cur = s.biz ?? { ...EMPTY_BIZ };
          const next = { ...cur };
          for (const k of BIZ_FIELD_KEYS) if (a.fields && typeof a.fields[k] === 'string') next[k] = clip(a.fields[k], BIZ_FIELD_MAX[k]);
          next.bizNo = onlyDigits(next.bizNo);
          if (!isValidBizNo(next.bizNo)) throw new Error('bad_biz_no');
          if (!emailOk(next.email)) throw new Error('bad_email');
          // 번호가 바뀌었거나 지난 조회가 실패했으면 다시 조회한다.
          if (next.bizNo !== cur.bizNo || s.check?.status === 'unknown') await this.setBiz(next);
          else s.biz = next;
          return;
        }
        if (a.choice === 'recheck') {
          // 진위확인을 하지 못했을 때만(08 §4 O-02 "잠시 뒤 다시"). 같은 번호로 다시 조회한다.
          if (!s.biz || s.check?.status !== 'unknown') throw new Error('bad_choice');
          if (!isValidBizNo(s.biz.bizNo)) throw new Error('bad_biz_no');
          await this.setBiz(s.biz);
          return;
        }
        // 진위확인을 하지 못한 번호(unknown)는 사용자가 [맞습니다]를 눌러야 확정한다(팀장 결정 2026-11-10, 08 §4 O-02).
        // 확인됐다고 보이지 않는다: 상태는 unknown 그대로 남는다. 휴·폐업으로 확인된 번호는 막는다.
        if (a.choice === 'confirm_unverified') {
          if (!s.biz || !isValidBizNo(s.biz.bizNo)) throw new Error('bad_biz_no');
          if (s.check?.status !== 'unknown') throw new Error('bad_choice');
          if (!s.biz.name.trim()) throw new Error('name_required');
          this.say('맞습니다');
          this.unskip('biz');
          await this.afterBiz(false);
          return;
        }
        // 휴·폐업이면 등록을 멈춘다(08 §4 O-02). 확인하지 못한 번호는 위의 [맞습니다]로만 확정한다.
        // 등록증(OCR)에서 읽은 번호도 DB와 같은 체크섬을 지나야 확정한다(요약 저장에서 처음 걸리지 않게).
        if (s.biz && !isValidBizNo(s.biz.bizNo)) throw new Error('bad_biz_no');
        if (!s.biz || s.check?.status !== 'active') throw new Error('biz_inactive');
        // 상호는 필수다(0.1.6 실사용: 상호 없이 확정되어 제목줄에 번호가 이름처럼 보였다). [고칠게요]에서 채운다.
        if (!s.biz.name.trim()) throw new Error('name_required');
        this.say('맞아요');
        this.unskip('biz');
        await this.afterBiz(false);
        return;
      case 'auth':
        if (a.choice === 'unsure') {
          s.explain = true;
          this.say('잘 모르겠어요');
          return;
        }
        if (a.choice === 'later') {
          // 바꾸려고 연 것이면 그 전 인증 그대로 둔다(건너뜀으로 바꾸지 않는다)
          if (s.redo === 'auth' && s.redoPrev) {
            this.say('지금 인증 그대로 둘게요');
            s.auth = s.redoPrev.auth;
            s.certId = s.redoPrev.certId;
            this.endRedo();
            return;
          }
          this.say('나중에 할게요');
          this.skip('auth');
          await this.afterAuth(true);
          return;
        }
        if (a.choice === 'cert') {
          const c = s.certs.find((x) => x.id === a.certId);
          if (!c || c.usable === false) throw new Error('bad_cert');
          s.certId = c.id;
        } else s.certId = null;
        {
          const kind = a.choice as AuthKind;
          s.auth = kind;
          this.unskip('auth');
          this.say(kind === 'cert' ? `${AUTH_LABEL[kind]} · ${s.certs.find((x) => x.id === s.certId)?.owner ?? ''}` : AUTH_LABEL[kind]);
          await this.afterAuth();
        }
        return;
      case 'delegation': {
        // 예전 이어 하기 저장이 ①에 멈춰 있을 때만 온다(이제 보안카드도 바로 ②로 간다). 그 화면과 [다른 인증으로 바꾸기]가 돌게 남겨 둔다.
        if (a.choice === 'switch') {
          this.say('다른 인증으로 바꿀게요');
          s.auth = null;
          await this.toAuth();
          return;
        }
        const version = CONSENT_NOTICES.delegation.version;
        const r = await this.ports.registerSecrets([
          { mode: 'store', kind: 'portal_password', scope: 'business', notice: { version } },
          { mode: 'store', kind: 'security_card', scope: 'business', notice: { version } },
        ]);
        if (!r.ok) {
          s.notice =
            r.reason === 'cancelled'
              ? '금고 창을 닫았어요. 다시 열거나 다른 인증으로 바꿀 수 있어요.'
              : r.reason === 'unavailable'
                ? '이 빌드에서는 아직 보안카드를 등록할 수 없어요. 다른 인증으로 바꿔 주세요.'
                : '금고에 등록하지 못했어요. 다시 해 주세요.';
          // 상태는 delegation 그대로(답은 기록하지 않는다). 실패를 오류로 던지지 않아 안내가 남는다.
          return;
        }
        const at = r.consents[0]?.at ?? this.at();
        s.registered = { at, noticeVersion: version, items: r.consents.reduce((n, c) => n + c.items, 0) };
        s.consents.delegation = { version, choice: 'agreed', at };
        if (r.portalLoginId) s.portalLoginId = r.portalLoginId;
        this.say('동의하고 금고에 등록했어요');
        await this.afterAuth();
        return;
      }
      case 'model': {
        const cfg = await this.ports.consentConfig();
        await this.consent('model', 'agreed', cfg.processorsVersion);
        this.say('동의해요');
        if (s.resumeStep) {
          s.step = s.resumeStep;
          s.resumeStep = null;
        } else await this.finish();
        return;
      }
      case 'telemetry':
        await this.consent('telemetry', a.choice === 'on' ? 'agreed' : 'declined');
        this.say(a.choice === 'on' ? '켤게요' : '끄고 계속할게요');
        s.step = 'tasks';
        return;
      case 'tasks': {
        if (a.choice === 'later') {
          this.say('나중에 할게요');
          this.skip('tasks');
          s.step = 'summary';
          return;
        }
        const picked = Object.entries(a.tasks ?? {})
          .filter(([id, on]) => on && NOW_TASKS.has(id))
          .map(([id]) => id);
        if (!picked.length) throw new Error('no_tasks');
        s.tasks = ONB_TASKS.filter((t) => picked.includes(t.id)).map((t) => t.id);
        this.unskip('tasks');
        this.say(ONB_TASKS.filter((t) => s.tasks.includes(t.id)).map((t) => t.label).join(', '));
        s.step = s.tasks.includes('H-01') ? 'counterparties' : 'summary';
        return;
      }
      case 'counterparties':
        if (a.choice === 'later') {
          this.say('나중에 할게요');
          this.skip('counterparties');
        } else {
          this.say('다 했어요');
          this.unskip('counterparties');
        }
        s.step = 'summary';
        return;
      case 'summary':
        // 옛 이어 하기 저장만 여기 온다(새 흐름은 요약 확인 없이 finish)
        await this.saveProfile();
        this.say('확인했어요');
        // 다시 연 것이면 첫 작업 제안 없이 끝낸다(이미 쓰던 사용자)
        if (s.redo) this.endRedo();
        else s.step = 'first';
        return;
      case 'first':
        this.say(a.choice === 'try' ? '지금 해 볼게요' : '나중에 할게요');
        s.step = 'done';
        // [지금 해 보기]는 지금 되는 일(세금계산서)로 채운다(F-13: 민원증명 실행이 들어오기 전에는 "증명서 발급은 곧…"이라 첫 시도가 안 됐다)
        return a.choice === 'try' ? TRY_FIRST_FILL : undefined;
    }
    return;
  }


  private async setBiz(f: BizFields) {
    const s = this.s;
    s.biz = { ...EMPTY_BIZ, ...f, bizNo: onlyDigits(f.bizNo) };
    // 등록증에서 읽은 이메일이 모양에 맞지 않으면 비워 둔다(사용자가 [고칠게요]에서 넣는다).
    if (!emailOk(s.biz.email)) s.biz.email = '';
    // 체크섬이 틀린 번호는 조회하지 않는다. [고칠게요]로 번호를 고쳐야 다음으로 간다.
    if (!isValidBizNo(s.biz.bizNo)) {
      s.check = null;
      s.notice = '읽은 사업자번호가 맞지 않아요. [고칠게요]에서 번호를 확인해 주세요.';
      s.step = 'biz-confirm';
      return;
    }
    s.check = await this.ports.checkBizNo(s.biz.bizNo).catch((): BizCheck => ({ status: 'unknown', label: '조회하지 못했어요', taxType: null, source: '국세청 조회' }));
    if (!s.biz.name) s.notice = BIZ_NAME_NOTICE;
    s.step = 'biz-confirm';
  }
}

/**
 * ②를 지났는데 모델 동의가 없는(거절이 저장된) 상태면 ②로 돌려 다시 묻는다(사용자 결정 2026-11-10). 동의하면 있던 단계(resumeStep)로 돌아간다.
 * ②를 아직 지나지 않았으면 그대로 둔다(차례가 오면 묻는다).
 */
export function reaskModel(s: OnbState): OnbState {
  const at = ONB_STEPS.indexOf(s.step);
  if (at <= ONB_STEPS.indexOf('model') || s.consents.model?.choice === 'agreed') return s;
  return { ...s, resumeStep: s.step, step: 'model', notice: null };
}

/** 건너뛴 항목 → 판의 "할 일"(08 §4). 사업자·인증은 내 사업장(D-03), 거래처는 거래처(D-02), 업무는 대화로 고친다. */
export function onboardingTodos(s: OnbState | null): Array<{ id: SkipItem; label: string; view: 'biz' | 'cps' }> {
  if (!s || s.step !== 'done') return [];
  return s.skipped.map((id) => ({ id, label: SKIP_LABEL[id], view: id === 'counterparties' ? 'cps' : 'biz' }));
}

/** 인증서가 30일 안에 만료되면 경고(08 §4 O-03). today: YYYY-MM-DD. */
export function certExpiringSoon(c: NpkiCert, today: string): boolean {
  const d = (x: string) => Date.UTC(Number(x.slice(0, 4)), Number(x.slice(5, 7)) - 1, Number(x.slice(8, 10)));
  return (d(c.expiresOn) - d(today)) / 86_400_000 <= CERT_EXPIRY_WARN_DAYS;
}
