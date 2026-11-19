// 대화 경로 가림 규칙(D06 §8, PR #296 판정 ②)과 금액·이름 읽기. PC 엔진(chat-agent.ts)과 폰 대화 코어가 같은 코드를 쓴다(ADR-047 결정 4):
// 같은 문장은 PC와 폰에서 같게 가려져야 한다. 순수 함수만 둔다(DB·Node API 없음). 장부는 부르는 쪽이 ChatRecord 목록으로 넘긴다.
import { normalizeForRedaction, type Redactor } from '@sax/redaction';

const KO_NUM: Record<string, string> = { 영: '0', 공: '0', 일: '1', 이: '2', 삼: '3', 사: '4', 오: '5', 육: '6', 륙: '6', 칠: '7', 팔: '8', 구: '9' };
const SMALL: Record<string, number> = { 십: 10, 백: 100, 천: 1000 };
const BIG: Record<string, number> = { 만: 1e4, 억: 1e8 };

const SINO = '영일이삼사오육칠팔구십백천만억';
/** 수 뒤에 올 수 있는 단위·조사(이 밖의 한글이 붙으면 낱말의 일부다: "천천히", "만들다") */
const NUM_TAIL = '(?=$|[^가-힣]|(?:원|건|월|일|년|개월|번째|에|에서|으로|로|을|를|이|가|은|는|도|만|짜리|정도|쯤|씩|예요|이에요|였|이었))';
/** 세션 Redactor별 대화 경로 추가 마스킹 상태(이번 장부 이름 정규식, 장부 이메일 조각 정규식). */
const CHAT_MASKS = new WeakMap<Redactor, { names: Array<{ re: RegExp }>; emails: RegExp[] }>();
const BARE_AMOUNT = /(?<![\dA-Za-z.,\-/_])(?:\d{1,3}(?:,\d{3})+|\d{5,})(?![\dA-Za-z.,\-/_])/gu;
/** 공백·점으로 끊은 금액: 550 000, 550.000, 1 100 000, 55 0000(만 단위) */
const SPLIT_AMOUNT = /(?<![\dA-Za-z.,\-/_])(?:\d{1,3}(?:[ .]\d{3})+|\d{1,4} \d{4})(?![\dA-Za-z,\-/_]|\.\d)/gu;
/** 통화 글자가 붙은 금액: KRW550000, 550000KRW, ₩550000, x550000 */
const CURRENCY_AMOUNT = /(?<![A-Za-z\d])(?:(?:KRW|₩|x)\s?(?:\d{1,3}(?:,\d{3})+|\d{4,})|(?:\d{1,3}(?:,\d{3})+|\d{4,})\s?KRW)(?![A-Za-z\d])/giu;
/** 기본 규칙이 놓치는 사업자번호 구분자(/·_·,·:, 앞뒤 한 칸 공백까지) */
const BIZNO_SLASH = /(?<![\d,])\d{3} ?[/_,:] ?\d{2} ?[/_,:] ?\d{5}(?![\d,])/gu;
/** 이메일 조각으로 가리지 않는 흔한 낱말(메일 업체·도메인 단계) */
const EMAIL_GENERIC = new Set(['www', 'mail', 'com', 'net', 'org', 'gmail', 'naver', 'daum', 'hanmail', 'kakao', 'nate', 'hotmail', 'outlook', 'yahoo', 'icloud']);
const escapeRe = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 장부 이메일의 조각(로컬 부분, 끝 단계를 뺀 도메인 단계, 3자 이상)을 낱말로 찾는 정규식. "tax at 도메인"·"(dot)" 꼴로 나누어 적어도 가린다. */
export function emailFragmentRes(emails: readonly string[]): RegExp[] {
  const frags = new Set<string>();
  for (const e of emails) {
    const [local, domain] = normalizeForRedaction(e).trim().toLowerCase().split('@');
    if (!local || !domain) continue;
    const labels = domain.split('.');
    for (const f of [local, ...labels.slice(0, -1)]) if (f.length >= 3 && !EMAIL_GENERIC.has(f)) frags.add(f);
  }
  return [...frags].sort((x, y) => y.length - x.length).map((f) => new RegExp(`(?<![A-Za-z0-9])${escapeRe(f)}(?![A-Za-z0-9])`, 'giu'));
}

