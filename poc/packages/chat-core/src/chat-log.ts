import { TOKEN_RE, type EntityKind, type Redactor } from '@sax/redaction';
import type { PhoneReplyKind } from './tables.ts';
import type { ReactionId } from './turn.ts';

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

export interface ChatMessage {
  id: string;
  at: number;
  from: 'user' | 'app';
  text: string;
  ctx?: MaskedText;
  kind?: PhoneReplyKind;
  reaction?: ReactionId;
}
