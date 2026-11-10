// 온보딩(08 §4 O-01~O-06, D14 M4-2)과 동의 화면 4종(D15 F-06, 팀장 승인 2026-11-05). Electron 없이 도는 상태 기계다.
// - 온보딩은 메인 대화의 첫 부분이다. 한 번에 하나씩 묻고, 사용자는 카드의 칩·버튼을 누른다(08 §4 공통 규칙).
// - 동의는 화면마다 명시 클릭이다. 묶음 동의 버튼은 없다. 문구는 전부 "F-06 초안 전" 자리표시이고 키에 판을 붙인다(F-06이 오면 문구만 바꾼다).
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
  first: ['try', 'invoice', 'later'],
} as const satisfies Record<Exclude<OnbStep, 'done'>, readonly string[]>;
export type OnbChoice = (typeof ONB_CHOICES)[keyof typeof ONB_CHOICES][number];
export const ONB_ALL_CHOICES = [...new Set(Object.values(ONB_CHOICES).flat())] as OnbChoice[];

// ---- 동의 화면 4종 ----

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
    version: V,
    title: '이용약관과 개인정보 처리방침',
    lines: ['계정 하나에 사업자 프로필 1곳과 개인 프로필 1곳까지 쓸 수 있어요.', '다른 사람의 사업자를 대신 맡아 쓰는 것은 허용하지 않아요.', '맡기는 곳과 국외로 가는 정보는 처리방침 표에 모두 적어 두었어요.', '동의해야 앱을 쓸 수 있어요.'],
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
    lines: ['오류 종류와 단계별 걸린 시간만 보내요. 서류·금액·거래처·사업자번호는 보내지 않아요.', '기본은 꺼져 있어요. 설정에서 언제든 바꿀 수 있어요.'],
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

/** O-04 맡길 업무. now: 이 빌드에서 켠 일(PoC 빌드는 H-01·H-03·H-04, 08 §4). soon은 회색 칩(누르면 "지원되면 알림"). */
export const ONB_TASKS: ReadonlyArray<{ id: string; label: string; now: boolean }> = [
  { id: 'H-01', label: '세금계산서 발급·메일 전송', now: true },
  { id: 'H-03', label: '사업자등록증명', now: true },
  { id: 'H-04', label: '납세증명서', now: true },
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
  if (o.resumeStep !== undefined && o.resumeStep !== null && !(typeof o.resumeStep === 'string' && (ONB_STEPS as readonly string[]).includes(o.resumeStep))) return null;
  const base = initialOnbState();
  const picked = Object.fromEntries(Object.keys(base).filter((k) => Object.hasOwn(o, k)).map((k) => [k, o[k]]));
  return { ...base, ...structuredClone(picked) } as OnbState;
}

export const initialOnbState = (): OnbState => ({ step: 'terms', biz: null, check: null, notice: null, auth: null, certId: null, certs: [], explain: false, registered: null, consents: {}, tasks: [], skipped: [], log: [], resumeStep: null, portalLoginId: null });

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

  async view(): Promise<OnbView> {
    const kind = CONSENT_STEP[this.s.step] ?? null;
    const st: Partial<OnbState> = this.state;
    delete st.portalLoginId; // 포털 아이디는 렌더러로 보내지 않는다
    return { ...(st as Omit<OnbState, 'portalLoginId'>), consent: kind ? CONSENT_NOTICES[kind] : null, config: this.s.step === 'model' ? await this.ports.consentConfig() : null, tasksCatalog: ONB_TASKS };
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

  private async apply(a: OnbAnswer): Promise<string | undefined> {
    const s = this.s;
    s.notice = null;
    switch (s.step) {
      case 'terms':
        await this.consent('terms', 'agreed');
        this.say('동의했어요');
        s.step = 'welcome';
        return;
      case 'welcome':
        if (a.choice === 'later') {
          this.say('나중에 할게요');
          this.skip('biz');
          await this.toAuth();
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
          this.say(`${no.slice(0, 3)}-${no.slice(3, 5)}-${no.slice(5)}`);
          await this.setBiz({ ...EMPTY_BIZ, bizNo: no });
        }
        return;
      case 'biz-confirm':
        if (a.choice === 'later') {
          this.say('나중에 할게요');
          this.skip('biz');
          await this.toAuth();
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
          this.say('맞습니다');
          this.unskip('biz');
          await this.toAuth();
          return;
        }
        // 휴·폐업이면 등록을 멈춘다(08 §4 O-02). 확인하지 못한 번호는 위의 [맞습니다]로만 확정한다.
        // 등록증(OCR)에서 읽은 번호도 DB와 같은 체크섬을 지나야 확정한다(요약 저장에서 처음 걸리지 않게).
        if (s.biz && !isValidBizNo(s.biz.bizNo)) throw new Error('bad_biz_no');
        if (!s.biz || s.check?.status !== 'active') throw new Error('biz_inactive');
        this.say('맞아요');
        this.unskip('biz');
        await this.toAuth();
        return;
      case 'auth':
        if (a.choice === 'unsure') {
          s.explain = true;
          this.say('잘 모르겠어요');
          return;
        }
        if (a.choice === 'later') {
          this.say('나중에 할게요');
          this.skip('auth');
          s.step = 'model';
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
          this.say(AUTH_LABEL[kind]);
          s.step = kind === 'card' ? 'delegation' : 'model';
        }
        return;
      case 'delegation': {
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
        s.step = 'model';
        return;
      }
      case 'model': {
        const cfg = await this.ports.consentConfig();
        await this.consent('model', 'agreed', cfg.processorsVersion);
        this.say('동의해요');
        s.step = s.resumeStep ?? 'telemetry';
        s.resumeStep = null;
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
        if (s.biz && !s.skipped.includes('biz')) {
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
            ...(s.portalLoginId ? { portalLoginId: s.portalLoginId } : {}),
          });
        }
        this.say('확인했어요');
        s.step = 'first';
        return;
      case 'first':
        this.say({ try: '지금 해 볼게요', invoice: '세금계산서 1건 발급', later: '나중에 할게요' }[a.choice as 'try' | 'invoice' | 'later']);
        s.step = 'done';
        return a.choice === 'try' ? '사업자등록증명 떼 줘' : a.choice === 'invoice' ? '세금계산서 ' : undefined;
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
