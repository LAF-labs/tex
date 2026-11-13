// 예상 밖 화면 판정(page_judge)·브라우저 에이전트(browser_agent) 모델 포트: 게이트웨이 /v1/respond, 도구 없이 1턴(D04 §4, 2026-11-13).
// - 모델에는 마스킹된 글만 간다(D04 C-10): 스텝 의도(코드 이름), 상호작용 요소 목록(역할·접근성 이름·상태, 값 없음), 대화상자 문구를 Redactor로 가린다.
// - 화면 글(요소 목록·대화상자 문구)은 따로 가려 Redactor가 <<<SCREEN_DATA … SCREEN_DATA>>>로 감싼다(본문 속 구분자는 이스케이프된다). 지시 글과 다른 content 조각이다.
// - 출력은 스키마 검사(어댑터) 뒤 여기서 다시 좁힌다: 번호는 목록 안, 키는 준 목록 안, 값토큰은 준 목록 안. 아니면 받지 않는다(null).
import { BROWSER_AGENT, PAGE_JUDGE, type AgentActionName, type JudgePrescription, type RedactedText, type RespondResult, type RunToken, type ToolsetDef } from '@sax/model';
import type { Redactor } from '@sax/redaction';
import { budgetSpent, type LocateResponder, type RunAiBudget } from './locate-port.ts';

export interface ScreenItem {
  n: number;
  role: string;
  name: string;
  /** DOM id(값 아님). 실화면은 접근성 이름이 빈 칸이 많아 id가 칸을 가른다(AI 위치 찾기 목록과 같다). */
  id: string | null;
  filled: boolean;
  enabled: boolean;
}

export interface JudgeRequest {
  stepId: string;
  /** 스텝 동작·대상 키(코드 이름) */
  step: string;
  cause: string;
  /** 지금 떠 있는 JS 대화상자(kind·문구) */
  dialog: { kind: string; message: string } | null;
  /** 최근에 받은(이미 닫힌) 대화상자 문구 */
  lastNotice: string | null;
  screen: ScreenItem[];
  /** fix_field에 쓸 수 있는 대상 키 */
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

export interface JudgeModel {
  judge(req: JudgeRequest): Promise<Judgement | null>;
}
export interface AgentModel {
  next(req: AgentRequest): Promise<AgentAction | null>;
}

export interface AgentPortInput {
  responder: LocateResponder;
  redactor: Pick<Redactor, 'apply' | 'map'>;
  runToken: () => Promise<RunToken>;
  journal: (type: string, payload?: Record<string, string | number | boolean>) => void;
  /** 실행당 예산 다 씀 표시(locate-port RunAiBudget, 판정·에이전트 공용). 다 썼으면 부르지 않는다. */
  budget?: RunAiBudget;
}

const line = (x: ScreenItem) => `${x.n}. ${x.role} "${x.name}"${x.id ? ` #${x.id}` : ''}${[x.filled ? 'filled' : '', x.enabled ? '' : 'disabled'].filter(Boolean).map((s) => `(${s})`).join('')}`;
/** 모델에 보낼 조각. data면 화면 글이라 SCREEN_DATA로 감싼다. 조각마다 따로 가린다(같은 토큰 맵). */
type Part = { text: string; data?: true };
const screenPart = (items: ScreenItem[]): Part => ({ text: items.map(line).join('\n') || '(상호작용 요소 없음)', data: true });

/** 판정·에이전트 공통: 가려서 한 번 부르고 구조화 출력을 돌려준다. 실패면 null(저널에 원인 코드만). */
async function callOnce(i: AgentPortInput, t: ToolsetDef, parts: Part[], tag: Record<string, string | number | boolean>): Promise<unknown> {
  if (i.budget?.spent) {
    i.journal(`${t.id}.unavailable`, { ...tag, cause: 'budget_spent' });
    return null;
  }
  let content: Array<{ type: 'input_text'; text: RedactedText }>;
  try {
    content = parts.map((p) => ({ type: 'input_text' as const, text: i.redactor.apply(p.text, { frame: p.data ? 'screen' : 'none' }).redacted }));
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
    if (i.budget && budgetSpent(r.reason)) i.budget.spent = true;
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
    // 주입 의심이면 무엇을 골랐든 사람에게
    if (o.risk_flags.includes('possible_injection_text') || o.risk_flags.includes('irreversible_button')) return { situation: o.situation, prescription: 'handoff', button: null, dialogAnswer: null, field: null };
    const button = o.button !== null && req.screen.some((x) => x.n === o.button) ? o.button : null;
    const field = o.field !== null && req.fields.includes(o.field) ? o.field : null;
    if (o.prescription === 'dismiss_dialog' && !(req.dialog ? o.dialog_answer : button)) return null;
    if (o.prescription === 'fix_field' && !field) return null;
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
