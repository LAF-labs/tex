// 데이터 패키지 로더(SIGNING.md §6 kind:"data", D14 M6-10): 기술자 서명 2-of-3 → 본문 다이제스트 → 등록된 본문 검증기 → 버전.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canonicalJson, canonicalWithout, decodeSxp, encodeSxp, loadDataPackage, sha256Hex, type DataLoaderContext, type DataLoadResult } from '@sax/engine/core';
import { validatePackage } from '@sax/payroll';
import { sigOf, type TestKey } from './core-fixtures.ts';
import { SAMPLE_NOW, SAMPLE_RATE_TABLES, sampleKeys } from './registry-samples.ts';

const K = sampleKeys();
const SCHEMAS = new Map([['sax.rate-tables/v1', validatePackage]]);
const BODY = Buffer.from(`${JSON.stringify(SAMPLE_RATE_TABLES, null, 2)}\n`, 'utf8');

function build(o: { desc?: Record<string, unknown>; body?: Buffer; signers?: TestKey[]; digestOf?: Buffer } = {}) {
  const body = o.body ?? BODY;
  const desc: Record<string, unknown> = {
    id: 'payroll.rate-tables', version: SAMPLE_RATE_TABLES.packageVersion, schema: 'sax.rate-tables/v1', bodyDigest: sha256Hex(o.digestOf ?? body), keyEpoch: 1, issuedAt: '2026-11-05T00:00:00Z', ...o.desc,
  };
  desc.signatures = (o.signers ?? K.pkg.slice(0, 2)).map((k) => sigOf(k, canonicalWithout(desc, ['signatures'])));
  return { descriptor: Buffer.from(canonicalJson(desc), 'utf8'), body };
}
const ctx = (o: Partial<DataLoaderContext> = {}): DataLoaderContext => ({ roots: K.roots, revoked: new Set(), schemas: SCHEMAS, installed: null, hold: false, now: SAMPLE_NOW, ...o });
const code = (r: DataLoadResult) => (r.ok ? 'ok' : r.code);
const okDigest = () => {
  const r = loadDataPackage(build(), ctx());
  assert.ok(r.ok);
  return r.data.digest;
};

