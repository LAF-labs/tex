// 예상 밖 화면 판정(2026-11-13 대표 지시 "스크립트가 안 되면 모델에게 판정을"): 폴백 사슬이 실패했거나 예상 밖 상태(JS 대화상자·공지 팝업·
// 다른 화면·세션 만료)일 때 모델에게 가린 화면을 보이고 처방 하나를 받아 엔진이 가드를 거쳐 실행한다. 첫 게이트 앞 스텝에서만 쓴다.
// 처방: dismiss_dialog(JS 대화상자 accept|dismiss, 화면 팝업은 단추 번호) · relogin(세션 체크포인트부터) · reload_checkpoint(이 스텝 앞 체크포인트부터)
//       · fix_field(대상 키 하나를 AI 위치 찾기로) · agent_mode(브라우저 에이전트) · handoff.
// 지키는 것: 커밋 항목 요소와 IRREVERSIBLE_TEXT 이름(발급·전송·서명·제출·동의·등록 등)의 단추는 누르지 않는다.
// JS confirm은 정책상 무장된 커밋 구간이 아니면 dismiss인데, 판정이 accept라고 하고 문구가 되돌릴 수 없는 일이 아닐 때만 accept한다(세션 연장 등).
import { flatten } from '../core/cfg.ts';
import { normalizeName } from '../core/constants.ts';
import { locatable, locateTarget, type LocateEnv } from '../core/locate.ts';
import type { PlaybookIR, Step } from '../core/types.ts';
import type { JudgeModel } from './agent-port.ts';
import { resolveListed, screenList, dropListed, type BrowserAgent, type ScreenDeps } from './browser-agent.ts';

/** 판정이 골라도 누르거나 수락하지 않는 글(되돌릴 수 없는 일·동의·등록·계정 변경). 공지의 [확인]·[닫기]·[연장]은 된다. */
export const IRREVERSIBLE_TEXT = /(발급|전송|서명|제출|신고|승인|결제|삭제|저장|신청|동의|등록|확정|변경|해지|탈퇴|issue|submit|send|sign|agree|delete|pay)/i;
/** 스텝당 판정 상한 */
const JUDGE_PER_STEP = 2;
/** 판정을 받을 스텝 타입(첫 게이트 앞만). goto·검사·체크포인트도 본다(세션 만료·다른 화면). */
const JUDGE_TYPES = new Set(['goto', 'click', 'fill', 'select', 'press', 'wait', 'assert', 'extract', 'checkpoint', 'readback']);
/** 판정을 받을 실패. 정책·보안 거부(policy.*, commit_shadow, url_not_allowed, secret_field…)는 넣지 않는다. */
const JUDGE_CODES = new Set([
  'step.selector_miss', 'step.identity_mismatch', 'step.timeout', 'step.readback_mismatch', 'step.assert_failed',
  'step.not_clickable', 'step.ambiguous', 'step.dialog_mismatch', 'step.extract_miss',
]);

export interface PageJudgeDeps extends ScreenDeps {
  ir: PlaybookIR;
  irreversible: ReadonlySet<string>;
  model: JudgeModel;
  agent: BrowserAgent | null;
  locate?: LocateEnv;
  /** 최근에 받은(이미 닫힌) 대화상자 문구(실행 메모리) */
  lastNotice: () => string | null;
  /** 지금 도는 스텝 id(대화상자 판정이 첫 게이트 앞인지 본다) */
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

  /** 첫 게이트 앞(되돌릴 수 있는 구간)의 스텝인가 */
  beforeGate(stepId: string | null): boolean {
    const v = stepId ? this.info.get(stepId) : undefined;
    return !!v && v.order < this.firstGate && !this.d.irreversible.has(stepId!);
  }

  /** 폴백 사슬 escalate: 이 실패를 판정에 보낼 수 있는가 */
  eligible(s: Step, cause: string): boolean {
    if (!JUDGE_TYPES.has(s.type) || !JUDGE_CODES.has(cause) || !this.beforeGate(s.id) || (this.used.get(s.id) ?? 0) >= JUDGE_PER_STEP) return false;
    const key = (s as Step & { target?: string }).target;
    const e = key ? this.d.dict.entries[key] : undefined;
    return !(e && (e.commits || e.secretKind || e.inputType === 'password'));
  }

  /** 막힌 스텝의 판정과 처방 실행. 다시 돌 곳 또는 false(사람에게). */
  async onStuck(stepId: string, cause: string): Promise<{ from: string } | false> {
    const s = this.info.get(stepId)?.step;
    const n = this.used.get(stepId) ?? 0;
    if (!s || !this.eligible(s, cause) || !this.d.page.listInteractive) return false;
    this.used.set(stepId, n + 1);
    const { items, els } = await screenList(this.d);
    const fields = this.fieldKeys(stepId);
    const target = (s as Step & { target?: string }).target;
    const j = await this.d.model.judge({ stepId, step: `${s.type}${target ? ` ${target}` : ''}`, cause, dialog: null, lastNotice: this.d.lastNotice(), screen: items, fields });
    if (!j) return this.done(stepId, 'none', 'model_unavailable', false);
    switch (j.prescription) {
      case 'dismiss_dialog': {
        const x = j.button !== null ? els[j.button - 1] : undefined;
        // 이름 없는 단추는 무엇인지 몰라 누르지 않는다
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
        // 누름·입력·선택이 시간 초과면 대상은 이미 찾았다: 위치 찾기는 같은 요소를 다시 낼 뿐이다(실행 예산만 쓴다).
        if (cause === 'step.timeout' && (s.type === 'click' || s.type === 'fill' || s.type === 'select')) return this.done(stepId, j.prescription, 'found_not_actionable', false);
        const key = j.field!;
        const e = this.d.dict.entries[key];
        if (!this.d.locate || !e) return this.done(stepId, j.prescription, 'no_locate', false);
        const purpose = e.role === 'textbox' || e.role === 'combobox' ? 'fill' : 'click';
        const r = await locateTarget({ page: this.d.page, dict: this.d.dict, loc: this.d.locate, stepId, key, purpose, rejected: [], calls: { n: 0 } });
        return this.done(stepId, j.prescription, r ? 'ok' : 'not_found', r ? { from: stepId } : false);
      }
      case 'agent_mode': {
        const resume = this.d.agent ? await this.d.agent.run(stepId) : null;
        return this.done(stepId, j.prescription, resume ? 'ok' : 'agent_failed', resume ? { from: resume } : false);
      }
      default:
        return this.done(stepId, j.prescription, 'handoff', false);
    }
  }

  /**
   * 정책이 dismiss로 정한 JS confirm(무장 밖)을 판정에 묻는다. accept는 판정이 accept라 하고 문구가 되돌릴 수 없는 일이 아닐 때만.
   * 대화상자가 떠 있는 동안에는 화면을 읽을 수 없어 문구만 보낸다.
   */
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

  private done(stepId: string, prescription: string, result: string, out: { from: string } | false): { from: string } | false {
    this.d.journal('judge.applied', { stepId, prescription, result, ...(out ? { from: out.from } : {}) });
    return out;
  }

  /** fix_field 후보: 이 스텝부터 첫 게이트 앞까지 스텝들의 대상 키(위치 찾기가 되는 것만). */
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
