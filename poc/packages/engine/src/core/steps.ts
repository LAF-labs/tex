// M2-1 스텝 핸들러(D02 §4, D03 §5.1): goto·click·fill·select·press·wait·assert·extract·branch·end.
// repeat·handoff·onFail 같은 제어 흐름은 실행기(interp.ts)가 한다. 핸들러는 결과(Outcome)만 돌려주고 다음 스텝을 정하지 않는다.
// - 페이지를 바꾸는 동작은 모두 Actuator, 읽기는 PageReader로만 한다.
// - 비밀 칸(secretKind·password)은 이 핸들러들이 읽거나 누를 수 없다(V-20의 실행 시 방어, step.secret_field).
// - commits:true 항목·비가역 스텝은 여기서 실행하지 않는다(커밋 구간은 M2-3 submit만, step.irreversible_unguarded).
// - 저널·로그에 화면 텍스트·입력 값을 남기지 않는다(⑦). 결과에는 코드만 있다.
import { evalCond, stringPattern, type CondEnv } from './conds.ts';
import { normalizeFieldValue, readField } from './readback.ts';
import { normalizeName } from './constants.ts';
import type { Actuator, Clock, PageReader, Resolved } from './page.ts';
import { resolveTarget } from './resolve.ts';
import { isAbsent, isRef, readRef, scalar, type RunScope } from './scope.ts';
import { isSecretEntry, type EndStep, type SelectorDict, type SelectorEntry, type Step, type StepOf, type StepType, type Strings } from './types.ts';
import { navigationUrlProblem, type FixtureOriginGrant } from './loader.ts';

export type Outcome =
  | { t: 'next' }
  /** 분기 목적지: stepRef 또는 'handoff'·'abort'. */
  | { t: 'jump'; to: string }
  | { t: 'fail'; code: string }
  | { t: 'end'; status: EndStep['status'] };

export interface StepEnv extends CondEnv {
  act: Actuator;
  clock: Clock;
  /** manifest.domains(V-06의 실행 시 재확인). */
  domains: readonly string[];
  /** fixture 패키지 실행일 때만(loader.fixtureOriginGrant, ADR-039). 없으면 실제 포털 규칙만. */
  fixtureGrant?: FixtureOriginGrant | null;
  /** 정적으로 계산한 비가역 스텝 id(validate.irreversibleSteps). */
  irreversible: ReadonlySet<string>;
  /** 스텝에 timeoutMs가 없을 때. */
  defaultTimeoutMs: number;
  /** 요소가 나타나기를 기다리는 간격. */
  pollMs: number;
  /** [중지]가 들어왔는가(조율기가 채운다). 기다리는 루프(waitTarget·wait text)가 폴링 때마다 보고 run.stopped로 빠진다. */
  stopRequested?: () => boolean;
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

/** fill.value·select.option: 참조면 읽고, 상수면 타깃의 allowedConstants 안에서만(V-21). */
function valueOf(raw: string, entry: SelectorEntry, scope: RunScope): { ok: true; value: string | null } | { ok: false; code: string } {
  if (!isRef(raw)) return entry.allowedConstants?.includes(raw) ? { ok: true, value: raw } : { ok: false, code: 'step.constant_not_allowed' };
  const v = readRef(scope, raw);
  if (isAbsent(v)) return { ok: true, value: null };
  const s = scalar(v);
  return s === null ? { ok: false, code: 'step.ref_unresolved' } : { ok: true, value: s };
}

/** 비가역 스텝(정적 집합)은 이 핸들러들로 실행하지 않는다. */
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
  return t.ok ? act(env.act.click(t.t)) : fail(t.code);
};

const fill: Handler<'fill'> = async (s, env) => {
  const t = await waitTarget(env, s.target, timeoutOf(s, env));
  if (!t.ok) return fail(t.code);
  const v = valueOf(s.value, t.t.entry, env.scope);
  if (!v.ok) return fail(v.code);
  if (v.value === null) {
    // 선택 입력이 비었다. clear면 칸을 비운다(포털 자동 채움 제거, B-05). 그 밖에는 실패(기본 fail).
    if (s.ifAbsent !== 'clear' || !s.value.startsWith('$inputs.')) return fail(s.value.startsWith('$inputs.') ? 'step.input_absent' : 'step.ref_unresolved');
    const r = await env.act.clear(t.t);
    if (!r.ok) return fail(r.code);
    return (await env.page.value(t.t.el)).trim() === '' ? NEXT : fail('step.readback_mismatch');
  }
  const r = await env.act.fill(t.t, v.value, { keyEvents: s.keyEvents === true });
  if (!r.ok) return fail(r.code);
  // 입력 뒤 DOM 값을 되읽어 같은지 확인한다(D02 §4 fill). 값은 남기지 않는다.
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
    case 'dialog': {
      // 마지막 동작 뒤 뜬 네이티브 대화상자(alert 등, 엔진 정책이 이미 닫았다)의 문구를 판정한다(홈택스 등록번호 [확인] → alert).
      // 다른 문구면 기다리지 않고 실패한다(재시도해도 같은 대화상자는 다시 오지 않는다). 문구는 남기지 않는다(⑦).
      const re = s.value ? stringPattern(env.strings, s.value) : null;
      if (!re || !env.act.dialogSinceAction) return fail('step.cond_unsupported');
      const deadline = env.clock.now() + ms;
      for (;;) {
        const d = env.act.dialogSinceAction();
        if (d) return re.test(normalizeName(d.notice)) ? NEXT : fail('step.dialog_mismatch');
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
  // 읽기만 하므로 커밋 항목(예: 결과 화면의 버튼 이름)도 읽을 수 있다. 비밀 칸은 안 된다.
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

const branch: Handler<'branch'> = async (s, env) => {
  const r = await evalCond(s.on, env);
  if (!r.ok) return fail(r.code);
  return { t: 'jump', to: s.cases[String(r.value)] ?? s.default };
};

const end: Handler<'end'> = async (s) => ({ t: 'end', status: s.status });

/**
 * readback(M2-3, D02 §2.1 B-06): 나열한 fieldKey를 세 값 일치로 되읽어 $readback에 고정한다.
 * 하나라도 실패하면 이 스텝의 값을 하나도 남기지 않는다(뒤 assert·게이트 카드가 반쯤 읽은 값을 쓰지 않게).
 */
const readback: Handler<'readback'> = async (s, env) => {
  for (const f of s.fields) env.scope.readback.delete(f);
  const got: Array<[string, string]> = [];
  for (const f of s.fields) {
    const r = await readField(env.page, env.dict, f);
    if (!r.ok) return fail(r.code);
    got.push([f, r.value]);
  }
  for (const [f, v] of got) env.scope.readback.set(f, v);
  return NEXT;
};

/** M2-1 핸들러 묶음 + readback(M2-3). decide·gate·human·checkpoint는 실행 조율기(run/)가 더한다. */
export const BASIC_HANDLERS: Handlers = { goto, click, fill, select, press, wait, assert, extract, branch, end, readback };

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
