
import { isValidBizNo } from '@sax/db';
import { certDocByCode } from './cert-docs.ts';

export const ONB_STEPS = ['terms', 'welcome', 'biz-number', 'biz-confirm', 'auth', 'model', 'telemetry', 'tasks', 'counterparties', 'summary', 'first', 'done'] as const;
export type OnbStep = (typeof ONB_STEPS)[number];

export const ONB_CHOICES = {
  terms: ['agree'],
  welcome: ['upload', 'number', 'later'],
  'biz-number': ['submit', 'back'],
  'biz-confirm': ['confirm', 'confirm_unverified', 'edit', 'recheck', 'later'],
  auth: ['simple', 'cert', 'fincert', 'unsure', 'later', 'rescan'],
  model: ['agree'],
  telemetry: ['on', 'off'],
  tasks: ['submit', 'later'],
  counterparties: ['done', 'later'],
  summary: ['ok'],
  first: ['try', 'later'],
} as const satisfies Record<Exclude<OnbStep, 'done'>, readonly string[]>;
type OnbChoice = (typeof ONB_CHOICES)[keyof typeof ONB_CHOICES][number];
export const ONB_ALL_CHOICES = [...new Set(Object.values(ONB_CHOICES).flat())] as OnbChoice[];

export const TRY_FIRST_FILL = '세금계산서 발급해 줘';

export const CONSENT_KINDS = ['terms', 'model', 'telemetry'] as const;
export type ConsentKind = (typeof CONSENT_KINDS)[number];

interface ConsentNotice {
  kind: ConsentKind;
  key: `consent.${ConsentKind}`;
  version: string;
  title: string;
  lines: string[];
  draft: string | null;
  links?: readonly { doc: 'terms' | 'privacy'; label: string }[];
}

const DRAFT = 'F-06 초안 전 문구';
const V = 'f06-pre.1';
export const CONSENT_NOTICES: Readonly<Record<ConsentKind, ConsentNotice>> = {
  terms: {
    kind: 'terms',
    key: 'consent.terms',
    version: 'terms-2026-11-30',
    title: '이용약관/개인정보 처리방침/AI 모델 이용',
    lines: [
      '앱은 내가 확인하고 승인한 세금계산서만 내 Mac에서 내 인증으로 발급해요. 세무 신고/기장/상담은 하지 않아요.',
      '계정 하나에 사업자 프로필 1곳과 개인 프로필 1곳까지 쓸 수 있어요. 다른 사람의 사업자를 대신 맡아 쓰는 것은 허용하지 않아요.',
      '홈택스 비밀번호/보안카드/사업자와 거래처 정보는 이 Mac에만 저장하고 서버로 보내지 않아요. 서버에는 이메일/기기/결제 정보만 있어요.',
      '대화는 AI 모델로 해석해요. 이름/번호를 찾아 가린 문장만 아래 곳(국외)으로 보내고, 비밀번호/보안카드 번호는 보내지 않아요. 가리기는 탐지 방식이라 일부가 남을 수 있어요.',
      '사용 기록은 보내지 않아요(켜려면 다음 화면에서).',
    ],
    draft: DRAFT,
    links: [
      { doc: 'terms', label: '이용약관 전문' },
      { doc: 'privacy', label: '개인정보 처리방침 전문' },
    ],
  },
  model: {
    kind: 'model',
    key: 'consent.model',
    version: 'f06-pre.2',
    title: '문장 해석에 쓰는 모델(국외 이전)',
    lines: ['입력한 문장을 해석할 때 이름/번호를 가린 문장만 모델에 보내요. 비밀번호/보안카드 번호는 보내지 않아요.', '아래 곳에서 처리하고, 보관 기간은 표에 적힌 대로예요.', '대화는 모델로 해석해요. 동의해야 앱을 쓸 수 있어요.'],
    draft: DRAFT,
  },
  telemetry: {
    kind: 'telemetry',
    key: 'consent.telemetry',
    version: V,
    title: '사용 기록 보내기(선택)',
    lines: ['오류 종류와 단계별 걸린 시간만 보내요. 서류/금액/거래처/사업자번호는 보내지 않아요.', '기본은 꺼져 있어요.'],
    draft: DRAFT,
  },
};

interface ModelProcessor {
  name: string;
  role: string;
  country: string;
  retention: string;
}
export interface ConsentConfig {
  processorsVersion: string;
  processors: ModelProcessor[];
}

