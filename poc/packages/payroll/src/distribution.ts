// 서명 배포 시행일 표 → 표 저장소(D14 M6-10, SIGNING.md §6 kind:"data"). 순수 TS: DB·엔진을 가져오지 않고 모양(구조 타입)만 맞춘다.
// 흐름(부르는 쪽, 업데이트 채널):
//   const installed = repo.installedPackage(RATE_TABLES_PACKAGE_ID);
//   const r = core.loadDataPackage(raw, { roots, revoked, now, hold, schemas: RATE_TABLE_SCHEMAS, installed });   // 서명 2-of-3·다이제스트·validatePackage·버전
//   const u = applyRateTableUpdate(repo, r);   // 실패면 저장소는 그대로, 계산은 기존 표로 계속(rate_table_missing으로 바뀌지 않는다)
//   const tables = availableTables(repo.list(), loadBundledPackage());   // pickTables에 넘긴다
import { tableSpansOverlap, validatePackage, type RateTable, type RateTablePackage, type TableMeta } from './tables.ts';

export const RATE_TABLES_SCHEMA = 'sax.rate-tables/v1';
/** 레지스트리 인덱스의 데이터 패키지 id */
export const RATE_TABLES_PACKAGE_ID = 'payroll.rate-tables';
/** 엔진 loadDataPackage의 ctx.schemas: 이 이름만 받는다(fail-closed) */
export const RATE_TABLE_SCHEMAS: ReadonlyMap<string, (body: unknown) => string[]> = new Map([[RATE_TABLES_SCHEMA, validatePackage]]);

/** @sax/db RateTableRow와 같은 모양 */
export interface StoredRateTable {
  id: string;
  kind: TableMeta['kind'];
  effectiveFrom: string;
  effectiveTo: string | null;
  body: unknown;
  rounding: string;
  packageVersion: string;
  signatureOk: boolean;
}

/** @sax/db RateTableRepo가 맞추는 모양 */
export interface RateTableStore {
  installedPackage(packageId: string): { version: string; digest: string } | null;
  installPackage(pkg: { id: string; version: string; digest: string }, rows: readonly StoredRateTable[]): { added: string[]; closed: string[]; unchanged: string[] };
}

/** 엔진 DataLoadResult와 같은 모양(필요한 칸만) */
export type DataLoadResultLike =
  | { ok: true; data: { descriptor: { id: string; version: string; schema: string }; digest: string; body: unknown } }
  | { ok: false; code: string };

export type RateTableUpdate =
  | { ok: true; packageVersion: string; added: string[]; closed: string[]; unchanged: string[] }
  /** 기존 표·설치 기록은 그대로다. kept = 계속 쓰는 설치본(없으면 null, 기본 표만 씀) */
  | { ok: false; code: string; kept: { version: string; digest: string } | null };

/**
 * 표 한 장을 저장소 행으로. body에는 시행 끝날을 뺀 표 전체(출처·검수 상태 포함)를 넣는다.
 * 끝날은 컬럼에만 둔다: 다음 판이 열린 끝을 닫아도 내용 비교(rate_table_id_reused)가 걸리지 않게
 */
export function toStoredTable(t: RateTable, packageVersion: string): StoredRateTable {
  const { effectiveTo, ...rest } = t;
  return { id: t.id, kind: t.kind, effectiveFrom: t.effectiveFrom, effectiveTo, body: rest, rounding: t.rounding, packageVersion, signatureOk: true };
}

/** 저장소 행 → 계산용 표. 컬럼과 body가 다르면(손상) 버린다 */
export function fromStoredTable(r: StoredRateTable): RateTable | null {
  const b = r.body as Partial<RateTable> | null;
  if (!r.signatureOk || !b || typeof b !== 'object' || b.id !== r.id || b.kind !== r.kind || b.effectiveFrom !== r.effectiveFrom || b.rounding !== r.rounding) return null;
  return { ...b, effectiveTo: r.effectiveTo } as RateTable;
}

/**
 * 엔진이 받은 결과를 저장소에 반영한다. 엔진이 이미 서명·본문 검증(validatePackage)을 했지만 id·schema·판은 여기서 다시 본다.
 * 저장소가 거부하면(겹침·같은 id 다른 내용) 한 표도 들어가지 않는다. 실패 코드: 엔진 코드 그대로, 또는 rate_tables.<이유>
 */
export function applyRateTableUpdate(store: RateTableStore, result: DataLoadResultLike): RateTableUpdate {
  const kept = (): { version: string; digest: string } | null => {
    const k = store.installedPackage(RATE_TABLES_PACKAGE_ID);
    return k ? { version: k.version, digest: k.digest } : null;
  };
  if (!result.ok) return { ok: false, code: result.code, kept: kept() };
  const { descriptor: d, digest, body } = result.data;
  if (d.id !== RATE_TABLES_PACKAGE_ID || d.schema !== RATE_TABLES_SCHEMA) return { ok: false, code: 'rate_tables.wrong_package', kept: kept() };
  if (validatePackage(body).length) return { ok: false, code: 'rate_tables.body_invalid', kept: kept() };
  const pkg = body as RateTablePackage;
  if (pkg.packageVersion !== d.version) return { ok: false, code: 'rate_tables.version_mismatch', kept: kept() };
  try {
    const r = store.installPackage({ id: d.id, version: d.version, digest }, pkg.tables.map((t) => toStoredTable(t, pkg.packageVersion)));
    return { ok: true, packageVersion: pkg.packageVersion, ...r };
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    if (typeof code !== 'string') throw e;
    return { ok: false, code: `rate_tables.${code}`, kept: kept() };
  }
}

/**
 * 계산에 쓸 표: 저장소(서명 배포)의 표가 먼저고, 앱에 실린 기본 표는 저장소에 같은 id가 없고 같은 종류의 저장소 표와 기간이 겹치지 않을 때만 보탠다.
 * 서명 배포 판이 일부 표만 실어도 나머지 기간은 기본 표로 계속 계산된다.
 */
export function availableTables(stored: readonly StoredRateTable[], bundled: Pick<RateTablePackage, 'tables'>): RateTable[] {
  const fromStore = stored.map(fromStoredTable).filter((t): t is RateTable => t !== null);
  const ids = new Set(fromStore.map((t) => t.id));
  const extra = bundled.tables.filter((b) => !ids.has(b.id) && !fromStore.some((s) => s.kind === b.kind && tableSpansOverlap(s, b)));
  return [...fromStore, ...extra];
}
