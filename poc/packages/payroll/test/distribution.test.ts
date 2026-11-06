// M6-10 서명 배포 표 → 저장소 반영(순수 부분): 행 변환, 실패 시 저장소 그대로, 계산에 쓸 표 고르기(저장소 먼저, 기본 표는 빈 곳만).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyRateTableUpdate, availableTables, fromStoredTable, loadBundledPackage, pickTables, RATE_TABLE_SCHEMAS, RATE_TABLES_PACKAGE_ID, RATE_TABLES_SCHEMA, toStoredTable, validatePackage,
  type DataLoadResultLike, type RateTable, type RateTablePackage, type RateTableStore, type StoredRateTable,
} from '@sax/payroll';

const bundled = loadBundledPackage();
const nontax = bundled.tables.find((t) => t.id === 'nontax-2026')! as RateTable<'nontax_limits'>;
const D = 'a'.repeat(64);

/** 저장소 흉내: installPackage는 한 번에 다 넣거나 code를 던진다 */
function memStore(fail?: unknown): RateTableStore & { rows: StoredRateTable[] } {
  let installed: { version: string; digest: string } | null = null;
  const rows: StoredRateTable[] = [];
  return {
    rows,
    installedPackage: () => installed,
    installPackage(pkg, rs) {
      if (fail) throw fail;
      rows.push(...rs);
      installed = { version: pkg.version, digest: pkg.digest };
      return { added: rs.map((r) => r.id), closed: [], unchanged: [] };
    },
  };
}
const loaded = (body: unknown, d: Partial<{ id: string; version: string; schema: string }> = {}): DataLoadResultLike => ({
  ok: true,
  data: { descriptor: { id: RATE_TABLES_PACKAGE_ID, version: (body as RateTablePackage).packageVersion, schema: RATE_TABLES_SCHEMA, ...d }, digest: D, body },
});
const pkgOf = (tables: RateTable[], packageVersion = '2027.1.0'): RateTablePackage => ({ schema: 'sax.rate-tables/v1', packageVersion, tables });

describe('서명 배포 시행일 표(M6-10)', () => {
  it('엔진 ctx.schemas는 sax.rate-tables/v1 → validatePackage 하나', () => {
    assert.deepEqual([...RATE_TABLE_SCHEMAS.keys()], ['sax.rate-tables/v1']);
    assert.equal(RATE_TABLE_SCHEMAS.get('sax.rate-tables/v1'), validatePackage);
  });

  it('행 변환: 끝날은 컬럼에만, 왕복하면 같은 표, 컬럼과 body가 다르면 버림', () => {
    const s = toStoredTable(nontax, '2026.11.1');
    assert.equal(s.effectiveTo, null);
    assert.ok(!('effectiveTo' in (s.body as object)), 'body에는 끝날 없음(닫는 재설치가 내용 비교에 걸리지 않게)');
    assert.deepEqual(fromStoredTable(s), nontax);
    assert.deepEqual(fromStoredTable({ ...s, effectiveTo: '2026-12-31' }), { ...nontax, effectiveTo: '2026-12-31' }, '닫힌 끝은 컬럼 값');
    assert.equal(fromStoredTable({ ...s, kind: 'insurance_rate' }), null);
    assert.equal(fromStoredTable({ ...s, signatureOk: false }), null);
    assert.equal(fromStoredTable({ ...s, body: null }), null);
  });

  it('반영: 받으면 저장소에 넣고, 엔진 실패·다른 패키지·본문 위반·판 불일치·저장소 거부면 아무것도 안 넣고 kept를 알림', () => {
    const next: RateTable<'nontax_limits'> = { ...nontax, id: 'nontax-2027', effectiveFrom: '2027-01-01' };
    const st = memStore();
    const ok = applyRateTableUpdate(st, loaded(pkgOf([next])));
    assert.deepEqual(ok, { ok: true, packageVersion: '2027.1.0', added: ['nontax-2027'], closed: [], unchanged: [] });
    assert.deepEqual(st.rows.map((r) => r.id), ['nontax-2027']);

    assert.deepEqual(applyRateTableUpdate(st, { ok: false, code: 'registry.signature_insufficient' }), { ok: false, code: 'registry.signature_insufficient', kept: { version: '2027.1.0', digest: D } });
    assert.equal(applyRateTableUpdate(st, loaded(pkgOf([next]), { id: 'payroll.other' })).ok, false);
    assert.deepEqual(applyRateTableUpdate(memStore(), loaded(pkgOf([next]), { schema: 'sax.other/v1' })), { ok: false, code: 'rate_tables.wrong_package', kept: null });
    assert.equal((applyRateTableUpdate(memStore(), loaded(pkgOf([next, { ...next, id: 'dup' }]))) as { code: string }).code, 'rate_tables.body_invalid', '겹침');
    assert.equal((applyRateTableUpdate(memStore(), loaded(pkgOf([next]), { version: '2027.2.0' })) as { code: string }).code, 'rate_tables.version_mismatch');
    const refused = memStore(Object.assign(new Error('x'), { code: 'rate_table_id_reused' }));
    assert.deepEqual(applyRateTableUpdate(refused, loaded(pkgOf([next]))), { ok: false, code: 'rate_tables.rate_table_id_reused', kept: null });
    assert.deepEqual(refused.rows, []);
    assert.throws(() => applyRateTableUpdate(memStore(new Error('disk')), loaded(pkgOf([next]))), /disk/, '코드 없는 오류는 숨기지 않는다');
  });

  it('계산에 쓸 표: 저장소 표가 먼저, 기본 표는 같은 id가 없고 기간이 안 겹칠 때만', () => {
    const ids = (ts: RateTable[]) => ts.map((t) => t.id).sort();
    assert.deepEqual(ids(availableTables([], bundled)), ids(bundled.tables), '설치본 없으면 기본 표 그대로');

    const changed = toStoredTable({ ...nontax, body: { kinds: { ...nontax.body.kinds, meal: { ...nontax.body.kinds.meal, monthlyLimit: 250_000 } } } }, '2026.12.0');
    const a = availableTables([changed], bundled);
    assert.equal(a.filter((t) => t.id === 'nontax-2026').length, 1, '같은 id는 저장소 것');
    const T = pickTables(a, { taxDate: '2026-11-10', insuranceDate: '2026-11-01' });
    assert.equal(T.nontax.body.kinds.meal.monthlyLimit, 250_000);

    const t2027 = toStoredTable({ ...nontax, id: 'nontax-2027', effectiveFrom: '2027-01-01' }, '2027.1.0');
    const b = availableTables([t2027], bundled);
    assert.ok(ids(b).includes('nontax-2026') && ids(b).includes('nontax-2027'), '뒤 기간만 실은 판: 앞 기간은 기본 표');
    assert.equal(pickTables(b, { taxDate: '2026-11-10', insuranceDate: '2026-11-01' }).nontax.id, 'nontax-2026');
    assert.equal(pickTables(b, { taxDate: '2027-03-10', insuranceDate: '2027-03-01' }).nontax.id, 'nontax-2027');

    const sameStart = toStoredTable({ ...nontax, id: 'nontax-2026-r2' }, '2026.12.0');
    assert.ok(!ids(availableTables([sameStart], bundled)).includes('nontax-2026'), '시작일이 같은 기본 표는 뺀다(ambiguous 방지)');
  });
});
