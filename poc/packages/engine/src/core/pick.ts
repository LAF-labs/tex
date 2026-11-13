// IR rev v1.3.6: 목록에서 행 고르기(pick 스텝·signFlow.certPick)와 사라짐 기다리기(wait for:'gone').
// - 목록 = rows 항목(사전): item(행)·name(행 안 이름 칸)·selected(선택된 행) CSS. 홈택스 인증서 창(ML4Web jqx DataTable)이 첫 사용처다.
// - 고르는 규칙: use 'selected'면 지금 선택된 행(사람이 고른 행, 정확히 하나). 그 밖에는 행이 하나면 그 행, 여럿이면 by 값과
//   이름 칸 글(정규화)이 같은 행이 정확히 하나일 때만. 추측하지 않는다(못 고르면 none, 스텝은 ifNone으로 간다).
// - 사후 조건: 고른 행이 선택돼 있지 않으면 누르고(GuardedActuator.pickRow), 선택 표지가 그 행으로 바뀌어야 성공이다.
// - 저널·로그에 행 글·이름을 남기지 않는다(⑦). 결과에는 코드만 있다. 이름은 remember일 때 프로필 칸으로만 간다.
import { normalizeName } from './constants.ts';
import type { ElementRef } from './page.ts';
import { resolveTarget } from './resolve.ts';
import { isAbsent, isRef, readRef, scalar } from './scope.ts';
import { NEXT, waitTarget, type Outcome, type StepEnv } from './steps.ts';
import type { StepOf } from './types.ts';

/** 고른 뒤 선택 표지가 그 행으로 바뀌기를 기다리는 상한(ms). */
export const PICK_SELECT_WAIT_MS = 3_000;
/** wait for:'gone': 대상이 이만큼 계속 없어야 사라졌다고 본다(처리 표시가 아직 안 뜬 순간을 사라짐으로 읽지 않게). */
export const GONE_QUIET_MS = 500;

export type PickResult = { ok: true; name: string } | { ok: false; code: string; none?: boolean };

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
  // 행이 그려질 때까지(이름 칸 글이 빈칸이 아닌 행이 하나 이상)
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
    // 다음 실행이 이름으로 고르게 프로필에 둔다. 저장이 안 돼도 이번 실행은 이미 골랐다(다음에 사람이 한 번 더 고를 뿐).
    await env.profileWrite?.(s.remember, r.name).catch(() => false);
    env.scope.profile = { ...env.scope.profile, [s.remember]: r.name };
  }
  return s.then ? { t: 'jump', to: s.then } : NEXT;
}

/** wait for:'gone'(IR rev v1.3.6): 대상이 없거나 안 보이는 상태가 GONE_QUIET_MS 동안 이어지면 통과. 보이거나 모호하면 계속 기다린다. */
export async function waitGone(key: string, env: StepEnv, timeoutMs: number): Promise<Outcome> {
  if (!env.dict.entries[key]) return { t: 'fail', code: 'step.selector_miss' };
  const deadline = env.clock.now() + timeoutMs;
  let since: number | null = null;
  for (;;) {
    const r = await resolveTarget(env.page, env.dict, key);
    const now = env.clock.now();
    if (r.ok || r.code !== 'step.selector_miss' || r.ambiguous) since = null;
    else if (since === null) since = now;
    if (since !== null && now - since >= GONE_QUIET_MS) return NEXT;
    if (env.stopRequested?.()) return { t: 'fail', code: 'run.stopped' };
    if (now >= deadline) return { t: 'fail', code: 'step.timeout' };
    await env.clock.sleep(Math.min(env.pollMs, Math.max(0, deadline - now)));
  }
}
