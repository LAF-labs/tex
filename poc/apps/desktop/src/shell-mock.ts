import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { gateHash, type GateRequest } from './approval-gate.ts';

// PoC-9 목업 데이터와 목업 실행기. 엔진(H-01 플레이북, PoC-6) 자리를 대신한다. 모든 값은 가상이다.
// PoC-6 연결 때: 요청 해석·초안은 engine intent, 실행 단계·게이트 요청·발급 확정은 엔진 이벤트, 원장 판정($first.*)은 엔진 원장으로 바꾼다.

const pad = (n: number) => String(n).padStart(2, '0');
export const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const dayOffset = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return ymd(d);
};
const hm = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

export interface Profile {
  kind: 'business' | 'personal';
  name: string;
  bizNo?: string;
  rep?: string;
  email: string;
  auth: string;
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
  issuedOn: string;
  expiresOn: string | null;
  source: '앱이 발급' | '직접 발급' | '직접 추가';
  purpose?: string;
}

export const PROFILES: Record<Profile['kind'], Profile> = {
  business: { kind: 'business', name: '가나다컴퍼니', bizNo: '1234567891', rep: '김가나', email: 'office@ganada.example', auth: '사업자 간편인증(카카오뱅크)' },
  personal: { kind: 'personal', name: '김가나', email: 'gana@ganada.example', auth: '간편인증(카카오톡)' },
};

export const COUNTERPARTIES: Counterparty[] = [
  { id: 'cp-a', name: 'A상사', bizNo: '2148651233', rep: '이에이', email: 'tax@asangsa.example', item: '경영 컨설팅', status: '계속사업자', checkedOn: dayOffset(-2), lastIssuedOn: dayOffset(-32) },
  { id: 'cp-b', name: 'B상사', bizNo: '3051288767', rep: '박비', email: 'account@bsangsa.example', item: '시스템 유지보수', status: '계속사업자', checkedOn: dayOffset(-1), lastIssuedOn: dayOffset(-1) },
  { id: 'cp-c', name: 'C테크', bizNo: '4182577343', rep: '최다라', email: 'billing@ctech.example', item: '교육 용역', status: '계속사업자', checkedOn: dayOffset(-5), lastIssuedOn: null },
];

/** 원장에서 verify로 확정된 공급받는자·받는 이메일(목업). "처음 거래"·"처음 보내는 주소" 판정에만 쓴다. */
const committed = { bizNos: new Set(['2148651233', '3051288767']), emails: new Set(['tax@asangsa.example', 'account@bsangsa.example']) };

export const docs: Doc[] = [
  { id: 'd1', name: '납세증명서(국세)', kind: '증명서', docName: '납세증명서', profile: 'business', issuedOn: dayOffset(-25), expiresOn: dayOffset(5), source: '앱이 발급', purpose: '입찰 제출' },
  { id: 'd2', name: '사업자등록증명', kind: '증명서', docName: '사업자등록증명', profile: 'business', issuedOn: dayOffset(-12), expiresOn: null, source: '앱이 발급', purpose: '거래처 등록' },
  { id: 'd3', name: '세금계산서 · B상사', kind: '세금계산서', docName: '전자세금계산서', profile: 'business', issuedOn: dayOffset(-1), expiresOn: null, source: '앱이 발급' },
  { id: 'd4', name: '세금계산서 · A상사', kind: '세금계산서', docName: '전자세금계산서', profile: 'business', issuedOn: dayOffset(-32), expiresOn: null, source: '앱이 발급' },
  { id: 'd5', name: '중소기업확인서', kind: '직접 추가', docName: '중소기업확인서', profile: 'business', issuedOn: dayOffset(-210), expiresOn: dayOffset(150), source: '직접 추가' },
  { id: 'd6', name: '주민등록표 등본', kind: '증명서', docName: '주민등록표 등본', profile: 'personal', issuedOn: dayOffset(-47), expiresOn: null, source: '직접 발급', purpose: '은행 제출' },
];

