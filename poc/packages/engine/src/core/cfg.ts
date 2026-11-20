import type { OnFail, PlaybookIR, Step } from './types.ts';

export const END = 'END';
export const ABORT = 'ABORT';
export const FALLOFF = 'FALLOFF';
export const hNode = (from: string) => `H:${from}`;
export const secretNode = (from: string) => `SECRET:${from}`;
export const isSynthetic = (n: string) => n === END || n === ABORT || n === FALLOFF || n.startsWith('H:') || n.startsWith('SECRET:');

export type EdgeKind =
  | 'fall'
  | 'body'
  | 'out'
  | 'fail'
  | 'recover'
  | 'resume'
  | 'rewind'
  | 'implicit'
  | 'observed';

export interface StepInfo {
  step: Step;
  repeats: string[];
  next: string | null;
  order: number;
}

export interface CfgProblem {
  rule: string;
  step: string;
  message: string;
}

export interface Cfg {
  entry: string;
  info: Map<string, StepInfo>;
  succ: Map<string, Map<string, EdgeKind>>;
  pred: Map<string, Map<string, EdgeKind>>;
  problems: CfgProblem[];
  dom: Map<string, Set<string>>;
  domData: Map<string, Set<string>>;
}

export const IRREVERSIBLE_TYPES = new Set(['submit', 'human_commit', 'send_email']);

/** 스텝의 실효 onFail: 스텝 값 → IR recovery.default → 엔진 기본(handoff, 재시도 0). */
export function effectiveOnFail(ir: PlaybookIR, s: Step): Required<OnFail> {
  const o = s.onFail ?? ir.recovery?.default ?? {};
  return { retry: o.retry ?? 0, then: o.then ?? 'handoff' };
}

const CAN_FAIL = (s: Step) => s.type !== 'end' && s.type !== 'branch' && s.type !== 'handoff';

export function flatten(steps: Step[], repeats: string[] = [], out = new Map<string, StepInfo>(), dup: string[] = []): { info: Map<string, StepInfo>; dup: string[] } {
  steps.forEach((s, i) => {
    if (out.has(s.id)) dup.push(s.id);
    else out.set(s.id, { step: s, repeats, next: steps[i + 1]?.id ?? null, order: out.size });
    if (s.type === 'repeat') flatten(s.steps, [...repeats, s.id], out, dup);
  });
  return { info: out, dup };
}

/**
 * opts.irreversible: 비가역 스텝 id 집합(셀렉터 사전이 있어야 계산되므로 검증기가 넘긴다).
 * 비가역 click·press·select는 다음이 verify여야 하지만 그런 필드가 없어 폴스루로 둔다(V-04가 거부한다).
 */
