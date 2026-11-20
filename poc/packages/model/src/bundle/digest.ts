import { createHash } from 'node:crypto';
import type { BundleDef } from './types.ts';

export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

export function computeDigest(def: BundleDef, prefixText: string): string {
  const rest: Partial<BundleDef> = { ...def };
  delete rest.digest;
  return createHash('sha256').update(canonicalJson({ def: rest, prefixText })).digest('hex');
}
