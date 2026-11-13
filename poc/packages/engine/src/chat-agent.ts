// 대화 에이전트 모델 경계 chat.step(D04 §4 chat_agent, 결정안 agent-chat-design-2026-11-12 §2~§10).
// 루프와 도구 실행은 main이 한다(값 공간: 카드·조회 결과와 ref). 엔진은 토큰 공간만 맡는다:
// 마스킹(대화 세션 토큰 맵), 마스킹 대화록, 그 턴의 replay, 도구 호출 역치환(토큰 → 레코드 ID·값), 도구 결과 구조 검사(C-10), 답 검사.
// - main → { start: {text, frame, profileId} } → 모델 → 도구 호출이면 { kind: 'tools', calls }(역치환한 DomainCall),
//   main이 실행 → { continue: {outputs} } → … → { kind: 'reply', reply }.
// - 도구 결과는 열거형 스키마(TOOL_OUTPUT_SCHEMA)를 통과해야만 보낸다. 값·개수·자유 문자열이 섞이면 보내지 않고 chat.bad_tool_output.
// - 대화록에는 채우기 전 답(모델이 쓴 토큰·슬롯 그대로)만 들어간다(AgentTurnRecord). 화면에 보이는 채운 문장은 대화록 타입과 따로다.
// - 로그·저널을 남기지 않는다(문장·토큰·값 없음).
import { randomUUID } from 'node:crypto';
import ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import { CounterpartyRepo, ProfileRepo, type Db } from '@sax/db';
import {
  AGENT_ASKS,
  AGENT_REPLY_KINDS,
  AGENT_SHOW_MAX,
  CHAT_AGENT,
  CHAT_REPLY_MAX_CHARS,
  OpenAIResponsesAdapter,
  SLOT_FIELDS,
  SLOT_MONEY_PATHS,
  gatewayRunToken,
  slotPattern,
  type AgentAsk,
  type AgentReplyKind,
  type ChatAgentToolName,
  type RedactedReplayItem,
  type RedactedText,
  type RespondRequest,
  type RespondResult,
  type RunToken,
  type SlotField,
  type ToolCall,
} from '@sax/model';
import type { Egress } from '@sax/net';
import { CHAT_MAP_IDLE_MS, ChatTokenMaps, TOKEN_RE, detokenize, normalizeForRedaction, type Redactor } from '@sax/redaction';
import { CHAT_ADVICE_TEXT, ChatError, chatAdviceMentioned, chatSecretShaped, errorOf, unsafeText, type ChatErrorCode } from './chat.ts';
import { INTENT_TEXT_MAX } from './intent.ts';

/** 한 사용자 턴의 마스킹 입력 상한(바이트). 대화록이 붙어 chat_reply(2048)보다 크다. 넘으면 오래된 턴부터 버린다. */
export const CHAT_AGENT_INPUT_MAX_BYTES = 8192;
/** 대화록에 붙이는 최근 턴 수 */
export const CHAT_AGENT_TRANSCRIPT_TURNS = 12;
/** 답 문장을 쓸 수 없을 때(식별자·링크·비밀 유도 말, 모델 거절)의 고정 안내 */
export const CHAT_AGENT_FALLBACK_TEXT = '세금계산서 카드 만들기와 발급 기록·매출·받을 돈 확인을 도와드려요. 어떤 일을 할까요?';
/**
 * 답 문장에 슬롯·토큰 밖의 숫자가 있을 때(모델이 셈하거나 지어낸 값일 수 있다). 문장은 버리고 같이 보일 표·카드는 그대로 둔다.
 * 다시 묻지 않는 이유: 한 번 더 부르면 3~4초가 늘고 또 틀릴 수 있다. 표·카드의 값은 PC가 낸 것이라 언제나 맞다.
 */
export const CHAT_AGENT_NUMBER_TEXT = '결과를 화면에 보여 드렸어요. 금액과 날짜는 표와 카드에서 확인해 주세요.';
/** 다시 보낼 턴이라 대화록에 남기지 않는 오류 */
const RETRY_CODES: readonly ChatErrorCode[] = ['chat.unavailable', 'chat.budget_exceeded', 'chat.quota_exceeded'];
/** 게이트웨이 respond 스키마의 replay maxItems */
const REPLAY_MAX = 12;

export const TOOL_STATUSES = ['ok', 'empty', 'unknown_counterparty', 'not_set_up', 'card_shown', 'needs_input', 'setup_missing', 'card_updated', 'no_such_draft', 'not_editable', 'discarded'] as const;
export type ToolStatus = (typeof TOOL_STATUSES)[number];
export const TOOL_NEEDS = ['amount', 'item', 'counterparty'] as const;
export type ToolNeed = (typeof TOOL_NEEDS)[number];

/** main이 모델에 돌려주는 도구 결과. 값·행·개수가 없다(C-10). */
export interface ToolOutput {
  ref: string | null;
  status: ToolStatus;
  fields: SlotField[] | null;
  needs: ToolNeed[] | null;
}

export type Vat = 'separate' | 'included';

/** 화면 프레임: 열린 카드의 ref와 열거 값만. 거래처는 레코드 ID로 받아 엔진이 토큰으로 바꾼다. */
export interface ScreenFrame {
  cards: Array<{ ref: string; counterpartyId: string; amount: boolean; vat: Vat | null; item: boolean }>;
}

export type StepParams = { start: { text: string; frame: ScreenFrame; profileId: string } } | { continue: { outputs: Array<{ callId: string; output: ToolOutput }> } };

/** 금액 인자: 금액 토큰을 로컬에서 읽은 값, 또는 main이 채울 결과 슬롯 */
export type DraftAmount = { value: number } | { slot: string } | null;

/** 역치환한 도구 호출. counterpartyId는 'cp:' 없는 거래처 레코드 ID다. */
export type DomainCall =
  | { tool: 'sales_summary'; monthOffset: number }
  | { tool: 'invoice_history'; counterpartyId: string | null }
  | { tool: 'receivables'; counterpartyId: string | null }
  | { tool: 'invoice_draft'; counterpartyId: string; amount: DraftAmount; vat: Vat | null; item: string | null }
  | { tool: 'draft_edit'; draft: string; amount: DraftAmount; vat: Vat | null; item: string | null }
  | { tool: 'draft_discard'; draft: string };

/** 검사를 마친 답. filtered가 있으면 text는 엔진 고정 문구다. */
export interface AgentReply {
  kind: AgentReplyKind;
  text: string;
  show: string[];
  ask: AgentAsk | null;
  filtered: null | 'advice' | 'unsafe' | 'refusal' | 'number';
}

/**
 * main에 돌려주는 답. text는 채우기 전 문장(토큰·슬롯 그대로)이고, values는 이 답에 나온 토큰의 화면 값이다
 * (거래처 토큰은 지금 장부 이름, 다른 토큰은 사장님이 쓴 원값). 토큰·슬롯을 값으로 바꾸고 조사를 맞추는 일은 main 한 곳에서 한다.
 */
