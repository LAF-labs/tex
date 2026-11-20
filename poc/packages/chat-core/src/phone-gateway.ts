import { wasMinted, type RedactedText } from '@sax/redaction';
import { CHAT_PHONE_TOOLS, DATE_MONTH_MIN, PHONE_SCREENS, type ChatPhoneToolName } from './tables.ts';
import { CHAT_ROUTE_BUNDLE, routeAnswersOf, type RouteAnswer } from './turn.ts';

export type PhoneChatErrorCode =
  | 'chat.unavailable'
  | 'chat.bad_response'
  | 'chat.budget_exceeded'
  | 'chat.quota_exceeded'
  | 'chat.daily_limit'
  | 'chat.subscription_required'
  | 'chat.device_suspended'
  | 'chat.rate_limited'
  | 'chat.input_too_large'
  | 'chat.secret_rejected'
  | 'chat.turn_limit'
  | 'bad_text';

export class PhoneChatError extends Error {
  readonly code: PhoneChatErrorCode;
  constructor(code: PhoneChatErrorCode) {
    super(code);
    this.code = code;
  }
}

/** 게이트웨이가 태그를 붙여 준 모델 출력 항목. 다음 턴에 그대로 돌려보낸다. */
export interface TaggedItem {
  item: Record<string, unknown>;
  tag: string;
}
export type ReplayItem = TaggedItem | { type: 'function_call_output'; call_id: string; output: RedactedText };

export interface PhoneRespondRequest {
  toolset: 'chat_phone' | 'chat_digest';
  text: RedactedText;
  replay: ReplayItem[];
  runToken: string;
}

export interface PhoneToolCall {
  callId: string;
  name: ChatPhoneToolName;
  arguments: Record<string, unknown>;
}

export type PhoneRespondResult =
  | { status: 'completed'; output: unknown; toolCalls: PhoneToolCall[]; replay: TaggedItem[] }
  | { status: 'refusal' }
  | { status: 'error'; code: PhoneChatErrorCode; tokenInvalid?: boolean };

export interface PhoneUsage {
  usedKrw: number;
  limitKrw: number;
  resetAt: number;
  tier: 'trial' | 'paid';
}

/** PhoneChat이 쓰는 모델 포트. 시험은 가짜로 바꾼다. */
export interface PhoneModel {
  runToken(chatSessionId: string): Promise<string>;
  respond(req: PhoneRespondRequest): Promise<PhoneRespondResult>;
  route?(req: { text: RedactedText; runToken: string }): Promise<Record<string, RouteAnswer> | null>;
}

export interface HttpResponse {
  status: number;
  text(): Promise<string>;
}

export interface PhoneGatewayOptions {
  origin: string;
  fetch(url: string, init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string }): Promise<HttpResponse>;
  authHeaders(method: 'GET' | 'POST', url: string): Promise<Record<string, string>>;
}

/** 게이트웨이 오류 코드({error: code}) → 대화 오류 코드 */
export function phoneErrorOf(code: string | undefined): { code: PhoneChatErrorCode; tokenInvalid?: boolean } {
  switch (code) {
    case 'gateway.run_budget_exceeded':
      return { code: 'chat.budget_exceeded', tokenInvalid: true };
    case 'gateway.run_token_invalid':
      return { code: 'chat.unavailable', tokenInvalid: true };
    case 'gateway.quota_exceeded':
      return { code: 'chat.quota_exceeded' };
    case 'gateway.daily_limit':
      return { code: 'chat.daily_limit' };
    case 'account.scope_denied':
    case 'account.subscription_required':
      return { code: 'chat.subscription_required' };
    case 'gateway.device_suspended':
      return { code: 'chat.device_suspended' };
    case 'policy.rate_limited':
      return { code: 'chat.rate_limited' };
    default:
      return { code: 'chat.unavailable' };
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const nullableString = (v: unknown) => v === null || typeof v === 'string';
const vat = (v: unknown) => v === null || v === 'separate' || v === 'included';
const keysAre = (o: Record<string, unknown>, keys: readonly string[]) => Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));
const ARG_MAX = 400;
const short = (o: Record<string, unknown>) => Object.values(o).every((v) => typeof v !== 'string' || v.length <= ARG_MAX);

const EXTRA_KEYS = ['date_month_offset', 'date_day', 'quantity', 'unit_price'] as const;
const monthOffset = (v: unknown) => v === null || (typeof v === 'number' && Number.isInteger(v) && v >= DATE_MONTH_MIN && v <= 0);
const extraOk = (a: Record<string, unknown>) => monthOffset(a.date_month_offset) && nullableString(a.date_day) && nullableString(a.quantity) && nullableString(a.unit_price);

/** 도구 인자 모양 검사. 표(CHAT_PHONE_TOOLS)의 JSON 스키마와 같은 판정이어야 한다(시험이 Ajv와 대조한다). */
export const PHONE_TOOL_ARGS: { [K in ChatPhoneToolName]: (a: Record<string, unknown>) => boolean } = {
  invoice_history: (a) => keysAre(a, ['counterparty']) && nullableString(a.counterparty),
  receivables: (a) => keysAre(a, ['counterparty']) && nullableString(a.counterparty),
  invoice_draft: (a) => keysAre(a, ['counterparty', 'amount', 'vat', 'item', ...EXTRA_KEYS]) && typeof a.counterparty === 'string' && nullableString(a.amount) && vat(a.vat) && nullableString(a.item) && extraOk(a),
  draft_edit: (a) => keysAre(a, ['draft', 'amount', 'vat', 'item', ...EXTRA_KEYS]) && typeof a.draft === 'string' && nullableString(a.amount) && vat(a.vat) && nullableString(a.item) && extraOk(a),
  draft_discard: (a) => keysAre(a, ['draft']) && typeof a.draft === 'string',
  open_screen: (a) => keysAre(a, ['screen']) && (PHONE_SCREENS as readonly unknown[]).includes(a.screen),
};
const TOOL_NAMES: ReadonlySet<string> = new Set(CHAT_PHONE_TOOLS.map((t) => t.name));

