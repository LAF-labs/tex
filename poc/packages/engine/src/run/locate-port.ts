import type { RedactedReplayItem, RedactedText, RespondRequest, RespondResult, RunToken, ToolsetDef } from '@sax/model';
import { DECISION_CHOICE_MAX_CHARS, DECISION_MAX_CHOICES, DECISION_PICK, DECISION_STATE_MAX_CHARS, selectorRepair } from '@sax/model';
import type { Redactor } from '@sax/redaction';
import type { LocateCandidate, LocateModel, LocateRequest } from '../core/locate.ts';

export interface LocateResponder {
  respond(t: ToolsetDef, req: RespondRequest): Promise<RespondResult>;
}

const SCOPE = 'frame';

function locateToolset(): ToolsetDef {
  const t = selectorRepair([SCOPE]);
  for (const tool of t.tools) {
    const props = (tool.parameters as { properties: Record<string, unknown> }).properties;
    if (props.scopeId) props.scopeId = { type: 'string', pattern: '^[A-Za-z0-9_.-]{1,64}$' };
  }
  return t;
}
const BLOCK_FLAGS = new Set(['target_is_irreversible_action', 'possible_injection_text']);

interface GatewayLocateInput {
  responder: LocateResponder;
  redactor: Pick<Redactor, 'apply' | 'map'>;
  runToken: () => Promise<RunToken>;
  journal: (type: string, payload?: Record<string, string | number | boolean>) => void;
  budget?: RunAiBudget;
}

/** 실행당 예산 다 씀 표시(실행마다, 위치 찾기 하나·판정과 에이전트 하나). */
export interface RunAiBudget {
  spent: boolean;
  day?: { spent: boolean };
}
const budgetSpent = (reason: string | undefined): boolean => !!reason && /run_budget_exceeded|budget_exceeded/.test(reason);
/** 응답 사유가 계정 한도(오늘·이번 달·구독)인가. */
export const accountLimited = (reason: string | undefined): boolean => !!reason && /daily_limit|quota_exceeded|subscription_required/.test(reason);
/** 이 응답 사유로 예산 표시를 바꾼다. 계정 한도면 한 번 저널에 남긴다. */
export function noteBudget(b: RunAiBudget | undefined, reason: string | undefined, journal: (type: string, payload?: Record<string, string | number | boolean>) => void): void {
  if (!b) return;
  if (budgetSpent(reason)) b.spent = true;
  if (b.day && accountLimited(reason) && !b.day.spent) {
    b.day.spent = true;
    journal('ai.account_limit', { reason: String(reason).replace(/^gateway:/, '').slice(0, 40) });
  }
}
/** 부르지 않을 때의 사유(없으면 불러도 된다). */
export const budgetBlock = (b: RunAiBudget | undefined): string | null => (b?.day?.spent ? 'account_limit' : b?.spent ? 'budget_spent' : null);

export class GatewayLocateModel implements LocateModel {
  private readonly i: GatewayLocateInput;

  constructor(i: GatewayLocateInput) {
    this.i = i;
  }

  private mask(text: string): RedactedText {
    return this.i.redactor.apply(text, { frame: 'none' }).redacted;
  }

  private unmask(v: string): string | null {
    const out = v.replace(/\[[A-Z]+_\d+\]/g, (t) => this.i.redactor.map.valueOf(t) ?? t);
    return /\[[A-Z]+_\d+\]/.test(out) ? null : out;
  }