export type ShownReply = AgentReply & {
  values: Record<string, string>;
  /**
   * 이번 턴에 장부의 거래처로 풀리지 않은 이름(U8-1). 사장님이 이번 문장에 쓴 낱말(그 토큰의 원값이나 문장에 글자 그대로 있던 말)일 때만이다.
   * 모델이 지어낸 이름은 싣지 않는다. 화면은 "장부에 없는 거래처" 안내와 그 이름으로 [거래처 추가]를 둔다. PC 밖으로 나가지 않는다.
   */
  unknownName: string | null;
};
export type StepResult = { kind: 'tools'; calls: Array<{ callId: string } & DomainCall> } | { kind: 'reply'; reply: ShownReply };

/** 대화록 한 턴. agent.text는 채우기 전(토큰·슬롯 그대로) 문장이다. 채운 문장은 이 타입에 들어오지 않는다. agent null은 답 없이 끝난 턴. */
export interface AgentTurnRecord {
  user: RedactedText;
  agent: { text: string; show: string[] } | null;
}

export interface ChatAgentModel {
  /** 게이트웨이 /v1/respond(chat_agent). 어댑터가 출력 스키마·도구 인자·툴셋 해시를 검증한다. */
  respond: (req: RespondRequest) => Promise<RespondResult>;
  /** 대화 세션 범위 실행 토큰(게이트웨이 POST /v1/run-tokens) */
  runToken: (chatSessionId: string) => Promise<RunToken>;
}

export interface ChatAgentOptions {
  /** null이면 모든 턴이 chat.unavailable(오프라인 대체 없음) */
  model: ChatAgentModel | null;
  now?: () => number;
}

const Ajv2020 = ajv2020.default as typeof import('ajv').default;
const ajv = new Ajv2020({ strict: false });
const nullable = (s: object) => ({ anyOf: [s, { type: 'null' }] });
const REF = '^[rd][1-9][0-9]{0,5}$';
const TOOL_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ref', 'status', 'fields', 'needs'],
  properties: {
    ref: nullable({ type: 'string', pattern: REF }),
    status: { enum: [...TOOL_STATUSES] },
    fields: nullable({ type: 'array', maxItems: SLOT_FIELDS.length, uniqueItems: true, items: { enum: [...SLOT_FIELDS] } }),
    needs: nullable({ type: 'array', maxItems: TOOL_NEEDS.length, uniqueItems: true, items: { enum: [...TOOL_NEEDS] } }),
  },
};
const validOutputs: ValidateFunction = ajv.compile({
  type: 'array',
  maxItems: CHAT_AGENT.maxTurns,
  items: { type: 'object', additionalProperties: false, required: ['callId', 'output'], properties: { callId: { type: 'string', maxLength: 128 }, output: TOOL_OUTPUT_SCHEMA } },
});
const validFrame: ValidateFunction = ajv.compile({
  type: 'object',
  additionalProperties: false,
  required: ['cards'],
  properties: {
    cards: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ref', 'counterpartyId', 'amount', 'vat', 'item'],
        properties: {
          ref: { type: 'string', pattern: '^d[1-9][0-9]{0,5}$' },
          counterpartyId: { type: 'string', minLength: 1, maxLength: 64 },
          amount: { type: 'boolean' },
          vat: { enum: ['separate', 'included', null] },
          item: { type: 'boolean' },
        },
      },
    },
  },
});

/** 도구마다 결과 ref의 종류(조회 결과 r#, 카드 d#) */
const REF_KIND: Record<ChatAgentToolName, 'r' | 'd'> = { sales_summary: 'r', invoice_history: 'r', receivables: 'r', invoice_draft: 'd', draft_edit: 'd', draft_discard: 'd' };
const engineAnswer = (status: 'unknown_counterparty' | 'no_such_draft'): ToolOutput => ({ ref: null, status, fields: null, needs: null });
/**
 * 풀리지 않은 거래처 인자가 사장님 이번 문장의 낱말인가: 이번 문장에 있는 토큰이면 그 원값, 토큰 없는 말이면 문장에 글자 그대로 있을 때만.
 * 다른 레코드에 묶인 토큰(내 사업장 등)은 "장부에 없는 거래처"가 아니라 싣지 않는다.
 */
const NAME_MAX = 40;
function typedName(s: { red: { map: { valueOf(tok: string): string | undefined; recordOf(tok: string): string | undefined } } }, turn: { user: string }, v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (/^\[NAME_\d+\]$/.test(t)) {
    const raw = turn.user.includes(t) && !s.red.map.recordOf(t) ? s.red.map.valueOf(t)?.trim() : undefined;
    return raw && [...raw].length <= NAME_MAX ? raw : null;
  }
  return t && !/[[\]]/.test(t) && [...t].length <= NAME_MAX && turn.user.includes(t) ? t : null;
}
const KINDS: ReadonlySet<string> = new Set(AGENT_REPLY_KINDS);
const ASKS: ReadonlySet<string> = new Set(AGENT_ASKS);
const SLOT_ANY = new RegExp(slotPattern.source.slice(1, -1), 'g');
const VAT_LABEL = { separate: '별도', included: '포함' } as const;

const KO_NUM: Record<string, string> = { 영: '0', 공: '0', 일: '1', 이: '2', 삼: '3', 사: '4', 오: '5', 육: '6', 륙: '6', 칠: '7', 팔: '8', 구: '9' };
const SMALL: Record<string, number> = { 십: 10, 백: 100, 천: 1000 };
const BIG: Record<string, number> = { 만: 1e4, 억: 1e8 };

