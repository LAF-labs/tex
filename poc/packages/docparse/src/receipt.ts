// 종이 증빙 규칙 파서(M6-4): OCR 글자 → 금액·날짜·상호·사업자번호·승인번호·카드 끝자리, 칸마다 신뢰도.
// 모델을 부르지 않는다(ADR-032 결정 11). 공제 가능 여부·경비 여부 같은 판정은 하지 않는다.
// 폰 앱(M7-5)의 기기 안 OCR 결과에도 같은 함수를 쓸 수 있다(입력은 글자와 줄 신뢰도뿐이다).
import type { Extracted, OcrLine, ReceiptDocKind, ReceiptResult, WarningCode } from './types.ts';
import { addDaysIso, combine, compact, conf, findDates, fixDigits, isValidBizNo, joinSpacedHangul, normText, parseWon } from './util.ts';

interface Line {
  i: number;
  text: string;
  c: string;
  ocr: number | null;
}

const none = <T>(reason: Extracted<T>['reason'] = 'not_found', candidates?: T[]): Extracted<T> => ({ value: null, confidence: 0, reason, ...(candidates?.length ? { candidates: candidates.slice(0, 6) } : {}) });
const got = <T>(value: T, confidence: number, candidates?: T[]): Extracted<T> => {
  const others = candidates?.filter((c) => c !== value);
  return { value, confidence: conf(confidence), reason: null, ...(others?.length ? { candidates: others.slice(0, 6) } : {}) };
};

function toLines(text: string, lines: OcrLine[] | undefined, ocr: number | null): Line[] {
  const raw = text.split('\n');
  // tesseract 줄 목록이 글자 줄과 같은 수면 줄마다 신뢰도를 쓴다. 아니면 전체 평균.
  const per = lines && lines.length === raw.length ? lines.map((l) => l.confidence) : null;
  return raw
    .map((t, i) => ({ i, text: normText(t), c: compact(t), ocr: per ? (per[i] ?? ocr) : ocr }))
    .filter((l) => l.text !== '');
}

