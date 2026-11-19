// 값 공간의 작은 규칙: 조사 맞추기, 금액·날짜 표기, 부가세 나누기, 품목 정리.
import type { Vat } from './tables.ts';

/** 끝소리: 'none' 받침 없음, 'rieul' ㄹ 받침, 'other' 다른 받침, null 판단 못 함(영문 등). */
type Final = 'none' | 'rieul' | 'other';

/** 숫자는 한국어 읽기로(영 일 이 삼 사 오 육 칠 팔 구) */
const DIGIT_FINAL: Record<string, Final> = { '0': 'other', '1': 'rieul', '2': 'none', '3': 'other', '4': 'none', '5': 'none', '6': 'other', '7': 'rieul', '8': 'rieul', '9': 'none' };

export function finalOf(value: string): Final | null {
  const c = value.trimEnd().at(-1);
  if (!c) return null;
  if (c in DIGIT_FINAL) return DIGIT_FINAL[c]!;
  const code = c.charCodeAt(0) - 0xac00;
  if (code < 0 || code > 11171) return null;
  const jong = code % 28;
  return jong === 0 ? 'none' : jong === 8 ? 'rieul' : 'other';
}

/** [받침 있을 때, 받침 없을 때]. 긴 것부터 본다(이에요가 이보다 먼저). */
const PAIRS: Array<[string, string]> = [
  ['이에요', '예요'],
  ['이었', '였'],
  ['으로', '로'],
  ['은', '는'],
  ['이', '가'],
  ['을', '를'],
  ['과', '와'],
];
/** 한 글자 조사는 뒤가 한글이 아닐 때만 조사로 본다("가게"의 가를 바꾸지 않게). 였은 어간이라 늘 뒤에 한글이 온다. */
const HANGUL = /[가-힣]/;

/** value 바로 뒤에 오는 rest의 첫 조사를 value의 끝소리에 맞춰 돌려준다. */
export function fixJosa(value: string, rest: string): string {
  const f = finalOf(value);
  if (!f) return rest;
  for (const [withF, noF] of PAIRS) {
    for (const form of [withF, noF]) {
      if (!rest.startsWith(form)) continue;
      if (form.length === 1 && form !== '였' && HANGUL.test(rest.charAt(1))) continue;
      // 으로/로는 ㄹ 받침도 로
      const want = withF === '으로' ? (f === 'other' ? withF : noF) : f === 'none' ? noF : withF;
      return want + rest.slice(form.length);
    }
  }
  return rest;
}

/** text에서 re에 맞는 자리를 valueOf로 바꾸고, 바꾼 값 바로 뒤 조사를 맞춘다. valueOf가 null이면 그 자리는 그대로 둔다. */
export function fillWithJosa(text: string, re: RegExp, valueOf: (m: RegExpExecArray) => string | null): string {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  let out = '';
  let at = 0;
  let pendingValue: string | null = null;
  for (let m = g.exec(text); m; m = g.exec(text)) {
    const between = text.slice(at, m.index);
    out += pendingValue !== null ? fixJosa(pendingValue, between) : between;
    const v = valueOf(m);
    out += v ?? m[0];
    pendingValue = v;
    at = m.index + m[0].length;
  }
  const tail = text.slice(at);
  return out + (pendingValue !== null ? fixJosa(pendingValue, tail) : tail);
}

/** "550,000원". Intl 없이 쓴다(폰 엔진마다 toLocaleString 결과가 다를 수 있다). */
export function won(n: number): string {
  return `${String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}원`;
}

/** 날짜는 "10월 15일", 올해가 아니면 "2025년 12월 3일". date·today는 KST YYYY-MM-DD */
export function koDate(date: string, today: string): string {
  const md = `${Number(date.slice(5, 7))}월 ${Number(date.slice(8, 10))}일`;
  return date.slice(0, 4) === today.slice(0, 4) ? md : `${Number(date.slice(0, 4))}년 ${md}`;
}

/** KST 날짜(YYYY-MM-DD). Intl·시간대 DB 없이 UTC+9로 센다. */
export function kstDate(ms: number): string {
  return new Date(ms + 9 * 3_600_000).toISOString().slice(0, 10);
}

/** 세액은 공급가액의 10%에서 원 미만을 버린다. 포함 금액은 공급가 + 세액이 합계와 맞는 공급가를 찾는다. */
export function splitVat(amount: number, vat: Vat): { supply: number; tax: number; total: number } {
  const taxOf = (s: number) => Math.floor(s / 10);
  if (vat === 'separate') return { supply: amount, tax: taxOf(amount), total: amount + taxOf(amount) };
  const base = Math.floor((amount * 10) / 11);
  const supply = [base, base + 1, base - 1].find((s) => s > 0 && s + taxOf(s) === amount) ?? base;
  return { supply, tax: amount - supply, total: amount };
}

export const ITEM_MAX = 100;
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

export const AMOUNT_MAX = 1e12;
export const validAmount = (n: number): boolean => Number.isInteger(n) && n > 0 && n <= AMOUNT_MAX;
