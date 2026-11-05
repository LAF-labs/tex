import { randomUUID } from 'node:crypto';

// PoC-9 목업 데이터와 요청 해석(정규식, 모델 호출 없음). 모든 값은 가상이다.
// PoC-6부터 실행 단계·게이트 요청·발급 확정·처음 거래 판정은 엔진(H-01 플레이북·원장)에서 온다(shell-runs.ts).
// 사업자 프로필·거래처는 DB(db.query.*)에서 읽는다. 문서함·정부24 후처리는 아직 목업이다.

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
  /** 보관함에서 가져온 서류는 발급일을 못 읽었으면 비어 있다(확인 필요) */
  issuedOn: string | null;
  expiresOn: string | null;
  source: '앱이 발급' | '직접 발급' | '직접 추가';
  purpose?: string;
  /** 보관함(엔진 DocumentService) 서류만: 확인·수정할 수 있고, 만료일 출처와 확인 필요 이유가 있다(shell-docs.ts) */
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

export const PROFILES: Record<Profile['kind'], Profile> = {
  business: { kind: 'business', name: '가나다컴퍼니', bizNo: '1234567891', rep: '김가나', email: 'office@ganada.example', auth: '사업자 간편인증(카카오뱅크)' },
  personal: { kind: 'personal', name: '김가나', email: 'gana@ganada.example', auth: '간편인증(카카오톡)' },
};

/** 셸 하나의 목업 문서함. 모듈 전역에 두지 않고 셸마다 새로 만든다. 보관함(PoC-8 documents)과는 아직 잇지 않는다. */
export class MockStore {
  /** 목업 서류의 견본 PDF 경로(시연 씨앗, demo-seed.ts). main 안에서만 쓰고 렌더러에 보내지 않는다. */
  readonly files = new Map<string, string>();
  readonly docs: Doc[] = [
    { id: 'd1', name: '납세증명서(국세)', kind: '증명서', docName: '납세증명서', profile: 'business', issuedOn: dayOffset(-25), expiresOn: dayOffset(5), source: '앱이 발급', purpose: '입찰 제출' },
    { id: 'd2', name: '사업자등록증명', kind: '증명서', docName: '사업자등록증명', profile: 'business', issuedOn: dayOffset(-12), expiresOn: null, source: '앱이 발급', purpose: '거래처 등록' },
    { id: 'd3', name: '세금계산서 · B상사', kind: '세금계산서', docName: '전자세금계산서', profile: 'business', issuedOn: dayOffset(-1), expiresOn: null, source: '앱이 발급' },
    { id: 'd4', name: '세금계산서 · A상사', kind: '세금계산서', docName: '전자세금계산서', profile: 'business', issuedOn: dayOffset(-32), expiresOn: null, source: '앱이 발급' },
    { id: 'd5', name: '중소기업확인서', kind: '직접 추가', docName: '중소기업확인서', profile: 'business', issuedOn: dayOffset(-210), expiresOn: dayOffset(150), source: '직접 추가' },
    { id: 'd6', name: '주민등록표 등본', kind: '증명서', docName: '주민등록표 등본', profile: 'personal', issuedOn: dayOffset(-47), expiresOn: null, source: '직접 발급', purpose: '은행 제출' },
  ];

  /** 정부24 직접 발급 파일을 문서함에 넣는다(사용자가 후보를 고른 뒤). */
  g24Save(candidateId: string, doc: G24Doc): Doc {
    if (candidateId !== 'f1' && candidateId !== 'f2') throw new Error('bad_candidate');
    const d: Doc = { id: `d-g24-${randomUUID().slice(0, 6)}`, name: doc, kind: '증명서', docName: doc, profile: 'personal', issuedOn: dayOffset(0), expiresOn: null, source: '직접 발급', purpose: '제출처 확인 필요' };
    this.docs.unshift(d);
    return d;
  }
}

/**
 * 이번 달 판 목업 어댑터(ADR-033, M6-16). 세무사 꾸러미(D-05, 2차 배분)·사업용 카드(D-04) 데이터가 들어오기 전 자리다.
 * 지난달 꾸러미 칸 상태와 카드 내역 마지막 최신화 날짜. 꾸러미 트랙의 공개 인터페이스가 나오면 그쪽 질의로 바꾼다.
 */
export function mockBundle(today: string): { month: string; slots: Array<{ name: string; state: 'missing' | 'done' | 'na'; receipt?: boolean }>; sentOn: null } {
  const [y, m] = today.split('-').map(Number) as [number, number];
  const t = y * 12 + (m - 1) - 1;
  const month = `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`;
  return {
    month,
    slots: [
      { name: '매출(세금계산서)', state: 'done' },
      { name: '매입(세금계산서)', state: 'done' },
      { name: '사업용 카드 내역', state: 'missing' },
      { name: '종이 영수증', state: 'missing', receipt: true },
      { name: '현금매출', state: 'na' },
    ],
    sentOn: null,
  };
}
export const MOCK_SETTINGS = { reminderDay: 5, cardFetchedOn: dayOffset(-38) };

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

// ---- 요청 해석(정규식. SAX_DEMO_MODEL=openrouter 시연에서는 모델이 먼저 뽑고 실패하면 이쪽, demo-model.ts) ----

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

/** 요청 해석이 초안을 만드는 곳(shell-runs). 되묻기 상태는 대화(세션)마다 하나다. */
export interface Drafts {
  readonly pending: { cp: Counterparty | null; asked: 'amount' | 'counterparty' | null; amount: number | null };
  readonly counterparties: Counterparty[];
  createDraft(cp: Counterparty, amount: number, vat: VatMode | null, item?: string | null): RunView;
}

