// P-08 규칙 파서: 폰 OCR 줄에서 금액·날짜·상호·사업자번호 후보를 뽑는다. 모델 없음(ADR-032 결정 11·ADR-034 결정 9).
// 결과는 입력 보조 후보일 뿐이고, 사장님이 확인·수정한다. PC docparse 샌드박스 OCR이 정본이다.
// 순수 함수(React Native·Expo 의존 없음) — node --test로 시험한다.

export interface Candidates {
  amount?: number;
  issuedOn?: string;
  merchant?: string;
  merchantBizNo?: string;
}

const TOTAL_KEYS = /(합\s*계|총\s*액|총\s*금\s*액|결\s*제\s*금\s*액|받\s*을\s*금\s*액|승\s*인\s*금\s*액|청\s*구\s*금\s*액|판\s*매\s*금\s*액|TOTAL|AMOUNT)/i;
const NOT_TOTAL = /(부\s*가\s*세|과\s*세|면\s*세|공\s*급\s*가|봉\s*사\s*료|할\s*인|거\s*스\s*름|받\s*은\s*돈|포\s*인\s*트|잔\s*액)/;
const MERCHANT_KEYS = /^(?:상\s*호(?:\s*명)?|가\s*맹\s*점(?:\s*명)?|매\s*장\s*명|업\s*체\s*명|판\s*매\s*자)\s*[:：]?\s*(.+)$/;
const NOISE_LINE = /(영수증|receipt|카드|승인|전화|tel|주소|대표|사업자|등록번호|일시|날짜|번호|POS|합계|금액|부가세|과세|면세|품명|수량|단가)/i;

/** 숫자 문자열 → 원. 쉼표·마침표 천 단위만 받는다. */
function money(s: string): number | null {
  const t = s.replace(/\s/g, '');
  if (!/^\d{1,3}([,.]\d{3})+$|^\d{1,9}$/.test(t)) return null;
  const n = Number(t.replace(/[,.]/g, ''));
  return Number.isSafeInteger(n) && n > 0 && n <= 100_000_000_000 ? n : null;
}

const NUM_RE = /(?<![\d-])(\d{1,3}(?:[,.]\d{3})+|\d{3,9})(?![\d-])\s*(원|₩)?/g;

function amountsIn(line: string): { n: number; won: boolean }[] {
  const out: { n: number; won: boolean }[] = [];
  // 날짜·시각·사업자번호·전화번호 꼴은 지운다
  const clean = line
    .replace(/\d{3}-\d{2}-\d{5}/g, ' ')
    .replace(/\d{2,4}[-./]\d{1,2}[-./]\d{1,2}/g, ' ')
    .replace(/\d{1,2}:\d{2}(:\d{2})?/g, ' ')
    .replace(/0\d{1,2}-\d{3,4}-\d{4}/g, ' ');
  for (const m of clean.matchAll(NUM_RE)) {
    const n = money(m[1]!);
    if (n !== null) out.push({ n, won: !!m[2] || /[,.]/.test(m[1]!) });
  }
  return out;
}

export function parseAmount(lines: string[]): number | undefined {
  let best: number | undefined;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (!TOTAL_KEYS.test(l) || NOT_TOTAL.test(l.replace(TOTAL_KEYS, ''))) continue;
    // 같은 줄, 없으면 다음 줄의 금액
    const here = amountsIn(l.replace(TOTAL_KEYS, ' '));
    const found = here.length ? here : amountsIn(lines[i + 1] ?? '');
    for (const a of found) if (best === undefined || a.n > best) best = a.n;
  }
  if (best !== undefined) return best;
  // 키워드가 없으면 원·천 단위 표기가 붙은 수 중 가장 큰 것
  for (const l of lines) for (const a of amountsIn(l)) if (a.won && (best === undefined || a.n > best)) best = a.n;
  return best;
}

function validDate(y: number, m: number, d: number, today: Date): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  const t = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const ms = dt.getTime();
  if (ms > t + 86_400_000 || ms < t - 5 * 366 * 86_400_000) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function parseDate(lines: string[], today = new Date()): string | undefined {
  const full = /(20\d{2})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})/;
  const short = /(?<!\d)(\d{2})[-./](\d{2})[-./](\d{2})(?!\d)/;
  for (const l of lines) {
    const m = full.exec(l);
    if (m) {
      const v = validDate(+m[1]!, +m[2]!, +m[3]!, today);
      if (v) return v;
    }
  }
  for (const l of lines) {
    const m = short.exec(l);
    if (m) {
      const v = validDate(2000 + +m[1]!, +m[2]!, +m[3]!, today);
      if (v) return v;
    }
  }
  return undefined;
}

/** 사업자등록번호 검증(국세청 가중치 1,3,7,1,3,7,1,3,5). */
export function validBizNo(digits: string): boolean {
  if (!/^\d{10}$/.test(digits)) return false;
  const w = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += +digits[i]! * w[i]!;
  sum += Math.floor((+digits[8]! * 5) / 10);
  return (10 - (sum % 10)) % 10 === +digits[9]!;
}

export function parseBizNo(lines: string[]): string | undefined {
  const re = /(?<!\d)(\d{3})\s*-?\s*(\d{2})\s*-?\s*(\d{5})(?!\d)/g;
  for (const l of lines) {
    for (const m of l.matchAll(re)) {
      const d = `${m[1]}${m[2]}${m[3]}`;
      if (validBizNo(d)) return `${m[1]}-${m[2]}-${m[3]}`;
    }
  }
  return undefined;
}

export function parseMerchant(lines: string[]): string | undefined {
  for (const l of lines) {
    const m = MERCHANT_KEYS.exec(l.trim());
    if (m) {
      const v = tidy(m[1]!);
      if (v) return v;
    }
  }
  // 위에서 세 줄 안의, 한글이 반 넘는 짧은 줄
  for (const l of lines.slice(0, 3)) {
    const t = tidy(l);
    if (!t || NOISE_LINE.test(t)) continue;
    const hangul = (t.match(/[가-힣]/g) ?? []).length;
    if (hangul >= 2 && hangul / t.replace(/\s/g, '').length >= 0.5) return t;
  }
  return undefined;
}

function tidy(s: string): string | undefined {
  const t = s.replace(/\p{Cc}/gu, '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return t.length >= 2 ? t : undefined;
}

export function parseReceipt(lines: string[], today = new Date()): Candidates {
  const c: Candidates = {};
  const amount = parseAmount(lines);
  const issuedOn = parseDate(lines, today);
  const merchant = parseMerchant(lines);
  const merchantBizNo = parseBizNo(lines);
  if (amount !== undefined) c.amount = amount;
  if (issuedOn) c.issuedOn = issuedOn;
  if (merchant) c.merchant = merchant;
  if (merchantBizNo) c.merchantBizNo = merchantBizNo;
  return c;
}
