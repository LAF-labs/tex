// 대화 기록과 합치기(ADR-047 결정 5·6). 폰과 PC가 같은 메시지 모양을 쓴다. 순수 함수만 둔다.
// - 메시지는 화면 문장(text, 가리지 않은 글)과 컨텍스트용 가린 글(ctx)을 같이 가진다. 둘 다 기기 안(폰은 봉인 저장)과 종단간 암호화 구간에만 있다.
// - ctx는 "토큰이 든 문장 + 그 토큰의 값"이다. 대화 세션이 바뀌면 값으로 새 토큰을 받아 다시 쓴다(rebind).
//   규칙으로 다시 가리지 않으므로 처음 보낼 때 가려진 것은 나중에도 똑같이 가려진다(토큰 번호는 세션을 넘어 남지 않는다).
import { TOKEN_RE, type EntityKind, type Redactor } from '@sax/redaction';
import type { PhoneReplyKind } from './tables.ts';

/** 가린 글 한 조각. e는 t에 나온 토큰의 종류(k)·값(v)·묶인 레코드(r)다. */
export interface MaskedText {
  t: string;
  e: Record<string, { k: string; v: string; r?: string }>;
}

/** 지금 세션의 토큰 맵에서 text에 나온 토큰의 값을 모아 MaskedText로 만든다. 맵에 없는 토큰이 있으면 null. */
export function capture(red: Redactor, text: string): MaskedText | null {
  const e: MaskedText['e'] = {};
  for (const m of text.matchAll(TOKEN_RE)) {
    const tok = m[0];
    if (e[tok]) continue;
    const v = red.map.valueOf(tok);
    if (v === undefined) return null;
    const r = red.map.recordOf(tok);
    e[tok] = { k: m[1]!, v, ...(r ? { r } : {}) };
  }
  return { t: text, e };
}

/** 값이 없는 토큰 자리에 넣는 말(값을 지어내지 않는다) */
export const UNKNOWN_TOKEN_TEXT = '(가림)';

/** MaskedText를 지금 세션의 토큰으로 다시 쓴다. 같은 값은 같은 토큰이 된다. 모르는 토큰은 UNKNOWN_TOKEN_TEXT로 바꾼다. */
export function rebind(red: Redactor, m: MaskedText): string {
  return m.t.replace(TOKEN_RE, (tok) => {
    const x = Object.hasOwn(m.e, tok) ? m.e[tok] : undefined;
    if (!x || !/^[A-Z]+$/.test(x.k) || typeof x.v !== 'string' || !x.v) return UNKNOWN_TOKEN_TEXT;
    const now = red.map.token(x.k as EntityKind, x.v);
    if (x.r) {
      try {
        red.map.bindRecord(now, x.r);
      } catch {
        // 이 세션에서 다른 레코드에 묶인 값이면 묶지 않는다(가림은 그대로다)
      }
    }
    return now;
  });
}

/** 화면에 보일 글로 푼다(토큰 → 값). 요약을 사람이 볼 일은 없지만 PC가 받은 요약을 점검할 때 쓴다. */
export function reveal(m: MaskedText): string {
  return m.t.replace(TOKEN_RE, (tok) => (Object.hasOwn(m.e, tok) ? m.e[tok]!.v : UNKNOWN_TOKEN_TEXT));
}

export interface ChatMessage {
  /** ULID(만든 기기가 붙인다). 합칠 때 이 id로 중복을 버린다. */
  id: string;
  /** 쓴 시각(ms, 만든 기기의 시계) */
  at: number;
  from: 'user' | 'app';
  origin: 'phone' | 'pc';
  /** 화면 문장 */
  text: string;
  /** 컨텍스트용 가린 글. 없으면 text를 규칙으로 가려 쓴다. */
  ctx?: MaskedText;
  /** app 메시지의 답 종류. defer는 PC가 켜지면 이어서 할 일이다. */
  kind?: PhoneReplyKind;
  /** 폰 구간 메시지: 이 메시지를 쓸 때 폰이 알고 있던 PC의 마지막 메시지 id */
  base?: string | null;
  /** 폰 구간 메시지: PC가 받았다고 답했다 */
  synced?: boolean;
}

