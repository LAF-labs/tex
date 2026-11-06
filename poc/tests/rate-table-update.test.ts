// M6-10 서명 배포 → 급여 표 저장소(데이터 트랙): .sxp kind:data → 엔진 loadDataPackage(2-of-3·다이제스트·validatePackage·버전) → applyRateTableUpdate → RateTableRepo.
// 실패하면 저장소·설치 기록은 그대로고 계산은 기존 표로 계속된다(rate_table_missing으로 바뀌지 않는다).
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { openDatabase, RateTableRepo, type Db } from '@sax/db';
import { canonicalJson, canonicalWithout, decodeSxp, encodeSxp, loadDataPackage, sha256Hex, type DataLoaderContext, type RawDataPackage } from '@sax/engine/core';
import {
  applyRateTableUpdate, availableTables, loadBundledPackage, pickTables, RATE_TABLE_SCHEMAS, RATE_TABLES_PACKAGE_ID, takeHome,
  type RateTable, type RateTablePackage,
} from '@sax/payroll';
import { sigOf } from './core-fixtures.ts';
import { SAMPLE_NOW, SAMPLE_RATE_TABLES, sampleKeys } from './registry-samples.ts';

const K = sampleKeys();
const bundled = loadBundledPackage();

/** 패키지 키 두 개로 서명한 .sxp를 만들어 다시 읽는다(레지스트리에서 받은 바이트처럼) */
function sxpOf(body: unknown, o: { version?: string; signers?: typeof K.pkg } = {}): RawDataPackage {
  const bytes = Buffer.from(`${JSON.stringify(body, null, 2)}\n`, 'utf8');
  const desc: Record<string, unknown> = {
    id: RATE_TABLES_PACKAGE_ID, version: o.version ?? (body as RateTablePackage).packageVersion, schema: 'sax.rate-tables/v1', bodyDigest: sha256Hex(bytes), keyEpoch: 1, issuedAt: '2026-11-05T00:00:00Z',
  };
  desc.signatures = (o.signers ?? K.pkg.slice(0, 2)).map((k) => sigOf(k, canonicalWithout(desc, ['signatures'])));
  const d = decodeSxp(encodeSxp({ kind: 'data', raw: { descriptor: Buffer.from(canonicalJson(desc), 'utf8'), body: bytes } }));
  assert.ok(d.ok && d.sxp.kind === 'data');
  return d.sxp.raw;
}

