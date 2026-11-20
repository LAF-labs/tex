import { cleanItem, type Vat } from '@sax/chat-core';
import { kstToday } from './approval-gate.ts';
import { CERT_DOCS_SHOWN, certDocByCode, certDocOf, certInputsFor, type CertCode } from './cert-docs.ts';

const pad = (n: number) => String(n).padStart(2, '0');
export const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const dayOffset = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return ymd(d);
};
export const hm = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

export interface Profile {
  kind: 'business' | 'personal';
  name: string;
  bizNo?: string;
  rep?: string;
  bizType?: string;
  bizItem?: string;
  address?: string;
  email: string;
  auth: string;
  nameMissing?: boolean;
  fromHometax?: Array<'name' | 'rep' | 'bizType' | 'bizItem' | 'address' | 'email'>;
  placeholder?: boolean;
}

export const SIGN_LABEL: Readonly<Record<'cert' | 'simple_auth', string>> = { simple_auth: '사업자 간편인증', cert: '공동·금융인증서' };

export const NO_AUTH = '발급 인증 미설정';

export function setupMissing(b: Profile): Array<'biz' | 'auth'> {
  return [...(!b.bizNo ? (['biz'] as const) : []), ...(!b.auth || b.auth === NO_AUTH ? (['auth'] as const) : [])];
}
export const SETUP_LABEL = { biz: '사업자 등록 마치기', auth: '발급 인증 고르기', chrome: 'Chrome 설치하기', security: '보안 프로그램 설치하기' } as const;
export type SetupItem = keyof typeof SETUP_LABEL;
export function setupText(work: 'invoice' | 'cert', missing: ReadonlyArray<SetupItem>): string {
  const what = work === 'invoice' ? '세금계산서를 발급하려면' : '증명서를 떼려면';
  const chrome = missing.includes('chrome');
  const head =
    missing.includes('biz') && missing.includes('auth')
      ? `${what} 먼저 사업자 정보와 발급 인증을 등록해 주세요. 지금은 둘 다 비어 있어요.`
      : missing.includes('biz')
        ? `${what} 먼저 사업자 정보(사업자번호)를 등록해 주세요.`
        : missing.includes('auth')
          ? `${what} 먼저 발급할 때 쓸 인증(공동인증서·간편인증)을 골라 주세요.`
          : null;
  const sec = missing.includes('security') ? '홈택스 공동인증서 프로그램(MagicLine4NX)도 켜 주세요.' : '';
  if (!chrome) return head ? `${head}${sec ? ` ${sec}` : ''}` : `${what} 먼저 홈택스 공동인증서 프로그램(MagicLine4NX)을 설치하거나 켜 주세요.`;
  return head ? `${head} Chrome도 설치해 주세요.${sec ? ` ${sec}` : ''}` : `${what} 먼저 이 PC에 Chrome을 설치해 주세요. 홈택스 작업은 Chrome 창에서 해요.${sec ? ` ${sec}` : ''}`;
}

export interface Counterparty {
  id: string;
  name: string;
  bizNo: string;
  rep: string;
  email: string;
  item: string;
  status: string;
  checkedOn: string;
  lastIssuedOn: string | null;
}

export interface Doc {
  id: string;
  name: string;
  kind: '세금계산서' | '증명서' | '직접 추가';
  docName: string;
  profile: 'business' | 'personal';
  issuedOn: string | null;
  expiresOn: string | null;
  source: '앱이 발급' | '직접 발급' | '직접 추가';
  noFile?: boolean;
  purpose?: string;
  runId?: string;
  vault?: {
    expirySource: 'document' | 'rule' | 'user' | null;
    needsUser: boolean;
    reasons: string[];
    suggested: { issuedOn?: string; validUntil?: string };
    docType: 'national_tax_cert' | 'biz_registration_cert' | 'other';
    textSource: 'text' | 'ocr' | 'scan';
    docNo: string | null;
    issuer: string | null;
    subjectMismatch: boolean;
  };
}

