// 브라우저 에이전트(browser-use식, 2026-11-13): 판정이 agent_mode를 고르면, 막힌 스텝부터 이어지는 "그냥 입력" 스텝 묶음을
// 모델이 한 걸음씩(최대 AGENT_MAX_ACTIONS) 대신한다. 끝나면 결정적 스크립트의 다음 확인 스텝(대화상자 대기·반복 확인·되읽기·게이트)으로 돌아간다.
// - 묶음: fill·click·select·press·wait(selector|idle|navigation)만. 확인 스텝(wait dialog·text, assert, readback, repeat, gate, checkpoint…)은 넣지 않는다.
//   그래서 사업자번호 확인 alert·합계 확인·미리보기 되읽기(R-C1)·게이트 본문 대조는 늘 스크립트가 한다. 하나라도 다르면 지금처럼 사람에게 간다.
// - 값: 모델은 {{inputs.counterpart.bizNo}} 같은 값토큰만 쓴다. 엔진이 그 실행 값으로 바꿔 넣는다(값은 모델로 가지 않는다).
// - 동작: 목록 번호의 요소를 실행 사본 사전의 임시 항목(__agent__)으로 해석해 GuardedActuator로 한다(R-A1·정책·비밀 칸 가드 그대로).
//   커밋 항목 요소는 누르지 않는다. 금지 이름(확인·발급…)의 단추는 그 걸음의 목표 click 스텝이 패키지에서 검토된(reviewNote) 항목이고
//   요소 이름이 그 항목의 이름 규칙에 맞을 때만 누른다(예: [확인] 사업자번호 확인, [발급미리보기]).
import { AGENT_MAX_ACTIONS } from '@sax/model';
import { flatten } from '../core/cfg.ts';
import { isDenyActionName, normalizeName } from '../core/constants.ts';
import type { Actuator, InteractiveElement, PageReader, Resolved } from '../core/page.ts';
import { nameMatches, resolveTarget } from '../core/resolve.ts';
import { isAbsent, isRef, readRef, scalar, type RunScope } from '../core/scope.ts';
import type { PlaybookIR, SelectorDict, SelectorEntry, Step } from '../core/types.ts';
import type { AgentModel, ScreenItem } from './agent-port.ts';

const KEY = '__agent__';
const PLAIN = new Set(['fill', 'click', 'select', 'press']);
const PLAIN_WAIT = new Set(['selector', 'idle', 'navigation']);
const reEscape = (s: string) => s.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');

export interface ScreenDeps {
  page: PageReader;
  dict: SelectorDict;
  act: Actuator;
  /** 요소를 찾는 프레임(H-01은 main) */
  frame: string;
  journal: (type: string, payload?: Record<string, string | number | boolean>) => void;
}

/** 화면 목록(번호 1부터). 요소 ref는 엔진이 들고, 모델에는 ScreenItem만 간다. */
export async function screenList(d: ScreenDeps): Promise<{ items: ScreenItem[]; els: InteractiveElement[] }> {
  const els = d.page.listInteractive ? await d.page.listInteractive(d.frame) : [];
  return { els, items: els.map((x, i) => ({ n: i + 1, role: x.role, name: x.name, id: x.id, filled: x.filled, enabled: x.enabled })) };
}

/**
 * 목록의 요소 하나를 행동 대상으로 해석한다. 실행 사본 사전에 임시 항목을 두고 resolveTarget(유일 일치·역할·정확한 이름)을 통과해야 한다.
 * 커밋 항목 요소면 거부. allowDeny: 금지 이름 단추를 눌러도 되는가(호출자가 검토 근거를 확인했을 때만 true).
 */
export async function resolveListed(d: ScreenDeps, x: InteractiveElement, allowDeny: boolean, activates: boolean): Promise<{ ok: true; t: Resolved } | { ok: false; code: string }> {
  const name = normalizeName(x.name);
  if (activates && isDenyActionName(name) && !allowDeny) return { ok: false, code: 'agent.deny_name' };
  const cand = x.id ? { kind: 'css' as const, value: `[id="${x.id.replace(/["\\]/g, '\\$&')}"]` } : { kind: 'role' as const, role: x.role, name: x.name };
  d.dict.entries[KEY] = {
    candidates: [cand], role: x.role, namePattern: `^${reEscape(name)}$`, frame: d.frame, landmark: KEY, commits: false, lastVerified: 'agent',
    ...(allowDeny ? { reviewNote: { by: 'agent', reason: 'reviewed target' } } : {}),
  } as unknown as SelectorEntry;
  const r = await resolveTarget(d.page, d.dict, KEY);
  if (!r.ok) return { ok: false, code: r.ambiguous ? 'agent.ambiguous' : r.code };
  for (const [k, e] of Object.entries(d.dict.entries)) {
    if (!e.commits) continue;
    const c = await resolveTarget(d.page, d.dict, k);
    if (c.ok && (await d.page.same(c.t.el, r.t.el))) return { ok: false, code: 'agent.commit_element' };
  }
  return { ok: true, t: r.t };
}