/** 대화 타임라인 첫 화면(지난 기록). 단일 세션이라 지난 일은 같은 타임라인 위쪽에 있다(ADR-019). */
export function seedTimeline(): unknown[] {
  return [
    { type: 'day', date: dayOffset(-4) },
    { type: 'app', text: '등록을 마쳤어요. 맡기신 일은 입력창 위 빠른 실행에 넣어 두었어요.' },
    { type: 'summary', rows: [['사업자', '가나다컴퍼니 · 123-45-67891'], ['발급 인증', '사업자 간편인증(카카오뱅크)'], ['거래처', '3곳'], ['맡긴 업무', '세금계산서 발급, 사업자등록증명, 납세증명서']] },
    { type: 'day', date: dayOffset(-1) },
    { type: 'me', text: 'B상사에 55만원 세금계산서 끊어 줘', time: '16:20' },
    { type: 'past', title: '세금계산서', who: 'B상사', total: 605000, supply: 550000, tax: 55000, approvalNo: `${dayOffset(-1).replaceAll('-', '')}-41000012-00000123`, mail: 'account@bsangsa.example' },
    { type: 'day', date: dayOffset(0) },
  ];
}

/** 빠른 실행 칩. soon은 이 데모에서 아직 보여 주지 않는 일(회색 "곧 지원" 칩, 08 §4). */
export const QUICK: Array<{ label: string; text: string; soon?: boolean }> = [
  { label: '세금계산서 발급', text: '세금계산서 ' },
  { label: '주민등록등본(직접 발급)', text: '주민등록등본 떼 줘' },
  { label: '사업자등록증명', text: '사업자등록증명 떼 줘', soon: true },
  { label: '납세증명서', text: '납세증명서 떼 줘', soon: true },
];

// ---- 요청 해석(정규식 목업, 모델 호출 없음) ----

const SMALL: Record<string, number> = { 천: 1e3, 백: 1e2, 십: 10 };
const BIG: Record<string, number> = { 만: 1e4, 억: 1e8 };

