import { flatten } from '../core/cfg.ts';
import { normalizeName } from '../core/constants.ts';
import { locatable, locateTarget, type LocateEnv } from '../core/locate.ts';
import type { PlaybookIR, Step } from '../core/types.ts';
import type { JudgeModel } from './agent-port.ts';
import { resolveListed, screenList, dropListed, type BrowserAgent, type ScreenDeps } from './browser-agent.ts';

/** 판정이 골라도 누르거나 수락하지 않는 글(되돌릴 수 없는 일·동의·등록·계정 변경). 공지의 [확인]·[닫기]·[연장]은 된다. */
export const IRREVERSIBLE_TEXT = /(발급|전송|서명|제출|신고|승인|결제|삭제|저장|신청|동의|등록|확정|변경|해지|탈퇴|issue|submit|send|sign|agree|delete|pay)/i;
const JUDGE_PER_STEP = 2;
const JUDGE_TYPES = new Set(['goto', 'click', 'fill', 'select', 'press', 'wait', 'assert', 'extract', 'checkpoint', 'readback']);
const JUDGE_CODES = new Set([
  'step.selector_miss', 'step.identity_mismatch', 'step.timeout', 'step.readback_mismatch', 'step.assert_failed',
  'step.not_clickable', 'step.ambiguous', 'step.dialog_mismatch', 'step.extract_miss',
]);

interface PageJudgeDeps extends ScreenDeps {
  ir: PlaybookIR;
  irreversible: ReadonlySet<string>;
  model: JudgeModel;
  agent: BrowserAgent | null;
  locate?: LocateEnv;
  lastNotice: () => string | null;
  currentStep: () => string | null;
}

export class PageJudge {
  private readonly d: PageJudgeDeps;
  private readonly info: ReturnType<typeof flatten>['info'];
  private readonly firstGate: number;
  private readonly used = new Map<string, number>();

  constructor(d: PageJudgeDeps) {
    this.d = d;
    this.info = flatten(d.ir.steps).info;
    this.firstGate = Math.min(...[...this.info.values()].filter((v) => v.step.type === 'gate').map((v) => v.order), Number.POSITIVE_INFINITY);
  }

  beforeGate(stepId: string | null): boolean {
    const v = stepId ? this.info.get(stepId) : undefined;
    return !!v && v.order < this.firstGate && !this.d.irreversible.has(stepId!);
  }

  eligible(s: Step, cause: string): boolean {
    if (!JUDGE_TYPES.has(s.type) || !JUDGE_CODES.has(cause) || !this.beforeGate(s.id) || (this.used.get(s.id) ?? 0) >= JUDGE_PER_STEP) return false;
    const key = (s as Step & { target?: string }).target;
    const e = key ? this.d.dict.entries[key] : undefined;
    return !(e && (e.commits || e.secretKind || e.inputType === 'password'));
  }

  async onStuck(stepId: string, cause: string, o: { locateTried?: boolean } = {}): Promise<{ from: string } | false> {
    const s = this.info.get(stepId)?.step;
    const n = this.used.get(stepId) ?? 0;
    if (!s || !this.eligible(s, cause) || !this.d.page.listInteractive) return false;
    this.used.set(stepId, n + 1);
    const { items, els } = await screenList(this.d);
    const target = (s as Step & { target?: string }).target;
    const fields = this.fieldKeys(stepId).filter((k) => !(o.locateTried && k === target));
    const j = await this.d.model.judge({ stepId, step: `${s.type}${target ? ` ${target}` : ''}`, cause, dialog: null, lastNotice: this.d.lastNotice(), screen: items, fields });
    if (!j) return this.done(stepId, 'none', 'model_unavailable', false);
    switch (j.prescription) {
      case 'dismiss_dialog': {
        const x = j.button !== null ? els[j.button - 1] : undefined;
        if (!x || !normalizeName(x.name) || IRREVERSIBLE_TEXT.test(normalizeName(x.name))) return this.done(stepId, j.prescription, 'refused_name', false);
        const r = await resolveListed(this.d, x, true, true);
        if (!r.ok) {
          dropListed(this.d.dict);
          return this.done(stepId, j.prescription, r.code, false);
        }
        const o = await this.d.act.click(r.t).finally(() => dropListed(this.d.dict));
        return this.done(stepId, j.prescription, o.ok ? 'ok' : o.code, o.ok ? { from: stepId } : false);
      }
      case 'relogin': {
        const cp = this.firstCheckpoint();
        return this.done(stepId, j.prescription, cp ? 'ok' : 'no_checkpoint', cp ? { from: cp } : false);
      }
      case 'reload_checkpoint': {
        const cp = s.type === 'checkpoint' ? stepId : this.checkpointBefore(stepId);
        return this.done(stepId, j.prescription, cp ? 'ok' : 'no_checkpoint', cp ? { from: cp } : false);
      }
      case 'fix_field': {
        if (cause === 'step.timeout' && (s.type === 'click' || s.type === 'fill' || s.type === 'select')) return this.done(stepId, j.prescription, 'found_not_actionable', false);
        const key = j.field!;
        const e = this.d.dict.entries[key];
        if (!this.d.locate || !e) return this.agentAfter(stepId, j.prescription, 'no_locate');
        const purpose = e.role === 'textbox' || e.role === 'combobox' ? 'fill' : 'click';
        const r = await locateTarget({ page: this.d.page, dict: this.d.dict, loc: this.d.locate, stepId, key, purpose, rejected: [], calls: { n: 0 } });
        if (r) return this.done(stepId, j.prescription, 'ok', { from: stepId });
        return this.agentAfter(stepId, j.prescription, 'not_found');
      }
      case 'agent_mode': {
        const resume = this.d.agent ? await this.d.agent.run(stepId) : null;
        return this.done(stepId, j.prescription, resume ? 'ok' : 'agent_failed', resume ? { from: resume } : false);
      }
      default:
        return this.done(stepId, j.prescription, 'handoff', false);
    }
  }