/** 띄어 쓴 한글 금액(오십 만, 오 십 만, 백 만): 한 칸씩 띄운 한글 수 중 백·천·만·억이 든 것 */
const KO_AMOUNT_SPACED = new RegExp(`(?<![가-힣])[${SINO}](?: ?[${SINO}])+${NUM_TAIL}`, 'gu');
/** 한글 금액처럼 보이지만 인사·관용구인 것: "이만 끝낼게", "천만에요" */
const NOT_AMOUNT = (m: string, after: string) => (m === '이만' && /^\s?(?:끝|줄|하|가|갈|됐|되|마치|실례|들어가|일어나)/u.test(after)) || (m === '천만' && /^에요/u.test(after));

/**
 * 대화 입력을 가리기 전에 고르게 편다. 공백 덩어리는 한 칸으로(사전 이름의 공백 변형은 한 칸까지만 잡는다).
 * 띄어 쓴 금액 자리(550 000원, 1 100 000, 55 0000)는 붙인다. 기본 금액 규칙이 뒤 조각("000원")만 가리고 앞 수를 남기지 않게 한다.
 */
export function chatInput(text: string): string {
  return normalizeForRedaction(text)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(?<![\d.,] ?)\d{1,3}(?: \d{3})+(?! ?\d)/gu, (v) => v.replace(/ /g, ','))
    .replace(/(?<![\d.,] ?)\d{1,4} \d{4}(?! ?\d)/gu, (v) => v.replace(/ /g, ''));
}

/** 대화 경로 추가 마스킹 구간: 장부 이름 변형(NAME), 장부 이메일 조각(EMAIL), 구분자가 다른 사업자번호(BIZNO), 단위 없는·통화 글자가 붙은·끊어 쓴·띄어 쓴 금액(AMT). 앞이 이긴다. */
export function chatMaskSpans(t: string, names: ReadonlyArray<{ re: RegExp }>, emails: readonly RegExp[] = []): Array<{ start: number; end: number; kind: 'AMT' | 'NAME' | 'BIZNO' | 'EMAIL' }> {
  const out: Array<{ start: number; end: number; kind: 'AMT' | 'NAME' | 'BIZNO' | 'EMAIL' }> = [];
  const push = (m: RegExpMatchArray, kind: 'AMT' | 'NAME' | 'BIZNO' | 'EMAIL') => out.push({ start: m.index!, end: m.index! + m[0].length, kind });
  for (const x of names) for (const m of t.matchAll(x.re)) push(m, 'NAME');
  for (const re of emails) for (const m of t.matchAll(re)) push(m, 'EMAIL');
  for (const m of t.matchAll(BIZNO_SLASH)) push(m, 'BIZNO');
  for (const m of t.matchAll(CURRENCY_AMOUNT)) push(m, 'AMT');
  for (const m of t.matchAll(BARE_AMOUNT)) push(m, 'AMT');
  for (const m of t.matchAll(SPLIT_AMOUNT)) push(m, 'AMT');
  for (const m of t.matchAll(KO_AMOUNT)) if (!NOT_AMOUNT(m[0], t.slice(m.index! + m[0].length))) push(m, 'AMT');
  for (const m of t.matchAll(KO_AMOUNT_SPACED)) if (m[0].includes(' ') && /[백천만억]/u.test(m[0]) && !NOT_AMOUNT(m[0].replace(/ /g, ''), t.slice(m.index! + m[0].length))) push(m, 'AMT');
  return out;
}

