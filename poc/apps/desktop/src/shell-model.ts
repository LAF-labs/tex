// 셸 화면 모델과 요청 해석(정규식, 모델 호출 없음). 제품 진입점이 쓰는 부분이다(ADR-035 W-7).
// 견본 데이터(견본 사업장·서류·대화·꾸러미·정부24 후보)는 shell-mock.ts에 있고 시연 연결(ShellDev, demo-dev.ts)로만 들어온다.
// 실행 단계·게이트 요청·발급 확정·처음 거래 판정은 엔진(H-01 플레이북·원장)에서 온다(shell-runs.ts). 사업자 프로필·거래처는 DB에서 읽는다.

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
  /** 업태·종목·주소(사업자 프로필, 내 사업장에서 보이고 고친다). */
  bizType?: string;
  bizItem?: string;
  address?: string;
  email: string;
  auth: string;
  /** 상호가 비어(또는 번호로 저장되어) name이 중립 표기("내 사업장")다. 번호를 이름처럼 보이지 않는다. */
  nameMissing?: boolean;
  /** 저장된 프로필이 없는 자리 표시(제품의 개인 프로필). 화면은 내용 없는 카드를 그리지 않는다. */
  placeholder?: boolean;
}

/** 발급 인증을 고르지 않은 프로필의 표시(내 사업장 화면). */
export const NO_AUTH = '발급 인증 미설정';

/** 발급에 필요한 등록 중 빠진 것: 사업자번호가 없으면 biz, 발급 인증(signMethod)이 없으면 auth. */
export function setupMissing(b: Profile): Array<'biz' | 'auth'> {
  return [...(!b.bizNo ? (['biz'] as const) : []), ...(!b.auth || b.auth === NO_AUTH ? (['auth'] as const) : [])];
}
export const SETUP_LABEL = { biz: '사업자 등록 마치기', auth: '발급 인증 고르기' } as const;
/** 빠진 등록 안내(무엇이 빠졌는지 말한다). */
export function setupText(work: 'invoice' | 'cert', missing: ReadonlyArray<'biz' | 'auth'>): string {
  const what = work === 'invoice' ? '세금계산서를 발급하려면' : '증명서를 떼려면';
  if (missing.includes('biz') && missing.includes('auth')) return `${what} 먼저 사업자 정보와 발급 인증을 등록해 주세요. 지금은 둘 다 비어 있어요.`;
  if (missing.includes('biz')) return `${what} 먼저 사업자 정보(사업자번호)를 등록해 주세요.`;
  return `${what} 먼저 발급할 때 쓸 인증(보안카드·간편인증·인증서)을 골라 주세요.`;
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
  /** 이 PC에 PDF가 없다(실행의 메모리 줄: 보관함에 같은 실행의 PDF가 없을 때만 보인다, F-04). 화면은 [열기]·[다시 발급] 대신 홈택스 발급목록 안내. */
  noFile?: boolean;
  purpose?: string;
  /** 실행이 보관한 발급 PDF(엔진 보관함 run_id). 같은 실행의 메모리 줄(d-<runId>)을 대신한다. */
  runId?: string;
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
  /** addCp: [거래처 추가] 버튼(거래처 화면의 추가 폼, name을 채워 연다). 거래처가 없거나(F-02) 장부에 없는 이름으로 답했을 때(F-03). */
  | { kind: 'say'; text: string; chips?: Array<{ label: string; text: string }>; fill?: string; addCp?: { name: string } }
  | { kind: 'g24'; doc: G24Doc };

export type G24Doc = '주민등록표 등본' | '주민등록표 초본';

/** 되묻기 상태: 무엇을 물었는지와 그 전 문장들에서 받아 둔 값(거래처·금액·품목·부가세). */
export interface Pending {
  cp: Counterparty | null;
  asked: 'amount' | 'counterparty' | 'item' | null;
  amount: number | null;
  item: string | null;
  vat: VatMode | null;
}
export const emptyPending = (): Pending => ({ cp: null, asked: null, amount: null, item: null, vat: null });

/** 품목 칸 상한(엔진 run.start가 100자에서 자른다). */
export const ITEM_MAX = 100;
/** 품목을 물을 때(엔진은 품목이 비면 시작하지 않는다, item_missing). */
export const ASK_ITEM_TEXT = (cp: string) => `${cp}에 어떤 품목으로 발급할까요? 예: 컨설팅 용역`;
/** 품목으로 보지 않는 낱말(요청 동사·세금계산서·부가세·때·취소 등). 조사를 뗀 뒤에도 본다. */
const ITEM_STOP = /^(?:전자)?(?:세금)?계산서|^발급|^발행|^작성|^끊|^보내|^메일|^이메일|^해(?:\s?줘|주세요|요|라|줄래|주라|줘요)?$|^해줘|^줘|^주세요|^부탁|^좀$|^부가세|^vat$|^포함|^별도|^공급가|^합계|^금액|^이번|^이달|^오늘|^어제|^내일|^지난번|^같게|^같은|^그대로|^건$|^원$|^취소|^그만|^아니|^됐어|^몰라|^네$|^응$|^예$/i;
const PARTICLE = /(?:으로|로|에게|한테|에서|에|을|를|은|는|이|가|의|도|만|과|와|짜리)$/;
/** 품목 값 정리: 제어 문자·꺾쇠 빼고, 공백 하나로, 상한까지. 글자가 없으면 null. */
export function cleanItem(s: string): string | null {
  const v = s
    .replace(/[\p{Cc}<>]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, ITEM_MAX)
    .trim();
  return /[가-힣A-Za-z]/.test(v) ? v : null;
}
/**
 * 문장에서 품목 후보를 뽑는다("일호유통에 컨설팅 1000원" → 컨설팅, 되묻기에 "컨설팅 용역으로 해 줘" → 컨설팅 용역).
 * 거래처 이름·금액·요청 낱말·조사를 빼고 남은 낱말이다. 후보는 카드에 추정이 아닌 값으로 보이고 그 자리에서 고칠 수 있다.
 */
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

/** 요청 해석이 초안을 만드는 곳(shell-runs). 되묻기 상태는 대화(세션)마다 하나다. */
export interface Drafts {
  readonly pending: Pending;
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
    // 품목: 세금계산서 문장은 거래처가 하나일 때만(모르는 이름이 품목으로 들어가지 않게), 그 밖의 짧은 답은 되묻기("어떤 품목으로…")의 답 후보
    item: intent === 'invoice' ? (named.length === 1 ? extractItem(t, named[0]!.name) : null) : intent === 'other' && named.length <= 1 ? extractItem(t, named[0]?.name ?? null) : null,
  };
}