const SINO = '영일이삼사오육칠팔구십백천만억';
/** 수 뒤에 올 수 있는 단위·조사(이 밖의 한글이 붙으면 낱말의 일부다: "천천히", "만들다") */
const NUM_TAIL = '(?=$|[^가-힣]|(?:원|건|월|일|년|개월|번째|에|에서|으로|로|을|를|이|가|은|는|도|만|짜리|정도|쯤|씩|예요|이에요|였|이었))';
/** 세션 Redactor별 대화 경로 추가 마스킹 상태(이번 장부 이름 정규식, 장부 이메일 조각 정규식). */
const CHAT_MASKS = new WeakMap<Redactor, { names: Array<{ re: RegExp }>; emails: RegExp[] }>();
const BARE_AMOUNT = /(?<![\dA-Za-z.,\-/_])(?:\d{1,3}(?:,\d{3})+|\d{5,})(?![\dA-Za-z.,\-/_])/gu;
/** 공백·점으로 끊은 금액: 550 000, 550.000, 1 100 000, 55 0000(만 단위) */
const SPLIT_AMOUNT = /(?<![\dA-Za-z.,\-/_])(?:\d{1,3}(?:[ .]\d{3})+|\d{1,4} \d{4})(?![\dA-Za-z,\-/_]|\.\d)/gu;
/** 통화 글자가 붙은 금액: KRW550000, 550000KRW, ₩550000, x550000 */
const CURRENCY_AMOUNT = /(?<![A-Za-z\d])(?:(?:KRW|₩|x)\s?(?:\d{1,3}(?:,\d{3})+|\d{4,})|(?:\d{1,3}(?:,\d{3})+|\d{4,})\s?KRW)(?![A-Za-z\d])/giu;
/** 기본 규칙이 놓치는 사업자번호 구분자(/·_·,·:, 앞뒤 한 칸 공백까지) */
const BIZNO_SLASH = /(?<![\d,])\d{3} ?[/_,:] ?\d{2} ?[/_,:] ?\d{5}(?![\d,])/gu;
/** 이메일 조각으로 가리지 않는 흔한 낱말(메일 업체·도메인 단계) */
const EMAIL_GENERIC = new Set(['www', 'mail', 'com', 'net', 'org', 'gmail', 'naver', 'daum', 'hanmail', 'kakao', 'nate', 'hotmail', 'outlook', 'yahoo', 'icloud']);
const escapeRe = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 장부 이메일의 조각(로컬 부분, 끝 단계를 뺀 도메인 단계, 3자 이상)을 낱말로 찾는 정규식. "tax at 도메인"·"(dot)" 꼴로 나누어 적어도 가린다. */
export function emailFragmentRes(emails: readonly string[]): RegExp[] {
  const frags = new Set<string>();
  for (const e of emails) {
    const [local, domain] = normalizeForRedaction(e).trim().toLowerCase().split('@');
    if (!local || !domain) continue;
    const labels = domain.split('.');
    for (const f of [local, ...labels.slice(0, -1)]) if (f.length >= 3 && !EMAIL_GENERIC.has(f)) frags.add(f);
  }
  return [...frags].sort((x, y) => y.length - x.length).map((f) => new RegExp(`(?<![A-Za-z0-9])${escapeRe(f)}(?![A-Za-z0-9])`, 'giu'));
}

/** 띄어 쓴 한글 금액(오십 만, 오 십 만, 백 만): 한 칸씩 띄운 한글 수 중 백·천·만·억이 든 것 */
const KO_AMOUNT_SPACED = new RegExp(`(?<![가-힣])[${SINO}](?: ?[${SINO}])+${NUM_TAIL}`, 'gu');
/** 한글 금액처럼 보이지만 인사·관용구인 것: "이만 끝낼게", "천만에요" */
const NOT_AMOUNT = (m: string, after: string) => (m === '이만' && /^\s?(?:끝|줄|하|가|갈|됐|되|마치|실례|들어가|일어나)/u.test(after)) || (m === '천만' && /^에요/u.test(after));

/**
 * 대화 입력을 가리기 전에 고르게 편다. 공백 덩어리는 한 칸으로(사전 이름의 공백 변형은 한 칸까지만 잡는다).
 * 띄어 쓴 금액 자리(550 000원, 1 100 000, 55 0000)는 붙인다. 기본 금액 규칙이 뒤 조각("000원")만 가리고 앞 수를 남기지 않게 한다.
 */
export function chatInput(text: string): string {
  return normalizeForRedaction(text)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(?<![\d.,] ?)\d{1,3}(?: \d{3})+(?! ?\d)/gu, (v) => v.replace(/ /g, ','))
    .replace(/(?<![\d.,] ?)\d{1,4} \d{4}(?! ?\d)/gu, (v) => v.replace(/ /g, ''));
}

/** 대화 경로 추가 마스킹 구간: 장부 이름 변형(NAME), 장부 이메일 조각(EMAIL), 구분자가 다른 사업자번호(BIZNO), 단위 없는·통화 글자가 붙은·끊어 쓴·띄어 쓴 금액(AMT). 앞이 이긴다. */
export function chatMaskSpans(t: string, names: ReadonlyArray<{ re: RegExp }>, emails: readonly RegExp[] = []): Array<{ start: number; end: number; kind: 'AMT' | 'NAME' | 'BIZNO' | 'EMAIL' }> {
  const out: Array<{ start: number; end: number; kind: 'AMT' | 'NAME' | 'BIZNO' | 'EMAIL' }> = [];
  const push = (m: RegExpMatchArray, kind: 'AMT' | 'NAME' | 'BIZNO' | 'EMAIL') => out.push({ start: m.index!, end: m.index! + m[0].length, kind });
  for (const x of names) for (const m of t.matchAll(x.re)) push(m, 'NAME');
  for (const re of emails) for (const m of t.matchAll(re)) push(m, 'EMAIL');
  for (const m of t.matchAll(BIZNO_SLASH)) push(m, 'BIZNO');
  for (const m of t.matchAll(CURRENCY_AMOUNT)) push(m, 'AMT');
  for (const m of t.matchAll(BARE_AMOUNT)) push(m, 'AMT');
  for (const m of t.matchAll(SPLIT_AMOUNT)) push(m, 'AMT');
  for (const m of t.matchAll(KO_AMOUNT)) if (!NOT_AMOUNT(m[0], t.slice(m.index! + m[0].length))) push(m, 'AMT');
  for (const m of t.matchAll(KO_AMOUNT_SPACED)) if (m[0].includes(' ') && /[백천만억]/u.test(m[0]) && !NOT_AMOUNT(m[0].replace(/ /g, ''), t.slice(m.index! + m[0].length))) push(m, 'AMT');
  return out;
}

// 답 숫자 규칙(PR #296 판정 ①): 슬롯·토큰 밖에 숫자가 있으면 답을 버린다. 숫자는 ASCII만이 아니다.
/** 단위 없는 한글 금액: 백·천·만·억이 든 한글 수 두 자 이상(오십만, 이백만, 삼천). 날짜(십오일)는 금액으로 보지 않는다. */
const KO_AMOUNT = new RegExp(`(?<![가-힣])(?=[${SINO}]*[백천만억])[${SINO}]{2,}${NUM_TAIL}`, 'gu');
const NUMBER_SHAPES: RegExp[] = [
  // 한글 수 두 자 이상이고 십·백·천·만·억이 든 것: 백이십일만, 일백이십일만, 십오일, 오십만
  new RegExp(`(?<![가-힣])(?=[${SINO}]*[십백천만억])[${SINO}]{2,}${NUM_TAIL}`, 'u'),
  // 달 이름(이월은 회계 낱말 "이월"과 같아서 뺀다)
  new RegExp(`(?<![가-힣])(?:시월|유월|십일월|십이월|[일삼사오육칠팔구]월)${NUM_TAIL}`, 'u'),
  // 고유어 건수: 두 건, 열한 건
  /(?<![가-힣])(?:한|두|세|네|다섯|여섯|일곱|여덟|아홉|열|스무|스물|서른|마흔|쉰)(?:한|두|세|네|다섯|여섯|일곱|여덟|아홉)?\s*건(?!물|강|설|축|너|전)/u,
  // 한자 수
  /[〇一二三四五六七八九十百千万萬億兆]/u,
];