export const CONSENT_CONFIG: ConsentConfig = {
  processorsVersion: '2026-11-16',
  processors: [
    { name: 'OpenAI', role: '요청 해석', country: '미국/EU/UAE', retention: '최대 30일(무보관 승인 전)' },
    { name: 'OpenRouter', role: '모델 중계', country: '미국', retention: '보관하지 않음' },
    { name: '모델 공급사(OpenRouter 연결)', role: '응답/화면 판정', country: '미국 등', retention: '공급사 정책(무보관 고정 호출은 보관 안 함)' },
  ],
};

export interface AppConsentRecord {
  v: 1;
  kind: ConsentKind;
  noticeKey: string;
  noticeVersion: string;
  processorsVersion?: string;
  choice: 'agreed' | 'declined';
  at: string;
  via: 'onboarding';
}

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
export const BIZ_FIELD_MAX: Record<(typeof BIZ_FIELD_KEYS)[number], number> = { name: 100, bizNo: 20, rep: 100, bizType: 100, bizItem: 100, address: 200, email: 320 };
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const emailOk = (s: string) => s === '' || EMAIL_SHAPE.test(s);
export const BIZ_NAME_NOTICE = '상호가 비어 있어요. [고칠게요]에서 상호를 넣어 주세요.';
const EMPTY_BIZ: BizFields = { name: '', bizNo: '', rep: '', bizType: '', bizItem: '', address: '', email: '' };

export interface BizCheck {
  status: 'active' | 'suspended' | 'closed' | 'unknown';
  label: string;
  taxType: string | null;
  source: '국세청 조회';
}

export interface NpkiCert {
  id: string;
  owner: string;
  usage: string;
  expiresOn: string;
  usable?: boolean;
  why?: 'no_key' | 'expired';
  kind?: 'corp' | 'personal';
}
const CERT_EXPIRY_WARN_DAYS = 30;

export type AuthKind = 'simple' | 'cert' | 'fincert';
export const AUTH_SIGN_METHOD: Record<AuthKind, 'simple_auth' | 'cert'> = { simple: 'simple_auth', cert: 'cert', fincert: 'cert' };
const defaultCertId = (certs: ReadonlyArray<{ id: string; usable?: boolean }>): string | null => certs.find((c) => c.usable !== false)?.id ?? null;
export const AUTH_LABEL: Record<AuthKind, string> = { simple: '사업자 간편인증', cert: '공동인증서', fincert: '금융인증서' };
const RETIRED_STEP = 'delegation';
const RETIRED_AUTH = 'card';

export const ONB_TASKS: ReadonlyArray<{ id: string; label: string; now: boolean }> = [
  { id: 'H-01', label: '세금계산서 발급/메일 전송', now: true },
  { id: 'H-03', label: certDocByCode('H-03')!.label, now: true },
  { id: 'H-04', label: certDocByCode('H-04')!.label, now: true },
  { id: 'H-02', label: '발급한 세금계산서 조회/PDF 보관', now: false },
  { id: 'H-10', label: '사실증명', now: false },
  { id: 'G-01', label: '주민등록 등/초본(직접 발급 안내)', now: false },
].filter((t) => !certDocByCode(t.id)?.hidden);
const NOW_TASKS = new Set(ONB_TASKS.filter((t) => t.now).map((t) => t.id));

export type SkipItem = 'biz' | 'auth' | 'tasks' | 'counterparties';
const SKIP_LABEL: Record<SkipItem, string> = { biz: '사업자 등록 마치기', auth: '발급 인증 고르기', tasks: '맡길 업무 고르기', counterparties: '거래처 등록하기' };

export interface OnbState {
  step: OnbStep;
  biz: BizFields | null;
  check: BizCheck | null;
  notice: string | null;
  auth: AuthKind | null;
  certId: string | null;
  certs: NpkiCert[];
  explain: boolean;
  consents: Partial<Record<ConsentKind, { version: string; choice: 'agreed' | 'declined'; at: string }>>;
  tasks: string[];
  skipped: SkipItem[];
  log: Array<{ step: OnbStep; text: string }>;
  resumeStep: OnbStep | null;
  redo: 'biz' | 'auth' | null;
  redoFrom: number | null;
  redoPrev: { auth: AuthKind; certId: string | null } | null;
}