export function validPhoneToolCall(name: unknown, args: unknown): args is Record<string, unknown> {
  return typeof name === 'string' && TOOL_NAMES.has(name) && isObj(args) && short(args) && PHONE_TOOL_ARGS[name as ChatPhoneToolName](args);
}

/** 게이트웨이 /v1/respond 응답({status, output:[{item, tag}], toolsetDigest, usage})을 도구 호출·출력으로 읽는다. */
export function parseRespond(v: unknown): PhoneRespondResult {
  const bad: PhoneRespondResult = { status: 'error', code: 'chat.bad_response' };
  if (!isObj(v) || typeof v.status !== 'string' || !Array.isArray(v.output)) return bad;
  const replay: TaggedItem[] = [];
  const toolCalls: PhoneToolCall[] = [];
  let output: unknown;
  let refused = false;
  for (const o of v.output) {
    if (!isObj(o) || !isObj(o.item) || typeof o.tag !== 'string' || !/^[0-9a-f]{64}$/.test(o.tag)) return bad;
    const item = o.item;
    replay.push({ item, tag: o.tag });
    if (item.type === 'function_call') {
      let args: unknown;
      try {
        args = JSON.parse(String(item.arguments));
      } catch {
        return bad;
      }
      if (typeof item.call_id !== 'string' || !item.call_id || item.call_id.length > 128 || !validPhoneToolCall(item.name, args)) return bad;
      toolCalls.push({ callId: item.call_id, name: item.name as ChatPhoneToolName, arguments: args });
    } else if (item.type === 'message') {
      for (const c of Array.isArray(item.content) ? item.content : []) {
        if (!isObj(c)) return bad;
        if (c.type === 'refusal') refused = true;
        if (c.type === 'output_text') {
          try {
            output = JSON.parse(String(c.text));
          } catch {
            return bad;
          }
        }
      }
    } else if (item.type !== 'reasoning') return bad;
  }
  if (refused) return { status: 'refusal' };
  if (v.status !== 'completed') return { status: 'error', code: 'chat.unavailable' };
  return { status: 'completed', output, toolCalls, replay };
}

export class PhoneGateway implements PhoneModel {
  private readonly o: PhoneGatewayOptions;

  constructor(o: PhoneGatewayOptions) {
    if (!/^https:\/\/[a-z0-9.-]+(?::\d+)?$/.test(o.origin) && !/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(o.origin)) throw new Error('phone_gateway_origin');
    this.o = o;
  }

  private async call(method: 'GET' | 'POST', path: '/v1/run-tokens' | '/v1/respond' | '/v1/usage' | '/v1/decide', body?: unknown): Promise<{ ok: true; value: unknown } | { ok: false; error: string | undefined }> {
    const url = this.o.origin + path;
    let res: HttpResponse;
    let text: string;
    try {
      const headers = { ...(await this.o.authHeaders(method, url)), ...(body === undefined ? {} : { 'content-type': 'application/json' }) };
      res = await this.o.fetch(url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      text = await res.text();
    } catch {
      return { ok: false, error: undefined };
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, error: undefined };
    }
    if (res.status !== 200) return { ok: false, error: isObj(json) && typeof json.error === 'string' ? json.error : undefined };
    return { ok: true, value: json };
  }

  async runToken(chatSessionId: string): Promise<string> {
    const r = await this.call('POST', '/v1/run-tokens', { chatSessionId });
    if (!r.ok) throw new PhoneChatError(phoneErrorOf(r.error).code);
    const t = isObj(r.value) ? r.value.runToken : undefined;
    if (typeof t !== 'string' || t.length < 16 || t.length > 512) throw new PhoneChatError('chat.bad_response');
    return t;
  }

  async respond(req: PhoneRespondRequest): Promise<PhoneRespondResult> {
    if (!wasMinted(req.text) || req.replay.some((x) => 'output' in x && !wasMinted(x.output))) return { status: 'error', code: 'chat.unavailable' };
    const r = await this.call('POST', '/v1/respond', {
      toolset: req.toolset,
      messages: [{ role: 'user', content: [{ type: 'input_text', text: req.text }] }],
      replay: req.replay,
      runToken: req.runToken,
    });
    if (!r.ok) return { status: 'error', ...phoneErrorOf(r.error) };
    return parseRespond(r.value);
  }

  async route(req: { text: RedactedText; runToken: string }): Promise<Record<string, RouteAnswer> | null> {
    if (!wasMinted(req.text)) return null;
    const r = await this.call('POST', '/v1/decide', { bundleId: CHAT_ROUTE_BUNDLE.id, bundleDigest: CHAT_ROUTE_BUNDLE.digest, input: req.text, runToken: req.runToken });
    if (!r.ok) {
      if (phoneErrorOf(r.error).tokenInvalid) throw new PhoneChatError('chat.unavailable');
      return null;
    }
    return isObj(r.value) ? routeAnswersOf(r.value.answers) : null;
  }

  async usage(): Promise<PhoneUsage | null> {
    const r = await this.call('GET', '/v1/usage');
    if (!r.ok || !isObj(r.value)) return null;
    const { usedKrw, limitKrw, resetAt, tier } = r.value;
    if (typeof usedKrw !== 'number' || typeof limitKrw !== 'number' || typeof resetAt !== 'number' || (tier !== 'trial' && tier !== 'paid')) return null;
    return { usedKrw, limitKrw, resetAt, tier };
  }
}
