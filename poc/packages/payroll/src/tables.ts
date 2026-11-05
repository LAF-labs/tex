// 시행일 단위 표(ADR-031 결정 5, D07 rate_tables, D14 M6-10). 표는 코드에 박지 않고 데이터 패키지로 받는다.
// 형태는 schema/rate-table-package.schema.json 이 정본이고, 여기 타입은 그 모양을 그대로 옮긴 것이다.
// 요율은 백만분율(ppm, 1% = 10,000), 금액은 원 단위 정수.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import type { ValidateFunction } from 'ajv';
import type { Rounding } from './money.ts';

export type TableKind = 'insurance_rate' | 'pension_bounds' | 'simple_tax_table' | 'nontax_limits';

/** 출처와 검수 상태. needs_review는 공식 원문 대조가 끝나지 않은 표다(화면에 "검수 필요"로 보인다) */
export interface TableMeta {
  id: string;
  kind: TableKind;
  /** 포함 시작일 'YYYY-MM-DD' */
  effectiveFrom: string;
  /** 포함 끝날. null이면 다음 표가 나올 때까지 */
  effectiveTo: string | null;
  /** 이 표의 최종 금액 끝처리 */
  rounding: Rounding;
  review: 'confirmed' | 'needs_review';
  sources: Array<{ title: string; url: string }>;
  note?: string;
}

/** 근로소득 간이세액표(소득세법 시행령 별표 2) */
export interface SimpleTaxBody {
  /** [이상(원), 미만(원), 가족 1명 세액, …, 가족 11명 세액]. 월급여액은 비과세·학자금 제외. 마지막 행은 표 끝값(over.top) 한 점 */
  rows: Array<[number, number, ...number[]]>;
  /** 표 끝(예: 10,000천원)을 넘는 월급여: 끝값 세액 + addWon + (월급여 − above) × num/den. 위 구간부터 찾는다 */
  over: { top: number; brackets: Array<{ above: number; addWon: number; num: number; den: number }> };
  /** 8세 이상 20세 이하 자녀 공제: amounts[n]은 자녀 n명 공제액, 배열 끝을 넘으면 마지막 값 + extraPerChild × 넘은 수 */
  children: { amounts: number[]; extraPerChild: number };
  /** 공제대상가족 11명 초과: 11명 세액 − (10명 세액 − 11명 세액) × 초과 인원(0 미만이면 0) */
  familyOver11: 'extrapolate_10_11';
}

export interface InsuranceBody {
  pension: { employeePpm: number; employerPpm: number; rounding: Rounding };
  health: { employeePpm: number; employerPpm: number; rounding: Rounding; minBase?: number; maxBase?: number };
  /** 장기요양보험료 = 건강보험료 × (장기요양보험료율 ÷ 건강보험료율) */
  ltc: { ratePpm: number; healthRatePpm: number; rounding: Rounding };
  employment: {
    employeePpm: number;
    employerUnemploymentPpm: number;
    /** 고용안정·직업능력개발(사업주만). 규모 구간 코드 → ppm */
    employerStabilityPpm: Record<EmployerSizeBand, number>;
    rounding: Rounding;
  };
}

export type EmployerSizeBand = 'under150' | 'priority150plus' | 'from150to999' | 'over1000';

export interface PensionBoundsBody {
  /** 기준소득월액 하한·상한(원) */
  minBase: number;
  maxBase: number;
  /** 기준소득월액 끝처리(천원 미만 절사 = floor_1000) */
  baseRounding: Rounding;
}

export type NontaxKind = 'meal' | 'vehicle' | 'childcare' | 'research';

export interface NontaxLimitsBody {
  kinds: Partial<Record<NontaxKind, { label: string; monthlyLimit: number; basis: string }>>;
}

export type TableBody<K extends TableKind> = K extends 'simple_tax_table'
  ? SimpleTaxBody
  : K extends 'insurance_rate'
    ? InsuranceBody
    : K extends 'pension_bounds'
      ? PensionBoundsBody
      : NontaxLimitsBody;

export type RateTable<K extends TableKind = TableKind> = TableMeta & { kind: K; body: TableBody<K> };

export interface RateTablePackage {
  schema: 'sax.rate-tables/v1';
  packageVersion: string;
  tables: RateTable[];
}

/** 계산에 쓰는 표 묶음. 급여대장의 rate_table_ids_json으로 남긴다(재현용) */
export interface TableSet {
  simpleTax: RateTable<'simple_tax_table'>;
  insurance: RateTable<'insurance_rate'>;
  pensionBounds: RateTable<'pension_bounds'>;
  nontax: RateTable<'nontax_limits'>;
}

export const tableIds = (t: TableSet): string[] => [t.simpleTax.id, t.insurance.id, t.pensionBounds.id, t.nontax.id];

export class TableError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

let validator: ValidateFunction | null = null;
function schemaValidator(): ValidateFunction {
  if (validator) return validator;
  const s = JSON.parse(fs.readFileSync(new URL('../schema/rate-table-package.schema.json', import.meta.url), 'utf8')) as object;
  const Ajv2020 = createRequire(import.meta.url)('ajv/dist/2020') as typeof import('ajv').default;
  validator = new Ajv2020({ allErrors: true, strict: false }).compile(s);
  return validator;
}

