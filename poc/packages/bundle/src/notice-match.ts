// S-06 4대보험 고지내역 → 직원 매칭(데이터 트랙, docparse #78 제안·팀장 전달 2026-11-05).
// docparse는 읽기만 하고 매칭하지 않는다. 입력·출력 형식은 @sax/docparse의 InsuranceNoticeMatchInput·InsuranceNoticeMatch 그대로다.
// 타입은 여기서 같은 모양으로 다시 적는다. 엔진이 이 패키지를 가져오는데 docparse가 엔진을 가져와서, 직접 가져오면 의존이 돌기 때문이다.
// 두 모양이 같은지는 tests/payroll-commands.test.ts가 타입으로 확인한다.
// 판정이 아니라 후보 제시다: 사장님이 확인 카드에서 고른다. 주민번호는 쓰지 않는다(이름·생년월일만, 직원 주민번호를 복호화하지 않는다).
import { EmployeeRepo, type ColumnCipher, type Db } from '@sax/db';
import type { NoticeAmounts } from '@sax/payroll';
import { BundleError } from './items.ts';

/** @sax/docparse InsuranceKind와 같다 */
export type InsuranceKind = 'pension' | 'health' | 'ltc' | 'employment' | 'industrial';

/** @sax/docparse InsuranceNoticeMatchInput과 같다(docparse insurance_notice 결과를 담는 S-06 매칭 입력) */
export interface InsuranceNoticeMatchInput {
  profileId: string;
  /** 고지 년월. 사장님이 확인 카드에서 고친 값 */
  month: string;
  /** 고지내역 원본 documents.id(payroll_months.notice_doc_ids_json에 들어갈 값) */
  noticeDocId: string;
  rows: Array<{
    rowId: string;
    name: string;
    birthDate: string | null;
    insurance: InsuranceKind;
    base: number | null;
    total: number | null;
    employee: number | null;
    employer: number | null;
  }>;
}

/** @sax/docparse InsuranceNoticeMatch와 같다 */
export interface InsuranceNoticeMatch {
  rowId: string;
  employeeId: string | null;
  /** name_birth: 이름·생년월일 일치, name_only: 이름만(생년월일 없음), ambiguous: 후보 여럿, none: 없음 */
  basis: 'name_birth' | 'name_only' | 'ambiguous' | 'none';
  candidates?: string[];
}

/** 이름 비교: 앞뒤·가운데 공백을 지우고 NFC로 맞춘다(고지내역은 '홍 길동'처럼 띄어 쓴 경우가 있다) */
const normName = (s: string): string => s.normalize('NFC').replace(/\s+/g, '');
/** 후보 id는 정렬해 늘 같은 순서로 낸다(입사일이 같으면 목록 순서가 정해지지 않는다) */
const ids = (es: readonly { id: string }[]): string[] => es.map((e) => e.id).sort();

/**
 * 고지 행마다 그 달 재직 직원 중 후보를 찾는다.
 * - name_birth: 이름과 생년월일이 같은 직원이 정확히 한 명
 * - name_only: 행에 생년월일이 없고 이름이 같은 직원이 정확히 한 명
 * - ambiguous: 후보가 둘 이상(candidates에 직원 id)
 * - none: 후보 없음. 이름은 같은데 생년월일이 다르면 candidates에 그 직원들을 넣어 확인 카드가 보여 줄 수 있게 한다
 * 같은 사람의 보험 종류별 행(rowId가 다름)은 각각 같은 직원으로 맞는다.
 */
export function matchInsuranceNotice(db: Db, cipher: ColumnCipher, input: InsuranceNoticeMatchInput): InsuranceNoticeMatch[] {
  const employees = new EmployeeRepo(db, cipher).list(input.profileId, { activeInMonth: input.month });
  return input.rows.map((row): InsuranceNoticeMatch => {
    const byName = employees.filter((e) => normName(e.name) === normName(row.name));
    if (row.birthDate) {
      const exact = byName.filter((e) => e.birthDate === row.birthDate);
      if (exact.length === 1) return { rowId: row.rowId, employeeId: exact[0]!.id, basis: 'name_birth' };
      if (exact.length > 1) return { rowId: row.rowId, employeeId: null, basis: 'ambiguous', candidates: ids(exact) };
      return { rowId: row.rowId, employeeId: null, basis: 'none', ...(byName.length ? { candidates: ids(byName) } : {}) };
    }
    if (byName.length === 1) return { rowId: row.rowId, employeeId: byName[0]!.id, basis: 'name_only' };
    if (byName.length > 1) return { rowId: row.rowId, employeeId: null, basis: 'ambiguous', candidates: ids(byName) };
    return { rowId: row.rowId, employeeId: null, basis: 'none' };
  });
}

// ── S-06 확인 카드(데스크톱이 그리는 데이터). 문구는 데스크톱이 갖는다 ──────────────────────────

/** 카드에 보이는 직원 한 명(그 달 재직) */
export interface NoticeCardEmployee {
  employeeId: string;
  name: string;
  birthDate: string;
  hiredOn: string;
}

