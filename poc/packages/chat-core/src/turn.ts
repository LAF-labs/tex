// 대화 한 턴의 이벤트(ADR-054)와 말풍선 반응(ADR-056). PC 엔진·main과 폰이 같이 쓴다. 순수 함수만 둔다.
// - 반응은 판정(jev, chat_route_v1)이 고른다. 사용자 문장을 정규식으로 읽어 반응을 정하지 않는다(ADR-051 1절).
// - 이모지는 허용 목록 넷뿐이다. 판정 값(이름)이 목록에 없으면 반응하지 않는다.

/** 반응 허용 목록(ADR-056 결정 2). 키는 판정 선택지 값, 값은 화면 이모지. */
export const REACTIONS = {
  /** 알겠다, 좋다, 확인했다 */
  thumbs_up: '👍',
  /** 맡긴 일을 보고 있다(접수) */
  eyes: '👀',
  /** 됐다, 끝났다는 말에 맞장구 */
  check: '✅',
  /** 고맙다, 수고했다는 인사에 */
  pray: '🙏',
} as const;
export type ReactionId = keyof typeof REACTIONS;
export const REACTION_IDS = Object.keys(REACTIONS) as ReactionId[];
export const isReaction = (v: unknown): v is ReactionId => typeof v === 'string' && Object.hasOwn(REACTIONS, v);

/** 판정 번들(chat_route_v1)의 답하는 방식 선택지 */
export const REPLY_MODES = ['reaction_only', 'react_then_work', 'answer'] as const;
export type ReplyMode = (typeof REPLY_MODES)[number];

/** 이 확률 아래면 반응하지 않고 늘 하던 대로 답한다(판정은 길을 좁히지 막지 않는다, ADR-051 2절 ①) */
export const REACTION_GTE = 0.8;

/** 폰과 PC가 같은 번들을 부른다. digest는 packages/model/bundles/chat_route_v1.json과 같다(시험이 대조). */
export const CHAT_ROUTE_BUNDLE = { id: 'chat_route_v1', digest: 'd422049ae92b3bea0965d05fed747a33a00cb5772dbc25918c93cbf973cf65db' } as const;

/** 판정 답 한 질문(이름 키). PC는 @sax/model BundleAnswers, 폰은 게이트웨이 응답을 이 꼴로 옮긴다. */
export type RouteAnswer = { type: 'choice'; value: string; confidence: number } | { type: 'predicate'; probability: number } | { type: 'refusal' } | { type: string };

/** 판정이 정한 받는 방식. mode가 answer면 reaction은 null이다. */
export interface RouteAck {
  mode: ReplyMode;
  reaction: ReactionId | null;
}

const choice = (a: RouteAnswer | undefined): { value: string; confidence: number } | null =>
  a && a.type === 'choice' && typeof (a as { value?: unknown }).value === 'string' && typeof (a as { confidence?: unknown }).confidence === 'number' ? (a as { value: string; confidence: number }) : null;

/**
 * 판정 답 → 받는 방식. 문턱 아래, 모르는 값, 반응을 못 고름, 세무 판단을 묻는 말은 answer다(그때 반응 없음).
 * - reaction_only: 반응 하나로 턴을 닫는다. 대화 모델을 부르지 않는다.
 * - react_then_work: 반응을 먼저 달고 도구 루프를 돈다. 답은 결과만 말한다.
 */
export function routeAck(answers: Record<string, RouteAnswer | undefined> | null | undefined): RouteAck {
  const none: RouteAck = { mode: 'answer', reaction: null };
  if (!answers) return none;
  const mode = choice(answers.reply_mode);
  const react = choice(answers.reaction);
  if (!mode || mode.confidence < REACTION_GTE || !(REPLY_MODES as readonly string[]).includes(mode.value) || mode.value === 'answer') return none;
  const advice = answers.mentions_tax_advice;
  // 세무 판단을 묻는 말은 반응으로 넘기지 않는다(고정 문구 길). 답이 없으면 묻는 쪽으로 본다(번들 onRefusal assume_true).
  if (!advice || advice.type !== 'predicate' || (advice as { probability: number }).probability >= 0.5) return none;
  if (!react || !isReaction(react.value)) return none;
  return { mode: mode.value as ReplyMode, reaction: react.value };
}

/**
 * 게이트웨이 /v1/decide 응답(OpenAI Decisions 배열 꼴: {type, name, choice|probability, confidence})을 이름 키 답으로 옮긴다.
 * 폰이 쓴다(PC는 @sax/model 어댑터가 같은 일을 한다). 모르는 꼴은 버린다.
 */
export function routeAnswersOf(decisions: unknown): Record<string, RouteAnswer> {
  const out: Record<string, RouteAnswer> = {};
  if (!Array.isArray(decisions)) return out;
  for (const d of decisions as Array<Record<string, unknown>>) {
    if (!d || typeof d !== 'object' || typeof d.name !== 'string') continue;
    if (d.type === 'choice' && typeof d.choice === 'string' && typeof d.confidence === 'number') out[d.name] = { type: 'choice', value: d.choice, confidence: d.confidence };
    else if (d.type === 'predicate' && typeof d.probability === 'number') out[d.name] = { type: 'predicate', probability: d.probability };
  }
  return out;
}

