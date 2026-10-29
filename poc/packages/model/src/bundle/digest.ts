// 번들 다이제스트 = sha256(정규 JSON(digest 필드를 뺀 정의 + 조립된 고정 접두 텍스트)).
// 접두를 포함하는 이유: 접두(라벨 정의)가 바뀌면 판정이 바뀌므로 같은 다이제스트로 배포될 수 없어야 한다.
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