/** 한 덩어리("330만원", "1억 2천만원", "1천2백만원", "3,300,000원")를 원 단위로. 단위·"원"이 없으면 쉼표가 있거나 1만 이상일 때만 금액으로 본다. */
function parseSegment(seg: string): number | null {
  let total = 0;
  let group = 0;
  let num: number | null = null;
  let eok = false;
  for (const tok of seg.matchAll(/(\d[\d,]*(?:\.\d+)?)|([억천백십만])/g)) {
    if (tok[1]) {
      if (num !== null) return null; // 단위 없이 숫자가 둘 이어지면 확신할 수 없다
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
  // "1억 2천"·"1억5천"처럼 억 뒤가 만 없이 끝나면 1억 2천만원인지 1억 2천원인지 확신할 수 없다. 되묻는다.
  if (eok && (group || num)) return null;
  total += group + (num ?? 0);
  const unit = /[억천백십만]/.test(seg) || seg.includes('원');
  if (!unit && !(seg.includes(',') || total >= 10_000)) return null;
  return Number.isFinite(total) && total > 0 && total <= 1e12 ? Math.round(total) : null;
}

/** 문장에서 처음 나오는 금액. 거래처 이름 등 금액이 아닌 숫자는 호출하는 쪽에서 빼고 넘긴다. */
export function parseAmount(t: string): number | null {
  for (const m of t.matchAll(/\d[\d,.\s억천백십만]*원?/g)) {
    const v = parseSegment(m[0]);
    if (v !== null) return v;
  }
  return null;
}

export type VatMode = 'separate' | 'included';

/** 세액은 공급가액의 10%에서 원 미만을 버린다. 포함 금액은 공급가 + 세액이 합계와 맞는 공급가를 찾는다. */
export function split(amount: number, vat: VatMode) {
  const taxOf = (s: number) => Math.floor(s / 10);
  if (vat === 'separate') return { supply: amount, tax: taxOf(amount), total: amount + taxOf(amount) };
  const base = Math.floor((amount * 10) / 11);
  const supply = [base, base + 1, base - 1].find((s) => s > 0 && s + taxOf(s) === amount) ?? base;
  return { supply, tax: amount - supply, total: amount };
}

export type Reply =
  | { kind: 'draft'; run: RunView }
  | { kind: 'say'; text: string; chips?: Array<{ label: string; text: string }>; fill?: string }
  | { kind: 'g24'; doc: G24Doc };

export type G24Doc = '주민등록표 등본' | '주민등록표 초본';

export function interpret(text: string, vat: VatMode | null, profile: Profile['kind'], runs: MockRuns): Reply {
  const t = text.trim();
  const pending = runs.pending;
  const asked = pending.asked;
  pending.asked = null;
  if (/신고|세액\s*계산/.test(t)) return { kind: 'say', text: '신고와 세액 계산은 하지 않아요. 신고에 필요한 증명서는 뗄 수 있어요.' };
  if (/등본|초본|정부24/.test(t)) return { kind: 'g24', doc: /초본/.test(t) ? '주민등록표 초본' : '주민등록표 등본' };
  const named = COUNTERPARTIES.filter((c) => t.includes(c.name));
  // 거래처 이름이 둘 이상이면("A상사 말고 C테크로") 고르지 않고 되묻는다.
  const cpNamed = named.length === 1 ? named[0]! : null;
  const amountNamed = parseAmount(cpNamed ? t.replace(cpNamed.name, ' ') : t);
  const invoice = /계산서/.test(t) || (asked === 'amount' && amountNamed !== null) || (asked === 'counterparty' && cpNamed !== null);
  if (invoice) {
    if (profile !== 'business') return { kind: 'say', text: '세금계산서는 사업자 프로필로 발급해요. 위에서 사업자로 바꿔 주세요.' };
    const cp = cpNamed ?? (asked === 'amount' ? pending.cp : null);
    const amount = amountNamed ?? (asked === 'counterparty' ? pending.amount : null);
    if (!cp) {
      Object.assign(pending, { cp: null, asked: 'counterparty', amount });
      return { kind: 'say', text: '어느 거래처에 발급할까요?', chips: (named.length > 1 ? named : COUNTERPARTIES).map((c) => ({ label: c.name, text: c.name })) };
    }
    if (!amount) {
      Object.assign(pending, { cp, asked: 'amount', amount: null });
      return { kind: 'say', text: `${cp.name}에 얼마를 발급할까요? 예: 330만원` };
    }
    Object.assign(pending, { cp: null, asked: null, amount: null });
    return { kind: 'draft', run: runs.createDraft(cp, amount, vat) };
  }
  if (/사업자등록증명|납세증명/.test(t)) return { kind: 'say', text: '증명서 발급은 곧 이 대화에서 할 수 있어요. 이 데모에서는 세금계산서 발급과 정부24 직접 발급 안내를 보여 드려요.' };
  return { kind: 'say', text: '세금계산서나 증명서를 말해 주세요.', chips: QUICK.filter((q) => !q.soon) };
}

// ---- 목업 실행기 ----

export type RunStatus = 'draft' | 'preparing' | 'turn' | 'waiting' | 'issuing' | 'done' | 'stopped';
export type StepState = 'todo' | 'now' | 'done' | 'attention';

export interface RunView {
  id: string;
  doc: 'H-01';
  status: RunStatus;
  createdAt: string;
  counterparty: { id: string; name: string; bizNo: string; first: boolean };
  email: { value: string; first: boolean };
  amount: number;
  vat: VatMode;
  vatGuessed: boolean;
  supply: number;
  tax: number;
  total: number;
  item: string;
  writeDate: string;
  auth: string;
  steps: Array<{ label: string; state: StepState; note?: string }>;
  turn: { text: string; note: string } | null;
  confirmed: boolean;
  result: { approvalNo: string; mailTo: string; docId: string; doneAt: string } | null;
  stoppedNote?: string;
}

const STEPS = ['홈택스 로그인', '건별발급 화면', '입력', '되읽기', '승인', '전자서명', '발급목록 확인', '메일 전송 확인'];

/**
 * 이벤트: 'update'(RunView) · 'gate'(runId, GateRequest) · 'gate-closed'(runId, reason) · 'doc'(Doc).
 * speed는 시간 배율(1 = 시연, e2e는 작게).
 */
export class MockRuns extends EventEmitter {
  private readonly runs = new Map<string, RunView>();
  private readonly timers = new Map<string, NodeJS.Timeout[]>();
  private readonly speed: number;
  /** 앱이 되물은 것(입력 보완). 다음 답이 금액만이거나 거래처 이름만이어도 이어 간다. 대화(세션)마다 하나. */
  readonly pending: { cp: Counterparty | null; asked: 'amount' | 'counterparty' | null; amount: number | null } = { cp: null, asked: null, amount: null };

  constructor(speed = 1) {
    super();
    this.speed = speed;
  }

  get(id: string): RunView | undefined {
    return this.runs.get(id);
  }

  createDraft(cp: Counterparty, amount: number, vat: VatMode | null): RunView {
    const s = split(amount, vat ?? 'separate');
    const run: RunView = {
      id: `run-${randomUUID().slice(0, 8)}`,
      doc: 'H-01',
      status: 'draft',
      createdAt: hm(),
      counterparty: { id: cp.id, name: cp.name, bizNo: cp.bizNo, first: !committed.bizNos.has(cp.bizNo) },
      email: { value: cp.email, first: !committed.emails.has(cp.email) },
      amount,
      vat: vat ?? 'separate',
      vatGuessed: vat === null,
      ...s,
      item: cp.item,
      writeDate: dayOffset(0),
      auth: PROFILES.business.auth,
      steps: STEPS.map((label) => ({ label, state: 'todo' as StepState })),
      turn: null,
      confirmed: false,
      result: null,
    };
    this.runs.set(run.id, run);
    return run;
  }

  updateDraft(id: string, patch: { vat?: VatMode; amount?: number; amountText?: string }): RunView {
    if (patch.amountText !== undefined) {
      // [금액 수정]도 요청 문장과 같은 규칙으로 읽는다. 단위 없는 숫자만 넣어도 금액으로 본다.
      const t = patch.amountText.trim();
      const v = parseAmount(/^[\d,]+$/.test(t) ? `${t}원` : t);
      if (v === null) throw new Error('bad_amount');
      patch = { ...patch, amount: v };
    }
    const r = this.mustDraft(id);
    if (patch.vat) {
      r.vat = patch.vat;
      r.vatGuessed = false;
    }
    if (patch.amount !== undefined) {
      if (!Number.isInteger(patch.amount) || patch.amount <= 0 || patch.amount > 1e12) throw new Error('bad_amount');
      r.amount = patch.amount;
    }
    Object.assign(r, split(r.amount, r.vat));
    this.emit('update', r);
    return r;
  }

  private mustDraft(id: string): RunView {
    const r = this.runs.get(id);
    if (!r || r.status !== 'draft') throw new Error('not_draft');
    return r;
  }

  private at(id: string, ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      const r = this.runs.get(id);
      if (r && r.status !== 'stopped') fn();
    }, ms * this.speed);
    this.timers.set(id, [...(this.timers.get(id) ?? []), t]);
  }

  private step(r: RunView, i: number, state: StepState, note?: string): void {
    r.steps[i] = { label: STEPS[i]!, state, note };
  }

  /** [홈택스에서 준비]: 로그인 → 건별발급 화면 → 입력 → 되읽기 → 승인 대기. 실행은 한 번에 하나다(08 §5). */
  prepare(id: string): RunView {
    const r = this.mustDraft(id);
    if ([...this.runs.values()].some((x) => ['preparing', 'turn', 'waiting', 'issuing'].includes(x.status))) throw new Error('busy');
    r.status = 'preparing';
    this.step(r, 0, 'now', '홈택스에 로그인하고 있어요');
    this.emit('update', r);
    let t = 900;
    this.at(id, t, () => {
      r.status = 'turn';
      r.turn = { text: '카카오뱅크 앱에서 간편인증을 승인해 주세요.', note: '데모: 3초 뒤 폰에서 승인한 것으로 진행해요' };
      this.step(r, 0, 'now', '카카오뱅크 앱 승인을 기다려요');
      this.emit('update', r);
    });
    t += 3000;
    this.at(id, t, () => {
      r.status = 'preparing';
      r.turn = null;
      this.step(r, 0, 'done');
      this.step(r, 1, 'now', '건별발급 화면을 열고 있어요');
      this.emit('update', r);
    });
    t += 900;
    this.at(id, t, () => {
      this.step(r, 1, 'done');
      this.step(r, 2, 'now', '공급받는자·품목·금액을 넣고 있어요');
      this.emit('update', r);
    });
    t += 1200;
    this.at(id, t, () => {
      this.step(r, 2, 'done');
      this.step(r, 3, 'now', '홈택스 화면에서 값을 되읽고 있어요');
      this.emit('update', r);
    });
    t += 900;
    this.at(id, t, () => {
      this.step(r, 3, 'done');
      this.step(r, 4, 'now', '아래 [승인하고 발급]을 기다려요');
      r.status = 'waiting';
      r.confirmed = true;
      this.emit('update', r);
      this.emit('gate', r.id, this.gateRequest(r));
    });
    return r;
  }

  /** 되읽은 값(목업: 초안과 같음)과 엔진 예약 키로 게이트 요청을 만든다. */
  gateRequest(r: RunView): GateRequest {
    const base = {
      runId: r.id,
      gateStepId: 'issue',
      reqId: randomUUID(),
      docType: 'H-01' as const,
      fields: [
        { fieldKey: 'supplierBizNo', value: PROFILES.business.bizNo! },
        { fieldKey: 'counterpartName', value: r.counterparty.name },
        { fieldKey: 'counterpartBizNo', value: r.counterparty.bizNo },
        { fieldKey: 'counterpartEmail', value: r.email.value },
        { fieldKey: 'itemName', value: r.item },
        { fieldKey: 'writeDate', value: r.writeDate },
        { fieldKey: 'supplyAmount', value: String(r.supply) },
        { fieldKey: 'taxAmount', value: String(r.tax) },
        { fieldKey: 'totalAmount', value: String(r.total) },
        { fieldKey: '$first.bizNo', value: String(r.counterparty.first) },
        { fieldKey: '$first.email', value: String(r.email.first) },
      ],
    };
    return { ...base, actionHash: gateHash(base) };
  }

  /** 승인 바 클릭 뒤: 전자서명(간편인증 폰 승인 1회) → 발급목록 확인 → 메일 전송 확인 → 완료. */
  approved(id: string): void {
    const r = this.runs.get(id);
    if (!r || r.status !== 'waiting') return;
    r.status = 'turn';
    this.step(r, 4, 'done');
    this.step(r, 5, 'now', '카카오뱅크 앱 승인을 기다려요');
    r.turn = { text: '카카오뱅크 앱에서 전자서명을 승인해 주세요.', note: '데모: 2초 뒤 폰에서 승인한 것으로 진행해요' };
    this.emit('update', r);
    let t = 2200;
    this.at(id, t, () => {
      r.status = 'issuing';
      r.turn = null;
      this.step(r, 5, 'done');
      this.step(r, 6, 'now', '발급목록에서 새 1건을 찾고 있어요');
      this.emit('update', r);
    });
    t += 1300;
    this.at(id, t, () => {
      this.step(r, 6, 'done', '발급목록에서 확인했어요');
      this.step(r, 7, 'now', '메일발송목록을 확인하고 있어요');
      this.emit('update', r);
    });
    t += 1000;
    this.at(id, t, () => {
      this.step(r, 7, 'done');
      const doc: Doc = { id: `d-${r.id}`, name: `세금계산서 · ${r.counterparty.name}`, kind: '세금계산서', docName: '전자세금계산서', profile: 'business', issuedOn: dayOffset(0), expiresOn: null, source: '앱이 발급' };
      docs.unshift(doc);
      committed.bizNos.add(r.counterparty.bizNo);
      committed.emails.add(r.email.value);
      const cp = COUNTERPARTIES.find((c) => c.id === r.counterparty.id);
      if (cp) cp.lastIssuedOn = dayOffset(0);
      r.status = 'done';
      r.result = { approvalNo: `${dayOffset(0).replaceAll('-', '')}-41000012-${(randomBytes(4).readUInt32BE() % 1e8).toString().padStart(8, '0')}`, mailTo: r.email.value, docId: doc.id, doneAt: hm() };
      this.emit('doc', doc);
      this.emit('update', r);
    });
  }

  /** [중지]·[취소]: 발급 전이면 언제든. 승인 대기 중이면 게이트를 닫는다. */
  stop(id: string): RunView {
    const r = this.runs.get(id);
    if (!r) throw new Error('no_run');
    if (r.status === 'done' || r.status === 'stopped') return r;
    if (r.status === 'issuing' || (r.status === 'turn' && r.steps[4]!.state === 'done')) throw new Error('already_issuing');
    const wasWaiting = r.status === 'waiting';
    const wasDraft = r.status === 'draft';
    for (const t of this.timers.get(id) ?? []) clearTimeout(t);
    this.timers.delete(id);
    r.status = 'stopped';
    r.turn = null;
    r.steps = r.steps.map((s) => (s.state === 'now' ? { ...s, state: 'todo', note: undefined } : s));
    r.stoppedNote = wasDraft ? '취소했어요.' : '발급 전에 멈췄어요. 홈택스에는 아무것도 발급되지 않았어요.';
    if (wasWaiting) this.emit('gate-closed', id, 'stopped');
    this.emit('update', r);
    return r;
  }
}