/** 문장에서 뽑은 요청 구조. 정규식(parseRegex)이나 시연 모델(demo-model.ts)이 만들고, interpret가 되묻기·초안으로 바꾼다. */
export interface Parsed {
  intent: 'invoice' | 'resident_copy' | 'resident_abstract' | 'cert' | 'filing' | 'other';
  /** 문장에 나온 거래처 이름(목록에 있는 것만) */
  counterparties: string[];
  amount: number | null;
  vat: VatMode | null;
  item: string | null;
}

export function parseRegex(text: string, counterparties: Counterparty[]): Parsed {
  const t = text.trim();
  const named = counterparties.filter((c) => t.includes(c.name));
  const intent: Parsed['intent'] = /신고|세액\s*계산/.test(t)
    ? 'filing'
    : /등본|초본|정부24/.test(t)
      ? /초본/.test(t) ? 'resident_abstract' : 'resident_copy'
      : /계산서/.test(t)
        ? 'invoice'
        : /사업자등록증명|납세증명/.test(t)
          ? 'cert'
          : 'other';
  return {
    intent,
    counterparties: named.map((c) => c.name),
    // 거래처 이름 속 숫자는 금액으로 보지 않는다. 이름이 하나일 때만 뺀다(둘 이상이면 어차피 되묻는다).
    amount: parseAmount(named.length === 1 ? t.replace(named[0]!.name, ' ') : t),
    vat: /(부가세|VAT)\s*포함/i.test(t) ? 'included' : /(부가세|VAT)\s*별도/i.test(t) ? 'separate' : null,
    item: null,
  };
}

/** parsed가 없으면 정규식으로 뽑는다. 화면의 부가세 선택(vat)이 문장보다 먼저다. */
export function interpret(text: string, vat: VatMode | null, profile: Profile['kind'], runs: Drafts, parsed: Parsed = parseRegex(text, runs.counterparties)): Reply {
  const pending = runs.pending;
  const asked = pending.asked;
  pending.asked = null;
  if (parsed.intent === 'filing') return { kind: 'say', text: '신고와 세액 계산은 하지 않아요. 신고에 필요한 증명서는 뗄 수 있어요.' };
  if (parsed.intent === 'resident_copy' || parsed.intent === 'resident_abstract') return { kind: 'g24', doc: parsed.intent === 'resident_abstract' ? '주민등록표 초본' : '주민등록표 등본' };
  const named = runs.counterparties.filter((c) => parsed.counterparties.includes(c.name));
  // 거래처 이름이 둘 이상이면("A상사 말고 C테크로") 고르지 않고 되묻는다.
  const cpNamed = named.length === 1 ? named[0]! : null;
  const amountNamed = parsed.amount;
  const invoice = parsed.intent === 'invoice' || (asked === 'amount' && amountNamed !== null) || (asked === 'counterparty' && cpNamed !== null);
  if (invoice) {
    if (profile !== 'business') return { kind: 'say', text: '세금계산서는 사업자 프로필로 발급해요. 위에서 사업자로 바꿔 주세요.' };
    const cp = cpNamed ?? (asked === 'amount' ? pending.cp : null);
    const amount = amountNamed ?? (asked === 'counterparty' ? pending.amount : null);
    if (!cp) {
      Object.assign(pending, { cp: null, asked: 'counterparty', amount });
      return { kind: 'say', text: '어느 거래처에 발급할까요?', chips: (named.length > 1 ? named : runs.counterparties).map((c) => ({ label: c.name, text: c.name })) };
    }
    if (!amount) {
      Object.assign(pending, { cp, asked: 'amount', amount: null });
      return { kind: 'say', text: `${cp.name}에 얼마를 발급할까요? 예: 330만원` };
    }
    Object.assign(pending, { cp: null, asked: null, amount: null });
    return { kind: 'draft', run: runs.createDraft(cp, amount, vat ?? parsed.vat, parsed.item) };
  }
  if (parsed.intent === 'cert') return { kind: 'say', text: '증명서 발급은 곧 이 대화에서 할 수 있어요. 이 데모에서는 세금계산서 발급과 정부24 직접 발급 안내를 보여 드려요.' };
  return { kind: 'say', text: '세금계산서나 증명서를 말해 주세요.', chips: QUICK.filter((q) => !q.soon) };
}

// ---- 실행 화면 모델 ----

export type RunStatus = 'draft' | 'preparing' | 'turn' | 'waiting' | 'issuing' | 'done' | 'stopped' | 'attention';
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
  result: { approvalNo: string; mailTo: string; docId: string; doneAt: string; mailConfirmed: boolean } | null;
  stoppedNote?: string;
  /** 승인 대기 카드의 고정 경고(중복 경고 등). 같은 값이 승인 바에도 있다. */
  warnings: string[];
  /** 승인 바 동작 글자(main이 게이트 fields로 정한 것). 카드 안내 문구가 같은 글자를 쓴다. */
  action?: string;
  /** 카드 꼬리 문장(포털 안내 문구·금고 알림). 텍스트로만 그린다. */
  notices?: string[];
  /** 홈택스에서 되읽은 값이 초안과 다르다. */
  readbackDiffers?: boolean;
  /** 승인했고 거부 우선 창(2초) 안이다. 이때 [중지]가 이긴다. */
  approvedPending?: boolean;
  /** 이 초안을 만든 요청 해석(활동 기록의 모델 줄). 시연 모델이면 'model'. */
  interp?: 'model' | 'offline';
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

