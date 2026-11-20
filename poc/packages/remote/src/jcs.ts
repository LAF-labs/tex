
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
