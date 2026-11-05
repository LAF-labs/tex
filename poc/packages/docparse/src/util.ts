// 규칙 파서 공용: 글자 정리, 금액·날짜·사업자번호 읽기, 신뢰도 계산. 판정은 하지 않는다(값과 신뢰도만).

/** NFC, 전각 숫자·기호 → 반각, 공백류 하나로 */
export function normText(s: string): string {
  return s
    .normalize('NFC')
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\u00A0\u2000-\u200A\u3000\t]+/g, ' ')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/[‐‑‒–—―−]/g, '-')
    .replace(/ +/g, ' ')
    .trim();
}

/** 라벨 비교용: 공백·구두점을 지운다("합 계 :" → "합계") */
export const compact = (s: string) => normText(s).replace(/[\s:：·.,()[\]{}<>*_|'"`~]/g, '');

/** OCR이 숫자 자리에서 흔히 헷갈리는 글자를 숫자로(숫자 칸 후보 안에서만 쓴다) */
export function fixDigits(s: string): string {
  return s.replace(/[OoㅇQD]/g, '0').replace(/[Il|!ㅣ]/g, '1').replace(/[Ss]/g, '5').replace(/B/g, '8').replace(/Z/g, '2').replace(/g/g, '9');
}

export function isValidBizNo(d: string): boolean {
  if (!/^\d{10}$/.test(d)) return false;
  const w = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(d[i]) * w[i]!;
  sum += Math.floor((Number(d[8]) * 5) / 10);
  return (10 - (sum % 10)) % 10 === Number(d[9]);
}

/**
 * 금액 글자 → 원 단위 정수. "12,000", "12.000"(점 천 단위), "₩12,000", "12,000원", "-3,000", "(3,000)"(음수 표기).
 * 소수점 금액(1,234.50)은 원 단위로 내림하지 않고 null(원화 서류에 없다. 다른 칸일 가능성이 크다).
 */
export function parseWon(raw: string | number | boolean | null | undefined): number | null {
  if (typeof raw === 'number') return Number.isSafeInteger(raw) ? raw : Number.isFinite(raw) && Math.abs(raw - Math.round(raw)) < 1e-6 ? Math.round(raw) : null;
  if (typeof raw !== 'string') return null;
  let s = normText(raw).replace(/[₩\\원\s]/g, '').replace(/^KRW/i, '');
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith('-')) {
    neg = !neg;
    s = s.slice(1);
  }
  if (/^\d{1,3}([,.]\d{3})+$/.test(s) && !/,\d{3}\.\d{3}/.test(s)) s = s.replace(/[,.]/g, '');
  if (!/^\d{1,13}$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? (neg ? -n : n) : null;
}

export const ISO_DATE = /^(19|20)\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export function isoDate(y: number, m: number, d: number): string | null {
  if (y < 100) y += 2000;
  if (y < 2000 || y > 2099 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null; // 2월 30일 같은 없는 날
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export interface DateHit {
  iso: string;
  index: number;
  length: number;
}

/**
 * 글자 안의 날짜를 모두 찾는다. 2026-11-03, 2026.11.03, 2026/11/03, 2026. 11. 3., 2026년 11월 3일, 20261103(라벨 옆에서만),
 * 두 자리 연도 26-11-03·26/11/03·26.11.03(앞뒤가 숫자가 아닐 때만).
 */
export function findDates(s: string, opts: { compactYmd?: boolean } = {}): DateHit[] {
  const out: DateHit[] = [];
  // OCR이 날짜와 시각을 붙여 읽은 경우("2026-09-0109:00"): 날짜 끝에 공백을 넣는다(같은 길이를 유지하려 시각 앞 글자를 바꾸지 않는다)
  const t = normText(s).replace(/(\d{4}\s*[-./]\s*\d{1,2}\s*[-./]\s*\d{2})(?=\d{1,2}:\d{2})/g, '$1 ');
  const re = /(?<!\d)(\d{4}|\d{2})\s*(?:[-./]|년)\s*(\d{1,2})\s*(?:[-./]|월)\s*(\d{1,2})(?:\s*일|\.)?(?!\d)/g;
  for (let m = re.exec(t); m; m = re.exec(t)) {
    const iso = isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
    if (iso) out.push({ iso, index: m.index, length: m[0].length });
  }
  if (opts.compactYmd) {
    const re8 = /(?<!\d)(20\d{2})(\d{2})(\d{2})(?!\d)/g;
    for (let m = re8.exec(t); m; m = re8.exec(t)) {
      const iso = isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
      if (iso && !out.some((h) => h.index === m!.index)) out.push({ iso, index: m.index, length: m[0].length });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

export const addDaysIso = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

/** 0~1로 자르고 소수 둘째 자리까지 */
export const conf = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 100) / 100;

/** 규칙 강도(0~1)와 OCR 줄 신뢰도(0~100, 없으면 텍스트 층이라 100)를 합친다. OCR이 낮으면 규칙이 맞아도 낮게. */
export const combine = (rule: number, ocr: number | null) => conf(rule * (0.55 + 0.45 * Math.min(1, Math.max(0.2, (ocr ?? 100) / 100))));

/** 'YYYYMMDD' 앞 7자리(생년월일 + 성별 자리) → 생년월일 ISO */
export function birthFromRrnFront(front7: string): string | null {
  if (!/^\d{7}$/.test(front7)) return null;
  const g = Number(front7[6]);
  const century = g === 1 || g === 2 || g === 5 || g === 6 ? 1900 : g === 3 || g === 4 || g === 7 || g === 8 ? 2000 : g === 9 || g === 0 ? 1800 : null;
  if (century === null) return null;
  const y = century + Number(front7.slice(0, 2));
  const m = Number(front7.slice(2, 4));
  const d = Number(front7.slice(4, 6));
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/** 한 글자씩 띄어 읽은 한글("가 나 다 식당")을 붙인다. 두 글자 이상 낱말 사이 띄어쓰기("김밥 천국")는 둔다 */
export function joinSpacedHangul(s: string): string {
  const toks = s.split(' ');
  const out: string[] = [];
  let run = '';
  for (const t of toks) {
    if (/^\p{Script=Hangul}$/u.test(t)) run += t;
    else if (run) {
      out.push(/^\p{Script=Hangul}/u.test(t) ? run + t : run, ...(/^\p{Script=Hangul}/u.test(t) ? [] : [t]));
      run = '';
    } else out.push(t);
  }
  if (run) out.push(run);
  return out.filter(Boolean).join(' ');
}
