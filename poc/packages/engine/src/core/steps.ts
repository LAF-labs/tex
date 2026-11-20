import { evalCond, stringPattern, type CondEnv } from './conds.ts';
import { normalizeFieldValue, readField, type FieldRead } from './readback.ts';
import { normalizeName } from './constants.ts';
import type { Actuator, Clock, PageReader, Resolved } from './page.ts';
import { resolveTarget } from './resolve.ts';
import { isAbsent, isRef, readRef, scalar, type RunScope } from './scope.ts';
import { isSecretEntry, type EndStep, type SelectorDict, type SelectorEntry, type Step, type StepOf, type StepType, type Strings } from './types.ts';
import { navigationUrlProblem, type FixtureOriginGrant } from './loader.ts';
import { pickStep, waitGone } from './pick.ts';

export type Outcome =
  | { t: 'next' }
  | { t: 'jump'; to: string }
  | { t: 'fail'; code: string }
  | { t: 'end'; status: EndStep['status'] };

export interface StepEnv extends CondEnv {
  act: Actuator;
  clock: Clock;
  domains: readonly string[];
  fixtureGrant?: FixtureOriginGrant | null;
  irreversible: ReadonlySet<string>;
  defaultTimeoutMs: number;
  pollMs: number;
  stopRequested?: () => boolean;
  profileWrite?: (field: 'certName', value: string) => Promise<boolean>;
  dialogShown?: (n: { stepId: string; key: string; text: string; ok: boolean }) => void;
  journal?: (type: string, payload: Record<string, string | number | boolean>) => void;
}

export type Handler<T extends StepType> = (s: StepOf<T>, env: StepEnv) => Promise<Outcome>;
export type Handlers = { [K in StepType]?: Handler<K> };

export const NEXT: Outcome = { t: 'next' };
const fail = (code: string): Outcome => ({ t: 'fail', code });
const timeoutOf = (s: Step, env: StepEnv) => s.timeoutMs ?? env.defaultTimeoutMs;

type TargetResult = { ok: true; t: Resolved } | { ok: false; code: string };

/**
 * 타깃을 timeoutMs 안에서 해석한다. 아직 없으면 기다리고, 모호하거나 동일성이 틀리면 기다리지 않고 실패한다.
 * 비밀 칸·커밋 항목은 이 경로로 해석하지 않는다(allowCommit은 M2-3 submit만).
 */
export async function waitTarget(env: StepEnv, key: string, timeoutMs: number, o: { allowCommit?: boolean } = {}): Promise<TargetResult> {
  const entry = env.dict.entries[key];
  if (!entry) return { ok: false, code: 'step.selector_miss' };
  if (isSecretEntry(entry)) return { ok: false, code: 'step.secret_field' };
  if (entry.commits && !o.allowCommit) return { ok: false, code: 'step.irreversible_unguarded' };
  const deadline = env.clock.now() + timeoutMs;
  for (;;) {
    const r = await resolveTarget(env.page, env.dict, key);
    if (r.ok || r.code !== 'step.selector_miss' || r.ambiguous) return r;
    if (env.stopRequested?.()) return { ok: false, code: 'run.stopped' };
    if (env.clock.now() >= deadline) return r;
    await env.clock.sleep(Math.min(env.pollMs, Math.max(0, deadline - env.clock.now())));
  }
}

function valueOf(raw: string, entry: SelectorEntry, scope: RunScope): { ok: true; value: string | null } | { ok: false; code: string } {
  if (!isRef(raw)) return entry.allowedConstants?.includes(raw) ? { ok: true, value: raw } : { ok: false, code: 'step.constant_not_allowed' };
  const v = readRef(scope, raw);
  if (isAbsent(v)) return { ok: true, value: null };
  const s = scalar(v);
  return s === null ? { ok: false, code: 'step.ref_unresolved' } : { ok: true, value: s };
}

const guardIrreversible = (s: Step, env: StepEnv): Outcome | null => (env.irreversible.has(s.id) ? fail('step.irreversible_unguarded') : null);