const overlaps = (a: TableMeta, b: TableMeta): boolean => a.effectiveFrom <= (b.effectiveTo ?? '9999-12-31') && b.effectiveFrom <= (a.effectiveTo ?? '9999-12-31');

/**
 * 패키지 검증(서명 검증은 레지스트리 채널이 먼저 한다, D14 M6-10). 스키마 + 의미 규칙:
 * id 중복, 같은 종류의 기간 겹침, 간이세액표 행이 빈틈없이 오름차순인지·가족 수 11칸인지·가족이 늘면 세액이 늘지 않는지, 상·하한 순서.
 * 위반 목록(코드)을 돌려준다. 빈 배열이면 통과.
 */
export function validatePackage(pkg: unknown): string[] {
  const v = schemaValidator();
  if (!v(pkg)) return (v.errors ?? []).map((e) => `schema:${e.instancePath || '/'}:${e.keyword}`);
  const p = pkg as RateTablePackage;
  const bad: string[] = [];
  const ids = new Set<string>();
  for (const t of p.tables) {
    if (ids.has(t.id)) bad.push(`duplicate_id:${t.id}`);
    ids.add(t.id);
    if (t.effectiveTo !== null && t.effectiveTo < t.effectiveFrom) bad.push(`range:${t.id}`);
  }
  for (const [i, a] of p.tables.entries()) for (const b of p.tables.slice(i + 1)) if (a.kind === b.kind && overlaps(a, b)) bad.push(`overlap:${a.id}:${b.id}`);
  for (const t of p.tables) {
    if (t.kind === 'simple_tax_table') bad.push(...checkSimpleTax(t as RateTable<'simple_tax_table'>));
    if (t.kind === 'pension_bounds') {
      const b = (t as RateTable<'pension_bounds'>).body;
      if (b.minBase >= b.maxBase) bad.push(`pension_bounds_order:${t.id}`);
    }
  }
  return bad;
}

function checkSimpleTax(t: RateTable<'simple_tax_table'>): string[] {
  const bad: string[] = [];
  const rows = t.body.rows;
  if (!rows.length || rows[0]![0] !== 0) bad.push(`simple_tax_start:${t.id}`);
  rows.forEach((r, i) => {
    if (r.length !== 13) bad.push(`simple_tax_width:${t.id}:${i}`);
    if (r[0] >= r[1]) bad.push(`simple_tax_row_range:${t.id}:${i}`);
    if (i > 0 && rows[i - 1]![1] !== r[0]) bad.push(`simple_tax_gap:${t.id}:${i}`);
    for (let f = 3; f < r.length; f++) if (r[f]! > r[f - 1]!) bad.push(`simple_tax_family_order:${t.id}:${i}`);
    if (i > 0) for (let f = 2; f < r.length; f++) if (r[f]! < rows[i - 1]![f]!) bad.push(`simple_tax_pay_order:${t.id}:${i}`);
  });
  const last = rows[rows.length - 1];
  // 마지막 행은 표 끝값 한 점(예: 10,000천원)이고 over.top과 같아야 한다
  if (last && t.body.over.top !== last[0]) bad.push(`simple_tax_top:${t.id}`);
  const br = t.body.over.brackets;
  for (let i = 1; i < br.length; i++) if (br[i]!.above <= br[i - 1]!.above) bad.push(`simple_tax_over_order:${t.id}`);
  return bad;
}

/** 패키지에서 그날 시행 중인 표를 고른다. 간이세액표는 지급일, 보험·상하한·비과세는 귀속 달의 1일 기준 */
export function pickTables(tables: readonly RateTable[], at: { taxDate: string; insuranceDate: string }): TableSet {
  const pick = <K extends TableKind>(kind: K, day: string): RateTable<K> => {
    const hits = tables.filter((t) => t.kind === kind && t.effectiveFrom <= day && (t.effectiveTo === null || t.effectiveTo >= day));
    if (hits.length !== 1) throw new TableError(hits.length ? `rate_table_ambiguous:${kind}` : `rate_table_missing:${kind}`);
    return hits[0] as RateTable<K>;
  };
  return {
    simpleTax: pick('simple_tax_table', at.taxDate),
    insurance: pick('insurance_rate', at.insuranceDate),
    pensionBounds: pick('pension_bounds', at.insuranceDate),
    nontax: pick('nontax_limits', at.insuranceDate),
  };
}

/** 앱에 같이 싣는 기본 패키지(data/). 서명 배포 패키지가 설치되면 그것을 우선한다(레지스트리 채널, 클라우드 트랙) */
export function loadBundledPackage(): RateTablePackage {
  const p = JSON.parse(fs.readFileSync(new URL('../data/rate-tables.json', import.meta.url), 'utf8')) as unknown;
  const bad = validatePackage(p);
  if (bad.length) throw new TableError(`bundled_package_invalid:${bad.slice(0, 3).join(',')}`);
  return p as RateTablePackage;
}
