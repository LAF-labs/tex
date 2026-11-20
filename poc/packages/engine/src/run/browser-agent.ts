import { AGENT_MAX_ACTIONS, COMPUTER_MAX_ACTIONS } from '@sax/model';
import { flatten } from '../core/cfg.ts';
import { isDenyActionName, normalizeName } from '../core/constants.ts';
import type { Actuator, InteractiveElement, PageReader, Resolved } from '../core/page.ts';
import { nameMatches, resolveTarget } from '../core/resolve.ts';
import { isAbsent, isRef, readRef, scalar, type RunScope } from '../core/scope.ts';
import type { PlaybookIR, SelectorDict, SelectorEntry, Step } from '../core/types.ts';
import type { AgentModel, ScreenItem, VisionModel } from './agent-port.ts';
import { planSignature, type AgentPathMemory, type PathAction } from './agent-path.ts';

const KEY = '__agent__';
const PLAIN = new Set(['fill', 'click', 'select', 'press']);
const PLAIN_WAIT = new Set(['selector', 'idle', 'navigation']);
const reEscape = (s: string) => s.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');

export interface ScreenDeps {
  page: PageReader;
  dict: SelectorDict;
  act: Actuator;
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
  paths?: AgentPathMemory;
  pkg?: SelectorDict;
  vision?: VisionModel;
}

export class BrowserAgent {
  private readonly d: BrowserAgentDeps;
  private readonly info: ReturnType<typeof flatten>['info'];

  private readonly firstGate: number;

  constructor(d: BrowserAgentDeps) {
    this.d = d;
    this.info = flatten(d.ir.steps).info;
    this.firstGate = Math.min(...[...this.info.values()].filter((v) => v.step.type === 'gate').map((v) => v.order), Number.POSITIVE_INFINITY);
  }

  private sig(p: { goal: GoalItem[]; resume: string }): string {
    return planSignature(p.goal, p.resume, this.d.pkg ?? this.d.dict);
  }

  replayable(stepId: string): boolean {
    const v = this.info.get(stepId);
    if (!this.d.paths?.has(stepId) || !v || v.order >= this.firstGate || this.d.irreversible.has(stepId)) return false;
    const p = this.plan(stepId);
    return !!p && !!this.d.paths.get(stepId, this.sig(p));
  }

  async replay(stepId: string): Promise<string | null> {
    const p = this.plan(stepId);
    const path = p && this.d.paths ? this.d.paths.get(stepId, this.sig(p)) : null;
    if (!p || !path || !this.d.paths) return null;
    this.d.journal('agentpath.replay', { stepId, actions: path.actions.length, resume: path.resume });
    await this.d.page.waitIdle(5_000).catch(() => false);
    for (const [i, a] of path.actions.entries()) {
      let index: number | null = null;
      let els: InteractiveElement[] = [];
      if (a.el) {
        ({ els } = await screenList(this.d));
        const want = a.el;
        const hits = els.map((x, n) => ({ x, n })).filter(({ x }) => x.role === want.role && (want.id ? x.id === want.id : normalizeName(x.name) === normalizeName(want.name)));
        if (hits.length !== 1) return this.replayFailed(stepId, i + 1, hits.length ? 'agentpath.ambiguous' : 'agentpath.no_element');
        index = hits[0]!.n + 1;
      }
      const code = await this.exec({ action: a.action, index, token: a.token, option: a.option, step: a.step }, els, p.goal);
      this.d.journal('agentpath.action', { stepId, n: i + 1, action: a.action, result: code });
      if (code !== 'ok') return this.replayFailed(stepId, i + 1, code);
    }
    this.d.paths.replaying(stepId, path.resume);
    this.d.journal('agentpath.replayed', { stepId, actions: path.actions.length, resume: path.resume });
    return path.resume;
  }

  visionable(stepId: string): boolean {
    const v = this.info.get(stepId);
    if (!this.d.vision || !this.d.page.maskedShot || !this.d.page.box || !v || v.order >= this.firstGate || this.d.irreversible.has(stepId)) return false;
    return !!this.plan(stepId);
  }