const act = async (p: Promise<{ ok: true } | { ok: false; code: string }>): Promise<Outcome> => {
  const r = await p;
  return r.ok ? NEXT : fail(r.code);
};

const goto: Handler<'goto'> = async (s, env) => {
  if (navigationUrlProblem(s.url, env.domains, env.fixtureGrant)) return fail('step.url_not_allowed');
  return act(env.act.goto(s.url));
};

const click: Handler<'click'> = async (s, env) => {
  const g = guardIrreversible(s, env);
  if (g) return g;
  const t = await waitTarget(env, s.target, timeoutOf(s, env));
  if (!t.ok) return fail(t.code);
  const r = await env.act.click(t.t);
  if (!r.ok && r.code === 'step.timeout' && env.act.clickByBox) return act(env.act.clickByBox(t.t));
  return r.ok ? NEXT : fail(r.code);
};

const fill: Handler<'fill'> = async (s, env) => {
  const t = await waitTarget(env, s.target, timeoutOf(s, env));
  if (!t.ok) return fail(t.code);
  const v = valueOf(s.value, t.t.entry, env.scope);
  if (!v.ok) return fail(v.code);
  if (v.value === null) {
    if (s.ifAbsent === 'keep' && s.value.startsWith('$inputs.')) return NEXT;
    if (s.ifAbsent !== 'clear' || !s.value.startsWith('$inputs.')) return fail(s.value.startsWith('$inputs.') ? 'step.input_absent' : 'step.ref_unresolved');
    const r = await env.act.clear(t.t);
    if (!r.ok) return fail(r.code);
    return (await env.page.value(t.t.el)).trim() === '' ? NEXT : fail('step.readback_mismatch');
  }
  const r = await env.act.fill(t.t, v.value, { keyEvents: s.keyEvents === true });
  if (!r.ok) return fail(r.code);
  const back = await env.page.value(t.t.el);
  return normalizeFieldValue(t.t.entry, back) === normalizeFieldValue(t.t.entry, v.value) ? NEXT : fail('step.readback_mismatch');
};

const select: Handler<'select'> = async (s, env) => {
  const g = guardIrreversible(s, env);
  if (g) return g;
  const t = await waitTarget(env, s.target, timeoutOf(s, env));
  if (!t.ok) return fail(t.code);
  const v = valueOf(s.option, t.t.entry, env.scope);
  if (!v.ok) return fail(v.code);
  if (v.value === null) return fail(s.option.startsWith('$inputs.') ? 'step.input_absent' : 'step.ref_unresolved');
  return act(env.act.select(t.t, v.value));
};

const press: Handler<'press'> = async (s, env) => {
  const g = guardIrreversible(s, env);
  if (g) return g;
  if (!s.target) return s.key === 'Enter' ? fail('step.selector_miss') : act(env.act.press(s.key, null));
  const t = await waitTarget(env, s.target, timeoutOf(s, env));
  return t.ok ? act(env.act.press(s.key, t.t)) : fail(t.code);
};

