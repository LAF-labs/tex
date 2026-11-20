import { ACTS, DOMAINS, REPLIES, type Act, type Domain, type RouteCase } from './cases.ts';

export type Coarse = 'work' | 'talk' | 'advice';
export const coarseOf = (a: Act | string): Coarse => (a === 'task' || a === 'lookup' || a === 'followup' ? 'work' : a === 'tax_advice' ? 'advice' : 'talk');

export interface Pick<T extends string> {
  got: T | null;
  conf: number | null;
}
export interface RouteRow {
  id: string;
  act: Pick<Act | string>;
  domain: Pick<Domain | string>;
  corrects: number | null;
  advice: number | null;
  reply?: Pick<string>;
  reaction?: Pick<string>;
  ms: number;
  inputTokens: number;
  error?: string;
}

const REACTION_NAMES = new Set(['thumbs_up', 'eyes', 'check', 'pray']);
export function shownMode(r: RouteRow, c?: Pick<RouteCase, 'ctx'>): 'reaction_only' | 'react_then_work' | 'answer' {
  const m = r.reply;
  if (m?.got === 'reaction_only' && (c?.ctx.reacted ?? 0) >= 1) return 'answer';
  if (!m || m.got === null || m.conf === null || m.conf < SURE || (m.got !== 'reaction_only' && m.got !== 'react_then_work')) return 'answer';
  if (r.advice === null || r.advice >= 0.5) return 'answer';
  if (!r.reaction?.got || !REACTION_NAMES.has(r.reaction.got)) return 'answer';
  return m.got;
}

export interface ReplyScore {
  n: number;
  accuracy: number | null;
  shownAccuracy: number | null;
  recall: Record<string, { n: number; recall: number | null }>;
  ece: number | null;
  wrongClose: number | null;
  ackClosed: number | null;
  workAcked: number | null;
  reactions: Record<string, Record<string, number>>;
  byStyle: Record<string, { n: number; shown: number | null }>;
}

export function scoreReply(cases: readonly RouteCase[], rows: readonly RouteRow[]): ReplyScore | null {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const pair = rows.filter((r) => !r.error && r.reply && byId.has(r.id)).map((r) => ({ r, c: byId.get(r.id)! }));
  if (!pair.length) return null;
  const reactions: Record<string, Record<string, number>> = {};
  for (const { r, c } of pair) {
    const k = String(r.reaction?.got ?? 'null');
    (reactions[c.reply] ??= {})[k] = (reactions[c.reply]![k] ?? 0) + 1;
  }
  const styles = new Map<string, typeof pair>();
  for (const x of pair) (styles.get(x.c.style) ?? styles.set(x.c.style, []).get(x.c.style)!).push(x);
  const notAck = pair.filter((x) => x.c.reply !== 'reaction_only');
  const ack = pair.filter((x) => x.c.reply === 'reaction_only');
  const work = pair.filter((x) => x.c.reply === 'react_then_work');
  return {
    n: pair.length,
    accuracy: rate(pair.filter((x) => x.r.reply!.got === x.c.reply).length, pair.length),
    shownAccuracy: rate(pair.filter((x) => shownMode(x.r, x.c) === x.c.reply).length, pair.length),
    recall: recall(REPLIES, pair.map((x) => ({ label: x.c.reply, got: x.r.reply!.got }))),
    ece: ece(pair.filter((x) => x.r.reply!.conf !== null).map((x) => ({ conf: x.r.reply!.conf!, ok: x.r.reply!.got === x.c.reply }))),
    wrongClose: rate(notAck.filter((x) => shownMode(x.r, x.c) === 'reaction_only').length, notAck.length),
    ackClosed: rate(ack.filter((x) => shownMode(x.r, x.c) === 'reaction_only').length, ack.length),
    workAcked: rate(work.filter((x) => shownMode(x.r, x.c) === 'react_then_work').length, work.length),
    reactions,
    byStyle: Object.fromEntries([...styles].sort().map(([k, xs]) => [k, { n: xs.length, shown: rate(xs.filter((x) => shownMode(x.r, x.c) === x.c.reply).length, xs.length) }])),
  };
}

export const SURE = 0.8;
const ADVICE_GTE = 0.75;

const rate = (n: number, d: number) => (d ? Number((n / d).toFixed(4)) : null);

function ece(pairs: Array<{ conf: number; ok: boolean }>, bins = 10): number | null {
  if (!pairs.length) return null;
  let sum = 0;
  for (let b = 0; b < bins; b++) {
    const xs = pairs.filter((p) => Math.min(bins - 1, Math.floor(p.conf * bins)) === b);
    if (!xs.length) continue;
    const acc = xs.filter((p) => p.ok).length / xs.length;
    const conf = xs.reduce((a, p) => a + p.conf, 0) / xs.length;
    sum += (xs.length / pairs.length) * Math.abs(acc - conf);
  }
  return Number(sum.toFixed(4));
}

function recall<T extends string>(labels: readonly T[], rows: Array<{ label: T; got: string | null }>): Record<string, { n: number; recall: number | null }> {
  const out: Record<string, { n: number; recall: number | null }> = {};
  for (const l of labels) {
    const xs = rows.filter((r) => r.label === l);
    if (xs.length) out[l] = { n: xs.length, recall: rate(xs.filter((r) => r.got === l).length, xs.length) };
  }
  return out;
}