describe('서명 배포 시행일 표 → 표 저장소(M6-10)', () => {
  let dir: string;
  let db: Db;
  let repo: RateTableRepo;
  /** 업데이트 채널이 하는 일: 설치본을 ctx.installed로 넘기고, 결과를 저장소에 반영 */
  const update = (raw: RawDataPackage, o: Partial<DataLoaderContext> = {}) =>
    applyRateTableUpdate(repo, loadDataPackage(raw, { roots: K.roots, revoked: new Set(), now: SAMPLE_NOW, hold: false, schemas: RATE_TABLE_SCHEMAS, installed: repo.installedPackage(RATE_TABLES_PACKAGE_ID), ...o }));
  const tablesNow = () => availableTables(repo.list(), bundled);
  const nontaxOn = (day: string) => pickTables(tablesNow(), { taxDate: day, insuranceDate: day }).nontax;

  before(() => {
    dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sax-rates-'));
    db = openDatabase(path.join(dir, 'db.sqlite'), new Uint8Array(randomBytes(32)));
    repo = new RateTableRepo(db);
  });
  after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const t2026 = SAMPLE_RATE_TABLES.tables[0] as unknown as RateTable<'nontax_limits'>;
  const meal = (t: RateTable<'nontax_limits'>, n: number): RateTable<'nontax_limits'> => ({ ...t, body: { kinds: { ...t.body.kinds, meal: { ...t.body.kinds.meal, monthlyLimit: n } } } });
  const v2: RateTablePackage = {
    schema: 'sax.rate-tables/v1', packageVersion: '2026.12.0',
    tables: [{ ...t2026, effectiveTo: '2026-12-31' }, { ...meal(t2026, 300_000), id: 'nontax-2027', effectiveFrom: '2027-01-01' }],
  };

  it('첫 판(레지스트리 샘플 2026.11.1): 받아서 저장, 설치 기록은 기술자 다이제스트', () => {
    const raw = sxpOf(SAMPLE_RATE_TABLES);
    const u = update(raw);
    assert.deepEqual(u, { ok: true, packageVersion: '2026.11.1', added: ['nontax-2026'], closed: [], unchanged: [] });
    const r = loadDataPackage(raw, { roots: K.roots, revoked: new Set(), now: SAMPLE_NOW, hold: false, schemas: RATE_TABLE_SCHEMAS, installed: null });
    assert.ok(r.ok);
    assert.deepEqual({ ...repo.installedPackage(RATE_TABLES_PACKAGE_ID)!, installedAt: '' }, { version: '2026.11.1', digest: r.data.digest, installedAt: '' });
    assert.equal(nontaxOn('2026-11-01').id, 'nontax-2026');
    assert.equal(pickTables(tablesNow(), { taxDate: '2026-11-10', insuranceDate: '2026-11-01' }).simpleTax.id, 'simple-tax-2026-03', '실리지 않은 종류는 기본 표');
    assert.deepEqual(update(raw), { ok: true, packageVersion: '2026.11.1', added: [], closed: [], unchanged: ['nontax-2026'] }, '같은 판 재로드');
  });

  it('다음 판(2026.12.0): 열린 끝을 닫고 2027 표를 더함, 시행일 규칙 그대로', () => {
    assert.deepEqual(update(sxpOf(v2)), { ok: true, packageVersion: '2026.12.0', added: ['nontax-2027'], closed: ['nontax-2026'], unchanged: [] });
    assert.equal(nontaxOn('2026-12-31').id, 'nontax-2026');
    assert.equal(nontaxOn('2027-01-01').body.kinds.meal.monthlyLimit, 300_000);
    assert.equal(repo.get('nontax-2026')!.packageVersion, '2026.11.1', '처음 실린 판');
    const T = pickTables(tablesNow(), { taxDate: '2027-01-10', insuranceDate: '2027-01-01' });
    const r = takeHome({ month: '2027-01', gross: 3_000_000, settings: { nontax: { meal: 300_000 }, dependents: 1, children8to20: 0, withholdingPct: 100, pensionApplies: true, healthApplies: true, employmentApplies: true } }, T);
    assert.equal(r.nontax, 300_000, '새 한도로 계산');
  });

  it('실패하면 기존 표 유지(서명 부족·내림·같은 id 다른 내용·검증기 없음·보류), 계산은 계속', () => {
    const before = JSON.stringify(repo.list());
    const kept = { version: '2026.12.0', digest: repo.installedPackage(RATE_TABLES_PACKAGE_ID)!.digest };
    const v3 = { ...v2, packageVersion: '2027.1.0', tables: [v2.tables[0]!, meal(v2.tables[1] as RateTable<'nontax_limits'>, 1)] };
    const cases: Array<[string, ReturnType<typeof update>]> = [
      ['registry.signature_insufficient', update(sxpOf(v3, { signers: [K.pkg[0]!, K.pol[0]!] }))],
      ['registry.version_rollback', update(sxpOf(SAMPLE_RATE_TABLES))],
      ['rate_tables.rate_table_id_reused', update(sxpOf(v3))],
      ['loader.data_schema_unknown', update(sxpOf(v3), { schemas: new Map() })],
      ['registry.update_held', update(sxpOf(v3), { hold: true })],
    ];
    for (const [code, u] of cases) assert.deepEqual(u, { ok: false, code, kept }, code);
    assert.equal(JSON.stringify(repo.list()), before, '표 그대로');
    assert.equal(repo.installedPackage(RATE_TABLES_PACKAGE_ID)!.version, '2026.12.0');
    assert.equal(nontaxOn('2027-03-01').body.kinds.meal.monthlyLimit, 300_000, 'rate_table_missing이 아니라 기존 표로');
  });
});
