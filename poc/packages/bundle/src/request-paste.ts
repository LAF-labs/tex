// 세무사 요청 문자·메일 붙여넣기 → 꾸러미 항목 후보(D14 M6-7, ADR-032 결정 8·11). 규칙 사전만 쓴다(모델 없음).
// - 붙여 넣은 글은 데이터로만 다룬다. 글 안의 지시를 따르지 않고, 저장하지 않고, 로그에 남기지 않는다.
// - 결과는 후보뿐이다. 사장님이 이름·주기를 고친 뒤 고른 것만 bundle.addItem(source: 'pasted_request')으로 넣는다. 여기서는 DB에 쓰지 않는다.
// - 1·2층에 이미 있는 자료(세금계산서·카드·급여대장·종이 증빙·정산·현금매출)는 새 항목이 아니라 그 항목을 가리킨다.
// - 세무 판단(공제 여부·신고) 문구는 만들지 않는다. 후보 이름은 서류 이름이다.
import type { BundleCadence, BundleItem } from '@sax/db';
import { BundleError, TIER2, type BuiltinKind, type Industry, type IndustryKind } from './items.ts';

/** 붙여 넣는 글 상한(문자 한 통·메일 한 통) */
export const REQUEST_TEXT_MAX = 10_000;
/** 후보 수 상한 */
export const REQUEST_CANDIDATES_MAX = 20;
/** 규칙으로 뽑은 이름 길이 상한(bundle.addItem 이름 상한 60보다 짧게) */
const PATTERN_NAME_MAX = 40;

export type RequestBasis = 'dictionary' | 'pattern';

export interface RequestCandidate {
  /** 화면 기본값(사장님이 고친다). 사전 항목은 정해진 이름, 규칙 항목은 글에서 뽑은 서류 이름 */
  name: string;
  /** 글에 주기 말이 있으면 그것, 없으면 사전 기본값(규칙 항목은 monthly) */
  cadence: BundleCadence;
  /** 주기를 글에서 읽었는가(false면 기본값이라 화면이 확인을 받는다) */
  cadenceFromText: boolean;
  basis: RequestBasis;
  /** 이미 있는 1·2층 항목이면 그 항목(새로 넣지 않는다). 2층이 꺼져 있으면 itemId null과 industry로 켜기를 안내한다 */
  existing: { kind: BuiltinKind | IndustryKind; itemId: string | null; industry?: Industry } | null;
  /** 같은 3층 항목(이름 같음)이 이미 켜져 있으면 그 id */
  duplicateOf: string | null;
}

interface DictEntry {
  re: RegExp;
  name: string;
  cadence: BundleCadence;
  kind?: BuiltinKind | IndustryKind;
}

/**
 * 사전(앞에서부터 먼저 맞는 것). 이름은 서류 이름만 쓴다. 1·2층 kind가 있으면 기존 항목을 가리킨다.
 * 순서: 더 구체적인 말(수정세금계산서·배달앱 정산)을 일반 말(세금계산서·정산)보다 앞에 둔다.
 */