// 답 숫자 규칙(PR #296 판정 ①): 슬롯·토큰 밖에 숫자가 있으면 답을 버린다. 숫자는 ASCII만이 아니다.
/** 단위 없는 한글 금액: 백·천·만·억이 든 한글 수 두 자 이상(오십만, 이백만, 삼천). 날짜(십오일)는 금액으로 보지 않는다. */
const KO_AMOUNT = new RegExp(`(?<![가-힣])(?=[${SINO}]*[백천만억])[${SINO}]{2,}${NUM_TAIL}`, 'gu');
const NUMBER_SHAPES: RegExp[] = [
  // 한글 수 두 자 이상이고 십·백·천·만·억이 든 것: 백이십일만, 일백이십일만, 십오일, 오십만
  new RegExp(`(?<![가-힣])(?=[${SINO}]*[십백천만억])[${SINO}]{2,}${NUM_TAIL}`, 'u'),
  // 달 이름(이월은 회계 낱말 "이월"과 같아서 뺀다)
  new RegExp(`(?<![가-힣])(?:시월|유월|십일월|십이월|[일삼사오육칠팔구]월)${NUM_TAIL}`, 'u'),
  // 고유어 건수: 두 건, 열한 건
  // "한 건씩"은 건수가 아니라 하나하나라는 말이다(chat-eval look-payables-sum: "화면에서 한 건씩 확인해 보세요"가 걸림)
  /(?<![가-힣])(?:한(?!\s*건씩)|두|세|네|다섯|여섯|일곱|여덟|아홉|열|스무|스물|서른|마흔|쉰)(?:한|두|세|네|다섯|여섯|일곱|여덟|아홉)?\s*건(?!물|강|설|축|너|전)/u,
  // 한자 수
  /[〇一二三四五六七八九十百千万萬億兆]/u,
];

/** 답 문장(슬롯·토큰을 뺀 것)에 수가 있는가: NFKC로 정규화한 뒤 모든 유니코드 숫자(전각·아랍-인도·원문자), 한글·한자 수, 고유어 건수. */
export function numberShaped(raw: string): boolean {
  // 관용구 "천만에요"·"천만의 말씀"은 수가 아니다(chat-eval 2026-11-19 chat-thanks: "천만에요, 사장님"이 금액으로 걸려 고정 문장으로 바뀜)
  const bare = raw.replace(/천만(?:에요|에\s*말씀|의\s*말씀)/gu, ' ');
  const t = normalizeForRedaction(bare).normalize('NFKC');
  return /\p{N}/u.test(bare) || /\p{N}/u.test(t) || NUMBER_SHAPES.some((re) => re.test(t)) || koNumberRun(t);
}

/** 띄어 쓴 한글 수(백 만 원, 오 십 만)와 한 글자 수 + 단위(만 원, 천 원, 십 원): 십·백·천·만·억이 들고, 두 자 이상이거나 단위가 붙은 것 */
const KO_NUM_RUN = new RegExp(`(?<![가-힣])[${SINO}](?: ?[${SINO}])*${NUM_TAIL}`, 'gu');
function koNumberRun(t: string): boolean {
  for (const m of t.matchAll(KO_NUM_RUN)) {
    const w = m[0].replace(/ /g, '');
    if (/[십백천만억]/u.test(w) && ([...w].length >= 2 || /^ ?(?:원|건|개|장|명|번|년|월|일|달)/u.test(t.slice(m.index! + m[0].length)))) return true;
  }
  return false;
}

/**
 * 금액 토큰의 원값("110만원", "1,100,000원", "3백만", "1억 2천", "삼백삼십만원")을 원 단위 정수로 읽는다. 읽을 수 없으면 null.
 * 억 뒤에 만 없이 남은 수는 만 단위로 읽는다("1억 2천" = 1억 2천만, 말로 쓰는 금액).
 */
export function parseKrw(raw: string): number | null {
  const s = normalizeForRedaction(raw)
    .replace(/[\s,원]/g, '')
    .replace(/[영공일이삼사오육륙칠팔구]/g, (c) => KO_NUM[c]!)
    // 단위 없이 점으로 세 자리씩 끊은 수(550.000)는 천 단위 구분이다(원에는 소수가 없다)
    .replace(/^\d{1,3}(?:\.\d{3})+$/, (v) => v.replace(/\./g, ''));
  if (!s) return null;
  let total = 0;
  let section = 0;
  let num: number | null = null;
  let lastBig = Infinity;
  let used = 0;
  for (const m of s.matchAll(/\d+(?:\.\d+)?|[십백천]|[만억]/g)) {
    const x = m[0];
    used += x.length;
    if (/\d/.test(x[0]!)) {
      if (num !== null) return null;
      num = Number(x);
    } else if (x in SMALL) {
      section += (num ?? 1) * SMALL[x]!;
      num = null;
    } else {
      const big = BIG[x]!;
      if (big >= lastBig) return null;
      total += (section + (num ?? 0) || 1) * big;
      section = 0;
      num = null;
      lastBig = big;
    }
  }
  if (used !== s.length) return null;
  let tail = section + (num ?? 0);
  if (lastBig === BIG['억'] && tail) tail *= BIG['만']!;
  total += tail;
  const n = Math.round(total);
  if (!(n > 0) || n > Number.MAX_SAFE_INTEGER || Math.abs(n - total) > 1e-6 * total) return null;
  return n;
}

