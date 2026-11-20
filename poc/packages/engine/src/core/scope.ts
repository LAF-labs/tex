
export interface RunScope {
  inputs: Readonly<Record<string, unknown>>;
  profile: Readonly<Record<string, unknown>>;
  intentId: string | null;
  vars: Map<string, string>;
  readbackOnly: Set<string>;
  human: Map<string, string>;
  readback: Map<string, string>;
  artifacts: Map<string, string>;
}

export function newScope(o: { inputs?: Record<string, unknown>; profile?: Record<string, unknown>; intentId?: string | null } = {}): RunScope {
  return {
    inputs: o.inputs ?? {},
    profile: o.profile ?? {},
    intentId: o.intentId ?? null,
    vars: new Map(),
    readbackOnly: new Set(),
    human: new Map(),
    readback: new Map(),
    artifacts: new Map(),
  };
}

export const isRef = (s: string): boolean => s.startsWith('$');

const ROOTS = ['inputs', 'vars', 'human', 'profile', 'readback', 'intent', 'artifacts'] as const;

const SEGMENT = /^([A-Za-z0-9_]+)((?:\[\d{1,3}\])*)$/;

function walk(v: unknown, path: string[]): unknown {
  let cur = v;
  const own = (o: unknown, k: string) => o !== null && typeof o === 'object' && !Array.isArray(o) && Object.prototype.hasOwnProperty.call(o, k);
  for (const seg of path) {
    const m = SEGMENT.exec(seg);
    if (!m || !own(cur, m[1]!)) return undefined;
    cur = (cur as Record<string, unknown>)[m[1]!];
    for (const ix of m[2]!.match(/\d+/g) ?? []) {
      if (!Array.isArray(cur)) return undefined;
      const i = Number(ix);
      if (i >= cur.length) return undefined;
      cur = cur[i];
    }
  }
  return cur;
}

/** 참조를 읽는다. 없는 이름·형식이 틀린 참조는 undefined. */
export function readRef(scope: RunScope, ref: string): unknown {
  if (!isRef(ref)) return undefined;
  const [root, ...path] = ref.slice(1).split('.');
  if (!root || !(ROOTS as readonly string[]).includes(root) || path.length === 0 || path.some((p) => p === '')) return undefined;
  switch (root) {
    case 'inputs':
      return walk(scope.inputs, path);
    case 'profile':
      return walk(scope.profile, path);
    case 'intent':
      return path.length === 1 && path[0] === 'id' ? (scope.intentId ?? undefined) : undefined;
    case 'vars':
      return path.length === 1 ? scope.vars.get(path[0]!) : undefined;
    case 'human':
      return path.length === 1 ? scope.human.get(path[0]!) : undefined;
    case 'readback':
      return path.length === 1 ? scope.readback.get(path[0]!) : undefined;
    case 'artifacts':
      return path.length === 1 ? scope.artifacts.get(path[0]!) : undefined;
  }
  return undefined;
}

/** 입력 칸에 넣을 스칼라 문자열로 바꾼다. 객체·배열·없음은 null. */
export function scalar(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'boolean') return String(v);
  return null;
}

/** 값이 비었는가(선택 입력이 없음, ifAbsent 판정). */
export const isAbsent = (v: unknown): boolean => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