const DICT: DictEntry[] = [
  { re: /(배달\s*앱|배민|배달의\s*민족|요기요|쿠팡\s*이츠|땡겨요)\s*.{0,6}정산/, name: '배달앱 월별 정산내역', cadence: 'monthly', kind: 'settlement_delivery' },
  { re: /(오픈\s*마켓|스마트\s*스토어|쿠팡|11번가|지마켓|G마켓|옥션)\s*.{0,6}정산/i, name: '오픈마켓 월별 정산내역', cadence: 'monthly', kind: 'settlement_market' },
  { re: /현금\s*매출/, name: '현금매출 내역(영수증 미발행)', cadence: 'monthly', kind: 'cash_sales' },
  { re: /(전자\s*)?(세금\s*)?계산서|매출\s*.{0,2}매입\s*(자료|내역)/, name: '매출·매입 세금계산서', cadence: 'monthly', kind: 'tax_invoice' },
  { re: /(사업용\s*)?(신용\s*)?카드\s*(사용\s*)?(내역|명세|전표)|카드\s*값/, name: '사업용 신용카드 사용내역', cadence: 'monthly', kind: 'card' },
  { re: /급여\s*(대장|명세)|임금\s*(대장|명세)|인건비\s*(자료|내역)/, name: '급여대장', cadence: 'monthly', kind: 'payroll' },
  { re: /간이\s*영수증|종이\s*(영수증|증빙|세금계산서)|영수증\s*(사진|원본)/, name: '종이 세무자료(종이 세금계산서·계산서·간이영수증)', cadence: 'monthly', kind: 'paper_receipt' },
  // 3층(업체별 추가 항목, ADR-032 결정 2 예시와 세무사 요청에 흔한 서류)
  { re: /임대\s*차?\s*계약서|임대차\s*계약|월세\s*계약서/, name: '임대차계약서', cadence: 'once' },
  { re: /월세\s*.{0,4}(이체|납부|송금)\s*(내역|확인)|임차료\s*(이체|납부)/, name: '월세 이체내역', cadence: 'monthly' },
  { re: /차량\s*운행\s*(일지|기록부?)|운행\s*기록부/, name: '차량 운행일지', cadence: 'monthly' },
  { re: /(해외|외화)\s*결제\s*.{0,4}(인보이스|영수증|내역)|인보이스/i, name: '해외 결제 인보이스', cadence: 'monthly' },
  { re: /대출\s*.{0,4}이자\s*(내역|납입|상환|증명)|이자\s*(납입|상환)\s*(내역|증명)/, name: '대출 이자 내역', cadence: 'monthly' },
  { re: /(사업용\s*)?(통장|계좌|은행)\s*(거래\s*)?(내역|입출금)/, name: '통장 거래내역', cadence: 'monthly' },
  { re: /통장\s*사본/, name: '통장 사본', cadence: 'once' },
  { re: /(4|사)\s*대\s*보험\s*.{0,6}(고지|납부)|건강\s*보험\s*.{0,4}고지|국민\s*연금\s*.{0,4}고지/, name: '4대보험 고지·납부내역', cadence: 'monthly' },
  { re: /(전기|수도|가스|통신)\s*(요금|료)|공과금/, name: '공과금 고지서(전기·수도·가스·통신)', cadence: 'monthly' },
  { re: /관리비\s*(고지서|내역)?/, name: '관리비 고지서', cadence: 'monthly' },
  { re: /(리스|렌트|렌탈)\s*.{0,4}(계약서|약정)/, name: '리스·렌트 계약서', cadence: 'once' },
  { re: /(리스|렌트|렌탈)\s*(료|비)\s*.{0,4}(내역|납부)/, name: '리스·렌트료 납부내역', cadence: 'monthly' },
  { re: /보험료\s*(납입|납부)\s*(증명|내역)/, name: '보험료 납입증명', cadence: 'once' },
  { re: /거래\s*명세서/, name: '거래명세서', cadence: 'monthly' },
  { re: /재고\s*(현황|목록|조사|자산)/, name: '재고 현황', cadence: 'once' },
  { re: /(기계|설비|차량|비품|자산)\s*.{0,4}(구입|취득|매입)\s*(계약서|영수증|자료)/, name: '자산 구입 자료', cadence: 'once' },
  { re: /수출\s*(신고\s*)?필증|수출\s*실적/, name: '수출신고필증', cadence: 'monthly' },
  { re: /사업자\s*등록증(?!\s*명)\s*(사본)?/, name: '사업자등록증 사본', cadence: 'once' },
  { re: /신분증\s*사본/, name: '대표자 신분증 사본', cadence: 'once' },
];

/** 사전에 없는 서류: "<명사구> + 서류 꼬리말" 다음에 요청 말이 오면 후보로 뽑는다 */
const DOC_TAIL = '(?:계약서|명세서|명세|내역서|내역|증명서|확인서|영수증|고지서|일지|사본|자료|목록|현황|필증|대장)';
const ASK = '(?:보내|주세요|주시|부탁|필요|전달|첨부|올려|제출|챙겨|준비)';
const PATTERN = new RegExp(`([가-힣A-Za-z0-9][가-힣A-Za-z0-9·()\\s]{0,30}?${DOC_TAIL})\\s*(?:을|를|도|좀|은|는|이|가|와|과|랑|및|,)?\\s*(?:[가-힣\\s]{0,8})?${ASK}`, 'g');
/** 뽑은 이름 앞의 군말(인사·호칭·조사)과 주기 말 */
const LEAD_NOISE = /^(?:(?:사장님|대표님|안녕하세요|그리고|또|추가로|혹시|이번\s*달|이번\s*분기|이번|지난\s*달|매달|매월|월별|분기별|분기마다|분기|연\s*1회|처음|최초|한\s*번)\s*)+/;
/**
 * 서류가 아니라 신고 묶음을 가리키는 말("부가세 자료", "결산 서류")은 후보로 만들지 않는다. 세무 판단처럼 읽히는 이름도 피한다.
 * 이런 요청은 꾸러미 전체가 답이다.
 */
