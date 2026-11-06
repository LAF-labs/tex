// 결정적 퍼징 도우미: 씨앗 고정 난수, JSON 변이 연산자. 실패하면 씨앗과 회차를 메시지에 남겨 재현한다.
// SAX_FUZZ_ITER(회차, 기본 300), SAX_FUZZ_SEED(씨앗, 기본 20261105)

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export const FUZZ_ITER = Number(process.env.SAX_FUZZ_ITER ?? 300);
export const FUZZ_SEED = Number(process.env.SAX_FUZZ_SEED ?? 20261105);

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

/** 이상한 값: 경계 숫자, 긴 문자열, 제어·보이지 않는 문자, 프로토타입 키, 위험 URL, ReDoS 모양 정규식. */
export const NASTY: readonly Json[] = [
  null, true, false, 0, -1, 1e308, -1e308, 2 ** 53 + 1, 0.5, Number.MAX_SAFE_INTEGER,
  '', ' ', 'a'.repeat(10_000), '\u0000', '‮발급', '​', '__proto__', 'constructor', 'prototype',
  'javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'https://evil.example/', '//evil.example',
  '(a+)+$', '(.*)*', '.*', '^$', '[', '\\', '$inputs.__proto__', '$vars.', '$intent.id', '{{name}}', '${x}',
  '<script>alert(1)</script>', '발급하기', '확인', 'Enter',
  [], {}, [null], JSON.parse('{"__proto__":{"polluted":true}}') as Json, { constructor: { prototype: { x: 1 } } },
];

interface Slot {
  parent: Json[] | { [k: string]: Json };
  key: string | number;
}

/** 모든 자리(부모, 키). 깊이 우선. */
export function slots(doc: Json): Slot[] {
  const out: Slot[] = [];
  const walk = (v: Json) => {
    if (Array.isArray(v)) {
      v.forEach((x, i) => {
        out.push({ parent: v, key: i });
        walk(x);
      });
    } else if (v && typeof v === 'object') {
      for (const k of Object.keys(v)) {
        out.push({ parent: v, key: k });
        walk(v[k]!);
      }
    }
  };
  walk(doc);
  return out;
}

const get = (s: Slot): Json => (s.parent as Record<string | number, Json>)[s.key]!;
const set = (s: Slot, v: Json) => ((s.parent as Record<string | number, Json>)[s.key] = v);

export type MutationName = 'delete' | 'replace' | 'duplicate' | 'swap' | 'retype' | 'nest';

/** doc을 제자리에서 한 번 변이한다. 무엇을 했는지 돌려준다. */
export function mutate(doc: Json, r: () => number): string {
  const all = slots(doc);
  if (!all.length) return 'none';
  const s = pick(r, all);
  const op: MutationName = pick(r, ['delete', 'replace', 'replace', 'duplicate', 'swap', 'retype', 'nest'] as const);
  const where = `${typeof s.key === 'number' ? `[${s.key}]` : `.${s.key}`}`;
  switch (op) {
    case 'delete':
      if (Array.isArray(s.parent)) s.parent.splice(s.key as number, 1);
      else delete s.parent[s.key as string];
      return `delete ${where}`;
    case 'replace': {
      const v = structuredClone(pick(r, NASTY));
      set(s, v);
      return `replace ${where}=${JSON.stringify(v)?.slice(0, 40)}`;
    }
    case 'duplicate':
      if (Array.isArray(s.parent)) s.parent.splice(s.key as number, 0, structuredClone(get(s)));
      else set(s, [structuredClone(get(s)), structuredClone(get(s))]);
      return `duplicate ${where}`;
    case 'swap': {
      const t = pick(r, all);
      const a = structuredClone(get(s));
      const b = structuredClone(get(t));
      // 자기 조상과 바꾸면 순환이 생기므로 복제본으로 바꾼다
      set(s, b);
      set(t, a);
      return `swap ${where}<->${String(t.key)}`;
    }
    case 'retype': {
      const v = get(s);
      set(s, typeof v === 'string' ? (Number(v) || v.length) : typeof v === 'number' ? String(v) : Array.isArray(v) ? Object.fromEntries(v.map((x, i) => [String(i), x])) : v && typeof v === 'object' ? Object.values(v) : String(v));
      return `retype ${where}`;
    }
    case 'nest':
      set(s, { [String(s.key)]: get(s) });
      return `nest ${where}`;
  }
}

/** 시간 상한 안에 끝나는지(무한 루프·지수 폭발 감지). */
export function timed<T>(f: () => T): { value: T; ms: number } {
  const t = performance.now();
  const value = f();
  return { value, ms: performance.now() - t };
}