describe('데이터 패키지 로더', () => {
  it('받기: 기술자 2-of-3, 본문은 등록된 검증기(급여 validatePackage)를 통과', () => {
    const r = loadDataPackage(build(), ctx());
    assert.ok(r.ok, code(r));
    assert.equal(r.data.descriptor.id, 'payroll.rate-tables');
    assert.deepEqual(r.data.body, SAMPLE_RATE_TABLES);
    assert.equal(r.data.digest, sha256Hex(canonicalWithout(r.data.descriptor, ['signatures'])));
    assert.deepEqual(r.events, []);
  });

  it('.sxp kind:data 왕복', () => {
    const raw = build();
    const d = decodeSxp(encodeSxp({ kind: 'data', raw }));
    assert.ok(d.ok && d.sxp.kind === 'data');
    assert.ok(Buffer.from(d.sxp.raw.body).equals(raw.body) && Buffer.from(d.sxp.raw.descriptor).equals(raw.descriptor));
    const bad = JSON.parse(encodeSxp({ kind: 'data', raw }).toString('utf8')) as Record<string, unknown>;
    delete bad.body;
    const r = decodeSxp(Buffer.from(canonicalJson(bad), 'utf8'));
    assert.ok(!r.ok && r.code === 'sxp.malformed', '키가 정확히 넷이 아니면 malformed');
  });

  it('기술자: 파싱 불가·스키마 위반·.hotfix id·keyEpoch·미래 issuedAt', () => {
    assert.equal(code(loadDataPackage({ descriptor: Buffer.from('{'), body: BODY }, ctx())), 'loader.manifest_unparsable');
    const noDigest = build();
    const d = JSON.parse(noDigest.descriptor.toString('utf8')) as Record<string, unknown>;
    delete d.bodyDigest;
    assert.equal(code(loadDataPackage({ descriptor: Buffer.from(JSON.stringify(d)), body: BODY }, ctx())), 'loader.schema_invalid');
    assert.equal(code(loadDataPackage(build({ desc: { id: 'payroll.rate-tables.hotfix' } }), ctx())), 'loader.schema_invalid');
    assert.equal(code(loadDataPackage(build({ desc: { keyEpoch: 2 } }), ctx())), 'registry.key_epoch_mismatch');
    assert.equal(code(loadDataPackage(build({ desc: { issuedAt: '2026-11-06T00:00:00Z' } }), ctx())), 'registry.issued_in_future');
  });

  it('서명: 패키지 키 2개 미만이면 거부, 폐기 키는 세지 않고 이벤트', () => {
    assert.equal(code(loadDataPackage(build({ signers: [K.pkg[0]!, K.pol[0]!] }), ctx())), 'registry.signature_insufficient', '정책 키는 패키지 키가 아니다');
    const r = loadDataPackage(build(), ctx({ revoked: new Set(['package-2']) }));
    assert.equal(code(r), 'registry.signature_insufficient');
    assert.deepEqual(r.events, ['registry.key_revoked']);
    const three = loadDataPackage(build({ signers: K.pkg }), ctx({ revoked: new Set(['package-2']) }));
    assert.ok(three.ok && three.events.includes('registry.key_revoked'));
    const tampered = build();
    const t = JSON.parse(tampered.descriptor.toString('utf8')) as Record<string, unknown>;
    t.version = '2026.11.2';
    assert.equal(code(loadDataPackage({ descriptor: Buffer.from(canonicalJson(t)), body: BODY }, ctx())), 'registry.signature_insufficient', '서명 뒤 기술자를 바꾸면');
  });

  it('본문: 다이제스트 불일치·검증기 없는 schema·JSON 아님·검증 실패·schema/packageVersion 불일치', () => {
    const raw = build();
    assert.equal(code(loadDataPackage({ ...raw, body: Buffer.concat([raw.body, Buffer.from(' ')]) }, ctx())), 'loader.content_digest_mismatch');
    assert.equal(code(loadDataPackage(raw, ctx({ schemas: new Map() }))), 'loader.data_schema_unknown', 'fail-closed');
    assert.equal(code(loadDataPackage(build({ body: Buffer.from('{not json') }), ctx())), 'loader.content_unparsable');
    const t = SAMPLE_RATE_TABLES.tables[0];
    const overlap = Buffer.from(JSON.stringify({ ...SAMPLE_RATE_TABLES, tables: [t, { ...t, id: 'nontax-2026b' }] }));
    const r = loadDataPackage(build({ body: overlap }), ctx());
    assert.ok(!r.ok && r.code === 'loader.schema_invalid' && r.violations.some((v) => v.message.startsWith('overlap:')), '급여 D07 규칙(겹침)');
    assert.equal(code(loadDataPackage(build({ desc: { version: '2026.11.2' } }), ctx())), 'loader.schema_invalid', 'packageVersion ≠ version');
  });

  it('버전: 내림 거부, 같은 버전은 같은 다이제스트만(재로드), 보류 중엔 설치본만', () => {
    const digest = okDigest();
    assert.equal(code(loadDataPackage(build(), ctx({ installed: { version: '2026.12.0', digest: 'f'.repeat(64) } }))), 'registry.version_rollback');
    assert.equal(code(loadDataPackage(build(), ctx({ installed: { version: '2026.11.1', digest: 'f'.repeat(64) } }))), 'registry.version_rollback');
    assert.equal(code(loadDataPackage(build(), ctx({ installed: { version: '2026.11.1', digest } }))), 'ok');
    assert.equal(code(loadDataPackage(build(), ctx({ installed: { version: '2026.10.0', digest: 'f'.repeat(64) } }))), 'ok');
    assert.equal(code(loadDataPackage(build(), ctx({ hold: true, installed: { version: '2026.10.0', digest: 'f'.repeat(64) } }))), 'registry.update_held');
    assert.equal(code(loadDataPackage(build(), ctx({ hold: true, installed: { version: '2026.11.1', digest } }))), 'ok');
  });
});