/** 거래처를 물었는데 장부에 없는 이름으로 답할 때 그 이름(F-03). 조사·"요"·"로 해 줘"를 뗀 짧은 낱말만. 아니면 null. */
const CP_ANSWER_TAIL = /\s*(?:(?:으로|로|에게|한테|에)\s*(?:해\s?(?:줘|주세요|요)|발급해\s?(?:줘|주세요)|끊어\s?(?:줘|주세요))|에게|한테|에|이요|이에요|예요|입니다|요)$/;
export const CP_NAME_MAX = 60;
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
/** 거래처가 하나도 없을 때(F-02). */
export const NO_CP_TEXT = '먼저 거래처를 추가해 주세요. 거래처를 넣으면 이어서 발급할게요.';
export const UNKNOWN_CP_TEXT = (name: string) => `${name}은(는) 장부에 없는 거래처예요. 거래처를 추가하면 이어서 발급할게요.`;

/**
 * 되묻던 것(거래처·금액)에 이 문장이 답하는가(interpret의 세금계산서 이어 가기와 같은 조건). 모델이 unknown이라도 이어 가기는 interpret가 맡고
 * 대화 응대(chat.respond)로 보내지 않는다("인스피릿", "50만원" 같은 짧은 답).
 */
export function answersPending(parsed: Parsed, runs: Drafts, text?: string): boolean {
  const asked = runs.pending.asked;
  const named = runs.counterparties.filter((c) => parsed.counterparties.includes(c.name));
  // 장부에 없는 이름으로 답해도 되묻기의 답이다(F-03: 일반 응대로 가지 않고 "장부에 없는 거래처예요" + [거래처 추가])
  const unknownCp = asked === 'counterparty' && named.length === 0 && parsed.amount === null && text !== undefined && cpNameFromAnswer(text) !== null;
  return (asked === 'amount' && parsed.amount !== null) || (asked === 'counterparty' && named.length === 1) || (asked === 'item' && parsed.item !== null) || unknownCp;
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
  // 거래처를 묻는 중 장부에 없는 이름(F-03): 되묻기를 끊지 않고 추가하게 한다. 받아 둔 금액·품목·부가세는 그대로 두고 다시 거래처를 기다린다.
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
    // 되묻던 중이면 그 전 문장들의 값(거래처·금액·품목·부가세)을 이어 쓴다. 거래처나 금액을 새로 말한 세금계산서 문장이면 새로 시작한다
    // (모델이 "컨설팅 용역" 같은 답을 세금계산서로 골라도 답으로 이어 간다).
    const cont = asked !== null && !(parsed.intent === 'invoice' && (named.length > 0 || amountNamed !== null));
    const cp = cpNamed ?? (cont && (asked === 'amount' || asked === 'item') ? pending.cp : null);
    const amount = amountNamed ?? (cont && (asked === 'counterparty' || asked === 'item') ? pending.amount : null);
    const item = parsed.item ?? (cont ? pending.item : null);
    const vatSaid = parsed.vat ?? (cont ? pending.vat : null);
    if (!cp) {
      Object.assign(pending, { cp: null, asked: 'counterparty', amount, item, vat: vatSaid });
      // 장부가 비었으면 고를 칩이 없다(F-02, 온보딩 O-05를 [나중에]로 넘긴 사용자): 추가부터
      if (!runs.counterparties.length) return { kind: 'say', text: NO_CP_TEXT, addCp: { name: '' } };
      return { kind: 'say', text: '어느 거래처에 발급할까요?', chips: (named.length > 1 ? named : runs.counterparties).map((c) => ({ label: c.name, text: c.name })) };
    }
    if (!amount) {
      Object.assign(pending, { cp, asked: 'amount', amount: null, item, vat: vatSaid });
      return { kind: 'say', text: `${cp.name}에 얼마를 발급할까요? 예: 330만원` };
    }
    // 품목: 문장에 없고 거래처 저장 품목도 없으면 카드 전에 묻는다(빈 칸 카드가 실행에서야 item_missing으로 멈추지 않게, 08 §5 "빠진 값만 묻는다")
    if (!item && !cleanItem(cp.item ?? '')) {
      Object.assign(pending, { cp, asked: 'item', amount, item: null, vat: vatSaid });
      return { kind: 'say', text: ASK_ITEM_TEXT(cp.name) };
    }
    Object.assign(pending, emptyPending());
    return { kind: 'draft', run: runs.createDraft(cp, amount, vat ?? vatSaid, item) };
  }
  if (parsed.intent === 'cert') return { kind: 'say', text: '증명서 발급은 곧 이 대화에서 할 수 있어요. 지금은 세금계산서 발급과 정부24 직접 발급 안내를 할 수 있어요.' };
  return { kind: 'say', text: '세금계산서나 증명서를 말해 주세요.', chips: QUICK.filter((q) => !q.soon) };
}

