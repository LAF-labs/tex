// RFC 8785 JCS. 서명 대상(manifest − signatures, 정책 내용, 타임스탬프 본문)의 정규 바이트. gate.ts의 jcs는 정수만 받아
// 정책(slowFactor 1.5 등)을 다룰 수 없어 따로 둔다. 숫자는 ECMAScript Number 직렬화(JSON.stringify와 같다), -0은 0.
import { createHash } from 'node:crypto';

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function canonicalJson(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('jcs_number');
    return Object.is(v, -0) ? '0' : JSON.stringify(v);
  }
  if (typeof v === 'string') {
    if (LONE_SURROGATE.test(v)) throw new Error('jcs_string');
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    // 키는 UTF-16 코드 단위 순서(RFC 8785 §3.2.3). undefined 값은 뺀다.
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  throw new Error('jcs_type');
}

export const sha256Hex = (b: string | Uint8Array): string => createHash('sha256').update(b).digest('hex');

/** 객체에서 키 몇 개를 뺀 JCS 바이트(서명 대상). */
export function canonicalWithout(o: object, omit: readonly string[]): Buffer {
  const copy: Record<string, unknown> = { ...(o as Record<string, unknown>) };
  for (const k of omit) delete copy[k];
  return Buffer.from(canonicalJson(copy), 'utf8');
}