// ── 턴 이벤트(ADR-054 결정 2, ADR-056 결정 3) ──

export type TurnEndStatus = 'completed' | 'failed' | 'cancelled';
/** 확률 구간(값을 그대로 남기지 않는다) */
export type ProbBand = 'gte90' | 'gte80' | 'lt80';
export const bandOf = (p: number): ProbBand => (p >= 0.9 ? 'gte90' : p >= 0.8 ? 'gte80' : 'lt80');

type Base = { turnId: string; seq: number; at: number };
export type TurnEvent = Base &
  (
    | { type: 'turn.start'; device: 'pc' | 'phone'; msgId: string }
    | { type: 'route'; act: string | null; domain: string | null; mode: ReplyMode; band: ProbBand; unsure: boolean; failed: boolean }
    /** 사용자 말풍선에 다는 반응. msgId는 반응을 받는 사용자 메시지다. */
    | { type: 'reaction'; msgId: string; reaction: ReactionId }
    | { type: 'path'; path: 'tools' | 'talk' | 'fixed' | 'reaction'; tools: string[] }
    | { type: 'tool.start'; tool: string; args: Record<string, unknown> }
    | { type: 'tool.end'; tool: string; status: string; ref: string | null; runId: string | null }
    | { type: 'recall' }
    | { type: 'reply'; msgId: string; kind: string; filtered: string | null }
    | { type: 'turn.end'; status: TurnEndStatus; code?: string; reason?: 'stopped' | 'closed' }
  );
/** 이벤트 본문(turnId·seq·at은 턴이 붙인다) */
export type TurnEventBody = TurnEvent extends infer E ? (E extends Base ? Omit<E, keyof Base> : never) : never;

/** 운영 신호(ADR-054 결정 5): 내용 없는 값만 허용 목록으로 뽑는다. 문장·토큰·인자·ref·turnId·msgId·반응 대상은 남기지 않는다. */
export interface TurnSignal {
  device: 'pc' | 'phone' | null;
  mode: ReplyMode | null;
  band: ProbBand | null;
  unsure: boolean;
  routeFailed: boolean;
  reaction: ReactionId | null;
  path: string | null;
  tools: string[];
  statuses: string[];
  recall: boolean;
  filtered: string | null;
  end: TurnEndStatus | null;
  code: string | null;
  ms: number | null;
}

export function turnSignal(events: readonly TurnEvent[]): TurnSignal {
  const s: TurnSignal = { device: null, mode: null, band: null, unsure: false, routeFailed: false, reaction: null, path: null, tools: [], statuses: [], recall: false, filtered: null, end: null, code: null, ms: null };
  let start: number | null = null;
  for (const e of events) {
    switch (e.type) {
      case 'turn.start':
        s.device = e.device;
        start = e.at;
        break;
      case 'route':
        s.mode = e.mode;
        s.band = e.band;
        s.unsure = e.unsure;
        s.routeFailed = e.failed;
        break;
      case 'reaction':
        s.reaction = e.reaction;
        break;
      case 'path':
        s.path = e.path;
        break;
      case 'tool.start':
        s.tools.push(e.tool);
        break;
      case 'tool.end':
        s.statuses.push(e.status);
        break;
      case 'recall':
        s.recall = true;
        break;
      case 'reply':
        s.filtered = e.filtered;
        break;
      case 'turn.end':
        s.end = e.status;
        s.code = e.code ?? null;
        s.ms = start === null ? null : e.at - start;
        break;
      default:
        // 모르는 종류는 건너뛴다(앞으로 호환)
        break;
    }
  }
  return s;
}

/** 턴 하나의 이벤트를 차례로 낸다. 끝은 한 번만 나간다(ADR-054 결정 3). */
export class TurnRecorder {
  readonly turnId: string;
  private seq = 0;
  private ended = false;
  private readonly now: () => number;
  private readonly sink: ((e: TurnEvent) => void) | undefined;
  readonly events: TurnEvent[] = [];

  constructor(turnId: string, now: () => number, sink?: (e: TurnEvent) => void) {
    this.turnId = turnId;
    this.now = now;
    this.sink = sink;
  }

  emit(body: TurnEventBody): void {
    if (this.ended) return;
    const e = { ...body, turnId: this.turnId, seq: this.seq++, at: this.now() } as TurnEvent;
    if (e.type === 'turn.end') this.ended = true;
    this.events.push(e);
    try {
      this.sink?.(e);
    } catch {
      // 화면 쪽 듣는 함수가 던져도 턴은 이어 간다
    }
  }

  get done(): boolean {
    return this.ended;
  }
}
