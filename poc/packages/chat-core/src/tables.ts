// 대화 표(도구·결과 슬롯 문법·답 종류·되묻기 칸). PC 대화 에이전트(chat_agent)와 폰 대화(chat_phone)가 이 표 하나에서 나온다.
// @sax/model이 이 표로 툴셋 정의(ToolsetDef)를 만들고, 폰 코어는 이 표로 모델 출력을 다시 검사한다(폰에는 @sax/model이 없다).
// 머리말(toolsets/chat_agent.ko.txt·chat_phone.ko.txt)은 손으로 맞추고 시험이 대조한다.

const obj = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const VAT = { type: ['string', 'null'], enum: ['separate', 'included', null] };
const NULLABLE_STRING = { type: ['string', 'null'] };

/**
 * 카드 인자 중 작성일자·수량·단가(ADR-049). 모델은 말한 그대로 넘기고 기기가 날짜·곱을 계산한다.
 * 날짜는 달(이번 달 0, 지난달 -1)과 날("1"~"31", 말일 "last") 두 칸이다. 공급사 strict 스키마에서 nullable 객체가 흔들릴 수 있어 폈다.
 */
export const DATE_MONTH_MIN = -12;
const DRAFT_EXTRA = {
  date_month_offset: { type: ['integer', 'null'], minimum: DATE_MONTH_MIN, maximum: 0 },
  date_day: NULLABLE_STRING,
  quantity: NULLABLE_STRING,
  unit_price: NULLABLE_STRING,
};

/** 도구 표. counterparty는 거래처 토큰, amount는 금액 토큰이나 결과 슬롯, draft는 카드 ref(d#)다. */
export const CHAT_AGENT_TOOLS = [
  { name: 'sales_summary', parameters: obj({ month_offset: { type: 'integer', minimum: -12, maximum: 0 } }) },
  { name: 'invoice_history', parameters: obj({ counterparty: NULLABLE_STRING }) },
  { name: 'receivables', parameters: obj({ counterparty: NULLABLE_STRING }) },
  { name: 'payables', parameters: obj({ counterparty: NULLABLE_STRING }) },
  { name: 'cash_flow', parameters: obj({ month_offset: { type: 'integer', minimum: -12, maximum: 0 } }) },
  { name: 'invoice_draft', parameters: obj({ counterparty: { type: 'string' }, amount: NULLABLE_STRING, vat: VAT, item: NULLABLE_STRING, ...DRAFT_EXTRA }) },
  { name: 'draft_edit', parameters: obj({ draft: { type: 'string' }, amount: NULLABLE_STRING, vat: VAT, item: NULLABLE_STRING, ...DRAFT_EXTRA }) },
  { name: 'draft_discard', parameters: obj({ draft: { type: 'string' } }) },
] as const;
export type ChatAgentToolName = (typeof CHAT_AGENT_TOOLS)[number]['name'];

/**
 * 결과 슬롯: 모델은 값을 모른 채 쓰고 기기(PC main·폰)가 로컬 결과에서 채운다.
 * - 행 값 `{r<N>.<first|last>.<field>}`: 맨 위·맨 아래 한 행의 값.
 * - 집계 `{r<N>.sum.<supply|total>}`·`{r<N>.count}`: 기기가 계산한 합계·건수. 모델은 산수를 하지 않는다(실제 모델이
 *   "매출 합계"에 첫 행 합계를 쓴 일이 있다, real-run-2 2026-11-12).
 */
export const SLOT_POSITIONS = ['first', 'last'] as const;
/** approvalNo: 국세청 승인번호(원장 committed). 값은 기기가 채우고 모델에는 가지 않는다. */
export const SLOT_FIELDS = ['date', 'supply', 'total', 'counterparty', 'approvalNo'] as const;
export type SlotField = (typeof SLOT_FIELDS)[number];
/**
 * 돈 흐름 결과(cash_flow)의 칸: `{r<N>.cash.<칸>}`. 행이 아니라 그달 요약 하나다(11 §3, ADR-045).
 * in·out·net: 그달 통장에 실제로 들어온·나간 돈과 그 차이. balance: 지금 잔액 합. next_in·next_out: 앞으로 30일 받을·낼 돈(기한 지난 낼 돈 포함).
 */
export const CASH_FIELDS = ['in', 'out', 'net', 'balance', 'next_in', 'next_out'] as const;
export type CashField = (typeof CASH_FIELDS)[number];
/** 합계를 낼 수 있는 칸(돈) */
export const SLOT_SUM_FIELDS = ['supply', 'total'] as const satisfies readonly SlotField[];
/** 슬롯 경로 전부(ref 뒤). 슬롯 문법은 이 목록 하나에서 나온다. */
export const SLOT_PATHS: readonly string[] = [
  ...SLOT_POSITIONS.flatMap((p) => SLOT_FIELDS.map((f) => `${p}.${f}`)),
  ...SLOT_SUM_FIELDS.map((f) => `sum.${f}`),
  'count',
  ...CASH_FIELDS.map((f) => `cash.${f}`),
];
/** 금액 인자로 쓸 수 있는 경로(돈인 칸만) */
export const SLOT_MONEY_PATHS: readonly string[] = SLOT_PATHS.filter((x) => /\.(supply|total)$/.test(x));
/** 슬롯 하나 전체에 맞는다. 묶음 1 = 결과 ref(r#), 2 = 경로(first.supply·sum.total·count …). */
export const slotPattern = new RegExp(`^\\{(r[1-9]\\d{0,5})\\.(${SLOT_PATHS.map((x) => x.replace('.', '\\.')).join('|')})\\}$`);
/** 문장 안의 슬롯 전부(g). 쓸 때마다 새로 만든다(lastIndex를 나눠 쓰지 않게). */
export const slotAnywhere = (): RegExp => new RegExp(slotPattern.source.slice(1, -1), 'g');

