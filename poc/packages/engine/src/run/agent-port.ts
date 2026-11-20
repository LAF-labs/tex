import { BROWSER_AGENT, COMPUTER_USE, PAGE_JUDGE, type AgentActionName, type ComputerActionName, type MaskedShot, type JudgePrescription, type RedactedText, type RespondResult, type RunToken, type ToolsetDef } from '@sax/model';
import type { Redactor } from '@sax/redaction';
import { budgetBlock, noteBudget, type LocateResponder, type RunAiBudget } from './locate-port.ts';

export interface ScreenItem {
  n: number;
  role: string;
  name: string;
  id: string | null;
  filled: boolean;
  enabled: boolean;
}

export interface JudgeRequest {
  stepId: string;
  step: string;
  cause: string;
  dialog: { kind: string; message: string } | null;
  lastNotice: string | null;
  screen: ScreenItem[];
  fields: string[];
}

export interface Judgement {
  situation: string;
  prescription: JudgePrescription;
  button: number | null;
  dialogAnswer: 'accept' | 'dismiss' | null;
  field: string | null;
}

export interface AgentRequest {
  goal: Array<{ stepId: string; what: string; token: string | null }>;
  history: string[];
  screen: ScreenItem[];
}

export interface AgentAction {
  action: AgentActionName;
  index: number | null;
  token: string | null;
  option: string | null;
  step: string | null;
}

export interface VisionRequest {
  goal: Array<{ stepId: string; what: string; token: string | null }>;
  history: string[];
  shot: { url: MaskedShot; width: number; height: number };
}

export interface VisionAction {
  action: ComputerActionName;
  x: number | null;
  y: number | null;
  token: string | null;
  step: string | null;
}

export interface VisionModel {
  next(req: VisionRequest): Promise<VisionAction | null>;
}

export interface JudgeModel {
  judge(req: JudgeRequest): Promise<Judgement | null>;
}
export interface AgentModel {
  next(req: AgentRequest): Promise<AgentAction | null>;
}

interface AgentPortInput {
  responder: LocateResponder;
  redactor: Pick<Redactor, 'apply' | 'map'>;
  runToken: () => Promise<RunToken>;
  journal: (type: string, payload?: Record<string, string | number | boolean>) => void;
  budget?: RunAiBudget;
}

const line = (x: ScreenItem) => `${x.n}. ${x.role} "${x.name}"${x.id ? ` #${x.id}` : ''}${[x.filled ? 'filled' : '', x.enabled ? '' : 'disabled'].filter(Boolean).map((s) => `(${s})`).join('')}`;
type Part = { text: string; data?: true };
const screenPart = (items: ScreenItem[]): Part => ({ text: items.map(line).join('\n') || '(상호작용 요소 없음)', data: true });

type Shot = { shot: MaskedShot };

async function callOnce(i: AgentPortInput, t: ToolsetDef, parts: Array<Part | Shot>, tag: Record<string, string | number | boolean>): Promise<unknown> {
  const blocked = budgetBlock(i.budget);
  if (blocked) {
    i.journal(`${t.id}.unavailable`, { ...tag, cause: blocked });
    return null;
  }
  let content: Array<{ type: 'input_text'; text: RedactedText } | { type: 'input_image'; image_url: MaskedShot }>;
  try {
    content = parts.map((p) => ('shot' in p ? { type: 'input_image' as const, image_url: p.shot } : { type: 'input_text' as const, text: i.redactor.apply(p.text, { frame: p.data ? 'screen' : 'none' }).redacted }));
  } catch {
    i.journal(`${t.id}.unavailable`, { ...tag, cause: 'redaction' });
    return null;
  }
  let token: RunToken;
  try {
    token = await i.runToken();
  } catch {
    i.journal(`${t.id}.unavailable`, { ...tag, cause: 'run_token' });
    return null;
  }
  let r: RespondResult;
  try {
    r = await i.responder.respond(t, { toolset: t.id, messages: [{ role: 'user', content }], replay: [], runToken: token });
  } catch {
    i.journal(`${t.id}.unavailable`, { ...tag, cause: 'respond' });
    return null;
  }
  if (r.status !== 'completed' || r.toolCalls.length) {
    noteBudget(i.budget, r.reason, i.journal);
    i.journal(`${t.id}.unavailable`, { ...tag, cause: r.reason ?? r.status });
    return null;
  }
  return r.output;
}

export class GatewayJudgeModel implements JudgeModel {
  private readonly i: AgentPortInput;
  constructor(i: AgentPortInput) {
    this.i = i;
  }