// ── 서류 이름 ──
const KIND_RULES: Array<[RegExp, ReceiptDocKind]> = [
  [/세금계산서/, 'tax_invoice'],
  [/(?<!세금)계산서/, 'invoice'],
  [/현금영수증|현금\(?소득공제|지출증빙/, 'cash_receipt'],
  [/카드매출전표|신용카드매출|매출전표|신용승인|카드영수증|카드승인|IC승인|체크승인/, 'card_slip'],
  [/간이영수증/, 'simple_receipt'],
  [/영수증|RECEIPT/i, 'receipt'],
];

function docKind(lines: Line[]): ReceiptDocKind {
  const head = lines.slice(0, 12).map((l) => l.c).join('\n');
  const all = lines.map((l) => l.c).join('\n');
  for (const [re, k] of KIND_RULES) if (re.test(head)) return k;
  for (const [re, k] of KIND_RULES) if (re.test(all)) return k;
  return 'unknown';
}

// ── 금액 ──
/** 합계 라벨(앞이 우선). 같은 줄의 금액, 없으면 다음 줄의 첫 금액 */
const TOTAL_LABELS = ['받을금액', '결제금액', '총결제금액', '청구금액', '승인금액', '합계금액', '총합계', '판매합계', '합계', '총액', '총금액', '결제액', '거래금액', '판매금액', 'TOTAL', '금액'];
const NOT_TOTAL = /부가세|부가가치세|세액|공급가|과세물품|면세|봉사료|거스름|받은금액|받은돈|현금받음|할인|포인트|적립|잔액|단가|수량|합계수량|공급대가|VAT/i;
const VAT_LABELS = ['부가세', '부가가치세', '세액', 'VAT'];
const SUPPLY_LABELS = ['공급가액', '과세물품가액', '과세물품', '과세금액', '물품가액', '공급가'];

/** 날짜·시각·전화·사업자번호·카드번호 같은 숫자를 지운 뒤 금액 후보 */
function amounts(text: string): number[] {
  const t = normText(text)
    .replace(/\d{2,4}\s*[-./년]\s*\d{1,2}\s*[-./월]\s*\d{1,2}\s*일?/g, ' ')
    .replace(/\d{1,2}:\d{2}(:\d{2})?/g, ' ')
    .replace(/\d{2,4}-\d{3,4}-\d{4}/g, ' ')
    .replace(/\d{3}-\d{2}-\d{5}/g, ' ')
    .replace(/[\d*]{4}[- ][\d*]{4}[- ][\d*]{4}[- ][\d*]{3,4}/g, ' ');
  const out: number[] = [];
  const re = /(?<![\d.,])(-?\(?\d{1,3}(?:[,.]\d{3})+\)?|-?\d{1,9})(?:\s*원)?(?![\d.,]*\d)/g;
  for (let m = re.exec(t); m; m = re.exec(t)) {
    const v = parseWon(m[1]!);
    if (v !== null) out.push(v);
  }
  return out;
}

function labeledAmount(lines: Line[], labels: string[], exclude: RegExp | null): { value: number; line: Line; rank: number }[] {
  const hits: { value: number; line: Line; rank: number }[] = [];
  lines.forEach((l, k) => {
    const rank = labels.findIndex((lab) => l.c.toUpperCase().includes(lab.toUpperCase()));
    if (rank < 0) return;
    const lab = labels[rank]!;
    if (exclude && exclude.test(l.c.replace(new RegExp(lab, 'i'), ''))) return;
    // 라벨 뒤쪽 글자에서 금액(라벨 앞의 숫자는 수량일 수 있다)
    let vals = amounts(afterLabel(l.text, lab));
    if (!vals.length && lines[k + 1]) vals = amounts(lines[k + 1]!.text).slice(0, 1);
    const v = vals[vals.length - 1];
    if (v !== undefined && v >= 0) hits.push({ value: v, line: l, rank });
  });
  return hits;
}

/** 띄어 쓴 라벨("합 계")까지 고려해 라벨 뒤 글자를 돌려준다 */
function afterLabel(text: string, label: string): string {
  const pattern = label.split('').map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*');
  const m = new RegExp(pattern, 'i').exec(text);
  return m ? text.slice(m.index + m[0].length) : text;
}

function pickAmount(lines: Line[], warnings: Set<WarningCode>): { amount: Extracted<number>; supply: Extracted<number>; vat: Extracted<number> } {
  const totals = labeledAmount(lines, TOTAL_LABELS, NOT_TOTAL);
  const vats = labeledAmount(lines, VAT_LABELS, /공급가|합계|총/);
  const supplies = labeledAmount(lines, SUPPLY_LABELS, /부가세|세액/);
  const vat = vats[0] ? got(vats[0].value, combine(0.85, vats[0].line.ocr)) : none<number>();
  const supply = supplies[0] ? got(supplies[0].value, combine(0.85, supplies[0].line.ocr)) : none<number>();
  let amount: Extracted<number>;
  if (totals.length) {
    const best = Math.min(...totals.map((h) => h.rank));
    const top = totals.filter((h) => h.rank === best);
    const values = [...new Set(top.map((h) => h.value))];
    const all = [...new Set(totals.map((h) => h.value))];
    if (values.length === 1) {
      // '금액'(가장 약한 라벨)만 잡혔으면 약하게
      const strength = TOTAL_LABELS[best] === '금액' ? 0.55 : 0.85;
      amount = got(values[0]!, combine(strength, top[0]!.line.ocr), all);
    } else {
      // 같은 라벨에 다른 값이 여럿(품목 줄의 '금액' 등): 가장 큰 값을 후보 맨 앞에
      amount = none('ambiguous', values.sort((a, b) => b - a));
    }
  } else {
    // 라벨 없음: '원'이 붙었거나 천 단위 쉼표가 있는 가장 큰 수(약한 추정)
    const loose = lines.flatMap((l) => (/[,.]\d{3}|원/.test(l.text) ? amounts(l.text).map((v) => ({ v, l })) : []));
    const max = loose.sort((a, b) => b.v - a.v)[0];
    amount = max ? got(max.v, combine(0.35, max.l.ocr)) : none<number>();
  }
  // 교차 확인 1: 합계 라벨끼리 값이 다르면(받을금액 3,000 / 합계 13,000) 값은 두되 신뢰도를 낮추고 다른 값을 후보로
  const allTotals = [...new Set(totals.map((h) => h.value))];
  if (amount.value !== null && allTotals.length > 1) amount = { ...amount, confidence: conf(Math.min(amount.confidence, 0.5)) };
  // 교차 확인 2: 공급가액 + 부가세 = 합계면 셋 다 올린다. 어긋나면 경고하고 합계 신뢰도를 낮춘다(값은 그대로, 합을 후보로)
  if (amount.value !== null && supply.value !== null && vat.value !== null) {
    const sum = supply.value + vat.value;
    if (sum === amount.value && allTotals.length === 1) {
      return { amount: { ...amount, confidence: conf(Math.max(amount.confidence, 0.95)) }, supply: { ...supply, confidence: conf(Math.max(supply.confidence, 0.92)) }, vat: { ...vat, confidence: conf(Math.max(vat.confidence, 0.92)) } };
    }
    if (sum !== amount.value) {
      warnings.add('amount_cross_check_failed');
      amount = withCandidate({ ...amount, confidence: conf(Math.min(amount.confidence, 0.45)) }, sum);
      return { amount, supply: { ...supply, confidence: conf(Math.min(supply.confidence, 0.5)) }, vat: { ...vat, confidence: conf(Math.min(vat.confidence, 0.5)) } };
    }
  } else if (amount.value === null && amount.reason === 'ambiguous' && supply.value !== null && vat.value !== null) {
    const sum = supply.value + vat.value;
    if (amount.candidates?.includes(sum)) amount = got(sum, 0.8, amount.candidates);
  }
  // 교차 확인 3: 품목 줄 금액의 합(머리글 '품목·상품명' 줄과 합계 줄 사이 각 줄의 마지막 금액)
  // (세금계산서처럼 품목 칸이 공급가액이면 공급가액과 견주고, 품목마다 반올림한 차이 1원씩은 같다고 본다)
  const items = itemsSum(lines);
  if (items?.basis === 'total' && amount.value !== null) {
    if (items.sum !== amount.value) {
      warnings.add('amount_cross_check_failed');
      amount = withCandidate({ ...amount, confidence: conf(Math.min(amount.confidence, 0.45)) }, items.sum);
    } else amount = { ...amount, confidence: conf(Math.max(amount.confidence, 0.9)) };
  } else if (items?.basis === 'supply' && supply.value !== null && Math.abs(items.sum - supply.value) > items.n) {
    warnings.add('amount_cross_check_failed');
    return { amount: { ...amount, confidence: conf(Math.min(amount.confidence, 0.5)) }, supply: { ...supply, confidence: conf(Math.min(supply.confidence, 0.45)) }, vat };
  }
  return { amount, supply, vat };
}

function withCandidate(f: Extracted<number>, v: number): Extracted<number> {
  if (f.value === v) return f;
  const c = [v, ...(f.candidates ?? []).filter((x) => x !== v)].slice(0, 6);
  return { ...f, candidates: c };
}

/** 품목 줄 합계. 머리글 줄이 없거나 품목 줄 금액을 못 읽으면 null. 머리글 끝 칸이 공급가액·세액이면 공급가액 기준 */
function itemsSum(lines: Line[]): { sum: number; n: number; basis: 'total' | 'supply' } | null {
  const head = lines.findIndex((l) => /품목|상품명|품명/.test(l.c) && /금액|공급가액/.test(l.c));
  if (head < 0) return null;
  const end = lines.findIndex((l, k) => k > head && /합계|공급가액|과세물품|부가세|총액|받을금액/.test(l.c));
  const body = lines.slice(head + 1, end < 0 ? undefined : end).filter((l) => !/^-+$/.test(l.c));
  if (!body.length || body.length > 30) return null;
  let sum = 0;
  for (const l of body) {
    const v = amounts(l.text).at(-1);
    if (v === undefined) return null;
    sum += v;
  }
  return { sum, n: body.length, basis: /공급가액/.test(lines[head]!.c) ? 'supply' : 'total' };
}

// ── 날짜 ──
const DATE_LABELS = /거래일시|거래일자|거래일|판매일시|판매일자|판매일|승인일시|승인일자|결제일시|결제일자|매출일|발행일|작성일자|작성일|일시|일자|날짜|DATE/i;
const NOT_ISSUE_DATE = /유효기간|만료|교환|환불|반품|기한|까지|출력|인쇄/;

function pickDate(lines: Line[], today: string): Extracted<string> {
  const latest = addDaysIso(today, 1);
  const hits: Array<{ iso: string; line: Line; labeled: boolean }> = [];
  for (const l of lines) {
    if (NOT_ISSUE_DATE.test(l.c)) continue;
    const labeled = DATE_LABELS.test(l.c);
    for (const h of findDates(l.text, { compactYmd: labeled })) if (h.iso <= latest && h.iso >= '2000-01-01') hits.push({ iso: h.iso, line: l, labeled });
  }
  if (!hits.length) return none();
  const labeled = hits.filter((h) => h.labeled);
  const uniq = (xs: typeof hits) => [...new Set(xs.map((h) => h.iso))];
  if (labeled.length) {
    const vs = uniq(labeled);
    if (vs.length === 1) return got(vs[0]!, combine(0.9, labeled[0]!.line.ocr), uniq(hits));
    return none('ambiguous', vs.sort());
  }
  const vs = uniq(hits);
  if (vs.length === 1) return got(vs[0]!, combine(0.7, hits[0]!.line.ocr));
  return none('ambiguous', vs.sort());
}

// ── 사업자번호 ──
const BIZ_LABEL = /사업자|등록번호|사업자번호|BIZ|사업장번호/i;
/** 숫자 자리에 헷갈리는 글자가 섞인 xxx-xx-xxxxx 또는 라벨 옆 10자리 */
const BIZ_RE = /(?<![\dA-Za-z])([\dOoIlSBZ|]{3})\s*-\s*([\dOoIlSBZ|]{2})\s*-\s*([\dOoIlSBZ|]{5})(?![\d])/g;
const BIZ10_RE = /(?<!\d)(\d{10})(?!\d)/g;

function pickBizNo(lines: Line[], warnings: Set<WarningCode>): { field: Extracted<string>; line: number | null } {
  const valid: Array<{ v: string; line: Line; labeled: boolean }> = [];
  const invalid: string[] = [];
  for (const l of lines) {
    const labeled = BIZ_LABEL.test(l.c);
    const found: string[] = [];
    for (let m = BIZ_RE.exec(l.text); m; m = BIZ_RE.exec(l.text)) found.push(fixDigits(m[1]! + m[2]! + m[3]!));
    BIZ_RE.lastIndex = 0;
    if (labeled) for (let m = BIZ10_RE.exec(l.text.replace(/\s/g, '')); m; m = BIZ10_RE.exec(l.text.replace(/\s/g, ''))) found.push(m[1]!);
    BIZ10_RE.lastIndex = 0;
    for (const d of found) {
      if (!/^\d{10}$/.test(d)) continue;
      if (isValidBizNo(d)) valid.push({ v: d, line: l, labeled });
      else invalid.push(d);
    }
  }
  const distinct = [...new Set(valid.map((x) => x.v))];
  if (distinct.length === 0) {
    if (invalid.length) return { field: none('checksum_failed', [...new Set(invalid)]), line: null };
    // 라벨 줄에서 한 자리를 놓친 번호(OCR이 가는 '1'을 흔히 빠뜨린다): 한 자리를 채워 체크섬이 맞는 후보만 낸다(값은 정하지 않는다)
    const partial = lines.filter((l) => BIZ_LABEL.test(l.c)).flatMap((l) => [...l.text.matchAll(/(?<!\d)(\d{2,3})\s*-\s*(\d{1,2})\s*-\s*(\d{4,5})(?!\d)/g)].map((m) => fixDigits(m[1]! + m[2]! + m[3]!)));
    const fills = [...new Set(partial.filter((d) => d.length === 9).flatMap(fillOneDigit))];
    return { field: fills.length ? none('unparseable', fills) : none(), line: null };
  }
  if (distinct.length > 1) warnings.add('multiple_biz_no');
  const labeled = valid.filter((x) => x.labeled);
  const labeledDistinct = [...new Set(labeled.map((x) => x.v))];
  if (labeledDistinct.length === 1) return { field: got(labeledDistinct[0]!, combine(0.95, labeled[0]!.line.ocr), distinct), line: labeled[0]!.line.i };
  if (distinct.length === 1) return { field: got(distinct[0]!, combine(0.8, valid[0]!.line.ocr)), line: valid[0]!.line.i };
  // 여럿: 위쪽(가맹점·공급자 칸이 먼저 나온다)을 후보 맨 앞에 두되 정하지 않는다
  return { field: none('ambiguous', distinct), line: null };
}

/** 9자리에 한 자리를 넣어 체크섬이 맞는 10자리(최대 6개) */
function fillOneDigit(d: string): string[] {
  const out: string[] = [];
  for (let i = 0; i <= 9 && out.length < 6; i++) for (let k = 0; k <= 9 && out.length < 6; k++) {
    const c = d.slice(0, i) + k + d.slice(i);
    if (isValidBizNo(c) && !out.includes(c)) out.push(c);
  }
  return out;
}

// ── 상호 ──
const MERCHANT_LABELS = /^(상호명|상호|가맹점명|가맹점|판매처|판매자|매장명|점포명|업체명|공급자상호|상점명)/;
const HEADER_WORDS = /영수증|전표|승인|고객용|가맹점용|카드사용|매출|계산서|RECEIPT|현금|신용|체크|IC|감사합니다|어서오세요|WELCOME|사업자|대표|전화|TEL|주소|일시|번호|금액|합계|품명|수량|단가/i;

function cleanName(s: string): string {
  const name = normText(s)
    .replace(/^[\s:：-]+/, '')
    .replace(/\(?\s*(사업자|등록번호|대표|대표자|성명|TEL|전화|☎|주소).*$/i, '')
    .replace(/\d{3}-\d{2}-\d{5}.*$/, '')
    .replace(/\d{2,4}-\d{3,4}-\d{4}.*$/, '')
    .replace(/[^\p{Script=Hangul}A-Za-z0-9&().\-· ]/gu, '')
    .replace(/(^|\s)[\u3131-\u318E]+(?=\s|$)/g, ' ') // 떨어진 자모(OCR 잡음)
    .replace(/\s+/g, ' ')
    .trim();
  return joinSpacedHangul(name).slice(0, 40);
}

function pickMerchant(lines: Line[], bizLine: number | null): Extracted<string> {
  for (const l of lines) {
    const m = MERCHANT_LABELS.exec(l.c);
    if (!m) continue;
    // 라벨 뒤 글자(원래 띄어쓰기 유지)
    const after = cleanName(afterLabel(l.text, m[1]!));
    if (/[\p{Script=Hangul}A-Za-z]{2,}/u.test(after.replace(/\s/g, ''))) return got(after, combine(0.85, l.ocr));
  }
  // 라벨 없음: 위쪽 몇 줄 중 머리말이 아닌 첫 한글 줄, 또는 사업자번호 줄 바로 위
  const pool = lines.slice(0, 6).filter((l) => !HEADER_WORDS.test(l.c) && /\p{Script=Hangul}{2,}/u.test(l.c) && !/\d{3,}/.test(l.c));
  const near = bizLine !== null ? lines.find((l) => l.i === bizLine - 1 && !HEADER_WORDS.test(l.c) && /\p{Script=Hangul}{2,}/u.test(l.c)) : undefined;
  const pick = near ?? pool[0];
  if (!pick) return none();
  const name = cleanName(pick.text);
  return name.length >= 2 ? got(name, combine(near ? 0.55 : 0.4, pick.ocr)) : none();
}

// ── 승인번호·카드 끝자리 ──
function pickApproval(lines: Line[]): Extracted<string> {
  for (const l of lines) {
    if (!/승인번호|승인NO|APPROVAL/i.test(l.c)) continue;
    const m = /(?<!\d)(\d{6,10})(?!\d)/.exec(fixDigits(afterLabel(l.text, l.c.includes('승인번호') ? '승인번호' : '승인')).replace(/\s/g, ''));
    if (m) return got(m[1]!, combine(0.85, l.ocr));
  }
  return none();
}

function pickCardTail(lines: Line[]): Extracted<string> {
  for (const l of lines) {
    const t = l.text.replace(/\s/g, '');
    // 9410-12**-****-1234, 941012******1234, ****-****-****-1234
    const m = /(?:[\d*]{4}-?){3}([\d*]{3,4})/.exec(t);
    if (!m || !t.includes('*')) continue;
    const tail = m[1]!;
    if (/^\d{4}$/.test(tail)) return got(tail, combine(0.8, l.ocr));
  }
  return none();
}

export interface ReceiptInput {
  text: string;
  /** tesseract 줄 목록(있으면 줄마다 신뢰도를 쓴다) */
  lines?: OcrLine[];
  /** 전체 OCR 신뢰도(0~100). 텍스트 층이면 null */
  ocrConfidence: number | null;
  today: string;
}

export function parseReceipt(input: ReceiptInput): { result: ReceiptResult; warnings: WarningCode[]; confidence: number } {
  const warnings = new Set<WarningCode>();
  const lines = toLines(input.text, input.lines, input.ocrConfidence);
  const { amount, supply, vat } = pickAmount(lines, warnings);
  const biz = pickBizNo(lines, warnings);
  const result: ReceiptResult = {
    extractor: 'receipt-v1',
    docKind: docKind(lines),
    issuedOn: pickDate(lines, input.today),
    merchant: pickMerchant(lines, biz.line),
    merchantBizNo: biz.field,
    amount,
    supplyAmount: supply,
    vat,
    approvalNo: pickApproval(lines),
    cardTail: pickCardTail(lines),
  };
  const core = [result.amount, result.issuedOn, result.merchant, result.merchantBizNo];
  const confidence = conf(core.reduce((s, f) => s + f.confidence, 0) / core.length);
  if (result.amount.value === null || result.issuedOn.value === null) warnings.add('core_fields_missing');
  return { result, warnings: [...warnings], confidence };
}