/** 답 문장(슬롯·토큰을 뺀 것)에 수가 있는가: NFKC로 정규화한 뒤 모든 유니코드 숫자(전각·아랍-인도·원문자), 한글·한자 수, 고유어 건수. */
export function numberShaped(bare: string): boolean {
  const t = normalizeForRedaction(bare).normalize('NFKC');
  return /\p{N}/u.test(bare) || /\p{N}/u.test(t) || NUMBER_SHAPES.some((re) => re.test(t)) || koNumberRun(t);
}

/** 띄어 쓴 한글 수(백 만 원, 오 십 만)와 한 글자 수 + 단위(만 원, 천 원, 십 원): 십·백·천·만·억이 들고, 두 자 이상이거나 단위가 붙은 것 */
const KO_NUM_RUN = new RegExp(`(?<![가-힣])[${SINO}](?: ?[${SINO}])*${NUM_TAIL}`, 'gu');
function koNumberRun(t: string): boolean {
  for (const m of t.matchAll(KO_NUM_RUN)) {
    const w = m[0].replace(/ /g, '');
    if (/[십백천만억]/u.test(w) && ([...w].length >= 2 || /^ ?(?:원|건|개|장|명|번|년|월|일|달)/u.test(t.slice(m.index! + m[0].length)))) return true;
  }
  return false;
}

/**
 * 금액 토큰의 원값("110만원", "1,100,000원", "3백만", "1억 2천", "삼백삼십만원")을 원 단위 정수로 읽는다. 읽을 수 없으면 null.
 * 억 뒤에 만 없이 남은 수는 만 단위로 읽는다("1억 2천" = 1억 2천만, 말로 쓰는 금액).
 */
export function parseKrw(raw: string): number | null {
  const s = normalizeForRedaction(raw)
    .replace(/[\s,원]/g, '')
    .replace(/[영공일이삼사오육륙칠팔구]/g, (c) => KO_NUM[c]!)
    // 단위 없이 점으로 세 자리씩 끊은 수(550.000)는 천 단위 구분이다(원에는 소수가 없다)
    .replace(/^\d{1,3}(?:\.\d{3})+$/, (v) => v.replace(/\./g, ''));
  if (!s) return null;
  let total = 0;
  let section = 0;
  let num: number | null = null;
  let lastBig = Infinity;
  let used = 0;
  for (const m of s.matchAll(/\d+(?:\.\d+)?|[십백천]|[만억]/g)) {
    const x = m[0];
    used += x.length;
    if (/\d/.test(x[0]!)) {
      if (num !== null) return null;
      num = Number(x);
    } else if (x in SMALL) {
      section += (num ?? 1) * SMALL[x]!;
      num = null;
    } else {
      const big = BIG[x]!;
      if (big >= lastBig) return null;
      total += (section + (num ?? 0) || 1) * big;
      section = 0;
      num = null;
      lastBig = big;
    }
  }
  if (used !== s.length) return null;
  let tail = section + (num ?? 0);
  if (lastBig === BIG['억'] && tail) tail *= BIG['만']!;
  total += tail;
  const n = Math.round(total);
  if (!(n > 0) || n > Number.MAX_SAFE_INTEGER || Math.abs(n - total) > 1e-6 * total) return null;
  return n;
}

interface Session {
  id: string;
  profileId: string;
  red: Redactor;
  transcript: AgentTurnRecord[];
  /** 이 대화 세션에서 도구 결과로 나온 ref(r#·d#) */
  refs: Set<string>;
  token: RunToken | null;
  lastAt: number;
  turn: Turn | null;
}

interface Turn {
  user: RedactedText;
  message: RedactedText;
  /** 이번 턴 화면 프레임의 카드 ref */
  frameRefs: Set<string>;
  replay: RedactedReplayItem[];
  /** main이 실행 중인 도구 호출. answer가 있으면 엔진이 직접 답한 것이다. */
  pending: Array<{ callId: string; tool: ChatAgentToolName; answer: ToolOutput | null }> | null;
  /** 이번 턴에 풀리지 않은 거래처 이름(사장님 문장에 있던 것만). 첫 하나만 둔다. */
  unknownName?: string;
}

type Parsed = DomainCall | ToolOutput;

export class ChatAgent {
  private readonly db: Db;
  private readonly opts: ChatAgentOptions;
  private readonly maps: ChatTokenMaps;
  private current: Session | null = null;