export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export const MESSAGE_TEXT_MAX = 4000;
/** 한 번에 보내는 폰 구간 메시지 수 상한 */
export const SEGMENT_MAX = 200;
/** PC가 넘기는 최근 메시지 수 상한(20턴 × 사용자·앱) */
export const CONTEXT_MESSAGES_MAX = 60;
const ENTRIES_MAX = 40;

function validMasked(v: unknown, max: number): v is MaskedText {
  const m = v as MaskedText | null;
  if (!m || typeof m !== 'object' || typeof m.t !== 'string' || [...m.t].length > max || !m.e || typeof m.e !== 'object' || Array.isArray(m.e)) return false;
  const es = Object.entries(m.e);
  return es.length <= ENTRIES_MAX && es.every(([tok, x]) => /^\[[A-Z]+_\d+\]$/.test(tok) && !!x && typeof x === 'object' && /^[A-Z]+$/.test(x.k) && typeof x.v === 'string' && x.v.length > 0 && x.v.length <= 200 && (x.r === undefined || (typeof x.r === 'string' && x.r.length <= 80)));
}

const KINDS: ReadonlySet<string> = new Set(['answer', 'did', 'ask', 'cannot', 'tax_advice', 'smalltalk', 'defer']);

/** 다른 기기에서 온 메시지 하나의 모양 검사. 모르는 칸은 버리고 아는 칸만 옮긴다. 틀리면 null. */
export function cleanMessage(v: unknown, origin: 'phone' | 'pc'): ChatMessage | null {
  const m = v as Partial<ChatMessage> | null;
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  if (typeof m.id !== 'string' || !ULID_RE.test(m.id) || typeof m.at !== 'number' || !Number.isSafeInteger(m.at) || m.at < 0) return null;
  if ((m.from !== 'user' && m.from !== 'app') || m.origin !== origin) return null;
  if (typeof m.text !== 'string' || !m.text.trim() || [...m.text].length > MESSAGE_TEXT_MAX) return null;
  if (m.ctx !== undefined && !validMasked(m.ctx, MESSAGE_TEXT_MAX)) return null;
  if (m.kind !== undefined && (m.from !== 'app' || !KINDS.has(m.kind))) return null;
  if (m.base !== undefined && m.base !== null && !(typeof m.base === 'string' && ULID_RE.test(m.base))) return null;
  return {
    id: m.id,
    at: m.at,
    from: m.from,
    origin,
    text: m.text,
    ...(m.ctx ? { ctx: { t: m.ctx.t, e: Object.fromEntries(Object.entries(m.ctx.e).map(([k, x]) => [k, { k: x.k, v: x.v, ...(x.r ? { r: x.r } : {}) }])) } } : {}),
    ...(m.kind ? { kind: m.kind } : {}),
    ...(m.base !== undefined ? { base: m.base } : {}),
  };
}

/** 폰 → PC 한 묶음(chat.sync 본문). 종단간 암호화 구간으로만 간다. */
export interface PhoneSegment {
  /** 묶음 첫 메시지를 쓸 때 폰이 알고 있던 PC의 마지막 메시지 id(없으면 null) */
  base: string | null;
  messages: ChatMessage[];
}

export function cleanSegment(v: unknown): PhoneSegment | null {
  const s = v as Partial<PhoneSegment> | null;
  if (!s || typeof s !== 'object' || !Array.isArray(s.messages) || s.messages.length < 1 || s.messages.length > SEGMENT_MAX) return null;
  if (!(s.base === null || (typeof s.base === 'string' && ULID_RE.test(s.base)))) return null;
  const messages = s.messages.map((m) => cleanMessage(m, 'phone'));
  if (messages.some((m) => !m) || new Set(messages.map((m) => m!.id)).size !== messages.length) return null;
  return { base: s.base, messages: messages as ChatMessage[] };
}