// ---- 정부24 후처리 목업(T-08). 정부24에 어떤 요청도 보내지 않고 브라우저도 열지 않는다(ADR-011, D17). ----

/** 작업 시작 뒤에 생긴 PDF만 후보로 올린다(D17 §1.3). 목업은 시작~지금 사이 시각으로 만든다. */
export function g24Candidates(doc: G24Doc, startedAt: number): Array<{ id: string; name: string; size: string; at: string }> {
  const now = Date.now();
  const start = Number.isFinite(startedAt) && startedAt <= now ? startedAt : now;
  const at = (f: number) => hm(new Date(start + (now - start) * f));
  return [
    { id: 'f1', name: `${doc.replace(/\s/g, '')}_${dayOffset(0).replaceAll('-', '')}.pdf`, size: '182KB', at: at(0.9) },
    { id: 'f2', name: 'print_0001.pdf', size: '96KB', at: at(0.4) },
  ];
}

export function g24Save(candidateId: string, doc: G24Doc): Doc {
  if (candidateId !== 'f1' && candidateId !== 'f2') throw new Error('bad_candidate');
  const d: Doc = { id: `d-g24-${randomUUID().slice(0, 6)}`, name: doc, kind: '증명서', docName: doc, profile: 'personal', issuedOn: dayOffset(0), expiresOn: null, source: '직접 발급', purpose: '제출처 확인 필요' };
  docs.unshift(d);
  return d;
}
