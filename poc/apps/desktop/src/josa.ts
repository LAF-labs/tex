// 조사 맞추기: 슬롯·토큰을 값으로 바꾼 바로 뒤의 조사를 값의 끝소리에 맞춘다.
// 모델은 값을 모르고 문장을 쓰므로 "{r1.sum.supply}예요"처럼 조사가 틀릴 수 있다. 바꾼 자리 바로 뒤만 본다.

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
