// RFC 8785 JCS. 엔진 gate.ts의 jcs·클라우드 services/shared의 jcs와 같은 규칙이다(키는 UTF-16 코드 단위 순서, 공백 없음, 정수만).
// AIK 서명 객체(기기 목록 항목·폐기 레코드·기기 인증서)와 DPoP 증명의 서명 입력은 utf8(ctx) ‖ utf8(JCS(객체))다(services/shared/CONTRACT.md §1).

import { fromUtf8, utf8 } from './bytes.ts';

export function jcs(v: unknown): string {
  if (typeof v === 'string' || typeof v === 'boolean' || v === null) return JSON.stringify(v);
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new Error('jcs_number');
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(jcs).join(',')}]`;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    // undefined 값은 JSON.stringify처럼 뺀다.
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${jcs(o[k])}`).join(',')}}`;
  }
  throw new Error('jcs_type');
}

export const jcsBytes = (v: unknown): Uint8Array => utf8(jcs(v));

/** JCS 바이트를 읽는다. 정규형이 아니면(키 순서·공백·이스케이프가 다르면) null. */
export function parseJcs(b: Uint8Array, maxBytes = 4096): unknown {
  if (b.length > maxBytes) return null;
  try {
    const s = fromUtf8(b);
    const v: unknown = JSON.parse(s);
    return jcs(v) === s ? v : null;
  } catch {
    return null;
  }
}