  async propose(req: LocateRequest): Promise<LocateCandidate[] | null> {
    const line = (x: LocateRequest['listing'][number]) => `${x.n}. ${req.role} "${x.name}"${x.id ? ` #${x.id}` : ''}`;
    const listing = req.listing.map(line).join('\n');
    const head = [
      '[AI 위치 찾기] 사전 선택자로 찾지 못한 요소를 같은 화면 프레임에서 고른다.',
      `step ${req.stepId} · purpose ${req.purpose} · role ${req.role} · namePattern(RE2) ${req.namePattern} · target ${req.describe}`,
      req.rejected.length ? `이미 써 보고 맞지 않은 선택자: ${req.rejected.join(', ')}` : '',
      req.found ? `사전 선택자가 찾은 요소는 ${req.found}번이다. 역할은 맞고 접근성 이름만 namePattern과 다르다. 그 요소가 대상이 맞으면 그것을 candidates 맨 앞에 낸다. 아니면 맞는 요소를 낸다.` : '',
      '같은 역할 요소 목록(번호. 역할 "접근성 이름" #DOM id). 입력값은 없다.',
    ].filter(Boolean).join('\n');
    const tail = '가장 맞는 요소 하나를 candidates 맨 앞에 낸다. id가 있으면 kind css, value "#id". 없으면 kind role, value 역할, name 접근성 이름. 확신이 없으면 not_found.';
    let message: RedactedText;
    let listingMasked: RedactedText;
    try {
      message = this.mask(`${head}\n${listing}\n${tail}`);
      listingMasked = this.mask(listing);
    } catch {
      this.i.journal('locate.unavailable', { stepId: req.stepId, cause: 'redaction' });
      return null;
    }
    const blocked = budgetBlock(this.i.budget);
    if (blocked) {
      this.i.journal('locate.unavailable', { stepId: req.stepId, cause: blocked });
      return null;
    }
    const t = locateToolset();
    const replay: RedactedReplayItem[] = [];
    let token: RunToken;
    try {
      token = await this.i.runToken();
    } catch {
      this.i.journal('locate.unavailable', { stepId: req.stepId, cause: 'run_token' });
      return null;
    }
    for (let turn = 0; turn < t.maxTurns; turn++) {
      let r: RespondResult;
      try {
        r = await this.i.responder.respond(t, { toolset: 'selector_repair', messages: [{ role: 'user', content: [{ type: 'input_text', text: message }] }], replay, runToken: token });
      } catch {
        this.i.journal('locate.unavailable', { stepId: req.stepId, cause: 'respond' });
        return null;
      }
      if (r.status !== 'completed') {
        noteBudget(this.i.budget, r.reason, this.i.journal);
        this.i.journal('locate.unavailable', { stepId: req.stepId, cause: r.reason ?? r.status });
        return null;
      }
      if (r.toolCalls.length) {
        replay.push(...r.replay);
        for (const c of r.toolCalls) replay.push({ kind: 'function_call_output', callId: c.callId, output: this.toolAnswer(c.name, c.arguments, req, listingMasked) });
        continue;
      }
      return this.accept(req, r.output);
    }
    this.i.journal('locate.unavailable', { stepId: req.stepId, cause: 'turn_limit' });
    return null;
  }

