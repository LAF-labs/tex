// S-06 4대보험 고지내역 → 직원 매칭(데이터 트랙, docparse #78 제안·팀장 전달 2026-11-05).
// docparse는 읽기만 하고 매칭하지 않는다. 입력·출력 형식은 @sax/docparse의 InsuranceNoticeMatchInput·InsuranceNoticeMatch 그대로다.
// 판정이 아니라 후보 제시다: 사장님이 확인 카드에서 고른다. 주민번호는 쓰지 않는다(이름·생년월일만, 직원 주민번호를 복호화하지 않는다).
import { EmployeeRepo, type ColumnCipher, type Db } from '@sax/db';
import type { InsuranceNoticeMatch, InsuranceNoticeMatchInput } from '@sax/docparse';

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