/** 고지내역의 한 사람(같은 이름·생년월일의 보험별 행을 묶음) */
export interface NoticeCardPerson {
  /** 묶음 키(정규화한 이름|생년월일). 사장님 선택을 이 키로 돌려받는다 */
  key: string;
  name: string;
  birthDate: string | null;
  rowIds: string[];
  /** 자동으로 맞은 직원(name_birth·name_only). 아니면 null */
  employeeId: string | null;
  basis: InsuranceNoticeMatch['basis'];
  /** 고를 후보(ambiguous·none). 없으면 빈 배열이고 화면은 재직 직원 전체(card.employees)에서 고르게 한다 */
  candidates: NoticeCardEmployee[];
  /** 근로자 부담 고지액(computePayroll의 notices). 산재는 사업주 부담뿐이라 넣지 않는다 */
  notices: Partial<NoticeAmounts>;
  /** 같은 보험이 두 번 나온 종류(동명이인이 생년월일 없이 섞인 경우). 그 종류 금액은 notices에 넣지 않는다 */
  conflicts: InsuranceKind[];
  /** 사장님이 골라야 한다: name_birth가 아니거나 conflicts가 있다(name_only도 확인을 받는다) */
  needsChoice: boolean;
}

export interface NoticeCard {
  month: string;
  noticeDocId: string;
  people: NoticeCardPerson[];
  /** 그 달 재직 직원 전체(고르기 목록) */
  employees: NoticeCardEmployee[];
  /** 그 달 재직인데 고지내역에 자동으로 맞은 행이 없는 직원(입사 직후 미가입 등. 판정하지 않고 보여 주기만) */
  notOnNotice: NoticeCardEmployee[];
  needsChoice: number;
}

const NOTICE_KINDS = ['pension', 'health', 'ltc', 'employment'] as const satisfies readonly (keyof NoticeAmounts)[];

/** 고지내역 결과 → S-06 확인 카드. 매칭은 matchInsuranceNotice와 같다(후보 제시, 판정 아님) */
export function noticeConfirmCard(db: Db, cipher: ColumnCipher, input: InsuranceNoticeMatchInput): NoticeCard {
  const list = new EmployeeRepo(db, cipher).list(input.profileId, { activeInMonth: input.month });
  const employees = list.map((e): NoticeCardEmployee => ({ employeeId: e.id, name: e.name, birthDate: e.birthDate, hiredOn: e.hiredOn }));
  const byId = new Map(employees.map((e) => [e.employeeId, e]));
  const matches = new Map(matchInsuranceNotice(db, cipher, input).map((m) => [m.rowId, m]));
  const groups = new Map<string, NoticeCardPerson>();
  for (const row of input.rows) {
    const key = `${normName(row.name)}|${row.birthDate ?? ''}`;
    const m = matches.get(row.rowId)!;
    let p = groups.get(key);
    if (!p) {
      p = { key, name: row.name.trim(), birthDate: row.birthDate, rowIds: [], employeeId: m.employeeId, basis: m.basis, candidates: (m.candidates ?? []).map((id) => byId.get(id)!), notices: {}, conflicts: [], needsChoice: false };
      groups.set(key, p);
    }
    p.rowIds.push(row.rowId);
    const kind = row.insurance;
    if (kind === 'industrial') continue;
    if (p.conflicts.includes(kind)) continue;
    if (kind in p.notices) {
      p.conflicts.push(kind);
      delete p.notices[kind];
    } else if (row.employee !== null) p.notices[kind] = row.employee;
  }
  const people = [...groups.values()];
  for (const p of people) {
    p.notices = Object.fromEntries(NOTICE_KINDS.filter((k) => k in p.notices).map((k) => [k, p.notices[k]])) as Partial<NoticeAmounts>;
    p.needsChoice = p.basis !== 'name_birth' || p.conflicts.length > 0;
  }
  const matched = new Set(people.map((p) => p.employeeId).filter((id): id is string => id !== null));
  return {
    month: input.month,
    noticeDocId: input.noticeDocId,
    people,
    employees,
    notOnNotice: employees.filter((e) => !matched.has(e.employeeId)),
    needsChoice: people.filter((p) => p.needsChoice).length,
  };
}

/**
 * 사장님이 카드에서 정한 결과 → 직원별 고지액(computePayroll notices). choices: 사람 key → 직원 id(고치거나 고름) 또는 null(이 사람은 건너뜀).
 * choices에 없는 사람은 자동 매칭을 따른다(needsChoice인 사람은 choices가 있어야 한다). 한 직원에 두 사람을 붙이면 거부.
 */
export function confirmNoticeCard(card: NoticeCard, choices: Readonly<Record<string, string | null>>): Map<string, Partial<NoticeAmounts>> {
  const active = new Set(card.employees.map((e) => e.employeeId));
  const out = new Map<string, Partial<NoticeAmounts>>();
  for (const k of Object.keys(choices)) if (!card.people.some((p) => p.key === k)) throw new BundleError('notice_unknown_person');
  for (const p of card.people) {
    const chosen = Object.hasOwn(choices, p.key) ? choices[p.key]! : p.needsChoice ? undefined : p.employeeId;
    if (chosen === undefined) throw new BundleError('notice_choice_needed');
    if (chosen === null) continue;
    if (!active.has(chosen)) throw new BundleError('notice_employee_not_active');
    if (out.has(chosen)) throw new BundleError('notice_employee_twice');
    out.set(chosen, p.notices);
  }
  return out;
}
