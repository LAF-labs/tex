
/** 반응 허용 목록(ADR-057 결정 2). 키는 판정 선택지 값, 값은 화면 이모지. */
export const REACTIONS = {
  thumbs_up: '👍',
  eyes: '👀',
  check: '✅',
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
export const CHAT_ROUTE_BUNDLE = { id: 'chat_route_v1', digest: '57e81c6d6b2892830cc672d91eeb588d493b38687c6c9fdbbee136c3b91211e5' } as const;

/** 판정 답 한 질문(이름 키). PC는 @sax/model BundleAnswers, 폰은 게이트웨이 응답을 이 꼴로 옮긴다. */
export type RouteAnswer = { type: 'choice'; value: string; confidence: number } | { type: 'predicate'; probability: number } | { type: 'refusal' } | { type: string };

/** 판정이 정한 받는 방식. mode가 answer여도 맞장구가 이어진 턴이면(capStreak) 반응을 달고 짧게 답한다. */
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
  if (!advice || advice.type !== 'predicate' || (advice as { probability: number }).probability >= 0.5) return none;
  if (!react || !isReaction(react.value)) return none;
  return { mode: mode.value as ReplyMode, reaction: react.value };
}

/**
 * 반응만으로 잇달아 닫는 상한(대표 피드백 2026-11-19: "고마워를 연달아 보내면 매번 이모지만 보내지 말고 응답을 해야 어색하지 않다").
 * 바로 앞 턴이 반응만이었으면 이번 맞장구는 반응을 달고 대화 모델이 한 문장으로 답한다. 판정 입력에도 연속 횟수를 실어 판정이 먼저 고르게 하고,
 * 이 상한은 판정이 그래도 반응만을 고를 때의 안전장치다. 문장이 아니라 대화 기록(앞 턴이 반응만이었는가)만 본다.
 */
export const ACK_STREAK_MAX = 1;

/** 판정 입력의 한 줄: 바로 앞에서 반응만으로 닫은 턴 수. 0이면 줄을 싣지 않는다(입력이 다른 사례와 같다). */
export const reactedLine = (streak: number): string[] => (streak > 0 ? [`직전 앱 답: 반응만 ${streak}번 연속`] : []);

/** 대화 모델에 주는 한 줄(짧게 답하라는 앱 판단). 맞장구가 이어져 반응만으로 닫지 않은 턴에만 싣는다. */
export const ACK_REPLY_HINT = '앱 판단: 맞장구가 이어짐(앞 맞장구에는 반응만 했다). 한 문장으로 짧게 답한다';

/** 연속 상한을 적용한다. 넘으면 반응은 달고 답은 대화 모델이 한다(mode answer, reaction 그대로). */
export function capStreak(ack: RouteAck, streak: number): RouteAck & { capped: boolean } {
  if (ack.mode === 'reaction_only' && streak >= ACK_STREAK_MAX) return { mode: 'answer', reaction: ack.reaction, capped: true };
  return { ...ack, capped: false };
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

export type TurnEndStatus = 'completed' | 'failed' | 'cancelled';
/** 확률 구간(값을 그대로 남기지 않는다) */
export type ProbBand = 'gte90' | 'gte80' | 'lt80';
export const bandOf = (p: number): ProbBand => (p >= 0.9 ? 'gte90' : p >= 0.8 ? 'gte80' : 'lt80');

type Base = { turnId: string; seq: number; at: number };
export type TurnEvent = Base &
  (
    | { type: 'turn.start'; device: 'pc' | 'phone'; msgId: string }
    | { type: 'route'; act: string | null; domain: string | null; mode: ReplyMode; band: ProbBand; unsure: boolean; failed: boolean }
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