export const QUICK: Array<{ label: string; text: string; soon?: boolean; cert?: CertCode }> = [
  { label: '세금계산서 발급', text: '세금계산서 ' },
  { label: '주민등록등본(직접 발급)', text: '주민등록등본 떼 줘' },
  ...CERT_DOCS_SHOWN.map((d) => ({ label: d.label, text: `${d.name} 떼 줘`, cert: d.code })),
];

const SMALL: Record<string, number> = { 천: 1e3, 백: 1e2, 십: 10 };
const BIG: Record<string, number> = { 만: 1e4, 억: 1e8 };

function parseSegment(seg: string): number | null {
  let total = 0;
  let group = 0;
  let num: number | null = null;
  let eok = false;
  for (const tok of seg.matchAll(/(\d[\d,]*(?:\.\d+)?)|([억천백십만])/g)) {
    if (tok[1]) {
      if (num !== null) return null;
      num = Number(tok[1].replace(/,/g, ''));
      continue;
    }
    const u = tok[2]!;
    if (u in SMALL) group += (num ?? 1) * SMALL[u]!;
    else total += (group + (num ?? 0) || 1) * BIG[u]!;
    if (u === '억') eok = true;
    if (!(u in SMALL)) group = 0;
    num = null;
  }
  if (eok && (group || num)) return null;
  total += group + (num ?? 0);
  const unit = /[억천백십만]/.test(seg) || seg.includes('원');
  if (!unit && !(seg.includes(',') || total >= 10_000)) return null;
  return Number.isFinite(total) && total > 0 && total <= 1e12 ? Math.round(total) : null;
}

export function parseAmount(t: string): number | null {
  for (const m of t.matchAll(/\d[\d,.\s억천백십만]*원?/g)) {
    const v = parseSegment(m[0]);
    if (v !== null) return v;
  }
  return null;
}

export type Reply =
  | { kind: 'draft'; run: RunView; text?: string }
  | { kind: 'say'; text: string; chips?: Array<{ label: string; text: string }>; fill?: string; addCp?: { name: string } }
  | { kind: 'g24'; doc: G24Doc };

export type G24Doc = '주민등록표 등본' | '주민등록표 초본';

export interface Pending {
  cp: Counterparty | null;
  asked: 'amount' | 'counterparty' | 'item' | null;
  amount: number | null;
  item: string | null;
  vat: Vat | null;
}
export const emptyPending = (): Pending => ({ cp: null, asked: null, amount: null, item: null, vat: null });

