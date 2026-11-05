// V-01(B-35): IR·strings·selectors의 모든 정규식은 RE2로 컴파일되어야 한다.
// Node 기본에는 RE2가 없으므로, RE2가 받지 않는 문법(역참조·전후방 탐색·소유/원자 그룹·조건식)을 문법 단위로 거부하고
// 백트래킹 폭주 모양(반복 안의 반복)도 거부한 뒤 JS RegExp(u)로 컴파일한다. 받은 패턴은 RE2와 JS에서 같은 언어다.
// 실제 RE2 바인딩으로 바꾸는 것은 의존성 결정이라 팀장 확인 뒤(PR 본문 '못 한 것').

export type Re2Problem = 'empty' | 'too_long' | 'backreference' | 'lookaround' | 'unsupported_group' | 'nested_quantifier' | 'syntax';

const MAX_LEN = 300;

/** 패턴이 RE2 부분집합 안에 있으면 null, 아니면 문제 하나. */
export function re2Problem(pattern: string): Re2Problem | null {
  if (pattern.length === 0) return 'empty';
  if (pattern.length > MAX_LEN) return 'too_long';
  // 문자 하나씩 읽으며 이스케이프·문자 클래스를 건너뛴다.
  const groupHasQuant: boolean[] = [];
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '\\') {
      const n = pattern[i + 1] ?? '';
      if (!inClass && /[1-9]/.test(n)) return 'backreference';
      if (!inClass && n === 'k') return 'backreference';
      i++;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      continue;
    }
    if (c === '[') {
      inClass = true;
      continue;
    }
    if (c === '(') {
      if (pattern[i + 1] === '?') {
        const n = pattern[i + 2] ?? '';
        if (n === '=' || n === '!') return 'lookaround';
        if (n === '<' && (pattern[i + 3] === '=' || pattern[i + 3] === '!')) return 'lookaround';
        if (n === '>' || n === '(' || n === '|') return 'unsupported_group';
        // (?:  (?<name>  (?i) 류만 남는다. RE2는 (?P<name>)·(?<name>)·(?:)·플래그를 받는다.
      }
      groupHasQuant.push(false);
      continue;
    }
    if (c === ')') {
      const inner = groupHasQuant.pop() ?? false;
      const q = pattern[i + 1];
      const quantified = q === '*' || q === '+' || q === '?' || q === '{';
      // (a+)+ 류: 반복되는 그룹 안에 무한 반복이 있으면 거부(RE2는 받지만 JS에서는 폭주할 수 있다).
      if (inner && (q === '*' || q === '+' || (q === '{' && /^\{\d+,/.test(pattern.slice(i + 1))))) return 'nested_quantifier';
      if (groupHasQuant.length && (inner || quantified)) groupHasQuant[groupHasQuant.length - 1] = true;
      continue;
    }
    if ((c === '*' || c === '+') && groupHasQuant.length) groupHasQuant[groupHasQuant.length - 1] = true;
    if (c === '{' && /^\{\d+,\}/.test(pattern.slice(i)) && groupHasQuant.length) groupHasQuant[groupHasQuant.length - 1] = true;
  }
  if (inClass) return 'syntax';
  try {
    new RegExp(pattern, 'u');
  } catch {
    return 'syntax';
  }
  return null;
}

/** RE2 부분집합 검사를 통과한 패턴만 컴파일한다. 통과하지 못하면 던진다. */
export function compileRe2(pattern: string, flags = ''): RegExp {
  const p = re2Problem(pattern);
  if (p) throw new Error(`re2.${p}`);
  return new RegExp(pattern, `u${flags.replace(/u/g, '')}`);
}

/** `^…$` 앵커(SV-04·V-24·V-03j″). 끝의 `$`가 이스케이프된 것이면 앵커가 아니다. */
export function isAnchored(pattern: string): boolean {
  if (!pattern.startsWith('^') || !pattern.endsWith('$')) return false;
  let bs = 0;
  for (let i = pattern.length - 2; i >= 0 && pattern[i] === '\\'; i--) bs++;
  return bs % 2 === 0 && pattern.length >= 2;
}