export function dropListed(dict: SelectorDict): void {
  delete dict.entries[KEY];
}

interface GoalItem {
  stepId: string;
  kind: 'fill' | 'click' | 'select';
  key: string;
  what: string;
  token: string | null;
  value: string | null;
}

export interface BrowserAgentDeps extends ScreenDeps {
  ir: PlaybookIR;
  scope: RunScope;
  irreversible: ReadonlySet<string>;
  model: AgentModel;
}

export class BrowserAgent {
  private readonly d: BrowserAgentDeps;
  private readonly info: ReturnType<typeof flatten>['info'];

  constructor(d: BrowserAgentDeps) {
    this.d = d;
    this.info = flatten(d.ir.steps).info;
  }

  /** 막힌 스텝부터 이어지는 "그냥 입력" 묶음과 돌아갈 스텝. 묶음이 비면 null. */
  plan(stepId: string): { goal: GoalItem[]; resume: string } | null {
    const order = [...this.info.values()].filter((v) => !v.repeats.length).sort((a, b) => a.order - b.order);
    const at = order.findIndex((v) => v.step.id === stepId);
    if (at < 0) return null;
    const goal: GoalItem[] = [];
    for (let i = at; i < order.length; i++) {
      const s = order[i]!.step as Step & { target?: string; value?: string; option?: string; for?: string; ifAbsent?: string };
      const plain = PLAIN.has(s.type) || (s.type === 'wait' && PLAIN_WAIT.has(String(s.for)));
      if (!plain || this.d.irreversible.has(s.id)) return goal.length ? { goal, resume: s.id } : null;
      const entry = s.target ? this.d.dict.entries[s.target] : undefined;
      if (entry && (entry.commits || entry.secretKind || entry.inputType === 'password')) return goal.length ? { goal, resume: s.id } : null;
      if (s.type === 'fill' && s.target && entry) {
        const v = this.value(s.value ?? '', entry);
        if (v === undefined) return goal.length ? { goal, resume: s.id } : null;
        goal.push({ stepId: s.id, kind: 'fill', key: s.target, what: `fill ${s.target}${entry.fieldKey ? ` (${entry.fieldKey})` : ''}`, token: v.token, value: v.value });
      } else if (s.type === 'click' && s.target && entry) {
        goal.push({ stepId: s.id, kind: 'click', key: s.target, what: `click ${s.target}`, token: null, value: null });
      } else if (s.type === 'select' && s.target && entry) {
        const v = this.value(s.option ?? '', entry);
        if (v === undefined) return goal.length ? { goal, resume: s.id } : null;
        goal.push({ stepId: s.id, kind: 'select', key: s.target, what: `select ${s.target} option ${v.token}`, token: v.token, value: v.value });
      }
      // press(Tab 등)·wait는 목표에 넣지 않는다: type은 입력 뒤 Tab을 누르고, 모델은 wait를 쓸 수 있다.
    }
    return null;
  }

  /** 값토큰(이중 중괄호)과 실제 값. 없는 선택 입력은 {{empty}}(칸 비우기). 상수는 패키지 허용 상수만. */
  private value(raw: string, entry: SelectorEntry): { token: string; value: string } | undefined {
    if (!isRef(raw)) return entry.allowedConstants?.includes(raw) ? { token: `{{const.${raw}}}`, value: raw } : undefined;
    const v = readRef(this.d.scope, raw);
    if (isAbsent(v)) return { token: '{{empty}}', value: '' };
    const s = scalar(v);
    return s === null ? undefined : { token: `{{${raw.slice(1)}}}`, value: s };
  }

