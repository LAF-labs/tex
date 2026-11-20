
export type Re2Problem = 'empty' | 'too_long' | 'backreference' | 'lookaround' | 'unsupported_group' | 'nested_quantifier' | 'syntax';

const MAX_LEN = 300;

/** 패턴이 RE2 부분집합 안에 있으면 null, 아니면 문제 하나. */
export function re2Problem(pattern: string): Re2Problem | null {
  if (pattern.length === 0) return 'empty';
  if (pattern.length > MAX_LEN) return 'too_long';
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
      }
      groupHasQuant.push(false);
      continue;
    }
    if (c === ')') {
      const inner = groupHasQuant.pop() ?? false;
      const q = pattern[i + 1];
      const quantified = q === '*' || q === '+' || q === '?' || q === '{';
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