  async judge(req: JudgeRequest): Promise<Judgement | null> {
    const parts: Part[] = [
      {
        text: [
          '[예상 밖 화면 판정] 첫 승인 앞 구간이다. 처방 하나를 고른다.',
          `step ${req.stepId} · ${req.step} · cause ${req.cause}`,
          ...(req.cause === 'step.timeout' && /^(click|fill|select) /.test(req.step) ? ['대상 요소는 찾았다. 그 요소에 대한 동작이 시간 안에 끝나지 않았다(덮은 팝업·처리 중 표시·비활성일 수 있다). fix_field는 소용없다.'] : []),
          `fix_field에 쓸 수 있는 대상 키: ${req.fields.join(', ') || '(없음)'}`,
        ].join('\n'),
      },
      ...(req.dialog ? [{ text: `떠 있는 JS 대화상자(${req.dialog.kind}) 문구:` }, { text: req.dialog.message, data: true as const }] : [{ text: 'JS 대화상자: 없음' }]),
      ...(req.lastNotice ? [{ text: '최근 닫힌 대화상자 문구:' }, { text: req.lastNotice, data: true as const }] : []),
      { text: '화면 상호작용 요소(번호. 역할 "이름" #id(상태)). 값은 없다.' },
      screenPart(req.screen),
    ];
    const o = (await callOnce(this.i, PAGE_JUDGE, parts, { stepId: req.stepId })) as
      | { situation: string; prescription: JudgePrescription; button: number | null; dialog_answer: 'accept' | 'dismiss' | null; field: string | null; risk_flags: string[] }
      | null;
    if (!o) return null;
    this.i.journal('judge.answer', { stepId: req.stepId, situation: o.situation, prescription: o.prescription, flags: o.risk_flags.join(',') });
    if (o.risk_flags.includes('possible_injection_text') || o.risk_flags.includes('irreversible_button')) return { situation: o.situation, prescription: 'handoff', button: null, dialogAnswer: null, field: null };
    const button = o.button !== null && req.screen.some((x) => x.n === o.button) ? o.button : null;
    const field = o.field !== null && req.fields.includes(o.field) ? o.field : null;
    if (o.prescription === 'dismiss_dialog' && !(req.dialog ? o.dialog_answer : button)) return null;
    if (o.prescription === 'fix_field' && !field) return { situation: o.situation, prescription: 'agent_mode', button: null, dialogAnswer: null, field: null };
    return { situation: o.situation, prescription: o.prescription, button, dialogAnswer: req.dialog ? o.dialog_answer : null, field };
  }
}

export class GatewayAgentModel implements AgentModel {
  private readonly i: AgentPortInput;
  constructor(i: AgentPortInput) {
    this.i = i;
  }

  async next(req: AgentRequest): Promise<AgentAction | null> {
    const parts: Part[] = [
      { text: ['[목표] 아래 스텝을 이 화면에서 한다. 값토큰은 그대로 쓴다.', ...req.goal.map((g) => `${g.stepId} ${g.what}${g.token ? ` ${g.token}` : ''}`), '[지난 동작]', ...(req.history.length ? req.history : ['(없음)'])].join('\n') },
      { text: '[화면] 상호작용 요소(번호. 역할 "이름" #id(상태)). 값은 없다.' },
      screenPart(req.screen),
    ];
    const o = (await callOnce(this.i, BROWSER_AGENT, parts, { steps: req.goal.length })) as AgentAction | null;
    if (!o) return null;
    const tokens = new Set(req.goal.map((g) => g.token).filter((x): x is string => !!x));
    if (o.index !== null && !req.screen.some((x) => x.n === o.index)) return null;
    if ((o.action === 'click' || o.action === 'type' || o.action === 'select') && o.index === null) return null;
    if (o.action === 'type' && (!o.token || !tokens.has(o.token))) return null;
    if (o.action === 'select' && !o.option) return null;
    return { action: o.action, index: o.index, token: o.action === 'type' ? o.token : null, option: o.action === 'select' ? o.option : null, step: o.step };
  }
}

/** 화면 보기(computer_use) 한 걸음: 목표·지난 동작(가린 글) + 가린 사진 한 장. 출력은 좌표가 사진 안, 값토큰이 목표 안일 때만 받는다. */
export class GatewayVisionModel implements VisionModel {
  private readonly i: AgentPortInput;
  constructor(i: AgentPortInput) {
    this.i = i;
  }

  async next(req: VisionRequest): Promise<VisionAction | null> {
    const parts: Array<Part | Shot> = [
      { text: ['[목표] 아래 스텝을 이 화면에서 한다. 값토큰은 그대로 쓴다.', ...req.goal.map((g) => `${g.stepId} ${g.what}${g.token ? ` ${g.token}` : ''}`), '[지난 동작]', ...(req.history.length ? req.history : ['(없음)'])].join('\n') },
      { text: `[사진] 가로 ${req.shot.width} 세로 ${req.shot.height} 픽셀. 입력 칸·숫자·메일 글은 검게 가렸다.` },
      { shot: req.shot.url },
    ];
    const o = (await callOnce(this.i, COMPUTER_USE, parts, { steps: req.goal.length })) as (VisionAction & { risk_flags?: string[] }) | null;
    if (!o) return null;
    if (o.risk_flags?.length) {
      this.i.journal('computer_use.refused', { flags: o.risk_flags.join(',') });
      return { action: 'fail', x: null, y: null, token: null, step: null };
    }
    const tokens = new Set(req.goal.map((g) => g.token).filter((x): x is string => !!x));
    const pointed = o.action === 'click' || o.action === 'type';
    if (pointed && (o.x === null || o.y === null || o.x < 0 || o.y < 0 || o.x >= req.shot.width || o.y >= req.shot.height)) return null;
    if (o.action === 'type' && (!o.token || !tokens.has(o.token))) return null;
    return { action: o.action, x: pointed ? o.x : null, y: pointed ? o.y : null, token: o.action === 'type' ? o.token : null, step: o.step };
  }
}