// ---- 실행 화면 모델 ----

export type RunStatus = 'draft' | 'preparing' | 'turn' | 'waiting' | 'issuing' | 'done' | 'stopped' | 'attention';
export type StepState = 'todo' | 'now' | 'done' | 'attention';

/**
 * 요청 해석 중 실제 송신(활동 기록 근거, 팀장 결정 2026-11-07 "via + 실제 송신 대상").
 * - openrouter_demo: 시연 모델(SAX_DEMO_MODEL, fixture)을 불렀다(성공 여부와 무관, 부르면 보낸 것이다).
 * - gateway.decide·gateway.run_tokens·gateway.respond: main이 그 경로의 게이트웨이 인증 헤더를 엔진에 내줬다(gateway-auth.ts onIssued).
 */
export type SentTo = 'openrouter_demo' | 'gateway.decide' | 'gateway.run_tokens' | 'gateway.respond';

/** 게이트웨이 경로 → SentTo(모르는 경로는 버린다). 같은 것은 한 번만, 순서는 고정. */
export function sentFromGateway(paths: readonly string[]): SentTo[] {
  const m: Record<string, SentTo> = { '/v1/run-tokens': 'gateway.run_tokens', '/v1/decide': 'gateway.decide', '/v1/respond': 'gateway.respond' };
  const got = new Set(paths.map((p) => m[p]).filter((x): x is SentTo => !!x));
  return (['gateway.run_tokens', 'gateway.decide', 'gateway.respond'] as const).filter((x) => got.has(x));
}

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
  /** 품목이 거래처 저장 품목에서 온 추정 값인가(문장·되묻기·카드에서 받았으면 false). */
  itemGuessed: boolean;
  /** 승인·게이트 전에 실패·핸드오프로 끝났다(발급 없음): 카드에 [다시 준비](같은 값의 새 초안) */
  redo?: boolean;
  /** 승인 전에 엔진이 이어 갈 수 없는 핸드오프로 끝냈다(end status handoff). 카드는 무슨 일인지와 [다시 준비]·[홈택스에서 직접 발급]을 보인다. */
  handoffEnd?: boolean;
  /** 초안만: 오늘 같은 거래처·같은 합계로 이미 발급한 실행이 있다(F-10, 이 앱이 켜진 동안의 발급). 승인 카드의 중복 경고보다 먼저 보인다. */
  dupToday?: boolean;
  writeDate: string;
  auth: string;
  steps: Array<{ label: string; state: StepState; note?: string }>;
  turn: { text: string; note: string } | null;
  confirmed: boolean;
  /** noFile: 발급 PDF를 보관하지 못했다(save_pdf.failed, F-04). */
  result: { approvalNo: string; mailTo: string; docId: string; doneAt: string; mailConfirmed: boolean; noFile?: boolean } | null;
  stoppedNote?: string;
  /** 승인 대기 카드의 고정 경고(중복 경고 등). 같은 값이 승인 바에도 있다. */
  warnings: string[];
  /** 승인 바 동작 글자(main이 게이트 fields로 정한 것). 카드 안내 문구가 같은 글자를 쓴다. */
  action?: string;
  /** 카드 꼬리 문장(포털 안내 문구·금고 알림). 텍스트로만 그린다. */
  notices?: string[];
  /** 다시 해도 되는 멈춤이었다(금고가 Chrome 확장을 보고 비밀 창을 거절). 발급 없이 끝난 카드에 [다시 시도]를 둔다. */
  retry?: 'extension';
  /** 홈택스에서 되읽은 값이 초안과 다르다. */
  readbackDiffers?: boolean;
  /** 승인했고 거부 우선 창(2초) 안이다. 이때 [중지]가 이긴다. */
  approvedPending?: boolean;
  /** 이 초안을 만든 요청 해석(활동 기록의 모델 줄). 시연 모델이면 'model'. */
  interp?: 'model' | 'offline';
  /** 이 요청을 해석하려고 앱이 실제로 보낸 곳(main이 관찰한 것). 활동 기록의 모델·우리 서버 줄은 이것으로만 만든다. 없거나 빈 배열이면 보낸 것 없음. */
  sent?: SentTo[];
  /** 발급됐는지 모른다(엔진 결과 in_doubt, 원장 in_doubt). 이 카드에는 다시 발급하는 버튼이 없다(08 §11). */
  inDoubt?: boolean;
  /** 발급목록 조회 몇 번째인지(엔진 verify 단계 이벤트의 attempt). 엔진이 보내지 않으면 없다. */
  verifyAttempt?: number;
  /** 이번 게이트가 다시 게이트인 이유와 그 고정 문구(main의 REGATE_NOTE에서 고른 것). */
  regate?: { reason: 'paused' | 'date_changed' | 'value_changed'; note: string };
  /** 핸드오프 중(status turn). afterGate면 게이트 뒤 단계에서 넘겨받은 것(중지는 엔진이 거부한다). */
  handoff?: { phase: string; afterGate: boolean } | null;
  /**
   * InDoubt 증언(ADR-021 결정 5). ready: 엔진이 증언을 받을 수 있다(이 카드를 열면 승인 바 자리에 황토색 바가 뜬다).
   * sent: 보냈고 엔진이 받았다. refused: 엔진이 받지 않았거나 보내지 못했다. 문구는 main의 ATTEST_NOTE에서 고른 것.
   */
  attest?: { state: 'ready' | 'sent' | 'refused'; note: string } | null;
}

/** 셸 문서함 곁 저장소(보관함 밖 서류·정부24 저장). 제품은 비어 있고(emptyDocStore), 시연은 견본 MockStore(shell-mock.ts)다. */
export interface DocStore {
  readonly files: Map<string, string>;
  readonly docs: Doc[];
  g24Save(candidateId: string, doc: G24Doc): Doc;
}

/** 제품의 곁 저장소: 견본 서류 없음. 정부24 후보를 보이지 않으므로 저장도 받지 않는다. */
export function emptyDocStore(): DocStore {
  return {
    files: new Map(),
    docs: [],
    g24Save: () => {
      throw new Error('bad_candidate');
    },
  };
}

/** 설정 bundle.reminderDay 기본값(02 §17). */
export const REMINDER_DAY_DEFAULT = 5;