  async onDialog(kind: string, message: string): Promise<'accept' | 'dismiss' | null> {
    const stepId = this.d.currentStep();
    if (kind !== 'confirm' || !stepId || !this.beforeGate(stepId)) return null;
    if (IRREVERSIBLE_TEXT.test(normalizeName(message))) {
      this.d.journal('judge.dialog', { stepId, kind, answer: 'dismiss', why: 'irreversible_text' });
      return 'dismiss';
    }
    const n = this.used.get(`dialog:${stepId}`) ?? 0;
    if (n >= JUDGE_PER_STEP) return null;
    this.used.set(`dialog:${stepId}`, n + 1);
    const s = this.info.get(stepId)?.step as (Step & { target?: string }) | undefined;
    const j = await this.d.model.judge({ stepId, step: `${s?.type ?? ''}${s?.target ? ` ${s.target}` : ''}`, cause: 'dialog.unexpected', dialog: { kind, message }, lastNotice: null, screen: [], fields: [] });
    const answer = j?.prescription === 'dismiss_dialog' ? j.dialogAnswer : null;
    this.d.journal('judge.dialog', { stepId, kind, answer: answer ?? 'default', prescription: j?.prescription ?? 'none' });
    return answer;
  }

  private async agentAfter(stepId: string, prescription: string, why: string): Promise<{ from: string } | false> {
    const resume = this.d.agent ? await this.d.agent.run(stepId) : null;
    return this.done(stepId, prescription, resume ? `${why}+agent_ok` : `${why}${this.d.agent ? '+agent_failed' : ''}`, resume ? { from: resume } : false);
  }

  private done(stepId: string, prescription: string, result: string, out: { from: string } | false): { from: string } | false {
    this.d.journal('judge.applied', { stepId, prescription, result, ...(out ? { from: out.from } : {}) });
    return out;
  }

  private fieldKeys(stepId: string): string[] {
    const me = this.info.get(stepId)!;
    const keys = new Set<string>();
    for (const v of this.info.values()) {
      const t = (v.step as Step & { target?: unknown }).target;
      if (v.order >= me.order && v.order < this.firstGate && typeof t === 'string' && locatable(this.d.dict.entries[t], v.step.id, this.d.irreversible)) keys.add(t);
    }
    return [...keys];
  }

  private firstCheckpoint(): string | null {
    const cps = [...this.info.values()].filter((v) => v.step.type === 'checkpoint' && !v.repeats.length).sort((a, b) => a.order - b.order);
    return (cps.find((v) => (v.step as { name?: string }).name === 'session') ?? cps[0])?.step.id ?? null;
  }

  private checkpointBefore(stepId: string): string | null {
    const me = this.info.get(stepId);
    if (!me) return null;
    let best: { id: string; order: number } | null = null;
    for (const [id, v] of this.info) if (v.step.type === 'checkpoint' && !v.repeats.length && v.order < me.order && (!best || v.order > best.order)) best = { id, order: v.order };
    return best?.id ?? null;
  }
}