export const AGENT_REPLY_KINDS = ['answer', 'did', 'ask', 'cannot', 'tax_advice', 'smalltalk'] as const;
export const AGENT_ASKS = ['counterparty', 'amount', 'item', 'vat', 'which_card', 'date'] as const;
export type AgentReplyKind = (typeof AGENT_REPLY_KINDS)[number];
export type AgentAsk = (typeof AGENT_ASKS)[number];
/** 답과 같이 보일 ref 상한 */
export const AGENT_SHOW_MAX = 3;
/** 답 문장 글자 상한(chat_reply·chat_agent·chat_phone 공통) */
export const CHAT_REPLY_MAX_CHARS = 200;

/** 도구 결과의 빈 값 종류(needs) */
export const TOOL_NEEDS = ['amount', 'item', 'counterparty', 'date'] as const;
export type ToolNeed = (typeof TOOL_NEEDS)[number];
export type Vat = 'separate' | 'included';

// ── 폰 대화(chat_phone, ADR-047 결정 3) ──

/** 폰에 없는 도구(장부 전체·통장 거래내역이 있어야 답하는 조회. 낼 돈·돈 흐름은 폰 사본에 아직 없다). 이런 요청은 defer로 답하고 PC가 켜지면 PC가 이어받는다. */
export const PHONE_OMITTED_TOOLS = ['sales_summary', 'payables', 'cash_flow'] as const;
/** 폰 앱 화면(말 한마디로 여는 곳). capture: 영수증·종이 증빙 찍기, cash: 현금 매출 적기, bizreg: 사업자등록증으로 거래처 추가, issue: 발급 작성(카드 없이) */
export const PHONE_SCREENS = ['capture', 'cash', 'bizreg', 'issue'] as const;
export type PhoneScreen = (typeof PHONE_SCREENS)[number];
/** 폰에만 있는 도구: 앱 화면을 연다(사장님이 누를 단추를 대화에 붙인다. 값은 없다). */
export const PHONE_ONLY_TOOLS = [{ name: 'open_screen', parameters: obj({ screen: { type: 'string', enum: [...PHONE_SCREENS] } }) }] as const;
/** 폰 대화 도구 표: chat_agent 표에서 폰에 없는 것을 빼고(이름·인자 모양은 PC와 같다) 폰 화면 도구를 더한다. */
export const CHAT_PHONE_TOOLS = [
  ...CHAT_AGENT_TOOLS.filter((t) => !(PHONE_OMITTED_TOOLS as readonly string[]).includes(t.name)),
  ...PHONE_ONLY_TOOLS,
] as ReadonlyArray<Exclude<(typeof CHAT_AGENT_TOOLS)[number], { name: (typeof PHONE_OMITTED_TOOLS)[number] }> | (typeof PHONE_ONLY_TOOLS)[number]>;
export type ChatPhoneToolName = Exclude<ChatAgentToolName, (typeof PHONE_OMITTED_TOOLS)[number]> | (typeof PHONE_ONLY_TOOLS)[number]['name'];

/** 답 종류: PC와 같고 defer(PC가 켜지면 이어서 할 일)만 더 있다. */
export const PHONE_REPLY_KINDS = [...AGENT_REPLY_KINDS, 'defer'] as const;
export type PhoneReplyKind = (typeof PHONE_REPLY_KINDS)[number];

/** 폰 도구 결과의 status(폰 코어가 만들고 머리말이 뜻을 적는다. 시험이 머리말과 대조한다). */
export const PHONE_TOOL_STATUSES = ['ok', 'empty', 'unknown_counterparty', 'not_on_phone', 'card_shown', 'needs_input', 'card_updated', 'no_such_draft', 'not_editable', 'discarded', 'screen_shown'] as const;
export type PhoneToolStatus = (typeof PHONE_TOOL_STATUSES)[number];

/** 사본 상태([사실]의 "사본:" 줄): fresh(받은 지 하루 안), stale(그보다 오래됨), none(아직 받은 적 없음) */
export const PHONE_COPY_STATES = ['fresh', 'stale', 'none'] as const;
export type PhoneCopyState = (typeof PHONE_COPY_STATES)[number];

/** 폰 대화 한 사용자 턴의 모델 호출 상한(게이트웨이 chat_phone maxTurns와 같다. 시험이 대조한다) */
export const CHAT_PHONE_MAX_TURNS = 4;
/** 요약 글자 상한(가린 글 기준). 공급사 strict 스키마가 maxLength를 받지 않을 수 있어 스키마에는 넣지 않고 부르는 쪽이 검사한다. */
export const CHAT_DIGEST_MAX_CHARS = 900;

/** 폰 토큰(chat 범위)이 부를 수 있는 툴셋 전부. chat_phone은 폰만, chat_digest는 폰과 PC 모두. */
export const PHONE_TOOLSETS = ['chat_phone', 'chat_digest'] as const;
/** 폰만 부르는 툴셋(데스크톱 토큰으로는 부르지 못한다: 표면별 계량이 섞이지 않게). */
export const PHONE_ONLY_TOOLSETS = ['chat_phone'] as const;
