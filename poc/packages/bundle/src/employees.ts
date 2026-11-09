// 급여대장 화면(08 D-06, D14 M6-9)의 직원 입력·"지난달과 같나요?"·급여 기능 켜기. 엔진 BundleService가 부른다.
// 직원 정보는 처음 한 번 넣는다(생년월일 따로, 주민번호는 선택이고 DB 키로 암호화한 rrn_enc에만, ADR-031). 결과에 주민번호 원문을 담지 않는다(가림값만).
// 직원을 지우는 명령은 없다: 임금대장은 3년 보관이라 퇴사는 leftOn으로만 적는다(확인한 달의 줄이 그 직원을 가리킨다).
// 모델을 부르지 않는다. 로그를 남기지 않는다(급여·개인정보 값이 섞이지 않게).
import { EmployeeRepo, PayrollRepo, type ColumnCipher, type Db, type Employee, type EmployeeInput, type EmployeePatch, type PayItem } from '@sax/db';
import type { ExtraItem } from '@sax/payroll';

export class EmployeeInputError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

const fail = (code: string): never => {
  throw new EmployeeInputError(code);
};

/** 비과세 항목 이름(@sax/payroll NontaxKind와 같다). 다른 이름은 계산 때가 아니라 입력 때 막는다 */
export const NONTAX_KINDS = ['meal', 'vehicle', 'childcare', 'research'] as const;

/** 받는 칸. 이 밖의 칸은 bad_employee_field(main이 엉뚱한 칸을 섞어 보내도 조용히 넘기지 않는다) */
const FIELDS = [
  'name', 'birthDate', 'rrn', 'hiredOn', 'leftOn', 'job', 'payType', 'basePay', 'nontax', 'dependents', 'children8to20', 'withholdingPct',
  'pensionApplies', 'healthApplies', 'employmentApplies', 'pensionBase', 'healthBase',
] as const;
type Field = (typeof FIELDS)[number];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, code: string, max: number): string => (typeof v === 'string' && v.length <= max ? v : fail(code));
const nullableStr = (v: unknown, code: string, max: number): string | null => (v === null ? null : str(v, code, max));
const num = (v: unknown, code: string): number => (typeof v === 'number' ? v : fail(code));
const nullableNum = (v: unknown, code: string): number | null => (v === null ? null : num(v, code));
const bool = (v: unknown, code: string): boolean => (typeof v === 'boolean' ? v : fail(code));

/** 칸 모양만 본다(문자열·숫자·참거짓). 범위·날짜·주민번호 형식은 EmployeeRepo가 본다(invalid_*, rrn_birth_mismatch) */
function field(k: Field, v: unknown): unknown {
  switch (k) {
    case 'name':
      return str(v, 'name_required', 50);
    case 'birthDate':
      return str(v, 'invalid_birth_date', 10);
    case 'hiredOn':
      return str(v, 'invalid_hired_on', 10);
    case 'leftOn':
      return nullableStr(v, 'invalid_left_on', 10);
    case 'rrn':
      return nullableStr(v, 'invalid_rrn', 20);
    case 'job':
      return nullableStr(v, 'bad_job', 50);
    case 'payType':
      return v === 'monthly' || v === 'hourly' ? v : fail('invalid_pay_type');
    case 'basePay':
      return num(v, 'invalid_base_pay');
    case 'dependents':
      return num(v, 'invalid_dependents');
    case 'children8to20':
      return num(v, 'invalid_children_8_20');
    case 'withholdingPct':
      return num(v, 'invalid_withholding_pct');
    case 'pensionBase':
      return nullableNum(v, 'invalid_pension_base');
    case 'healthBase':
      return nullableNum(v, 'invalid_health_base');
    case 'pensionApplies':
    case 'healthApplies':
    case 'employmentApplies':
      return bool(v, `bad_${k}`);
    case 'nontax': {
      if (!isObj(v)) return fail('invalid_nontax');
      for (const [kind, amount] of Object.entries(v)) if (!(NONTAX_KINDS as readonly string[]).includes(kind) || typeof amount !== 'number') return fail('invalid_nontax');
      return v;
    }
  }
}

function fields(v: unknown): Partial<Record<Field, unknown>> {
  if (!isObj(v)) return fail('bad_employee');
  const out: Partial<Record<Field, unknown>> = {};
  for (const [k, x] of Object.entries(v)) {
    if (!(FIELDS as readonly string[]).includes(k)) return fail('bad_employee_field');
    if (x === undefined) continue;
    out[k as Field] = field(k as Field, x);
  }
  return out;
}