  constructor(db: Db, opts: ChatAgentOptions) {
    this.db = db;
    this.opts = opts;
    this.maps = new ChatTokenMaps(() => this.now());
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  async handle(method: string, p: Record<string, unknown>): Promise<StepResult> {
    if (method !== 'chat.step') throw new ChatError('bad_text');
    return this.step(p as unknown as StepParams);
  }

  async step(p: StepParams): Promise<StepResult> {
    const keys = p && typeof p === 'object' ? Object.keys(p) : [];
    if (keys.length !== 1) throw new ChatError('bad_text');
    if ('start' in p) return this.start(p.start);
    if ('continue' in p) return this.cont(p.continue);
    throw new ChatError('bad_text');
  }

  private async start(p: { text: string; frame: ScreenFrame; profileId: string }): Promise<StepResult> {
    const text = p?.text;
    if (typeof text !== 'string' || !text.trim() || [...text].length > INTENT_TEXT_MAX) throw new ChatError('bad_text');
    if (typeof p?.profileId !== 'string' || !p.profileId || p.profileId.length > 128) throw new ChatError('bad_text');
    if (!validFrame(p.frame)) throw new ChatError('chat.bad_tool_output');
    const cps = new CounterpartyRepo(this.db);
    const cards = p.frame.cards.map((c) => ({ ...c, cp: cps.get(c.counterpartyId) }));
    if (cards.some((c) => !c.cp) || new Set(cards.map((c) => c.ref)).size !== cards.length) throw new ChatError('chat.bad_tool_output');
    if (!this.opts.model) throw new ChatError('chat.unavailable');
    if (chatSecretShaped(text)) throw new ChatError('chat.secret_rejected');
    const s = this.session(p.profileId);
    s.turn = null;
    let user: RedactedText;
    let frameLine: string;
    try {
      const said = chatInput(text);
      this.register(s.red, said);
      user = s.red.apply(said, { frame: 'none' }).redacted;
      frameLine = cards.length
        ? `화면: ${cards.map((c) => `카드 ${c.ref}(세금계산서, 거래처 ${s.red.apply(c.cp!.name, { frame: 'none' }).redacted}, 금액 ${c.amount ? '있음' : '없음'}, 부가세 ${c.vat ? VAT_LABEL[c.vat] : '미정'}, 품목 ${c.item ? '있음' : '없음'})`).join('; ')}`
        : '화면: 열린 카드 없음';
    } catch {
      throw new ChatError('chat.unavailable');
    }
    s.turn = { user, message: this.compose(s, user, frameLine), frameRefs: new Set(cards.map((c) => c.ref)), replay: [], pending: null };
    return this.run(s, () => this.advance(s));
  }

  private async cont(p: { outputs: Array<{ callId: string; output: ToolOutput }> }): Promise<StepResult> {
    const s = this.current;
    const t = this.now();
    const turn = s?.turn;
    if (!s || !turn?.pending || t - s.lastAt > CHAT_MAP_IDLE_MS) throw new ChatError('chat.bad_tool_output');
    s.lastAt = t;
    this.maps.get(s.id, s.profileId);
    return this.run(s, async () => {
      const outputs = p?.outputs;
      if (!validOutputs(outputs)) throw new ChatError('chat.bad_tool_output');
      const waiting = turn.pending!.filter((c) => !c.answer);
      const given = new Map(outputs.map((o) => [o.callId, o.output]));
      if (given.size !== outputs.length || given.size !== waiting.length || waiting.some((c) => !given.has(c.callId))) throw new ChatError('chat.bad_tool_output');
      for (const c of waiting) {
        const o = given.get(c.callId)!;
        if (o.ref !== null && o.ref[0] !== REF_KIND[c.tool]) throw new ChatError('chat.bad_tool_output');
        c.answer = o;
      }
      this.answer(s, turn);
      return this.advance(s);
    });
  }

  /** 턴 오류 처리: 답 없이 끝난 턴은 대화록에 agent null로 남긴다. 경로 실패·예산·한도는 다시 보낼 턴이라 남기지 않는다. */
  private async run(s: Session, f: () => Promise<StepResult>): Promise<StepResult> {
    try {
      return await f();
    } catch (e) {
      const code = e instanceof ChatError ? e.code : 'chat.unavailable';
      if (s.turn && !RETRY_CODES.includes(code)) this.record(s, { user: s.turn.user, agent: null });
      s.turn = null;
      throw e instanceof ChatError ? e : new ChatError('chat.unavailable');
    }
  }

  private async advance(s: Session): Promise<StepResult> {
    const model = this.opts.model!;
    const turn = s.turn!;
    for (;;) {
      let r: RespondResult;
      try {
        s.token ??= await model.runToken(s.id);
        r = await model.respond({
          toolset: CHAT_AGENT.id,
          messages: [{ role: 'user', content: [{ type: 'input_text', text: turn.message }] }],
          replay: [...turn.replay],
          runToken: s.token,
          chatSessionId: s.id as RespondRequest['chatSessionId'],
        });
      } catch {
        s.token = null;
        throw new ChatError('chat.unavailable');
      }
      if (r.status === 'refusal') return this.finish(s, { kind: 'cannot', text: CHAT_AGENT_FALLBACK_TEXT, show: [], ask: null, filtered: 'refusal' });
      if (r.status !== 'completed') {
        const code = errorOf(r.reason);
        if (code === 'chat.unavailable') s.token = null;
        throw new ChatError(code);
      }
      turn.replay.push(...r.replay);
      if (!r.toolCalls.length) return this.finish(s, this.checkReply(s, turn, r.output));
      // 다음 호출이 툴셋 턴 상한·replay 상한을 넘으면 도구를 실행하지 않는다(결과를 모델에 돌려줄 수 없다).
      const turns = turn.replay.filter((x) => x.kind === 'model_output' && (x.item.item as { type?: string }).type !== 'reasoning').length;
      if (turns >= CHAT_AGENT.maxTurns || turn.replay.length + r.toolCalls.length > REPLAY_MAX) throw new ChatError('chat.turn_limit');
      const parsed = r.toolCalls.map((c) => ({ c, p: this.parseCall(s, turn, c) }));
      turn.pending = parsed.map(({ c, p }) => ({ callId: c.callId, tool: c.name as ChatAgentToolName, answer: 'status' in p ? p : null }));
      const calls = parsed.flatMap(({ c, p }) => ('status' in p ? [] : [{ callId: c.callId, ...p }]));
      if (calls.length) return { kind: 'tools', calls };
      this.answer(s, turn);
    }
  }

  /** 모든 도구 호출에 답이 있으면 function_call_output을 replay에 붙인다. 결과 ref는 이 세션의 ref로 기억한다. */
  private answer(s: Session, turn: Turn): void {
    for (const c of turn.pending!) {
      const o = c.answer!;
      if (o.ref) s.refs.add(o.ref);
      turn.replay.push({ kind: 'function_call_output', callId: c.callId, output: s.red.apply(JSON.stringify(o), { frame: 'none' }).redacted });
    }
    turn.pending = null;
  }

  /** 도구 인자 역치환. 거래처가 레코드 하나로 풀리지 않거나 모르는 카드면 main에 가지 않고 엔진이 결과를 답한다. */
  private parseCall(s: Session, turn: Turn, c: ToolCall): Parsed {
    const a = c.arguments as Record<string, unknown>;
    const cp = (v: unknown): string | null => {
      if (typeof v !== 'string') return null;
      if (gluedName(turn.user, v.trim(), /\s/.test(s.red.map.valueOf(v.trim()) ?? ''))) return null;
      const r = detokenize({ counterparty: v.trim() }, s.red.map, { recordFields: ['counterparty'] });
      const id = r.ok ? (r.value as { counterparty: { recordId: string } }).counterparty.recordId : '';
      return id.startsWith('cp:') ? id.slice(3) : null;
    };
    // 거래처가 풀리지 않으면 엔진이 답한다. 그 인자가 사장님 이번 문장의 낱말이면 화면용 이름으로 남긴다(U8-1).
    const unknown = (v: unknown): ToolOutput => {
      turn.unknownName ??= typedName(s, turn, v) ?? undefined;
      return engineAnswer('unknown_counterparty');
    };
    const draft = (v: unknown): string | null => (typeof v === 'string' && /^d[1-9]\d{0,5}$/.test(v) && (turn.frameRefs.has(v) || s.refs.has(v)) ? v : null);
    const amount = (v: unknown): DraftAmount => {
      if (v === null) return null;
      const t = String(v).trim();
      const slot = slotPattern.exec(t);
      if (slot) {
        if (!s.refs.has(slot[1]!) || !SLOT_MONEY_PATHS.includes(slot[2]!)) throw new ChatError('chat.bad_response');
        return { slot: t };
      }
      const n = /^\[AMT_\d+\]$/.test(t) ? parseKrw(s.red.map.valueOf(t) ?? '') : null;
      if (n === null) throw new ChatError('chat.bad_response');
      return { value: n };
    };
    const item = (v: unknown): string | null => {
      if (v === null) return null;
      const r = detokenize(String(v), s.red.map);
      if (!r.ok) throw new ChatError('chat.bad_response');
      return String(r.value).trim() || null;
    };
    const vat = (v: unknown): Vat | null => (v === 'separate' || v === 'included' ? v : null);
    const tool = c.name as ChatAgentToolName;
    const parse: { [K in ChatAgentToolName]: () => Extract<DomainCall, { tool: K }> | ToolOutput } = {
      sales_summary: () => ({ tool: 'sales_summary', monthOffset: Number(a.month_offset) }),
      invoice_history: () => {
        const id = a.counterparty === null ? null : cp(a.counterparty);
        return a.counterparty !== null && !id ? unknown(a.counterparty) : { tool: 'invoice_history', counterpartyId: id };
      },
      receivables: () => {
        const id = a.counterparty === null ? null : cp(a.counterparty);
        return a.counterparty !== null && !id ? unknown(a.counterparty) : { tool: 'receivables', counterpartyId: id };
      },
      invoice_draft: () => {
        const id = cp(a.counterparty);
        return id ? { tool: 'invoice_draft', counterpartyId: id, amount: amount(a.amount), vat: vat(a.vat), item: item(a.item) } : unknown(a.counterparty);
      },
      draft_edit: () => {
        const d = draft(a.draft);
        return d ? { tool: 'draft_edit', draft: d, amount: amount(a.amount), vat: vat(a.vat), item: item(a.item) } : engineAnswer('no_such_draft');
      },
      draft_discard: () => {
        const d = draft(a.draft);
        return d ? { tool: 'draft_discard', draft: d } : engineAnswer('no_such_draft');
      },
    };
    if (!Object.hasOwn(parse, tool)) throw new ChatError('chat.bad_response');
    return parse[tool]();
  }

  /**
   * 답 검사(chat.ts checkOutput을 옮김). 채우기 전 문장에 돈다: 토큰·슬롯은 허용하되 맵에 있는 토큰, 이 세션 결과를 가리키는 슬롯만.
   * 세무 판단은 고정 문구, 식별자·이메일·링크·비밀 유도 말은 고정 안내, 모양이 틀리면 chat.bad_response.
   */
  private checkReply(s: Session, turn: Turn, out: unknown): AgentReply {
    const bad = () => new ChatError('chat.bad_response');
    const o = out as Record<string, unknown> | null | undefined;
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw bad();
    if (Object.keys(o).sort().join(',') !== 'ask,kind,show,text') throw bad();
    const { kind, show, ask } = o;
    if (typeof kind !== 'string' || !KINDS.has(kind) || typeof o.text !== 'string' || !Array.isArray(show) || show.length > AGENT_SHOW_MAX) throw bad();
    if (!show.every((r) => typeof r === 'string') || !(ask === null || (typeof ask === 'string' && ASKS.has(ask)))) throw bad();
    const k = kind as AgentReplyKind;
    const a = ask as AgentAsk | null;
    if (k === 'tax_advice') return { kind: k, text: CHAT_ADVICE_TEXT, show: [], ask: null, filtered: 'advice' };
    // 슬롯 안 공백("{ r1.first.total }")은 뜻이 같으니 붙인다
    const text = o.text.replace(/\s+/g, ' ').trim().replace(/\{([^{}]*)\}/g, (_m, x: string) => `{${x.replace(/\s+/g, '')}}`);
    if (!text || [...text].length > CHAT_REPLY_MAX_CHARS) throw bad();
    for (const m of text.matchAll(TOKEN_RE)) if (!s.red.map.has(m[0])) throw bad();
    for (const m of text.matchAll(SLOT_ANY)) if (!s.refs.has(m[1]!)) throw bad();
    if (/[{}]/.test(text.replace(SLOT_ANY, ''))) throw bad();
    const refs = [...new Set(show as string[])];
    if (!refs.every((r) => new RegExp(REF).test(r) && (s.refs.has(r) || turn.frameRefs.has(r)))) throw bad();
    if (chatAdviceMentioned(text)) return { kind: k, text: CHAT_ADVICE_TEXT, show: [], ask: null, filtered: 'advice' };
    const bare = text.replace(TOKEN_RE, ' ').replace(SLOT_ANY, ' ');
    if (unsafeText(bare)) return { kind: k, text: CHAT_AGENT_FALLBACK_TEXT, show: [], ask: null, filtered: 'unsafe' };
    if (numberShaped(bare)) return { kind: k, text: refs.length ? CHAT_AGENT_NUMBER_TEXT : CHAT_AGENT_FALLBACK_TEXT, show: refs, ask: null, filtered: 'number' };
    return { kind: k, text, show: refs, ask: a, filtered: null };
  }

  /** 턴을 닫는다: 채우기 전 문장을 대화록에 넣고, 이 답에 나온 토큰의 화면 값을 같이 돌려준다. */
  private finish(s: Session, r: AgentReply): StepResult {
    const unknownName = r.filtered ? null : (s.turn!.unknownName ?? null);
    this.record(s, { user: s.turn!.user, agent: { text: r.text, show: r.show } });
    s.turn = null;
    return { kind: 'reply', reply: { ...r, values: r.filtered ? {} : this.values(s, r.text), unknownName } };
  }

  private values(s: Session, text: string): Record<string, string> {
    const cps = new CounterpartyRepo(this.db);
    const out: Record<string, string> = {};
    for (const [tok] of text.matchAll(TOKEN_RE)) {
      const rec = s.red.map.recordOf(tok);
      const name = tok.startsWith('[NAME_') && rec?.startsWith('cp:') ? cps.get(rec.slice(3))?.name : undefined;
      out[tok] = name ?? s.red.map.valueOf(tok)!;
    }
    return out;
  }

  private record(s: Session, r: AgentTurnRecord): void {
    s.transcript.push(r);
    if (s.transcript.length > CHAT_AGENT_TRANSCRIPT_TURNS) s.transcript.splice(0, s.transcript.length - CHAT_AGENT_TRANSCRIPT_TURNS);
  }

  /** 이번 턴 user 메시지 하나: 대화록(오래된 턴부터 버려 상한 안으로) + 화면 프레임 + 이번 문장. 같은 세션 Redactor로 다시 마스킹해 발급한다. */
  private compose(s: Session, user: RedactedText, frameLine: string): RedactedText {
    const now = `[지금]\n${frameLine}\n사용자: ${user}`;
    const line = (r: AgentTurnRecord) => `사용자: ${r.user}\n앱: ${r.agent ? `${r.agent.text}${r.agent.show.length ? ` (보임: ${r.agent.show.join(', ')})` : ''}` : '(답 없음)'}`;
    for (let from = 0; from <= s.transcript.length; from++) {
      const past = s.transcript.slice(from);
      let out: RedactedText;
      try {
        out = s.red.apply(past.length ? `[앞 대화]\n${past.map(line).join('\n')}\n${now}` : now, { frame: 'none' }).redacted;
      } catch {
        throw new ChatError('chat.unavailable');
      }
      if (Buffer.byteLength(out, 'utf8') <= CHAT_AGENT_INPUT_MAX_BYTES) return out;
    }
    throw new ChatError('chat.input_too_large');
  }

  /** 대화 세션: 프로필이 바뀌거나 CHAT_MAP_IDLE_MS 쉬면 토큰 맵과 대화록을 같이 버리고 새 세션(새 chatSessionId·실행 토큰)을 연다. */
  private session(profileId: string): Session {
    const t = this.now();
    let s = this.current;
    if (s && (s.profileId !== profileId || t - s.lastAt > CHAT_MAP_IDLE_MS)) {
      this.maps.end(s.id);
      s = null;
    }
    if (!s) {
      const id = `chat_${randomUUID()}`;
      s = { id, profileId, red: this.maps.get(id, profileId), transcript: [], refs: new Set(), token: null, lastAt: t, turn: null };
      this.current = s;
    }
    s.lastAt = t;
    this.maps.get(s.id, profileId);
    return s;
  }

  /**
   * 마스킹 사전(intent.ts addNames와 같은 범위): 거래처 상호·대표자·이메일·사업자번호, 내 프로필 상호·대표자·사업자번호.
   * 두 레코드가 같은 값을 쓰면 그 값은 가리기만 하고 레코드에 묶지 않는다(역치환이 엉뚱한 거래처로 가지 않게).
   * 오타 거래처는 typoAliases로 그 거래처 별칭을 더한다.
   */
  /**
   * 대화 경로 추가 마스킹(PR #296 판정 ②). 대화록과 도구 왕복으로 같은 문장이 여러 번 나가므로 기본 규칙이 놓치는 두 가지를 이 경로에서 가린다.
   * - 단위 없는 금액: 다섯 자리 이상 맨숫자·콤마 숫자(550000, 1,100,000), 백·천·만·억이 든 한글 수(오십만, 이백만).
   * - 구분자가 / · _ 인 사업자번호(100/64/14392).
   * - 장부 이름의 대소문자·띄어쓰기 변형(a상사, A 상사, LAF 테크, 한빛  전자, 김 철수). 그 이름의 레코드가 하나면 토큰을 레코드에 묶어 도구 인자로도 풀린다.
   * 가리는 것만 더한다(SpanFinder는 기본 규칙 뒤에 돌고 겹치면 기본 규칙이 이긴다).
   */
  private maskVariants(red: Redactor, text: string, recs: Array<{ recordId: string; names: string[]; emails: string[] }>): void {
    const loose = (v: string) => v.replace(/\s+/g, '').toLowerCase();
    // 긴 이름부터 맞춘다(A상사몰이 A상사보다 먼저). 짧은 이름이 긴 이름의 앞을 먹지 않게 한다.
    const names = recs
      .flatMap((r) => r.names.map((n) => ({ recordId: r.recordId, name: normalizeForRedaction(n).replace(/\s+/g, ' ').trim() })))
      .filter((x) => [...loose(x.name)].length >= 2)
      .sort((a, b) => [...loose(b.name)].length - [...loose(a.name)].length);
    const owners = new Map<string, Set<string>>();
    for (const x of names) (owners.get(loose(x.name)) ?? owners.set(loose(x.name), new Set()).get(loose(x.name))!).add(x.recordId);
    const res = names.map((x) => ({ ...x, re: new RegExp([...x.name.replace(/\s/g, '')].map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*'), 'giu') }));
    let st = CHAT_MASKS.get(red);
    if (!st) {
      const fresh: { names: typeof res; emails: RegExp[] } = { names: [], emails: [] };
      red.addSpanFinder((t) => chatMaskSpans(t, fresh.names, fresh.emails));
      CHAT_MASKS.set(red, fresh);
      st = fresh;
    }
    st.names = res;
    st.emails = emailFragmentRes(recs.flatMap((r) => r.emails));
    // 이번 문장의 변형 낱말을 사전에 올리고 그 레코드에 묶는다. 사전에 올려야 기본 사전의 짧은 정확한 이름("A상사 몰"의 A상사)보다 긴 변형이 먼저 잡힌다.
    // 긴 이름의 변형 안에 든 짧은 이름 변형은 건너뛴다. 주인이 둘 이상인 이름의 변형은 가리기만 한다(되묻기).
    const t = normalizeForRedaction(text);
    const taken: Array<[number, number]> = [];
    for (const x of res) {
      for (const m of t.matchAll(x.re)) {
        const start = m.index!;
        const end = start + m[0].length;
        if (taken.some(([a, b]) => start < b && end > a)) continue;
        taken.push([start, end]);
        const lit = m[0].replace(/\s+/g, ' ').trim();
        if (lit === x.name) continue;
        red.addName(lit, { variant: true });
        if (owners.get(loose(x.name))!.size !== 1) continue;
        try {
          red.map.bindRecord(red.map.token('NAME', lit), x.recordId);
        } catch {
          // 다른 레코드에 이미 묶인 낱말이면 가리기만 한다
        }
      }
    }
  }

  private register(red: Redactor, text: string): void {
    const recs = [
      ...new CounterpartyRepo(this.db).list().map((c) => ({ recordId: `cp:${c.id}`, names: [c.name, ...(c.repName ? [c.repName] : [])], emails: c.email ? [c.email] : [], bizNos: [c.bizNo] })),
      ...new ProfileRepo(this.db).list().map((p) => ({ recordId: `pf:${p.id}`, names: [p.displayName, ...(p.repName ? [p.repName] : [])], emails: [] as string[], bizNos: p.bizNo ? [p.bizNo] : [] })),
    ];
    const key = (k: string, v: string) => `${k}\u0000${k === 'b' ? v.replace(/\D/g, '') : normalizeForRedaction(v).replace(/\s+/g, ' ').trim().toLowerCase()}`;
    const owners = new Map<string, Set<string>>();
    for (const r of recs) for (const [k, vs] of [['n', r.names], ['e', r.emails], ['b', r.bizNos]] as const) for (const v of vs) (owners.get(key(k, v)) ?? owners.set(key(k, v), new Set()).get(key(k, v))!).add(r.recordId);
    const sole = (k: string, v: string) => owners.get(key(k, v))!.size === 1;
    for (const r of recs) {
      for (const n of r.names) if (!sole('n', n)) red.addName(n);
      red.addRecord({ recordId: r.recordId, names: r.names.filter((n) => sole('n', n)), emails: r.emails.filter((e) => sole('e', e)), bizNos: r.bizNos.filter((b) => sole('b', b)) });
    }
    this.maskVariants(red, text, recs);
    const known = new Set(recs.flatMap((r) => r.names.map((n) => normalizeForRedaction(n).replace(/\s+/g, ' ').trim().toLowerCase())));
    for (const a of typoAliases(text, recs.filter((r) => r.recordId.startsWith('cp:')).map((r) => ({ recordId: r.recordId, name: r.names[0]! })), known)) {
      try {
        if (a.recordId) red.addRecord({ recordId: a.recordId, names: [a.alias] });
        else red.addName(a.alias, { variant: true });
      } catch {
        // 앞 턴에서 다른 거래처 별칭으로 묶인 낱말이면 그대로 둔다
      }
    }
  }
}

/** 거래처 이름 뒤에 붙어도 이름의 일부가 아닌 말: 조사, 이다 꼴(인데·이고·라고), 건·거·꺼·것·쪽·측·님·서(에서 줄임) */
const NAME_TAIL = /^(?:입니다|이라고|이니까|이라서|에다가|이에요|에서|에게|인데|이고|이니|이라|라고|이지|이었|에다|보고|더러|인|였|한테|께서|이랑|으로|부터|까지|하고|처럼|보다|이나|이요|예요|이야|께|에|도|랑|와|과|은|는|이|가|을|를|의|로|만|나|요|야|건|거|꺼|것|쪽|측|님|서)*(?![\p{L}\p{N}])/u;

/** 잘린 이름 뒤에 붙는 격조사(끝 글자가 이것이면 오타가 아니라 잘린 이름 + 조사로 본다). 야·요·이처럼 이름 끝 글자로도 흔한 것은 뺀다. */
const CASE_JOSA = /^(?:에서|에게|한테|께서|이랑|으로|에|께|도|랑|와|과|은|는|을|를|의|로|만)(?![가-힣])/u;

/**
 * 이번 문장에서 이 이름 토큰이 모두 다른 글자에 붙어 있는가("신[NAME_1]에", "[NAME_1]몰에"). 그러면 장부에 없는 긴 이름의 일부라
 * 그 거래처로 풀지 않는다(되묻기). 이번 문장에 없는 토큰(앞 턴에서 온 것)은 보지 않는다.
 */
export function gluedName(user: string, tok: string, spaced = false): boolean {
  if (!/^\[NAME_\d+\]$/.test(tok)) return false;
  let at = user.indexOf(tok);
  if (at < 0) return false;
  for (; at >= 0; at = user.indexOf(tok, at + 1)) {
    const before = user.slice(0, at);
    const after = user.slice(at + tok.length);
    if (!/[\p{L}\p{N}]$/u.test(before) && NAME_TAIL.test(after) && !(spaced && trailingSyllable(after))) return false;
  }
  return true;
}

/** 띄어 쓴 이름 뒤에 한 글자 낱말이 이어지는가("A 상사 몰에"): 이름을 띄어 쓰는 사람에게 그 글자는 이름의 끝일 수 있다. 조사·흔한 한 글자 부사는 아니다. */
const ONE_SYLLABLE_WORDS = new Set([...'좀또꼭더다잘딱막쫌왜총약각첫새앞뒤몇한두세네전분씨및등']);
function trailingSyllable(after: string): boolean {
  const m = /^ ([가-힣])/u.exec(after);
  if (!m || ONE_SYLLABLE_WORDS.has(m[1]!) || NAME_TAIL.exec(after.slice(1))?.[0]) return false;
  return NAME_TAIL.test(after.slice(2));
}

/**
 * 오타 거래처 별칭: 문장 속 낱말 중 거래처 상호(3자 이상)와 길이가 같고 한 글자만 다르며(대소문자는 같은 글자로 본다), 이미 있는 이름(대소문자 무시)이 아니고,
 * 그렇게 가까운 거래처가 정확히 하나인 것. 둘 이상에 가까우면(A상사·B상사 사이의 C상사) 고르지 않는다.
 * 장부 이름(공백·대소문자 무시)이 든 낱말은 오타로 보기 전에 따진다. 이름 바로 뒤가 조사면(A상사몰이 있을 때 "A상사에") 정확한 이름이 이기니 별칭을 만들지 않는다.
 * 든 이름이 이 거래처 이름의 앞이고 남은 글자가 둘 이상이면 긴 이름의 오타다. 그 밖("A상사물")은 어느 거래처인지 모르니 recordId null로 돌려 가리기만 한다(되묻기).
 */
export function typoAliases(text: string, cps: Array<{ recordId: string; name: string }>, known: ReadonlySet<string>): Array<{ recordId: string | null; alias: string }> {
  const t = [...normalizeForRedaction(text)];
  const hits = new Map<string, Set<string>>();
  const asks = new Set<string>();
  const knownLow = [...known].map((k) => k.replace(/\s+/g, '').toLowerCase()).filter((k) => [...k].length >= 2);
  const knownSet = new Set(knownLow);
  for (const c of cps) {
    const n = [...normalizeForRedaction(c.name).trim().toLowerCase()];
    if (n.length < 3) continue;
    for (let i = 0; i + n.length <= t.length; i++) {
      const w = t.slice(i, i + n.length);
      if (!w.every((ch) => /[\p{L}\p{N}]/u.test(ch))) continue;
      const word = w.join('');
      const low = word.toLowerCase();
      if (knownSet.has(low) || [...low].filter((ch, k) => ch !== n[k]).length !== 1) continue;
      const inner = knownLow.filter((k) => low.includes(k));
      if (inner.length) {
        // 가장 긴 장부 이름이 앞에 있고 뒤가 조사·이다 꼴이면 그 이름이 이긴다(별칭 아님). 그 이름이 이 거래처 이름의 앞이기도 하고
        // 남은 글자가 둘 이상이면 긴 이름의 오타다(A상사몰코리야 → A상사몰코리아). 아니면 어느 쪽인지 모르니 되묻는다(A상사물).
        const head = inner.filter((k) => low.startsWith(k)).sort((x, y) => [...y].length - [...x].length)[0];
        const len = head ? [...head].length : 0;
        if (head && NAME_TAIL.test(t.slice(i + len).join(''))) continue;
        if (!(head && n.join('').startsWith(head) && n.length - len >= 2)) {
          asks.add(word);
          continue;
        }
      }
      // 끝 글자만 다르고 거기서 조사가 시작하면 잘린 이름 + 조사다(A상사몰코리에, A상에). 어느 거래처인지 모르니 되묻는다.
      if (low.at(-1) !== n.at(-1) && CASE_JOSA.test(t.slice(i + n.length - 1).join(''))) {
        asks.add(word);
        continue;
      }
      (hits.get(word) ?? hits.set(word, new Set()).get(word)!).add(c.recordId);
    }
  }
  return [
    ...[...hits].filter(([alias, ids]) => ids.size === 1 && !asks.has(alias)).map(([alias, ids]) => ({ recordId: [...ids][0]!, alias })),
    ...[...asks].map((alias) => ({ recordId: null, alias })),
  ];
}

/** 엔진 기본 경로(게이트웨이)로 ChatAgentModel을 만든다. Egress에 게이트웨이 설정이 없으면 null(chat.step은 chat.unavailable). */
export function gatewayChatAgentModel(egress: Egress): ChatAgentModel | null {
  if (!egress.gatewayGuard) return null;
  const responder = new OpenAIResponsesAdapter({ transport: 'gateway', egress });
  return { respond: (req) => responder.respond(CHAT_AGENT, req), runToken: (chatSessionId) => gatewayRunToken(egress, { chatSessionId }) };
}
