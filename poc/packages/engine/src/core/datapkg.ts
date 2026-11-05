// 데이터 패키지 로더(SIGNING.md §6 kind:"data", D14 M6-10). 급여 시행일 표처럼 플레이북이 아닌 서명 데이터.
// 1. 기술자: 스키마(data_descriptor) → JCS 가능 → id 규칙(.hotfix 금지) → keyEpoch·issuedAt(미래 금지) → 패키지 키 2-of-3(폐기 반영, 대상 = JCS(기술자 − signatures))
// 2. 본문: SHA-256(원시 바이트) = bodyDigest → UTF-8 JSON → 앱이 등록한 그 schema 이름의 검증기 → body.schema·packageVersion이 기술자와 같음
// 3. 버전: 같은 id의 내림 금지, 같은 버전은 설치본과 같은 다이제스트일 때만(재로드). 보류(hold) 중에는 설치본만.
// 본문 모양은 엔진이 모른다. 검증기가 없는 schema 이름은 받지 않는다(fail-closed).
import { canonicalWithout, canonicalizable, sha256Hex } from './canon.ts';
import { compareSemver } from './loader.ts';
import { countSignatures, epochProblem, issuedInFuture, type TrustRoots } from './registry.ts';
import { schemaViolations } from './schema.ts';
import type { RawDataPackage } from './sxp.ts';
import type { Signature, Violation } from './types.ts';

export interface DataDescriptor {
  id: string;
  version: string;
  schema: string;
  bodyDigest: string;
  keyEpoch: number;
  issuedAt: string;
  signatures: Signature[];
}

/** 본문 검증기: 문제가 없으면 빈 배열. */
export type DataBodyValidator = (body: unknown) => string[];

export interface DataLoaderContext {
  roots: TrustRoots;
  revoked: ReadonlySet<string>;
  /** schema 이름(예: sax.rate-tables/v1) → 검증기. 여기 없는 이름은 거부. */
  schemas: ReadonlyMap<string, DataBodyValidator>;
  /** 이 id로 설치된 버전·기술자 다이제스트. 없으면 null. */
  installed: { version: string; digest: string } | null;
  hold: boolean;
  /** 현재 시각(ms). issuedAt이 허용 오차보다 미래면 거부. */
  now: number;
}

export interface LoadedData {
  descriptor: DataDescriptor;
  /** JCS(기술자 − signatures)의 SHA-256. 재로드 판정에 쓴다. */
  digest: string;
  body: unknown;
}

export type DataLoadResult = { ok: true; data: LoadedData; events: string[] } | { ok: false; code: string; violations: Violation[]; events: string[] };

const parse = (b: Uint8Array): { ok: true; v: unknown } | { ok: false } => {
  try {
    return { ok: true, v: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(b)) };
  } catch {
    return { ok: false };
  }
};

export function loadDataPackage(raw: RawDataPackage, ctx: DataLoaderContext): DataLoadResult {
  const events: string[] = [];
  const fail = (code: string, violations: Violation[] = []): DataLoadResult => ({ ok: false, code, violations, events });

  // 1. 기술자
  const d = parse(raw.descriptor);
  if (!d.ok) return fail('loader.manifest_unparsable');
  const ds = schemaViolations('data_descriptor', d.v);
  if (ds.length) return fail('loader.schema_invalid', ds);
  const desc = d.v as DataDescriptor;
  if (!canonicalizable(desc)) return fail('loader.schema_invalid', [{ rule: 'DATA-1', message: 'JCS로 직렬화할 수 없는 값' }]);
  if (desc.id.endsWith('.hotfix')) return fail('loader.schema_invalid', [{ rule: 'DATA-1', message: '데이터 패키지 id는 .hotfix로 끝날 수 없음' }]);
  const ep = epochProblem(desc, ctx.roots);
  if (ep) return fail(ep);
  if (issuedInFuture(desc.issuedAt, ctx.now)) return fail('registry.issued_in_future');
  const signed = canonicalWithout(desc, ['signatures']);
  const q = countSignatures(signed, desc.signatures, ctx.roots.packageKeys, ctx.revoked);
  if (q.revoked.length) events.push('registry.key_revoked');
  if (q.valid.length < 2) return fail('registry.signature_insufficient');
  const digest = sha256Hex(signed);
  if (ctx.hold && digest !== ctx.installed?.digest) return fail('registry.update_held');

  // 2. 본문
  if (sha256Hex(raw.body) !== desc.bodyDigest) return fail('loader.content_digest_mismatch', [{ rule: 'DATA-2', target: 'body', message: 'body 다이제스트 불일치' }]);
  const validate = ctx.schemas.get(desc.schema);
  if (!validate) return fail('loader.data_schema_unknown');
  const b = parse(raw.body);
  if (!b.ok) return fail('loader.content_unparsable');
  const bv = validate(b.v);
  if (bv.length) return fail('loader.schema_invalid', bv.map((message) => ({ rule: 'DATA-2', target: 'body', message })));
  const head = b.v as { schema?: unknown; packageVersion?: unknown };
  if (head.schema !== desc.schema || head.packageVersion !== desc.version) return fail('loader.schema_invalid', [{ rule: 'DATA-2', target: 'body', message: 'body.schema·packageVersion이 기술자와 다름' }]);

  // 3. 버전
  if (ctx.installed) {
    const c = compareSemver(desc.version, ctx.installed.version);
    if (c === null || c < 0 || (c === 0 && digest !== ctx.installed.digest)) return fail('registry.version_rollback');
  }
  return { ok: true, data: { descriptor: desc, digest, body: b.v }, events };
}