  async vision(stepId: string): Promise<string | null> {
    const p = this.plan(stepId);
    if (!p || !this.d.vision || !this.d.page.maskedShot || !this.d.page.box) return null;
    this.d.journal('computer_use.start', { stepId, steps: p.goal.map((g) => g.stepId).join(','), resume: p.resume });
    const history: string[] = [];
    const walked: PathAction[] = [];
    const refused = new Map<string, number>();
    const end = (result: string, n: number, resume?: string) => {
      this.d.journal('computer_use.end', { stepId, result, actions: n, ...(resume ? { resume } : {}) });
      return resume ?? null;
    };
    for (let n = 1; n <= COMPUTER_MAX_ACTIONS; n++) {
      const shot = await this.d.page.maskedShot().catch(() => null);
      if (!shot) return end('no_shot', n - 1);
      const a = await this.d.vision.next({ goal: p.goal.map((g) => ({ stepId: g.stepId, what: g.what, token: g.token })), history, shot });
      if (!a) return end('model_unavailable', n - 1);
      if (a.action === 'done') {
        this.d.paths?.propose(stepId, { sig: this.sig(p), resume: p.resume, actions: walked });
        return end('done', n - 1, p.resume);
      }
      if (a.action === 'fail') return end('fail', n - 1);
      let code: string;
      let el: InteractiveElement | undefined;
      if (a.action === 'click' || a.action === 'type') {
        const { els } = await screenList(this.d);
        let best: { i: number; area: number } | null = null;
        for (const [i, x] of els.entries()) {
          const b = await this.d.page.box(x.el).catch(() => null);
          if (!b || a.x! < b.x || a.y! < b.y || a.x! > b.x + b.width || a.y! > b.y + b.height) continue;
          const area = b.width * b.height;
          if (!best || area < best.area) best = { i, area };
        }
        if (!best) code = 'computer_use.no_element';
        else {
          el = els[best.i];
          code = await this.exec({ action: a.action, index: best.i + 1, token: a.token, option: null, step: a.step }, els, p.goal);
        }
      } else {
        code = await this.exec({ action: a.action, index: null, token: null, option: null, step: a.step }, [], p.goal);
      }
      if (code === 'ok') walked.push({ action: a.action, el: el ? { role: el.role, name: normalizeName(el.name), id: el.id } : null, token: a.token, option: null, step: a.step });
      history.push(`${n}. ${a.action}${a.x !== null ? ` (${a.x},${a.y})` : ''}${a.token ? ` ${a.token}` : ''}${el ? ` = ${el.role}` : ''} → ${code}`);
      this.d.journal('computer_use.action', { stepId, n, action: a.action, ...(a.step ? { goalStep: a.step } : {}), result: code });
      if (code !== 'ok') {
        const sig = `${a.action}:${el?.id ?? el?.name ?? `${a.x},${a.y}`}:${a.token ?? ''}`;
        const k = (refused.get(sig) ?? 0) + 1;
        refused.set(sig, k);
        if (k >= 2) return end('refused_twice', n);
      }
    }
    return end('action_limit', COMPUTER_MAX_ACTIONS);
  }

  private replayFailed(stepId: string, n: number, code: string): null {
    this.d.journal('agentpath.replay_failed', { stepId, n, code });
    this.d.paths?.missed(stepId, code);
    return null;
  }

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
    }
    return null;
  }

  private value(raw: string, entry: SelectorEntry): { token: string; value: string } | undefined {
    if (!isRef(raw)) return entry.allowedConstants?.includes(raw) ? { token: `{{const.${raw}}}`, value: raw } : undefined;
    const v = readRef(this.d.scope, raw);
    if (isAbsent(v)) return { token: '{{empty}}', value: '' };
    const s = scalar(v);
    return s === null ? undefined : { token: `{{${raw.slice(1)}}}`, value: s };
  }

  async run(stepId: string): Promise<string | null> {
    const p = this.plan(stepId);
    if (!p) {
      this.d.journal('agent.no_plan', { stepId });
      return null;
    }
    this.d.journal('agent.start', { stepId, steps: p.goal.map((g) => g.stepId).join(','), resume: p.resume });
    const history: string[] = [];
    const walked: PathAction[] = [];
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
        this.d.paths?.propose(stepId, { sig: this.sig(p), resume: p.resume, actions: walked });
        return p.resume;
      }
      if (a.action === 'fail') {
        this.d.journal('agent.end', { stepId, result: 'fail', actions: n - 1 });
        return null;
      }
      const code = await this.exec(a, els, p.goal);
      if (code === 'ok' && (a.action === 'click' || a.action === 'type' || a.action === 'select' || a.action === 'wait' || a.action === 'scroll')) {
        const x = a.index !== null ? els[a.index - 1] : undefined;
        walked.push({ action: a.action, el: x ? { role: x.role, name: normalizeName(x.name), id: x.id } : null, token: a.token, option: null, step: a.step });
      }
      const sig = `${a.action}:${a.index ?? ''}:${a.token ?? ''}`;
      history.push(`${n}. ${a.action}${a.index !== null ? ` ${a.index}` : ''}${a.token ? ` ${a.token}` : ''}${a.option ? ` "${a.option}"` : ''} → ${code}`);
      this.d.journal('agent.action', { stepId, n, action: a.action, ...(a.step ? { goalStep: a.step } : {}), result: code });
      if (code !== 'ok') {
        const k = (refused.get(sig) ?? 0) + 1;
        refused.set(sig, k);
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
    if (a.action === 'scroll') return 'ok';
    if (a.action === 'wait') {
      await this.d.page.waitIdle(1_500).catch(() => false);
      return 'ok';
    }
    const x = a.index !== null ? els[a.index - 1] : undefined;
    if (!x) return 'agent.no_element';
    const g = a.step ? goal.find((y) => y.stepId === a.step && y.kind === 'click') : undefined;
    const ge = g ? this.d.dict.entries[g.key] : undefined;
    const allowDeny = a.action === 'click' && !!ge && !ge.commits && !!ge.reviewNote && ge.role === x.role && nameMatches(ge.namePattern, x.name);
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