export function parseOnbState(x: unknown): OnbState | null {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return null;
  const o = { ...(x as Record<string, unknown>) };
  const retired = o.step === RETIRED_STEP || o.resumeStep === RETIRED_STEP || o.auth === RETIRED_AUTH;
  if (o.step === RETIRED_STEP) o.step = 'auth';
  if (o.resumeStep === RETIRED_STEP) o.resumeStep = 'auth';
  if ((o.redoPrev as { auth?: unknown } | null | undefined)?.auth === RETIRED_AUTH) o.redoPrev = null;
  if (Array.isArray(o.log)) o.log = o.log.map((l) => ((l as { step?: unknown } | null)?.step === RETIRED_STEP ? { ...(l as object), step: 'auth' } : l));
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
  const GONE: readonly OnbStep[] = ['telemetry', 'tasks', 'counterparties'];
  if (GONE.includes(s.step)) s.step = 'summary';
  if (s.resumeStep && GONE.includes(s.resumeStep)) s.resumeStep = 'summary';
  if (retired) {
    Object.assign(s, { auth: null, certId: null, notice: null, explain: false });
    delete (s.consents as Record<string, unknown>)[RETIRED_STEP];
  }
  return s;
}

export const initialOnbState = (): OnbState => ({ step: 'terms', biz: null, check: null, notice: null, auth: null, certId: null, certs: [], explain: false, consents: {}, tasks: [], skipped: [], log: [], resumeStep: null, redo: null, redoFrom: null, redoPrev: null });

export interface OnbProfile {
  kind: 'business';
  displayName: string;
  bizNo: string;
  repName: string | null;
  bizType: string | null;
  bizItem: string | null;
  address: string | null;
  email: string | null;
  signMethod: 'simple_auth' | 'cert' | null;
  certId: string | null;
}

export interface OnboardingPorts {
  recognizeBizCert(): Promise<BizFields | null>;
  checkBizNo(bizNo: string): Promise<BizCheck>;
  findCerts(): Promise<NpkiCert[]>;
  consentConfig(): Promise<ConsentConfig>;
  recordConsent(rec: AppConsentRecord): Promise<void>;
  saveProfile(p: OnbProfile): Promise<void>;
  save(s: OnbState): Promise<void>;
}

export interface OnbAnswer {
  step: OnbStep;
  choice: OnbChoice;
  fields?: Partial<BizFields>;
  certId?: string;
  tasks?: Record<string, boolean>;
}

interface OnbResult {
  state: OnbState;
  fill?: string;
}

const onlyDigits = (s: string) => s.replace(/[^0-9]/g, '');
const clip = (s: unknown, n: number) => (typeof s === 'string' ? s.trim().slice(0, n) : '');