const wait: Handler<'wait'> = async (s, env) => {
  const ms = timeoutOf(s, env);
  switch (s.for) {
    case 'navigation':
      return (await env.page.waitNavigation(ms)) ? NEXT : fail('step.timeout');
    case 'idle':
      return (await env.page.waitIdle(ms)) ? NEXT : fail('step.timeout');
    case 'selector': {
      if (!s.value || !env.dict.entries[s.value]) return fail('step.selector_miss');
      const t = await waitTarget(env, s.value, ms, { allowCommit: true });
      if (t.ok) return NEXT;
      return t.code === 'step.selector_miss' ? fail('step.timeout') : fail(t.code);
    }
    case 'text': {
      const re = s.value ? stringPattern(env.strings, s.value) : null;
      if (!re) return fail('step.cond_unsupported');
      const deadline = env.clock.now() + ms;
      for (;;) {
        if (re.test(normalizeName(await env.page.bodyText()))) return NEXT;
        if (env.stopRequested?.()) return fail('run.stopped');
        if (env.clock.now() >= deadline) return fail('step.timeout');
        await env.clock.sleep(Math.min(env.pollMs, Math.max(0, deadline - env.clock.now())));
      }
    }
    case 'gone':
      return s.value ? waitGone(s.value, env, ms) : fail('step.selector_miss');
    case 'dialog': {
      const re = s.value ? stringPattern(env.strings, s.value) : null;
      if (!re || !env.act.dialogSinceAction) return fail('step.cond_unsupported');
      const deadline = env.clock.now() + ms;
      for (;;) {
        const d = env.act.dialogSinceAction();
        if (d) {
          const ok = re.test(normalizeName(d.notice));
          env.dialogShown?.({ stepId: s.id, key: s.value!, text: d.notice, ok });
          return ok ? NEXT : fail('step.dialog_mismatch');
        }
        if (env.stopRequested?.()) return fail('run.stopped');
        if (env.clock.now() >= deadline) return fail('step.timeout');
        await env.clock.sleep(Math.min(env.pollMs, Math.max(0, deadline - env.clock.now())));
      }
    }
  }
  return fail('step.cond_unsupported');
};

const assert: Handler<'assert'> = async (s, env) => {
  const r = await evalCond(s.cond, env);
  if (!r.ok) return fail(r.code);
  return r.value ? NEXT : fail('step.assert_failed');
};

const extract: Handler<'extract'> = async (s, env) => {
  const from = s.from;
  const key = 'selector' in from ? from.selector : 'regex' in from ? from.regex.target : from.a11y.target;
  const t = await waitTarget(env, key, timeoutOf(s, env), { allowCommit: true });
  if (!t.ok) return fail(t.code);
  let value: string;
  if ('a11y' in from) value = normalizeName(await env.page.a11yValue(t.t.el));
  else {
    const text = normalizeName(await env.page.text(t.t.el));
    if ('selector' in from) value = text;
    else {
      const re = stringPattern(env.strings, from.regex.patternRef);
      if (!re) return fail('step.cond_unsupported');
      const m = re.exec(text);
      if (!m) return fail('step.extract_miss');
      value = m[1] ?? m[0];
    }
  }
  env.scope.vars.set(s.name, value);
  if (s.readback) env.scope.readbackOnly.add(s.name);
  else env.scope.readbackOnly.delete(s.name);
  return NEXT;
};

/**
 * IR rev v1.3.7(부장 2026-11-13): 화면 글로 가르는 branch는 성공한 같은 결과가 BRANCH_SETTLE_MS 이어질 때 정한다(WebSquare가 머리말을 다시 그린다).
 * 해석 실패(동일성·없음)는 다시 그리는 중으로 보고 BRANCH_SETTLE_MAX_MS까지 계속 본다. 거짓은 페이지 요청이 멎은 뒤 다시 보고 정한다.
 * 상한이 되면 마지막 결과로 정한다(실패면 실패).
 */
export const BRANCH_SETTLE_MS = 400;
export const BRANCH_SETTLE_MAX_MS = 8_000;

const branch: Handler<'branch'> = async (s, env) => {
  let r = await evalCond(s.on, env);
  if ('textMatches' in s.on) {
    const key = (x: typeof r) => (x.ok ? `v:${x.value}` : `e:${x.code}`);
    const t0 = env.clock.now();
    const until = t0 + BRANCH_SETTLE_MAX_MS;
    let since = t0;
    const trace = [`${key(r)}~0`];
    const settle = async (): Promise<boolean> => {
      while ((!r.ok || env.clock.now() - since < BRANCH_SETTLE_MS) && env.clock.now() < until) {
        if (env.stopRequested?.()) return false;
        await env.clock.sleep(Math.max(20, Math.min(env.pollMs, 100)));
        const n = await evalCond(s.on, env);
        if (key(n) !== key(r)) {
          r = n;
          since = env.clock.now();
          trace.push(`${key(r)}~${since - t0}`);
        }
      }
      return true;
    };
    if (!(await settle())) return fail('run.stopped');
    if (r.ok && r.value === false && env.clock.now() < until) {
      await env.page.waitIdle(Math.max(0, until - env.clock.now())).catch(() => false);
      const n = await evalCond(s.on, env);
      since = env.clock.now();
      trace.push(`idle:${key(n)}~${since - t0}`);
      r = n;
      if (!(await settle())) return fail('run.stopped');
    }
    await settledTrace(s, env, key(r), env.clock.now() - t0, trace);
  }
  if (!r.ok) return fail(r.code);
  return { t: 'jump', to: s.cases[String(r.value)] ?? s.default };
};

