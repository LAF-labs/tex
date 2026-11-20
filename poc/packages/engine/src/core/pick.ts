import { normalizeName } from './constants.ts';
import type { ElementRef } from './page.ts';
import { resolveTarget } from './resolve.ts';
import { isAbsent, isRef, readRef, scalar } from './scope.ts';
import { NEXT, waitTarget, type Outcome, type StepEnv } from './steps.ts';
import type { StepOf } from './types.ts';

const PICK_SELECT_WAIT_MS = 3_000;
const GONE_QUIET_MS = 500;

type PickResult = { ok: true; name: string } | { ok: false; code: string; none?: boolean };

const none = (code: string): PickResult => ({ ok: false, code, none: true });

/** 목록(key)에서 행 하나를 고르고 선택돼 있게 만든다. by는 값 참조($profile.certName 등) 또는 없음. */
export async function pickRow(env: StepEnv, key: string, o: { by?: string; use?: 'selected' }, timeoutMs: number): Promise<PickResult> {
  const entry = env.dict.entries[key];
  if (!entry?.rows) return { ok: false, code: 'step.selector_miss' };
  const t = await waitTarget(env, key, timeoutMs);
  if (!t.ok) return { ok: false, code: t.code };
  const { item, name, selected } = entry.rows;
  const css = (value: string) => ({ kind: 'css' as const, value });
  const deadline = env.clock.now() + timeoutMs;
  let rows: Array<{ el: ElementRef; name: string }> = [];
  for (;;) {
    rows = [];
    for (const el of await env.page.query(css(item), entry.frame, t.t.el)) {
      const cell = (await env.page.query(css(name), entry.frame, el))[0];
      const n = cell ? normalizeName(await env.page.text(cell)) : '';
      if (n !== '') rows.push({ el, name: n });
    }
    if (rows.length > 0) break;
    if (env.stopRequested?.()) return { ok: false, code: 'run.stopped' };
    if (env.clock.now() >= deadline) return { ok: false, code: 'step.timeout' };
    await env.clock.sleep(Math.min(env.pollMs, Math.max(0, deadline - env.clock.now())));
  }
  const selectedRow = async (): Promise<number | null> => {
    const sel = await env.page.query(css(selected), entry.frame, t.t.el);
    if (sel.length !== 1) return null;
    for (let i = 0; i < rows.length; i++) if (await env.page.same(rows[i]!.el, sel[0]!)) return i;
    return null;
  };
  let pick: number | null;
  if (o.use === 'selected') {
    pick = await selectedRow();
    if (pick === null) return none('pick.none_selected');
  } else if (rows.length === 1) pick = 0;
  else {
    const v = o.by && isRef(o.by) ? readRef(env.scope, o.by) : undefined;
    const want = isAbsent(v) ? null : scalar(v);
    if (want === null) return none('pick.name_absent');
    const hits = rows.flatMap((r, i) => (r.name === normalizeName(want) ? [i] : []));
    if (hits.length !== 1) return none(hits.length === 0 ? 'pick.no_match' : 'pick.ambiguous');
    pick = hits[0]!;
  }
  if ((await selectedRow()) !== pick) {
    if (!env.act.pickRow) return { ok: false, code: 'step.cond_unsupported' };
    const c = await env.act.pickRow(t.t, rows[pick]!.el);
    if (!c.ok) return { ok: false, code: c.code };
    const until = env.clock.now() + Math.min(PICK_SELECT_WAIT_MS, Math.max(0, deadline - env.clock.now()));
    for (;;) {
      if ((await selectedRow()) === pick) break;
      if (env.clock.now() >= until) return { ok: false, code: 'pick.not_selected' };
      await env.clock.sleep(Math.min(env.pollMs, Math.max(0, until - env.clock.now())));
    }
  }
  return { ok: true, name: rows[pick]!.name };
}

/** pick 스텝(IR rev v1.3.6). 못 고르면 ifNone(없으면 실패), 고르면 remember 뒤 then 또는 다음 스텝. */
export async function pickStep(s: StepOf<'pick'>, env: StepEnv): Promise<Outcome> {
  const r = await pickRow(env, s.target, { ...(s.by !== undefined ? { by: s.by } : {}), ...(s.use ? { use: s.use } : {}) }, s.timeoutMs ?? env.defaultTimeoutMs);
  if (!r.ok) return r.none && s.ifNone ? { t: 'jump', to: s.ifNone } : { t: 'fail', code: r.code };
  if (s.remember) {
    await env.profileWrite?.(s.remember, r.name).catch(() => false);
    env.scope.profile = { ...env.scope.profile, [s.remember]: r.name };
  }
  return s.then ? { t: 'jump', to: s.then } : NEXT;
}

/**
 * wait for:'gone'(IR rev v1.3.6, v1.3.7에서 바꿈): 보이는 대상이 하나뿐일 때만 기다린다. 없거나 안 보이는 상태가 GONE_QUIET_MS 이어지면 통과.
 * v1.3.7(부장 2026-11-13): 보이는 것이 여럿이거나 timeoutMs까지 계속 보이면 실패하지 않고 지나간다(처리 표시는 다음 스텝을 막는 조건이 아니다).
 */
export async function waitGone(key: string, env: StepEnv, timeoutMs: number): Promise<Outcome> {
  if (!env.dict.entries[key]) return { t: 'fail', code: 'step.selector_miss' };
  const deadline = env.clock.now() + timeoutMs;
  let since: number | null = null;
  for (;;) {
    const r = await resolveTarget(env.page, env.dict, key);
    const now = env.clock.now();
    if (!r.ok && r.ambiguous) return NEXT;
    if (r.ok || r.code !== 'step.selector_miss') since = null;
    else if (since === null) since = now;
    if (since !== null && now - since >= GONE_QUIET_MS) return NEXT;
    if (env.stopRequested?.()) return { t: 'fail', code: 'run.stopped' };
    if (now >= deadline) return NEXT;
    await env.clock.sleep(Math.min(env.pollMs, Math.max(0, deadline - now)));
  }
}