export interface OnbView extends OnbState {
  consent: ConsentNotice | null;
  config: ConsentConfig | null;
  tasksCatalog: typeof ONB_TASKS;
}
const CONSENT_STEP: Partial<Record<OnbStep, ConsentKind>> = { terms: 'terms', model: 'model', telemetry: 'telemetry' };

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
  modelAllowed(): boolean {
    return this.s.consents.model?.choice === 'agreed';
  }

  missing(): Array<'biz' | 'auth'> {
    const s = this.s;
    return [...(!s.biz || s.skipped.includes('biz') ? (['biz'] as const) : []), ...(!s.auth || s.skipped.includes('auth') ? (['auth'] as const) : [])];
  }

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
    return { ...this.state, consent: kind ? CONSENT_NOTICES[kind] : null, config: this.s.step === 'model' || this.s.step === 'terms' ? await this.ports.consentConfig() : null, tasksCatalog: ONB_TASKS };
  }

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
      this.s = before;
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
  private async consent(kind: ConsentKind, choice: 'agreed' | 'declined', processorsVersion?: string) {
    const n = CONSENT_NOTICES[kind];
    const at = this.at();
    await this.ports.recordConsent({ v: 1, kind, noticeKey: n.key, noticeVersion: n.version, ...(processorsVersion ? { processorsVersion } : {}), choice, at, via: 'onboarding' });
    this.s.consents[kind] = { version: n.version, choice, at };
  }
  private async toAuth() {
    this.s.step = 'auth';
    this.s.certs = await this.ports.findCerts().catch(() => []);
  }
  private async afterBiz(skipped: boolean) {
    const s = this.s;
    if (!s.redo) return this.toAuth();
    if (skipped) return this.endRedo();
    if (s.auth && !s.skipped.includes('auth')) s.step = 'summary';
    else await this.toAuth();
  }
  private async afterAuth(skipped = false) {
    const s = this.s;
    if (s.redo && skipped && s.redo === 'auth') return this.endRedo();
    if (!s.redo && s.consents.model?.choice !== 'agreed') {
      s.step = 'model';
      return;
    }
    await this.finish();
  }
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
      signMethod: s.auth ? AUTH_SIGN_METHOD[s.auth] : 'cert',
      certId: !s.auth || s.auth === 'cert' ? (s.certId ?? defaultCertId(s.certs)) : null,
    });
  }
  private useDefaultCert() {
    const s = this.s;
    s.auth = 'cert';
    s.certId = defaultCertId(s.certs);
    this.unskip('auth');
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
          const name = clip(a.fields?.name, BIZ_FIELD_MAX.name);
          this.say(`${name ? `${name}, ` : ''}${no.slice(0, 3)}-${no.slice(3, 5)}-${no.slice(5)}`);
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
          if (next.bizNo !== cur.bizNo || s.check?.status === 'unknown') await this.setBiz(next);
          else s.biz = next;
          return;
        }
        if (a.choice === 'recheck') {
          if (!s.biz || s.check?.status !== 'unknown') throw new Error('bad_choice');
          if (!isValidBizNo(s.biz.bizNo)) throw new Error('bad_biz_no');
          await this.setBiz(s.biz);
          return;
        }
        if (a.choice === 'confirm_unverified') {
          if (!s.biz || !isValidBizNo(s.biz.bizNo)) throw new Error('bad_biz_no');
          if (s.check?.status !== 'unknown') throw new Error('bad_choice');
          if (!s.biz.name.trim()) throw new Error('name_required');
          this.say('맞습니다');
          this.unskip('biz');
          await this.afterBiz(false);
          return;
        }
        if (s.biz && !isValidBizNo(s.biz.bizNo)) throw new Error('bad_biz_no');
        if (!s.biz || s.check?.status !== 'active') throw new Error('biz_inactive');
        if (!s.biz.name.trim()) throw new Error('name_required');
        this.say('맞아요');
        this.unskip('biz');
        await this.afterBiz(false);
        return;
      case 'auth':
        if (a.choice === 'rescan') {
          s.certs = await this.ports.findCerts().catch(() => s.certs);
          return;
        }
        if (a.choice === 'unsure') {
          this.say('잘 모르겠어요');
          this.useDefaultCert();
          await this.afterAuth();
          return;
        }
        if (a.choice === 'later') {
          if (s.redo === 'auth' && s.redoPrev) {
            this.say('지금 인증 그대로 둘게요');
            s.auth = s.redoPrev.auth;
            s.certId = s.redoPrev.certId;
            this.endRedo();
            return;
          }
          this.say('나중에 할게요');
          this.useDefaultCert();
          await this.afterAuth();
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
          this.say(kind === 'cert' ? `${AUTH_LABEL[kind]}, ${s.certs.find((x) => x.id === s.certId)?.owner ?? ''}` : AUTH_LABEL[kind]);
          await this.afterAuth();
        }
        return;
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
        await this.saveProfile();
        this.say('확인했어요');
        if (s.redo) this.endRedo();
        else s.step = 'first';
        return;
      case 'first':
        this.say(a.choice === 'try' ? '지금 해 볼게요' : '나중에 할게요');
        s.step = 'done';
        return a.choice === 'try' ? TRY_FIRST_FILL : undefined;
    }
    return;
  }


  private async setBiz(f: BizFields) {
    const s = this.s;
    s.biz = { ...EMPTY_BIZ, ...f, bizNo: onlyDigits(f.bizNo) };
    if (!emailOk(s.biz.email)) s.biz.email = '';
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

export function reaskModel(s: OnbState): OnbState {
  const at = ONB_STEPS.indexOf(s.step);
  if (at <= ONB_STEPS.indexOf('model') || s.consents.model?.choice === 'agreed') return s;
  return { ...s, resumeStep: s.step, step: 'model', notice: null };
}

export function onboardingTodos(s: OnbState | null): Array<{ id: SkipItem; label: string; view: 'biz' | 'cps' }> {
  if (!s || s.step !== 'done') return [];
  return s.skipped.map((id) => ({ id, label: SKIP_LABEL[id], view: id === 'counterparties' ? 'cps' : 'biz' }));
}

export function certExpiringSoon(c: NpkiCert, today: string): boolean {
  const d = (x: string) => Date.UTC(Number(x.slice(0, 4)), Number(x.slice(5, 7)) - 1, Number(x.slice(8, 10)));
  return (d(c.expiresOn) - d(today)) / 86_400_000 <= CERT_EXPIRY_WARN_DAYS;
}