  /** 한 번의 agent_mode. 성공이면 돌아갈 스텝 id, 아니면 null(사람에게). */
  async run(stepId: string): Promise<string | null> {
    const p = this.plan(stepId);
    if (!p) {
      this.d.journal('agent.no_plan', { stepId });
      return null;
    }
    this.d.journal('agent.start', { stepId, steps: p.goal.map((g) => g.stepId).join(','), resume: p.resume });
    const history: string[] = [];
    const refused = new Map<string, number>();
    for (let n = 1; n <= AGENT_MAX_ACTIONS; n++) {
      const { items, els } = await screenList(this.d);
      const a = await this.d.model.next({ goal: p.goal.map((g) => ({ stepId: g.stepId, what: g.what, token: g.token })), history, screen: items });
      if (!a) {
        this.d.journal('agent.end', { stepId, result: 'model_unavailable', actions: n - 1 });
        return null;
      }
      if (a.action === 'done') {
        this.d.journal('agent.end', { stepId, result: 'done', actions: n - 1, resume: p.resume });
        return p.resume;
      }
      if (a.action === 'fail') {
        this.d.journal('agent.end', { stepId, result: 'fail', actions: n - 1 });
        return null;
      }
      const code = await this.exec(a, els, p.goal);
      const sig = `${a.action}:${a.index ?? ''}:${a.token ?? ''}`;
      history.push(`${n}. ${a.action}${a.index !== null ? ` ${a.index}` : ''}${a.token ? ` ${a.token}` : ''}${a.option ? ` "${a.option}"` : ''} → ${code}`);
      this.d.journal('agent.action', { stepId, n, action: a.action, ...(a.step ? { goalStep: a.step } : {}), result: code });
      if (code !== 'ok') {
        const k = (refused.get(sig) ?? 0) + 1;
        refused.set(sig, k);
        // 같은 동작이 두 번 거부되면 그만(모델에게도 같은 규칙)
        if (k >= 2) {
          this.d.journal('agent.end', { stepId, result: 'refused_twice', actions: n });
          return null;
        }
      }
    }
    this.d.journal('agent.end', { stepId, result: 'action_limit', actions: AGENT_MAX_ACTIONS });
    return null;
  }

  private async exec(a: { action: string; index: number | null; token: string | null; option: string | null; step: string | null }, els: InteractiveElement[], goal: GoalItem[]): Promise<string> {
    // 목록은 화면 밖 요소도 담고 동작은 요소로 스크롤하므로 scroll은 할 일이 없다
    if (a.action === 'scroll') return 'ok';
    if (a.action === 'wait') {
      await this.d.page.waitIdle(1_500).catch(() => false);
      return 'ok';
    }
    const x = a.index !== null ? els[a.index - 1] : undefined;
    if (!x) return 'agent.no_element';
    // 금지 이름 단추: 그 걸음의 목표 click 스텝이 검토된(reviewNote, commits:false) 항목이고, 요소 이름이 그 항목 이름 규칙에 맞을 때만
    const g = a.step ? goal.find((y) => y.stepId === a.step && y.kind === 'click') : undefined;
    const ge = g ? this.d.dict.entries[g.key] : undefined;
    const allowDeny = a.action === 'click' && !!ge && !ge.commits && !!ge.reviewNote && ge.role === x.role && nameMatches(ge.namePattern, x.name);
    // 이름 없는 단추·링크는 그 걸음의 목표 click 스텝 항목이 빈 이름을 허용할 때만(예: 실화면 [확인] 사업자번호 확인 ^(확인)?$)
    if (a.action === 'click' && !normalizeName(x.name) && !(ge && !ge.commits && ge.role === x.role && nameMatches(ge.namePattern, x.name))) return 'agent.unnamed';
    const r = await resolveListed(this.d, x, allowDeny, a.action === 'click' || a.action === 'select');
    if (!r.ok) {
      dropListed(this.d.dict);
      return r.code;
    }
    try {
      if (a.action === 'click') {
        const o = await this.d.act.click(r.t);
        return o.ok ? 'ok' : o.code;
      }
      const item = goal.find((y) => y.token === a.token && (a.action === 'type' ? y.kind === 'fill' : y.kind === 'select'));
      if (!item || item.value === null) return 'agent.bad_token';
      if (a.action === 'type') {
        if (x.role !== 'textbox' && x.role !== 'combobox') return 'agent.not_field';
        const o = item.value === '' ? await this.d.act.clear(r.t) : await this.d.act.fill(r.t, item.value, { keyEvents: true });
        if (!o.ok) return o.code;
        // 칸을 떠나며 화면 계산(합계 등)을 돌린다(플레이북의 press Tab과 같다)
        await this.d.act.press('Tab', r.t).catch(() => undefined);
        return 'ok';
      }
      const o = await this.d.act.select(r.t, item.value);
      return o.ok ? 'ok' : o.code;
    } finally {
      dropListed(this.d.dict);
    }
  }
}