/** payroll.addEmployee의 employee. 꼭 있어야 하는 칸은 이름·생년월일·입사일·기본급·공제대상가족 수다 */
export function employeeInput(profileId: string, v: unknown): EmployeeInput {
  const f = fields(v);
  for (const [k, code] of [['name', 'name_required'], ['birthDate', 'invalid_birth_date'], ['hiredOn', 'invalid_hired_on'], ['basePay', 'invalid_base_pay'], ['dependents', 'invalid_dependents']] as const) {
    if (f[k] === undefined) fail(code);
  }
  return { ...(f as Omit<EmployeeInput, 'profileId'>), profileId };
}

/** payroll.updateEmployee의 patch. 바뀐 칸만. rrn: null은 지움 */
export function employeePatch(v: unknown): EmployeePatch {
  const f = fields(v);
  if (Object.keys(f).length === 0) fail('bad_employee');
  return f as EmployeePatch;
}

/** 화면에 주는 직원: 주민번호는 가림값만(revealRrn 결과를 담지 않는다) */
export type EmployeeView = Employee & { maskedRrn: string | null };

export const employeeView = (repo: EmployeeRepo, e: Employee): EmployeeView => ({ ...e, maskedRrn: e.hasRrn ? repo.maskedRrn(e.id) : null });

/** 그 프로필의 직원(다른 프로필 id면 employee_not_found) */
export function ownEmployee(repo: EmployeeRepo, profileId: string, employeeId: unknown): Employee {
  const e = typeof employeeId === 'string' && employeeId.length <= 64 ? repo.get(employeeId) : null;
  return e && e.profileId === profileId ? e : fail('employee_not_found');
}

const prevMonth = (m: string): string => {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`;
};

/**
 * 저장된 줄에서 이달 입력(extras)을 되살린다. 계산기는 항목을 기본급 → 과세 수당·차감(extras) → 비과세(한도 초과분 포함) 순으로 쌓는다.
 * 그래서 기본급 다음부터 첫 비과세 항목 앞까지가 extras다. 비과세는 직원 설정에서 다시 나오므로 넘기지 않는다.
 */
export function extrasFromItems(items: readonly PayItem[]): ExtraItem[] {
  const out: ExtraItem[] = [];
  for (const i of items.slice(1)) {
    if (!i.taxable) break;
    out.push({ name: i.name, amount: i.amount, calc: i.calc });
  }
  return out;
}

export interface CarryOver {
  month: string;
  /** 지난달 가장 큰 개정. 없으면 null(처음 쓰는 달) */
  from: { month: string; revision: number; status: 'draft' | 'confirmed' } | null;
  /** payroll.compute·saveDraft의 inputs로 그대로 넣을 수 있다. 이달 재직이고 지난달 줄이 있는 직원만 */
  inputs: Record<string, { extras: ExtraItem[] }>;
  /** 이달 재직인데 지난달 줄이 없는 직원(새로 들어옴): 이번 달 입력을 따로 받는다 */
  newEmployees: Array<{ id: string; name: string }>;
  /** 지난달 줄은 있는데 이달 재직이 아닌 직원(퇴사): 보여 주기만 */
  leftEmployees: Array<{ id: string; name: string }>;
}

/**
 * "지난달과 같나요?"(08 D-06): 지난달 가장 큰 개정의 과세 수당·차감을 이달 입력으로 내준다. 읽기만 한다(DB에 쓰지 않음).
 * 근로일수·근로시간·고지액은 넘기지 않는다: 달마다 다르고, 시급제 시간은 근무표에서, 고지액은 S-06에서 온다.
 */
export function carryOver(db: Db, cipher: ColumnCipher, profileId: string, month: string): CarryOver {
  const pr = new PayrollRepo(db);
  const emps = new EmployeeRepo(db, cipher);
  const from = prevMonth(month);
  const last = pr.revisions(profileId, from).at(-1) ?? null;
  const lines = last ? pr.lines(profileId, from, last.revision) : [];
  const active = emps.list(profileId, { activeInMonth: month });
  const activeIds = new Set(active.map((e) => e.id));
  const byId = new Map(lines.map((l) => [l.employeeId, l]));
  const inputs: CarryOver['inputs'] = {};
  const newEmployees: CarryOver['newEmployees'] = [];
  for (const e of active) {
    const l = byId.get(e.id);
    if (l) inputs[e.id] = { extras: extrasFromItems(l.items) };
    else newEmployees.push({ id: e.id, name: e.name });
  }
  const leftEmployees = lines.filter((l) => !activeIds.has(l.employeeId)).map((l) => ({ id: l.employeeId, name: emps.get(l.employeeId)?.name ?? '' }));
  return { month, from: last ? { month: from, revision: last.revision, status: last.status } : null, inputs, newEmployees, leftEmployees };
}