async function settledTrace(s: StepOf<'branch'>, env: StepEnv, result: string, ms: number, trace: string[]): Promise<void> {
  if (!env.journal || !('textMatches' in s.on)) return;
  const target = s.on.textMatches.target;
  const entry = env.dict.entries[target];
  const out: Record<string, string | number | boolean> = { stepId: s.id, target, result, ms, trace: trace.slice(0, 12).join('>') };
  const el = entry ? (await env.page.query(entry.candidates[0]!, entry.frame, null).catch(() => []))[0] : undefined;
  if (el) {
    const info = await env.page.info(el).catch(() => null);
    if (info) Object.assign(out, { role: info.role, visible: info.visible });
    const text = normalizeName(await env.page.text(el).catch(() => ''));
    if (entry?.navigationOnly && text.length <= 12) out.text = text;
  }
  env.journal('branch.settled', out);
}

const end: Handler<'end'> = async (s) => ({ t: 'end', status: s.status });

const readback: Handler<'readback'> = async (s, env) => {
  for (const f of [...s.fields, ...(s.optional ?? [])]) env.scope.readback.delete(f);
  const got: Array<[string, string]> = [];
  for (const f of s.fields) {
    const r = await readField(env.page, env.dict, f);
    if (!r.ok) {
      env.journal?.('readback.failed', { stepId: s.id, field: f, code: r.code, detail: r.detail ?? '' });
      return fail(r.code);
    }
    got.push([f, r.value]);
  }
  const opt: Array<[string, number]> = [];
  for (const f of s.optional ?? []) {
    const r = await readField(env.page, env.dict, f).catch((): FieldRead => ({ ok: false, code: 'step.readback_error' }));
    if (!r.ok) continue;
    got.push([f, r.value]);
    opt.push([f, r.value.length]);
  }
  if (s.optional?.length) env.journal?.('readback.optional', { stepId: s.id, read: opt.map(([f]) => f).join(','), lens: opt.map(([, n]) => n).join(','), missed: s.optional.length - opt.length });
  for (const [f, v] of got) env.scope.readback.set(f, v);
  return NEXT;
};

/** M2-1 핸들러 묶음 + readback(M2-3). decide·gate·human·checkpoint는 실행 조율기(run/)가 더한다. */
export const BASIC_HANDLERS: Handlers = { goto, click, fill, select, press, wait, assert, extract, branch, end, readback, pick: pickStep };

export interface StepEnvInput {
  page: PageReader;
  act: Actuator;
  clock: Clock;
  dict: SelectorDict;
  strings: Strings;
  scope: RunScope;
  domains: readonly string[];
  fixtureGrant?: FixtureOriginGrant | null;
  irreversible: ReadonlySet<string>;
  defaultTimeoutMs?: number;
  pollMs?: number;
  pre?: CondEnv['pre'];
}

/** 스텝에 timeoutMs가 없을 때의 기본값과 대기 간격. */
export const DEFAULT_STEP_TIMEOUT_MS = 30_000;
export const DEFAULT_POLL_MS = 250;

export function stepEnv(i: StepEnvInput): StepEnv {
  return { defaultTimeoutMs: DEFAULT_STEP_TIMEOUT_MS, pollMs: DEFAULT_POLL_MS, ...i };
}
