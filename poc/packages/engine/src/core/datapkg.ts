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
  schemas: ReadonlyMap<string, DataBodyValidator>;
  installed: { version: string; digest: string } | null;
  hold: boolean;
  now: number;
}

export interface LoadedData {
  descriptor: DataDescriptor;
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

  if (sha256Hex(raw.body) !== desc.bodyDigest) return fail('loader.content_digest_mismatch', [{ rule: 'DATA-2', target: 'body', message: 'body 다이제스트 불일치' }]);
  const validate = ctx.schemas.get(desc.schema);
  if (!validate) return fail('loader.data_schema_unknown');
  const b = parse(raw.body);
  if (!b.ok) return fail('loader.content_unparsable');
  const bv = validate(b.v);
  if (bv.length) return fail('loader.schema_invalid', bv.map((message) => ({ rule: 'DATA-2', target: 'body', message })));
  const head = b.v as { schema?: unknown; packageVersion?: unknown };
  if (head.schema !== desc.schema || head.packageVersion !== desc.version) return fail('loader.schema_invalid', [{ rule: 'DATA-2', target: 'body', message: 'body.schema·packageVersion이 기술자와 다름' }]);

  if (ctx.installed) {
    const c = compareSemver(desc.version, ctx.installed.version);
    if (c === null || c < 0 || (c === 0 && digest !== ctx.installed.digest)) return fail('registry.version_rollback');
  }
  return { ok: true, data: { descriptor: desc, digest, body: b.v }, events };
}