const GENERIC = /^(?:(?:부가세|부가가치세|종소세|종합소득세|법인세|원천세|세금|신고|결산|세무|기장|장부|관련|필요한|모든|각종|기타|전체|나머지)\s*)+(?:관련\s*)?(?:자료|서류|내역|목록|현황)$/;
const MONTHLY = /매\s*달|매\s*월|월\s*별|달\s*마다|월\s*마다|매\s*월말|월말/;
const QUARTERLY = /분기|3\s*개월\s*마다|석\s*달/;
const ONCE = /한\s*번|1\s*회|최초|처음에?|이번\s*한/;

/** 한 덩어리(줄·문장·목록 항목) 단위로 자른다. 주기 말은 같은 덩어리 안에서만 본다 */
function segments(text: string): string[] {
  return text
    .split(/\r?\n|(?<=[.!?。])\s+|[;•▪◦·]\s+|(?:^|\s)(?:\d{1,2}[.)]|[-*])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function cadenceIn(seg: string): BundleCadence | null {
  if (QUARTERLY.test(seg)) return 'quarterly';
  if (MONTHLY.test(seg)) return 'monthly';
  if (ONCE.test(seg)) return 'once';
  return null;
}

const clean = (s: string) => s.replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim();

export interface RequestCandidatesInput {
  text: string;
  /** 이 프로필의 지금 항목(BundleRepo.items) */
  items: readonly BundleItem[];
}

/** 붙여 넣은 글 → 항목 후보(같은 이름은 한 번만, 글에 나온 순서). 글이 비었거나 너무 길면 bad_request_text */
export function requestCandidates(input: RequestCandidatesInput): RequestCandidate[] {
  const raw = input.text;
  if (typeof raw !== 'string' || !raw.trim() || [...raw].length > REQUEST_TEXT_MAX) throw new RequestPasteError('bad_request_text');
  const text = raw.normalize('NFKC');
  const out: RequestCandidate[] = [];
  const seen = new Set<string>();
  const push = (name: string, cadence: BundleCadence | null, fallback: BundleCadence, basis: RequestBasis, kind?: BuiltinKind | IndustryKind) => {
    if (seen.has(name) || out.length >= REQUEST_CANDIDATES_MAX) return;
    seen.add(name);
    out.push({ name, cadence: cadence ?? fallback, cadenceFromText: cadence !== null, basis, existing: kind ? existingOf(input.items, kind) : null, duplicateOf: kind ? null : duplicateOf(input.items, name) });
  };
  for (const seg of segments(text)) {
    const cad = cadenceIn(seg);
    // 한 덩어리에 사전 말이 여럿이면 모두(예: "카드 내역이랑 통장 거래내역 보내 주세요")
    const hits = DICT.map((d) => ({ d, at: seg.search(d.re) })).filter((h) => h.at >= 0).sort((a, b) => a.at - b.at);
    const covered: Array<[number, number]> = [];
    for (const { d } of hits) {
      const m = seg.match(d.re)!;
      covered.push([m.index!, m.index! + m[0].length]);
      push(d.name, cad, d.cadence, 'dictionary', d.kind);
    }
    for (const m of seg.matchAll(PATTERN)) {
      const s = m.index!;
      const e = s + m[1]!.length;
      if (covered.some(([a, b]) => s < b && e > a)) continue;
      const name = clean(m[1]!.replace(LEAD_NOISE, ''));
      if ([...name].length < 2 || [...name].length > PATTERN_NAME_MAX || new RegExp(`^${DOC_TAIL}$`).test(name) || GENERIC.test(name)) continue;
      push(name, cad, 'monthly', 'pattern');
    }
  }
  return out;
}

function existingOf(items: readonly BundleItem[], kind: BuiltinKind | IndustryKind): RequestCandidate['existing'] {
  const it = items.find((i) => i.kind === kind && (i.tier === 1 || i.tier === 2));
  const industry = (Object.keys(TIER2) as Industry[]).find((k) => TIER2[k].kind === kind);
  if (it?.enabled) return { kind, itemId: it.id };
  return { kind, itemId: null, ...(industry ? { industry } : {}) };
}

function duplicateOf(items: readonly BundleItem[], name: string): string | null {
  return items.find((i) => i.tier === 3 && i.enabled && i.name === name)?.id ?? null;
}

/** BundleError라 BundleService가 code만 넘긴다 */
export class RequestPasteError extends BundleError {}