export function buildCfg(ir: PlaybookIR, opts: { irreversible?: ReadonlySet<string> } = {}): Cfg {
  const { info, dup } = flatten(ir.steps);
  const problems: CfgProblem[] = dup.map((id) => ({ rule: 'V-19', step: id, message: `스텝 id ${id} 중복` }));
  const succ = new Map<string, Map<string, EdgeKind>>();
  const pred = new Map<string, Map<string, EdgeKind>>();
  const add = (a: string, b: string, k: EdgeKind) => {
    if (!succ.has(a)) succ.set(a, new Map());
    if (!pred.has(b)) pred.set(b, new Map());
    if (!succ.get(a)!.has(b)) succ.get(a)!.set(b, k);
    if (!pred.get(b)!.has(a)) pred.get(b)!.set(a, k);
  };
  for (const n of [END, ABORT, FALLOFF]) succ.set(n, new Map());

  const known = (ref: string, from: string, what: string): boolean => {
    if (info.has(ref)) return true;
    problems.push({ rule: 'V-11', step: from, message: `${what} 목적지 ${ref}가 없음` });
    return false;
  };
  const jumpOk = (from: string, to: string): boolean => {
    const a = info.get(from)!.repeats;
    const b = info.get(to)?.repeats ?? [];
    return a.length === b.length && a.every((r, i) => r === b[i]);
  };
  const jump = (from: string, ref: string, k: EdgeKind, what: string) => {
    if (ref === 'abort') return add(from, ABORT, k);
    if (ref === 'handoff') {
      add(from, hNode(from), k);
      add(hNode(from), from, 'resume');
      add(hNode(from), ABORT, 'resume');
      return;
    }
    if (!known(ref, from, what)) return;
    if (!jumpOk(from, ref)) problems.push({ rule: 'V-05', step: from, message: `${what}가 repeat 경계를 넘어 ${ref}로 감` });
    add(from, ref, k);
  };
  const fallTarget = (id: string): string => {
    const i = info.get(id)!;
    if (i.next) return i.next;
    return i.repeats.at(-1) ?? FALLOFF;
  };
  const checkpoints = new Map<string, string>();
  for (const [id, { step }] of info) if (step.type === 'checkpoint') checkpoints.set(step.name, id);

  for (const [id, { step: s }] of info) {
    switch (s.type) {
      case 'end':
        add(id, s.status === 'failed' ? ABORT : END, 'out');
        break;
      case 'decide':
        for (const [, t] of Object.entries(s.on)) jump(id, t, 'out', `decide.on`);
        break;
      case 'branch':
        for (const t of Object.values(s.cases)) jump(id, t, 'out', 'branch.cases');
        jump(id, s.default, 'out', 'branch.default');
        break;
      case 'verify':
        jump(id, s.on.committed, 'out', 'verify.committed');
        jump(id, s.on.not_committed, 'out', 'verify.not_committed');
        jump(id, s.on.unknown, 'out', 'verify.unknown');
        break;
      case 'pick':
        if (s.ifNone) jump(id, s.ifNone, 'out', 'pick.ifNone');
        if (s.then) jump(id, s.then, 'out', 'pick.then');
        else add(id, fallTarget(id), 'fall');
        break;
      case 'handoff':
        add(id, hNode(id), 'out');
        if (known(s.resumeAt, id, 'handoff.resumeAt')) add(hNode(id), s.resumeAt, 'resume');
        add(hNode(id), ABORT, 'resume');
        break;
      case 'repeat': {
        const first = s.steps[0];
        if (first) add(id, first.id, 'body');
        add(id, fallTarget(id), 'fall');
        break;
      }
      case 'submit':
      case 'human_commit':
      case 'send_email':
        if (known(s.verify, id, `${s.type}.verify`)) add(id, s.verify, 'out');
        break;
      default:
        add(id, fallTarget(id), 'fall');
    }
    if (CAN_FAIL(s)) {
      const then = effectiveOnFail(ir, s).then;
      if (then === 'abort') add(id, ABORT, 'fail');
      else if (then === 'handoff') {
        add(id, hNode(id), 'fail');
        const v = IRREVERSIBLE_TYPES.has(s.type) ? (s as { verify: string }).verify : id;
        if (info.has(v)) add(hNode(id), v, 'resume');
        add(hNode(id), ABORT, 'resume');
      } else if (then === 'human:secret') {
        add(id, secretNode(id), 'fail');
        add(secretNode(id), IRREVERSIBLE_TYPES.has(s.type) ? (s as { verify: string }).verify : fallTarget(id), 'resume');
      } else if (then.startsWith('checkpoint:')) {
        const cp = checkpoints.get(then.slice('checkpoint:'.length));
        if (!cp) problems.push({ rule: 'V-17', step: id, message: `${then} 체크포인트가 없음` });
        else add(id, cp, 'fail');
      }
    }
  }

  const entry = ir.steps[0]?.id ?? END;
  const dom0 = dominators(entry, succ);
  const domCps = (id: string) => [...(dom0.get(id) ?? [])].filter((d) => d !== id && info.get(d)?.step.type === 'checkpoint');
  const sessionCp = checkpoints.get('session');
  for (const [id, { step: s }] of info) {
    if (CAN_FAIL(s) && effectiveOnFail(ir, s).then === 'recover') {
      for (const cp of domCps(id)) add(id, cp, 'recover');
      add(id, id, 'recover');
    }
    if (s.type === 'gate' || s.type === 'human') for (const cp of domCps(id)) add(id, cp, 'rewind');
    if (sessionCp && sessionCp !== id && dom0.get(id)?.has(sessionCp) && !IRREVERSIBLE_TYPES.has(s.type) && s.type !== 'end') add(id, sessionCp, 'implicit');
  }
  const irr = [...(opts.irreversible ?? [])].filter((x) => info.has(x));
  const hs = [...succ.keys()].filter((n) => n.startsWith('H:'));
  for (const x of irr) {
    const s = info.get(x)!.step;
    const v = 'verify' in s && typeof s.verify === 'string' ? s.verify : null;
    if (!v || !info.has(v)) continue;
    for (const n of hs) add(n, v, 'observed');
  }
  for (const n of [...succ.keys()]) if (!pred.has(n)) pred.set(n, new Map());
  const noObserved = new Map([...succ].map(([a, m]) => [a, new Map([...m].filter(([, k]) => k !== 'observed'))] as const));
  return { entry, info, succ, pred, problems, dom: dominators(entry, succ), domData: dominators(entry, noObserved) };
}

