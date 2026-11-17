// 대화 기록의 모양(ADR-047 결정 5·6). 대화는 기기마다 따로 둔다(ADR-046 결정 7): 이 기록은 만든 기기 밖으로 나가지 않는다. 순수 함수만 둔다.
// - 메시지는 화면 문장(text, 가리지 않은 글)과 컨텍스트용 가린 글(ctx)을 같이 가진다. 둘 다 기기 안(폰은 봉인 저장)에만 있다.
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

export interface ChatMessage {
  /** ULID(만든 기기가 붙인다) */
  id: string;
  /** 쓴 시각(ms, 만든 기기의 시계) */
  at: number;
  from: 'user' | 'app';
  /** 화면 문장 */
  text: string;
  /** 컨텍스트용 가린 글. 없으면 text를 규칙으로 가려 쓴다. */
  ctx?: MaskedText;
  /** app 메시지의 답 종류. defer는 PC를 켜면 이어서 할 일이다. */
  kind?: PhoneReplyKind;
}