export const ASK_ITEM_TEXT = (cp: string) => `${cp}에 어떤 품목으로 발급할까요? 예: 컨설팅 용역`;
const ITEM_STOP = /^(?:전자)?(?:세금)?계산서|^발급|^발행|^작성|^끊|^보내|^메일|^이메일|^해(?:\s?줘|주세요|요|라|줄래|주라|줘요)?$|^해줘|^줘|^주세요|^부탁|^좀$|^부가세|^vat$|^포함|^별도|^공급가|^합계|^금액|^이번|^이달|^오늘|^어제|^내일|^지난번|^같게|^같은|^그대로|^건$|^원$|^취소|^그만|^아니|^됐어|^몰라|^네$|^응$|^예$/i;
const PARTICLE = /(?:으로|로|에게|한테|에서|에|을|를|은|는|이|가|의|도|만|과|와|짜리)$/;
export function extractItem(text: string, cpName: string | null): string | null {
  let s = cpName ? text.replace(cpName, ' ') : text;
  const said = /품목(?:은|는|을|를)?\s*[:：]?\s*(.+)$/.exec(s);
  if (said) s = said[1]!;
  s = s.replace(/\d[\d,.\s억천백십만]*원?/g, ' ').replace(/[,.!?~"'“”‘’()[\]]/g, ' ');
  const keep: string[] = [];
  for (const tok of s.split(/\s+/)) {
    if (!tok) continue;
    const w = tok.replace(PARTICLE, '');
    if (!w || ITEM_STOP.test(tok) || ITEM_STOP.test(w)) continue;
    keep.push(w);
  }
  return keep.length ? cleanItem(keep.join(' ')) : null;
}

export interface Drafts {
  readonly pending: Pending;
  readonly counterparties: Counterparty[];
  createDraft(cp: Counterparty, amount: number, vat: Vat | null, item?: string | null): RunView;
  createCertDraft(code: CertCode, inputs: Record<string, string>): RunView;
}

export interface Parsed {
  intent: 'invoice' | 'resident_copy' | 'resident_abstract' | 'cert' | 'filing' | 'other';
  counterparties: string[];
  amount: number | null;
  vat: Vat | null;
  item: string | null;
  cert?: CertCode | null;
}

export function parseRegex(text: string, counterparties: Counterparty[]): Parsed {
  const t = text.trim();
  const named = counterparties.filter((c) => t.includes(c.name));
  const certDoc = certDocOf(t);
  const intent: Parsed['intent'] = certDoc
    ? 'cert'
    : /신고|세액\s*계산/.test(t)
      ? 'filing'
      : /등본|초본|정부24/.test(t)
        ? /초본/.test(t) ? 'resident_abstract' : 'resident_copy'
        : /계산서/.test(t)
          ? 'invoice'
          : 'other';
  return {
    intent,
    cert: certDoc?.code ?? null,
    counterparties: named.map((c) => c.name),
    amount: parseAmount(named.length === 1 ? t.replace(named[0]!.name, ' ') : t),
    vat: /(부가세|VAT)\s*포함/i.test(t) ? 'included' : /(부가세|VAT)\s*별도/i.test(t) ? 'separate' : null,
    item: intent === 'invoice' ? (named.length === 1 ? extractItem(t, named[0]!.name) : null) : intent === 'other' && named.length <= 1 ? extractItem(t, named[0]?.name ?? null) : null,
  };
}

const CP_ANSWER_TAIL = /\s*(?:(?:으로|로|에게|한테|에)\s*(?:해\s?(?:줘|주세요|요)|발급해\s?(?:줘|주세요)|끊어\s?(?:줘|주세요))|에게|한테|에|이요|이에요|예요|입니다|요)$/;
const CP_NAME_MAX = 60;
export function cpNameFromAnswer(text: string): string | null {
  const t = text
    .trim()
    .replace(/[.!?~。]+$/, '')
    .replace(CP_ANSWER_TAIL, '')
    .trim();
  if (!t || t.length > CP_NAME_MAX || t.split(/\s+/).length > 3) return null;
  if (!/[가-힣A-Za-z]/.test(t) || /\d{3,}|계산서|증명|등본|초본|[<>]/.test(t) || ITEM_STOP.test(t)) return null;
  return t;
}
export const NO_CP_TEXT = '먼저 거래처를 추가해 주세요. 거래처를 넣으면 이어서 발급할게요.';
export const UNKNOWN_CP_TEXT = (name: string) => `${name}은(는) 거래처 목록에 없어요. 거래처를 추가하면 이어서 발급할게요.`;

export function answersPending(parsed: Parsed, runs: Drafts, text?: string): boolean {
  const asked = runs.pending.asked;
  const named = runs.counterparties.filter((c) => parsed.counterparties.includes(c.name));
  const unknownCp = asked === 'counterparty' && named.length === 0 && parsed.amount === null && text !== undefined && cpNameFromAnswer(text) !== null;
  return (asked === 'amount' && parsed.amount !== null) || (asked === 'counterparty' && named.length === 1) || (asked === 'item' && parsed.item !== null) || unknownCp;
}

export const EMPTY_REQUEST_TEXT = '세금계산서 발급이나 지난 발급, 매출을 말해 주세요.';
export const CERT_OTHER_TEXT = `그 증명서는 이 앱에서 떼지 못해요. ${CERT_DOCS_SHOWN.map((d) => d.name).join('·')}은 바로 뗄 수 있어요.`;
const objectJosa = (w: string) => ((w.charCodeAt(w.length - 1) - 0xac00) % 28 > 0 ? '을' : '를');

export function interpret(text: string, vat: Vat | null, profile: Profile['kind'], runs: Drafts, parsed: Parsed = parseRegex(text, runs.counterparties)): Reply {
  const pending = runs.pending;
  const asked = pending.asked;
  pending.asked = null;
  if (parsed.intent === 'filing') return { kind: 'say', text: '신고와 세액 계산은 하지 않아요. 세금계산서 발급과 지난 발급 확인은 도와드릴 수 있어요.' };
  if (parsed.intent === 'resident_copy' || parsed.intent === 'resident_abstract') return { kind: 'g24', doc: parsed.intent === 'resident_abstract' ? '주민등록표 초본' : '주민등록표 등본' };
  const named = runs.counterparties.filter((c) => parsed.counterparties.includes(c.name));
  const cpNamed = named.length === 1 ? named[0]! : null;
  const amountNamed = parsed.amount;
  if (asked === 'counterparty' && named.length === 0 && amountNamed === null && parsed.intent === 'other' && profile === 'business') {
    const name = cpNameFromAnswer(text);
    if (name) {
      pending.asked = 'counterparty';
      return { kind: 'say', text: UNKNOWN_CP_TEXT(name), chips: runs.counterparties.map((c) => ({ label: c.name, text: c.name })), addCp: { name } };
    }
  }
  const invoice = parsed.intent === 'invoice' || (asked === 'amount' && amountNamed !== null) || (asked === 'counterparty' && cpNamed !== null) || (asked === 'item' && parsed.item !== null);
  if (invoice) {
    if (profile !== 'business') return { kind: 'say', text: '세금계산서는 사업자 프로필로 발급해요. 위에서 사업자로 바꿔 주세요.' };
    const cont = asked !== null && !(parsed.intent === 'invoice' && (named.length > 0 || amountNamed !== null));
    const cp = cpNamed ?? (cont && (asked === 'amount' || asked === 'item') ? pending.cp : null);
    const amount = amountNamed ?? (cont && (asked === 'counterparty' || asked === 'item') ? pending.amount : null);
    const item = parsed.item ?? (cont ? pending.item : null);
    const vatSaid = parsed.vat ?? (cont ? pending.vat : null);
    if (!cp) {
      Object.assign(pending, { cp: null, asked: 'counterparty', amount, item, vat: vatSaid });
      if (!runs.counterparties.length) return { kind: 'say', text: NO_CP_TEXT, addCp: { name: '' } };
      return { kind: 'say', text: '어느 거래처에 발급할까요?', chips: (named.length > 1 ? named : runs.counterparties).map((c) => ({ label: c.name, text: c.name })) };
    }
    if (!amount) {
      Object.assign(pending, { cp, asked: 'amount', amount: null, item, vat: vatSaid });
      return { kind: 'say', text: `${cp.name}에 얼마를 발급할까요? 예: 330만원` };
    }
    if (!item && !cleanItem(cp.item ?? '')) {
      Object.assign(pending, { cp, asked: 'item', amount, item: null, vat: vatSaid });
      return { kind: 'say', text: ASK_ITEM_TEXT(cp.name) };
    }
    Object.assign(pending, emptyPending());
    return { kind: 'draft', run: runs.createDraft(cp, amount, vat ?? vatSaid, item) };
  }
  if (parsed.intent === 'cert') {
    const doc = parsed.cert ? certDocByCode(parsed.cert) : null;
    if (!doc || doc.hidden) return { kind: 'say', text: CERT_OTHER_TEXT };
    if (profile !== 'business') return { kind: 'say', text: '증명서는 사업자 프로필로 떼요. 위에서 사업자로 바꿔 주세요.' };
    const inputs = certInputsFor(doc, text, kstToday(Date.now()));
    return { kind: 'draft', run: runs.createCertDraft(doc.code, inputs), text: `${doc.name}${objectJosa(doc.name)} 홈택스에서 떼요. 사용 용도 ${inputs.purpose} · 제출처 ${inputs.submitTo}.` };
  }
  return { kind: 'say', text: EMPTY_REQUEST_TEXT, chips: QUICK.filter((q) => !q.soon) };
}

export type RunStatus = 'draft' | 'preparing' | 'turn' | 'waiting' | 'issuing' | 'done' | 'stopped' | 'attention';
export type StepState = 'todo' | 'now' | 'done' | 'attention';

export type SentTo = 'openrouter_demo' | 'gateway.decide' | 'gateway.run_tokens' | 'gateway.respond';

export function sentFromGateway(paths: readonly string[]): SentTo[] {
  const m: Record<string, SentTo> = { '/v1/run-tokens': 'gateway.run_tokens', '/v1/decide': 'gateway.decide', '/v1/respond': 'gateway.respond' };
  const got = new Set(paths.map((p) => m[p]).filter((x): x is SentTo => !!x));
  return (['gateway.run_tokens', 'gateway.decide', 'gateway.respond'] as const).filter((x) => got.has(x));
}

interface CertRun {
  code: CertCode;
  playbookId: string;
  name: string;
  docType: string;
  inputs: Record<string, string>;
}

export type RunView = RunViewBase & RunKind;
export type RunKind = { doc: 'H-01'; cert: null } | { doc: 'cert'; cert: CertRun };

export interface RunViewBase {
  id: string;
  status: RunStatus;
  createdAt: string;
  counterparty: { id: string; name: string; bizNo: string; first: boolean };
  email: { value: string; first: boolean };
  amount: number;
  vat: Vat;
  vatGuessed: boolean;
  supply: number;
  tax: number;
  total: number;
  item: string;
  itemGuessed: boolean;
  redo?: boolean;
  endCode?: string;
  browserClosed?: boolean;
  endedAt?: number;
  discarded?: boolean;
  handoffEnd?: boolean;
  maintenance?: { until: string | null; restartedAs?: string };
  dupToday?: boolean;
  noChrome?: boolean;
  rehearsal?: boolean;
  batch?: { id: string; index: number; count: number; approved?: boolean; halted?: boolean; skipped?: boolean };
  resumedFrom?: string;
  certRetryOf?: string;
  simpleAuth?: { provider: string; deadline: number };
  writeDate: string;
  writeDateSet?: boolean;
  quantity?: number;
  unitPrice?: number;
  issueDateLate?: boolean;
  issueDateHeld?: boolean;
  auth: string;
  steps: Array<{ label: string; state: StepState; note?: string }>;
  turn: { text: string; note: string } | null;
  confirmed: boolean;
  result: { approvalNo: string; mailTo: string; docId: string; doneAt: string; mailConfirmed: boolean; noFile?: boolean } | null;
  stoppedNote?: string;
  warnings: string[];
  action?: string;
  notices?: string[];
  replaced?: boolean;
  portalChecks?: Array<{ step: number; text: string; ok: boolean }>;
  retry?: 'extension';
  readbackDiffers?: boolean;
  approvedPending?: boolean;
  interp?: 'model' | 'offline';
  sent?: SentTo[];
  inDoubt?: boolean;
  verifyAttempt?: number;
  regate?: { reason: 'paused' | 'date_changed' | 'value_changed'; note: string };
  handoff?: { phase: string; afterGate: boolean; kind?: 'login' | 'sign' | 'other'; code?: string } | null;
  attest?: { state: 'ready' | 'sent' | 'refused'; note: string } | null;
}

export interface DocStore {
  readonly files: Map<string, string>;
  readonly docs: Doc[];
  g24Save(candidateId: string, doc: G24Doc): Doc;
}

export function emptyDocStore(): DocStore {
  return {
    files: new Map(),
    docs: [],
    g24Save: () => {
      throw new Error('bad_candidate');
    },
  };
}

export const REMINDER_DAY_DEFAULT = 5;