export interface RouteScore {
  n: number;
  errors: number;
  act: { accuracy: number | null; coarse: number | null; recall: Record<string, { n: number; recall: number | null }>; ece: number | null; confusion: Record<string, Record<string, number>> };
  domain: { accuracy: number | null; recall: Record<string, { n: number; recall: number | null }>; ece: number | null };
  joint: number | null;
  corrects: { accuracy: number | null; recall: number | null; falsePositive: number | null } | null;
  advice: { recall: number | null; falsePositive: number | null } | null;
  sure: { unsure: number | null; jointWhenSure: number | null } | null;
  gate: {
    issueMiss: number | null;
    falseOpen: number | null;
    joint: number | null;
  };
  byStyle: Record<string, { n: number; joint: number | null }>;
  latencyMs: { p50: number; p95: number };
  inputTokensMean: number;
}

const sureOf = (r: RouteRow) => (r.act.conf === null || r.domain.conf === null ? true : r.act.conf >= SURE && r.domain.conf >= SURE);

export function scoreRoute(cases: readonly RouteCase[], rows: readonly RouteRow[], opts: { fineAct: boolean; domain: boolean; corrects: boolean; advice: boolean }): RouteScore {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const ok = rows.filter((r) => !r.error && byId.has(r.id));
  const pair = ok.map((r) => ({ r, c: byId.get(r.id)! }));
  const actOk = (x: { r: RouteRow; c: RouteCase }) => (opts.fineAct ? x.r.act.got === x.c.act : coarseOf(x.r.act.got ?? 'other') === coarseOf(x.c.act));
  const domOk = (x: { r: RouteRow; c: RouteCase }) => x.r.domain.got === x.c.domain;
  const jointOk = (x: { r: RouteRow; c: RouteCase }) => actOk(x) && (!opts.domain || domOk(x));
  const confusion: Record<string, Record<string, number>> = {};
  for (const { r, c } of pair) {
    const g = String(r.act.got ?? 'null');
    (confusion[c.act] ??= {})[g] = (confusion[c.act]![g] ?? 0) + 1;
  }
  const withConf = pair.filter((x) => x.r.act.conf !== null);
  const issue = pair.filter((x) => x.c.domain === 'invoice' && (x.c.act === 'task' || x.c.act === 'followup'));
  const small = pair.filter((x) => x.c.act === 'smalltalk');
  const styles = new Map<string, Array<{ r: RouteRow; c: RouteCase }>>();
  for (const x of pair) (styles.get(x.c.style) ?? styles.set(x.c.style, []).get(x.c.style)!).push(x);
  const ms = ok.map((r) => r.ms).sort((a, b) => a - b);
  const q = (p: number) => Math.round(ms[Math.min(ms.length - 1, Math.floor(p * ms.length))] ?? 0);
  const cor = pair.filter((x) => x.r.corrects !== null);
  const adv = pair.filter((x) => x.r.advice !== null);
  return {
    n: rows.length,
    errors: rows.length - ok.length,
    act: {
      accuracy: opts.fineAct ? rate(pair.filter(actOk).length, pair.length) : null,
      coarse: rate(pair.filter((x) => coarseOf(x.r.act.got ?? 'other') === coarseOf(x.c.act)).length, pair.length),
      recall: opts.fineAct ? recall(ACTS, pair.map((x) => ({ label: x.c.act, got: x.r.act.got }))) : recall(['work', 'talk', 'advice'] as const, pair.map((x) => ({ label: coarseOf(x.c.act), got: x.r.act.got === null ? null : coarseOf(x.r.act.got) }))),
      ece: ece(withConf.map((x) => ({ conf: x.r.act.conf!, ok: actOk(x) }))),
      confusion,
    },
    domain: opts.domain
      ? { accuracy: rate(pair.filter(domOk).length, pair.length), recall: recall(DOMAINS, pair.map((x) => ({ label: x.c.domain, got: x.r.domain.got }))), ece: ece(withConf.filter((x) => x.r.domain.conf !== null).map((x) => ({ conf: x.r.domain.conf!, ok: domOk(x) }))) }
      : { accuracy: null, recall: {}, ece: null },
    joint: rate(pair.filter(jointOk).length, pair.length),
    corrects: opts.corrects
      ? {
          accuracy: rate(cor.filter((x) => x.r.corrects! >= 0.5 === x.c.corrects).length, cor.length),
          recall: rate(cor.filter((x) => x.c.corrects && x.r.corrects! >= 0.5).length, cor.filter((x) => x.c.corrects).length),
          falsePositive: rate(cor.filter((x) => !x.c.corrects && x.r.corrects! >= 0.5).length, cor.filter((x) => !x.c.corrects).length),
        }
      : null,
    advice: opts.advice
      ? {
          recall: rate(adv.filter((x) => x.c.advice && x.r.advice! >= ADVICE_GTE).length, adv.filter((x) => x.c.advice).length),
          falsePositive: rate(adv.filter((x) => !x.c.advice && x.r.advice! >= ADVICE_GTE).length, adv.filter((x) => !x.c.advice).length),
        }
      : null,
    sure: withConf.length
      ? { unsure: rate(withConf.filter((x) => !sureOf(x.r)).length, withConf.length), jointWhenSure: rate(withConf.filter((x) => sureOf(x.r) && jointOk(x)).length, withConf.filter((x) => sureOf(x.r)).length) }
      : null,
    gate: {
      issueMiss: rate(issue.filter((x) => sureOf(x.r) && coarseOf(x.r.act.got ?? 'other') !== 'work').length, issue.length),
      falseOpen: rate(small.filter((x) => sureOf(x.r) && coarseOf(x.r.act.got ?? 'other') === 'work').length, small.length),
      joint: rate(pair.filter(jointOk).length, pair.length),
    },
    byStyle: Object.fromEntries([...styles].sort().map(([k, xs]) => [k, { n: xs.length, joint: rate(xs.filter(jointOk).length, xs.length) }])),
    latencyMs: { p50: q(0.5), p95: q(0.95) },
    inputTokensMean: ok.length ? Math.round(ok.reduce((a, r) => a + r.inputTokens, 0) / ok.length) : 0,
  };
}