  private toolAnswer(name: string, args: unknown, req: LocateRequest, listingMasked: RedactedText): RedactedText {
    const a = (args ?? {}) as { nameContains?: string; role?: string };
    if (name === 'find_candidates') {
      const hits = req.listing.filter((x) => (a.role ?? req.role) === req.role && x.name.includes(String(a.nameContains ?? '')));
      return this.mask(hits.map((x) => `${x.n}. ${req.role} "${x.name}"${x.id ? ` #${x.id}` : ''}`).join('\n') || '(없음)');
    }
    if (name === 'propose_selectors') return this.mask('제안은 엔진이 최종 출력에서 검사한다. 최종 출력 candidates에 넣어라.');
    return listingMasked;
  }

  private accept(req: LocateRequest, output: unknown): LocateCandidate[] | null {
    const o = output as { outcome?: string; risk_flags?: string[]; candidates?: Array<{ kind: string; value: string; name: string }> } | undefined;
    const flags = o?.risk_flags ?? [];
    this.i.journal('locate.answer', { stepId: req.stepId, outcome: o?.outcome ?? 'none', flags: flags.join(',') });
    if (o?.outcome !== 'repaired' || flags.some((f) => BLOCK_FLAGS.has(f))) return null;
    const out: LocateCandidate[] = [];
    for (const c of o.candidates ?? []) {
      if (c.kind !== 'css' && c.kind !== 'role' && c.kind !== 'label') continue;
      const value = this.unmask(c.value);
      const name = this.unmask(c.name ?? '');
      if (value === null || name === null) continue;
      out.push({ kind: c.kind, value, name });
    }
    return out.length ? out : null;
  }
}

/**
 * 결정 모델 고르기를 받는 기준(typesafe/jev-1.14, none 없는 모양, 2026-11-16): 맞는 답 p 0.77~0.96, 틀린 답 p 0.25~0.69.
 * 0.7 미만은 '모름'으로 보고 다음 칸(AI 위치 찾기)으로 넘긴다. 받은 후보는 엔진이 역할·유일 일치로 다시 검사한다.
 */
export const DECISION_MIN_P = 0.7;
export const DECISION_MIN_CONFIDENCE = 0.7;

/**
 * 결정 모델 칸(decision_pick, 기본 ~typesafe/jev-latest): 위치 찾기의 첫 호출을 생성 모델 대신 선택지 분류로 한다. 같은 역할 요소 목록(가림)의
 * 번호 하나를 고르게 하고, 확률·신뢰도가 기준을 넘을 때만 그 요소를 후보로 낸다. 아니면(또는 목록이 길거나 호출이 안 되면) 같은 호출 안에서
 * 생성 모델(selector_repair)로 넘긴다. 받은 후보는 엔진이 위치 찾기와 똑같이 다시 검사한다(R-A1 이름 규칙·유일 일치·커밋 충돌).
 * 스텝·항목마다 한 번만 쓴다(두 번째 호출은 바로 생성 모델).
 */
export class DecisionFirstLocateModel implements LocateModel {
  private readonly i: GatewayLocateInput;
  private readonly next: LocateModel;
  private readonly asked = new Set<string>();

  constructor(i: GatewayLocateInput, next: LocateModel) {
    this.i = i;
    this.next = next;
  }

  async propose(req: LocateRequest): Promise<LocateCandidate[] | null> {
    const k = `${req.stepId}\u0000${req.key}`;
    if (this.asked.has(k) || req.found) return this.next.propose(req);
    this.asked.add(k);
    const picked = await this.pick(req).catch(() => null);
    return picked ?? this.next.propose(req);
  }

  private async pick(req: LocateRequest): Promise<LocateCandidate[] | null> {
    const skip = (cause: string) => {
      this.i.journal('locate.decision', { stepId: req.stepId, key: req.key, result: cause });
      return null;
    };
    const built = decisionPickInput(req);
    if (typeof built === 'string') return skip(built);
    let text: RedactedText;
    try {
      text = this.i.redactor.apply(built.json, { frame: 'none' }).redacted;
      JSON.parse(text);
    } catch {
      return skip('redaction');
    }
    const blocked = budgetBlock(this.i.budget);
    if (blocked) return skip(blocked);
    const { pool } = built;
    let token: RunToken;
    try {
      token = await this.i.runToken();
    } catch {
      return skip('run_token');
    }
    this.i.journal('locate.decision_asked', { stepId: req.stepId, key: req.key, choices: pool.length });
    let r: RespondResult;
    try {
      r = await this.i.responder.respond(DECISION_PICK, { toolset: 'decision_pick', messages: [{ role: 'user', content: [{ type: 'input_text', text }] }], replay: [], runToken: token });
    } catch {
      return skip('respond');
    }
    if (r.status !== 'completed') {
      noteBudget(this.i.budget, r.reason, this.i.journal);
      return skip(String(r.reason ?? r.status).slice(0, 40));
    }
    const o = r.output as { choice?: string; confidence?: number; p?: number } | undefined;
    const x = pool.find((e) => String(e.n) === o?.choice);
    const ok = !!x && (o?.p ?? 0) >= DECISION_MIN_P && (o?.confidence ?? 0) >= DECISION_MIN_CONFIDENCE;
    this.i.journal('locate.decision', { stepId: req.stepId, key: req.key, result: ok ? 'picked' : x ? 'low_confidence' : 'none', choice: String(o?.choice ?? '').slice(0, 8), p: Math.round((o?.p ?? 0) * 100), confidence: Math.round((o?.confidence ?? 0) * 100) });
    if (!ok || !x) return null;
    return [x.id ? { kind: 'css', value: `#${x.id}`, name: x.name } : { kind: 'role', value: req.role, name: x.name }];
  }
}

/** 칸 고르기 글 모양. ids: 'short'는 id 공통 머리를 state에 한 번만, 'full'은 id 그대로. none: '없음' 선택지를 둘지. 측정용으로 열어 둔다. */
export interface DecisionPickShape { ids: 'short' | 'full'; none: boolean }
/**
 * jev-1.14 측정(2026-11-16, 6경우×2×4모양): none이 있으면 맞을 때도 p가 0.45~0.79로 none과 나뉘고 글 낱말 하나에 8/12↔4/12로 흔들렸다.
 * none을 빼면 맞는 답 p 0.77~0.96, 틀린 답 p 0.25~0.69로 갈려 문턱(DECISION_MIN_P)이 '모름'을 맡는다. id 머리 생략은 입력 11% 절약.
 */
export const DECISION_PICK_SHAPE: DecisionPickShape = { ids: 'short', none: false };

export function decisionPickInput(req: LocateRequest, shape: DecisionPickShape = DECISION_PICK_SHAPE): { pool: LocateRequest['listing']; json: string } | 'listing_size' {
  const pool = req.listing.filter((x) => !req.rejected.includes(x.id ? `#${x.id}` : `role=${req.role}[name="${x.name}"]`));
  if (pool.length < 1 || pool.length > DECISION_MAX_CHOICES - 1) return 'listing_size';
  const ids = pool.map((x) => x.id).filter((x): x is string => !!x);
  let head = shape.ids === 'short' && ids.length > 1 ? ids[0]! : '';
  for (const id of ids) while (head && !id.startsWith(head)) head = head.slice(0, -1);
  head = head.replace(/[^_-]*$/, '');
  const short = (id: string | null) => (id ? `#${head && id.startsWith(head) ? id.slice(head.length) : id}` : '');
  const strip = (sel: string) => (head ? sel.split(`#${head}`).join('#') : sel);
  const state = [
    `[목표] 스텝 ${req.stepId}: ${req.purpose} · 항목 ${req.describe} · 역할 ${req.role}`,
    req.was?.length ? `예전 선택자(지금은 못 찾음): ${req.was.map(strip).join(', ')}` : '',
    req.rejected.length ? `써 보고 맞지 않은 선택자: ${req.rejected.map(strip).join(', ')}` : '',
    `선택지는 아래 같은 역할 요소 목록의 번호다.${head ? ` id의 공통 머리 ${head}는 생략했다.` : ''}${shape.none ? ' 목표 칸이 없거나 확신이 없으면 none.' : ' 목표 칸에 가장 가까운 번호 하나.'}`,
  ].filter(Boolean).join('\n').slice(0, DECISION_STATE_MAX_CHARS);
  const choices: Record<string, string> = {};
  for (const x of pool) choices[String(x.n)] = `${req.role} "${x.name}"${x.id ? ` ${short(x.id)}` : ''}`.slice(0, DECISION_CHOICE_MAX_CHARS);
  if (shape.none) choices.none = '목록에 목표 칸이 없다 또는 확신이 없다';
  return { pool, json: JSON.stringify({ state, choices }) };
}