/** PC → 폰 컨텍스트(chat.context 본문): 긴 요약과 최근 메시지. 종단간 암호화 구간으로만 간다. */
export interface PcContext {
  /** PC가 만든 긴 요약(없으면 null) */
  summary: MaskedText | null;
  /** 최근 메시지(오래된 것부터). 폰에서 온 것을 PC가 합친 뒤에는 origin phone도 섞여 있다. */
  messages: ChatMessage[];
  /** PC 기록의 마지막 메시지 id(없으면 null) */
  cursor: string | null;
  /** PC가 이 컨텍스트를 만든 시각(ms) */
  at: number;
}

export const SUMMARY_MAX_CHARS = 2400;

export function cleanContext(v: unknown): PcContext | null {
  const c = v as Partial<PcContext> | null;
  if (!c || typeof c !== 'object' || !Array.isArray(c.messages) || c.messages.length > CONTEXT_MESSAGES_MAX) return null;
  if (!(c.summary === null || validMasked(c.summary, SUMMARY_MAX_CHARS))) return null;
  if (!(c.cursor === null || (typeof c.cursor === 'string' && ULID_RE.test(c.cursor))) || typeof c.at !== 'number' || !Number.isSafeInteger(c.at)) return null;
  const messages = c.messages.map((m) => cleanMessage(m, (m as { origin?: unknown } | null)?.origin === 'phone' ? 'phone' : 'pc'));
  if (messages.some((m) => !m) || new Set(messages.map((m) => m!.id)).size !== messages.length) return null;
  return { summary: c.summary ? { t: c.summary.t, e: { ...c.summary.e } } : null, messages: messages as ChatMessage[], cursor: c.cursor, at: c.at };
}

/**
 * PC 기록에 폰 구간을 합친다(ADR-047 결정 6). 여러 번 불러도 결과가 같다(메시지 id로 중복을 버린다).
 * - 구간 안에서는 폰이 쓴 순서 그대로다.
 * - 구간의 자리는 base(폰이 알고 있던 PC의 마지막 메시지) 바로 뒤부터다. base 뒤에 PC에서 생긴 메시지와는 쓴 시각으로 맞춘다
 *   (두 줄을 순서를 지키며 섞는다). 폰 시계가 틀려도 구간 안 순서와 "이미 본 PC 메시지 뒤"는 지켜진다.
 * - base를 PC가 모르면(기록을 지웠거나 다른 PC) 전체를 시각으로 맞춘다.
 * accepted는 이 묶음에서 PC 기록에 있는(새로 넣었거나 이미 있던) 메시지 id 전부다. PC는 이것으로 chat.sync.ack를 답한다.
 */
export function mergeSegment(log: readonly ChatMessage[], seg: PhoneSegment): { log: ChatMessage[]; accepted: string[]; added: number } {
  const have = new Set(log.map((m) => m.id));
  const fresh = seg.messages.filter((m) => !have.has(m.id)).map((m) => ({ ...m, origin: 'phone' as const, synced: true }));
  const accepted = seg.messages.map((m) => m.id);
  if (!fresh.length) return { log: [...log], accepted, added: 0 };
  const at = seg.base === null ? -1 : log.findIndex((m) => m.id === seg.base);
  const head = log.slice(0, at + 1);
  const tail = log.slice(at + 1);
  const out = [...head];
  let i = 0;
  let j = 0;
  while (i < tail.length || j < fresh.length) {
    if (j >= fresh.length || (i < tail.length && tail[i]!.at <= fresh[j]!.at)) out.push(tail[i++]!);
    else out.push(fresh[j++]!);
  }
  return { log: out, accepted, added: fresh.length };
}