/** 가림 사전에 올릴 장부 레코드 하나. recordId는 'cp:<거래처 id>'·'pf:<프로필 id>' 꼴이다. names[0]이 상호다. */
export interface ChatRecord {
  recordId: string;
  names: string[];
  emails: string[];
  bizNos: string[];
}

/**
 * 대화 경로 추가 마스킹(PR #296 판정 ②). 대화록과 도구 왕복으로 같은 문장이 여러 번 나가므로 기본 규칙이 놓치는 두 가지를 이 경로에서 가린다.
 * - 단위 없는 금액: 다섯 자리 이상 맨숫자·콤마 숫자(550000, 1,100,000), 백·천·만·억이 든 한글 수(오십만, 이백만).
 * - 구분자가 / · _ 인 사업자번호(100/64/14392).
 * - 장부 이름의 대소문자·띄어쓰기 변형(a상사, A 상사, LAF 테크, 한빛  전자, 김 철수). 그 이름의 레코드가 하나면 토큰을 레코드에 묶어 도구 인자로도 풀린다.
 * 가리는 것만 더한다(SpanFinder는 기본 규칙 뒤에 돌고 겹치면 기본 규칙이 이긴다).
 */
function maskVariants(red: Redactor, text: string, recs: ReadonlyArray<Pick<ChatRecord, 'recordId' | 'names' | 'emails'>>): void {
  const loose = (v: string) => v.replace(/\s+/g, '').toLowerCase();
  // 긴 이름부터 맞춘다(A상사몰이 A상사보다 먼저). 짧은 이름이 긴 이름의 앞을 먹지 않게 한다.
  const names = recs
    .flatMap((r) => r.names.map((n) => ({ recordId: r.recordId, name: normalizeForRedaction(n).replace(/\s+/g, ' ').trim() })))
    .filter((x) => [...loose(x.name)].length >= 2)
    .sort((a, b) => [...loose(b.name)].length - [...loose(a.name)].length);
  const owners = new Map<string, Set<string>>();
  for (const x of names) (owners.get(loose(x.name)) ?? owners.set(loose(x.name), new Set()).get(loose(x.name))!).add(x.recordId);
  const res = names.map((x) => ({ ...x, re: new RegExp([...x.name.replace(/\s/g, '')].map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*'), 'giu') }));
  let st = CHAT_MASKS.get(red);
  if (!st) {
    const fresh: { names: typeof res; emails: RegExp[] } = { names: [], emails: [] };
    red.addSpanFinder((t) => chatMaskSpans(t, fresh.names, fresh.emails));
    CHAT_MASKS.set(red, fresh);
    st = fresh;
  }
  st.names = res;
  st.emails = emailFragmentRes(recs.flatMap((r) => r.emails));
  // 이번 문장의 변형 낱말을 사전에 올리고 그 레코드에 묶는다. 사전에 올려야 기본 사전의 짧은 정확한 이름("A상사 몰"의 A상사)보다 긴 변형이 먼저 잡힌다.
  // 긴 이름의 변형 안에 든 짧은 이름 변형은 건너뛴다. 주인이 둘 이상인 이름의 변형은 가리기만 한다(되묻기).
  const t = normalizeForRedaction(text);
  const taken: Array<[number, number]> = [];
  for (const x of res) {
    for (const m of t.matchAll(x.re)) {
      const start = m.index!;
      const end = start + m[0].length;
      if (taken.some(([a, b]) => start < b && end > a)) continue;
      taken.push([start, end]);
      const lit = m[0].replace(/\s+/g, ' ').trim();
      if (lit === x.name) continue;
      red.addName(lit, { variant: true });
      if (owners.get(loose(x.name))!.size !== 1) continue;
      try {
        red.map.bindRecord(red.map.token('NAME', lit), x.recordId);
      } catch {
        // 다른 레코드에 이미 묶인 낱말이면 가리기만 한다
      }
    }
  }
}

/**
 * 마스킹 사전(intent.ts addNames와 같은 범위): 거래처 상호·대표자·이메일·사업자번호, 내 프로필 상호·대표자·사업자번호.
 * 두 레코드가 같은 값을 쓰면 그 값은 가리기만 하고 레코드에 묶지 않는다(역치환이 엉뚱한 거래처로 가지 않게).
 * 오타 거래처는 typoAliases로 그 거래처 별칭을 더한다. text는 chatInput을 지난 이번 문장이다.
 */
export function registerChatRecords(red: Redactor, text: string, recs: readonly ChatRecord[]): void {
  const key = (k: string, v: string) => `${k}\u0000${k === 'b' ? v.replace(/\D/g, '') : normalizeForRedaction(v).replace(/\s+/g, ' ').trim().toLowerCase()}`;
  const owners = new Map<string, Set<string>>();
  for (const r of recs) for (const [k, vs] of [['n', r.names], ['e', r.emails], ['b', r.bizNos]] as const) for (const v of vs) (owners.get(key(k, v)) ?? owners.set(key(k, v), new Set()).get(key(k, v))!).add(r.recordId);
  const sole = (k: string, v: string) => owners.get(key(k, v))!.size === 1;
  for (const r of recs) {
    for (const n of r.names) if (!sole('n', n)) red.addName(n);
    red.addRecord({ recordId: r.recordId, names: r.names.filter((n) => sole('n', n)), emails: r.emails.filter((e) => sole('e', e)), bizNos: r.bizNos.filter((b) => sole('b', b)) });
  }
  maskVariants(red, text, recs);
  const known = new Set(recs.flatMap((r) => r.names.map((n) => normalizeForRedaction(n).replace(/\s+/g, ' ').trim().toLowerCase())));
  for (const a of typoAliases(text, recs.filter((r) => r.recordId.startsWith('cp:')).map((r) => ({ recordId: r.recordId, name: r.names[0]! })), known)) {
    try {
      if (a.recordId) red.addRecord({ recordId: a.recordId, names: [a.alias] });
      else red.addName(a.alias, { variant: true });
    } catch {
      // 앞 턴에서 다른 거래처 별칭으로 묶인 낱말이면 그대로 둔다
    }
  }
}

/** 거래처 이름 뒤에 붙어도 이름의 일부가 아닌 말: 조사, 이다 꼴(인데·이고·라고), 건·거·꺼·것·쪽·측·님·서(에서 줄임) */
const NAME_TAIL = /^(?:입니다|이라고|이니까|이라서|에다가|이에요|에서|에게|인데|이고|이니|이라|라고|이지|이었|에다|보고|더러|인|였|한테|께서|이랑|으로|부터|까지|하고|처럼|보다|이나|이요|예요|이야|께|에|도|랑|와|과|은|는|이|가|을|를|의|로|만|나|요|야|건|거|꺼|것|쪽|측|님|서)*(?![\p{L}\p{N}])/u;

/** 잘린 이름 뒤에 붙는 격조사(끝 글자가 이것이면 오타가 아니라 잘린 이름 + 조사로 본다). 야·요·이처럼 이름 끝 글자로도 흔한 것은 뺀다. */
const CASE_JOSA = /^(?:에서|에게|한테|께서|이랑|으로|에|께|도|랑|와|과|은|는|을|를|의|로|만)(?![가-힣])/u;

/**
 * 이번 문장에서 이 이름 토큰이 모두 다른 글자에 붙어 있는가("신[NAME_1]에", "[NAME_1]몰에"). 그러면 장부에 없는 긴 이름의 일부라
 * 그 거래처로 풀지 않는다(되묻기). 이번 문장에 없는 토큰(앞 턴에서 온 것)은 보지 않는다.
 */
export function gluedName(user: string, tok: string, spaced = false): boolean {
  if (!/^\[NAME_\d+\]$/.test(tok)) return false;
  let at = user.indexOf(tok);
  if (at < 0) return false;
  for (; at >= 0; at = user.indexOf(tok, at + 1)) {
    const before = user.slice(0, at);
    const after = user.slice(at + tok.length);
    if (!/[\p{L}\p{N}]$/u.test(before) && NAME_TAIL.test(after) && !(spaced && trailingSyllable(after))) return false;
  }
  return true;
}

/** 띄어 쓴 이름 뒤에 한 글자 낱말이 이어지는가("A 상사 몰에"): 이름을 띄어 쓰는 사람에게 그 글자는 이름의 끝일 수 있다. 조사·흔한 한 글자 부사는 아니다. */
const ONE_SYLLABLE_WORDS = new Set([...'좀또꼭더다잘딱막쫌왜총약각첫새앞뒤몇한두세네전분씨및등']);
function trailingSyllable(after: string): boolean {
  const m = /^ ([가-힣])/u.exec(after);
  if (!m || ONE_SYLLABLE_WORDS.has(m[1]!) || NAME_TAIL.exec(after.slice(1))?.[0]) return false;
  return NAME_TAIL.test(after.slice(2));
}

/**
 * 오타 거래처 별칭: 문장 속 낱말 중 거래처 상호(3자 이상)와 길이가 같고 한 글자만 다르며(대소문자는 같은 글자로 본다), 이미 있는 이름(대소문자 무시)이 아니고,
 * 그렇게 가까운 거래처가 정확히 하나인 것. 둘 이상에 가까우면(A상사·B상사 사이의 C상사) 고르지 않는다.
 * 장부 이름(공백·대소문자 무시)이 든 낱말은 오타로 보기 전에 따진다. 이름 바로 뒤가 조사면(A상사몰이 있을 때 "A상사에") 정확한 이름이 이기니 별칭을 만들지 않는다.
 * 든 이름이 이 거래처 이름의 앞이고 남은 글자가 둘 이상이면 긴 이름의 오타다. 그 밖("A상사물")은 어느 거래처인지 모르니 recordId null로 돌려 가리기만 한다(되묻기).
 */
export function typoAliases(text: string, cps: Array<{ recordId: string; name: string }>, known: ReadonlySet<string>): Array<{ recordId: string | null; alias: string }> {
  const t = [...normalizeForRedaction(text)];
  const hits = new Map<string, Set<string>>();
  const asks = new Set<string>();
  const knownLow = [...known].map((k) => k.replace(/\s+/g, '').toLowerCase()).filter((k) => [...k].length >= 2);
  const knownSet = new Set(knownLow);
  for (const c of cps) {
    const n = [...normalizeForRedaction(c.name).trim().toLowerCase()];
    if (n.length < 3) continue;
    for (let i = 0; i + n.length <= t.length; i++) {
      const w = t.slice(i, i + n.length);
      if (!w.every((ch) => /[\p{L}\p{N}]/u.test(ch))) continue;
      const word = w.join('');
      const low = word.toLowerCase();
      if (knownSet.has(low) || [...low].filter((ch, k) => ch !== n[k]).length !== 1) continue;
      const inner = knownLow.filter((k) => low.includes(k));
      if (inner.length) {
        // 가장 긴 장부 이름이 앞에 있고 뒤가 조사·이다 꼴이면 그 이름이 이긴다(별칭 아님). 그 이름이 이 거래처 이름의 앞이기도 하고
        // 남은 글자가 둘 이상이면 긴 이름의 오타다(A상사몰코리야 → A상사몰코리아). 아니면 어느 쪽인지 모르니 되묻는다(A상사물).
        const head = inner.filter((k) => low.startsWith(k)).sort((x, y) => [...y].length - [...x].length)[0];
        const len = head ? [...head].length : 0;
        if (head && NAME_TAIL.test(t.slice(i + len).join(''))) continue;
        if (!(head && n.join('').startsWith(head) && n.length - len >= 2)) {
          asks.add(word);
          continue;
        }
      }
      // 끝 글자만 다르고 거기서 조사가 시작하면 잘린 이름 + 조사다(A상사몰코리에, A상에). 어느 거래처인지 모르니 되묻는다.
      if (low.at(-1) !== n.at(-1) && CASE_JOSA.test(t.slice(i + n.length - 1).join(''))) {
        asks.add(word);
        continue;
      }
      (hits.get(word) ?? hits.set(word, new Set()).get(word)!).add(c.recordId);
    }
  }
  return [
    ...[...hits].filter(([alias, ids]) => ids.size === 1 && !asks.has(alias)).map(([alias, ids]) => ({ recordId: [...ids][0]!, alias })),
    ...[...asks].map((alias) => ({ recordId: null, alias })),
  ];
}

// ── 발급 의도(사장님이 "세금계산서"라고 말하지 않아도) ──

/** 발급을 시키는 말. 사장님들이 실제로 쓰는 말: 끊다·떼다·발급·발행·끊어 주다, 줄임말(세계·계산서), 띄어 쓴 꼴 */
const ISSUE_VERB_RE = /(?:끊|떼|뗴|발급|발행|세금\s?계산서|세계|계산서|전자\s?세금|세금계산|tax\s?invoice)/iu;
/** 시키는 끝말(해 줘·하자·할게·해·부탁·ㄱㄱ). 끊어/떼/발급 뒤에 오거나 금액 뒤에 바로 온다. */
const ASK_END_RE = /^\s?(?:줘|주|줄|달|해|하|할|자|게|께|ㄱ|고고|부탁|드|요청|좀|요|\?|$)/u;
/** 발급이 아니라 조회·취소·질문으로 읽히는 말. 이게 있으면 발급 의도로 보지 않는다. */
const NOT_ISSUE_RE = /(?:끊은|끊었|뗀|뗐|발급한|발급했|발행한|발행했|발급된|발급 된|기록|내역|목록|보여|알려|얼마|몇\s?건|몇 개|언제|있어\?|있나|했어\?|했나|됐어|됐나|취소|수정|정정|지워|삭제|받을\s?돈|못\s?받|입금|매출|합계|어떻게|뭐야|무슨|왜)/u;
/** 금액만 말하고 시키는 꼴: "[AMT_1] 해 줘", "[AMT_1]짜리 하나", "[NAME_1] [AMT_1]" */
const AMOUNT_ASK_RE = /\[AMT_\d+\]\s?(?:짜리|어치|만큼|으로|로)?\s?(?:하나|한 장|한장|한 건|한건)?\s?(?:해|좀|부탁|ㄱㄱ|고고|요청|줘|주세요)/u;

export interface IssueIntent {
  /** 세금계산서를 만들어 달라는 말로 읽힌다 */
  issue: boolean;
  /** 문장에 금액 토큰이 있다 */
  amount: boolean;
  /** 문장에 거래처 이름 토큰이 있다 */
  counterparty: boolean;
}

/**
 * 가린 사용자 문장(토큰이 든 글)에서 발급 의도를 읽는다. 모델이 놓쳐도 앱이 발급 흐름(카드 만들기·되묻기)으로 잇게 하는 안전망이다.
 * - "[AMT_1] 끊어줘", "[NAME_1] [AMT_1] 떼 줘", "[AMT_1] 발급해줘", "계산서 [AMT_1]", "[NAME_1] [AMT_1] 해 줘" → 발급
 * - "지난주 끊은 거 보여 줘", "[NAME_1] 발급한 거 얼마야", "발급 취소해 줘" → 발급 아님(조회·취소)
 * 이름 없이 "[AMT_1]"만 있고 시키는 말도 없으면 발급으로 보지 않는다("[AMT_1] 들어왔어?" 같은 말).
 */
export function issueIntent(masked: string): IssueIntent {
  const t = masked.replace(/\s+/g, ' ').trim();
  const amount = /\[AMT_\d+\]/u.test(t);
  const counterparty = /\[NAME_\d+\]/u.test(t);
  const base = { amount, counterparty };
  if (!t || NOT_ISSUE_RE.test(t)) return { issue: false, ...base };
  const verb = ISSUE_VERB_RE.exec(t);
  if (verb) {
    const after = t.slice(verb.index + verb[0].length).replace(/^\s?(?:[어아여을를]|어\s?서)?/u, '');
    // "계산서"·"세계" 같은 이름말은 시키는 끝말이 없어도 금액·거래처와 함께면 발급이다("[NAME_1] 계산서 [AMT_1]")
    const noun = /계산서|세계|전자|tax/iu.test(verb[0]);
    if (ASK_END_RE.test(after) || (noun && (amount || counterparty))) return { issue: true, ...base };
  }
  if (amount && AMOUNT_ASK_RE.test(t)) return { issue: true, ...base };
  // 거래처와 금액만 말한 문장("[NAME_1] [AMT_1]", "[NAME_1]에 [AMT_1]요")은 이 앱에서 발급을 시키는 말이다
  if (amount && counterparty && t.replace(/\[(?:AMT|NAME)_\d+\]/gu, '').replace(/[\s.,!~]/gu, '').length <= 3) return { issue: true, ...base };
  return { issue: false, ...base };
}