export function reachable(from: string, succ: Map<string, Map<string, EdgeKind>>, blocked?: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>([from]);
  const stack = [from];
  while (stack.length) {
    const n = stack.pop()!;
    for (const m of succ.get(n)?.keys() ?? []) {
      if (seen.has(m) || blocked?.has(m)) continue;
      seen.add(m);
      stack.push(m);
    }
  }
  return seen;
}

/** 반복 자료 흐름 지배자 계산(노드 수가 수백 이하라 집합 교집합으로 충분). */
export function dominators(entry: string, succ: Map<string, Map<string, EdgeKind>>): Map<string, Set<string>> {
  const nodes = [...reachable(entry, succ)];
  const preds = new Map<string, string[]>(nodes.map((n) => [n, []]));
  for (const n of nodes) for (const m of succ.get(n)?.keys() ?? []) preds.get(m)?.push(n);
  const all = new Set(nodes);
  const dom = new Map<string, Set<string>>(nodes.map((n) => [n, n === entry ? new Set([entry]) : new Set(all)]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of nodes) {
      if (n === entry) continue;
      let acc = null as Set<string> | null;
      for (const p of preds.get(n)!) {
        const d = dom.get(p)!;
        acc = acc ? new Set([...acc].filter((x) => d.has(x))) : new Set(d);
      }
      const next = acc ?? new Set<string>();
      next.add(n);
      const cur = dom.get(n)!;
      if (next.size !== cur.size || [...next].some((x) => !cur.has(x))) {
        dom.set(n, next);
        changed = true;
      }
    }
  }
  return dom;
}

/** a가 b를 지배하는가(b가 진입점에서 도달 불가면 거짓). */
export const dominates = (cfg: Cfg, a: string, b: string) => cfg.dom.get(b)?.has(a) ?? false;

/**
 * opts.followUp: 후속 비가역 Y의 구간. 관측 간선과 핸드오프·비밀 창 합성 노드를 지나지 않는다 — HandedOff 진입은 미소비 토큰을
 * 폐기하고(R-G2) 후속 토큰은 같은 커밋 구간의 committed 전이에서만 발급되므로(D03 §3) 그 길로는 Y를 실행할 수 없다.
 */
export function commitWindow(cfg: Cfg, g: string, x: string, opts: { followUp?: boolean } = {}): Set<string> {
  const exclude: EdgeKind[] = opts.followUp ? ['observed'] : [];
  const skip = (m: string) => !!opts.followUp && (m.startsWith('H:') || m.startsWith('SECRET:'));
  const fwd = new Set<string>([g]);
  const stack = [g];
  while (stack.length) {
    const n = stack.pop()!;
    if (n === x) continue;
    for (const [m, k] of cfg.succ.get(n) ?? []) {
      if (m === g || fwd.has(m) || exclude.includes(k) || skip(m)) continue;
      fwd.add(m);
      stack.push(m);
    }
  }
  if (!fwd.has(x)) return new Set([g, x]);
  const bwd = new Set<string>([x]);
  const st2 = [x];
  while (st2.length) {
    const n = st2.pop()!;
    if (n === g) continue;
    for (const [m, k] of cfg.pred.get(n) ?? []) {
      if (bwd.has(m) || !fwd.has(m) || exclude.includes(k)) continue;
      bwd.add(m);
      st2.push(m);
    }
  }
  const w = new Set([...fwd].filter((n) => bwd.has(n)));
  w.add(g);
  w.add(x);
  return w;
}

/** 강한 연결 요소(Tarjan). 자기 자신으로 가는 간선만 있는 노드는 크기 1로 나온다. */
export function sccs(nodes: Iterable<string>, edge: (n: string) => Iterable<string>): string[][] {
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const on = new Set<string>();
  const st: string[] = [];
  const out: string[][] = [];
  const visit = (v: string) => {
    idx.set(v, index);
    low.set(v, index++);
    st.push(v);
    on.add(v);
    for (const w of edge(v)) {
      if (!idx.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (on.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
    if (low.get(v) === idx.get(v)) {
      const c: string[] = [];
      let w: string;
      do {
        w = st.pop()!;
        on.delete(w);
        c.push(w);
      } while (w !== v);
      out.push(c);
    }
  };
  for (const n of nodes) if (!idx.has(n)) visit(n);
  return out;
}
