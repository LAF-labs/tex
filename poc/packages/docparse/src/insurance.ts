// 4대보험 고지내역 형식 규칙(M6-5, S-06 후처리). 사장님이 사회보험 통합징수포털·EDI에서 내려받은 엑셀·CSV를 읽는다.
// 형식 근거: 공단 안내 화면에 나오는 칸 이름(성명·주민등록번호·보수월액/기준소득월액·산출(고지)보험료·근로자/사업자 부담)으로 만든
// "추정" 규칙이다(estimated=true). 보험별로 파일이 따로 오는 경우와, 한 줄에 여러 보험 칸이 있는 경우를 모두 받는다.
// 주민번호는 앞 7자리만 남긴다(생년월일 매칭용). 매칭·차이 판정은 하지 않는다(데이터 트랙, ADR-031 결정 4).
import type { Cell, SheetOutput } from './sandbox/index.ts';
import { cellText, findHeader, headText, isTotalRow, roleOf, sheetWarnings, type RoleRule } from './table.ts';
import type { Extracted, InsuranceKind, InsuranceNoticeResult, InsuranceNoticeRow, WarningCode } from './types.ts';
import { birthFromRrnFront, compact, conf, normText, parseWon } from './util.ts';

type Role = 'name' | 'rrn' | 'base' | 'total' | 'employee' | 'employer';

const ROLES: RoleRule<Role>[] = [
  { role: 'name', any: ['성명', '가입자명', '근로자명', '이름', '피보험자명'] },
  { role: 'rrn', any: ['주민등록번호', '주민번호', '생년월일'] },
  { role: 'employee', any: ['근로자부담', '가입자부담', '본인부담', '근로자분', '본인분', '피보험자부담'], multi: true },
  { role: 'employer', any: ['사업자부담', '사용자부담', '사업주부담', '사업장부담', '사업주분', '사용자분'], multi: true },
  { role: 'base', any: ['기준소득월액', '보수월액', '월평균보수', '보수총액'], multi: true },
  { role: 'total', any: ['고지보험료', '산출보험료', '산정보험료', '결정보험료', '부과보험료', '당월보험료', '보험료계', '보험료'], not: ['부담', '정산', '소급', '환급', '연체'], multi: true },
];

const KIND_WORDS: Array<[RegExp, InsuranceKind]> = [
  [/장기요양/, 'ltc'],
  [/건강/, 'health'],
  [/국민연금|연금/, 'pension'],
  [/고용/, 'employment'],
  [/산재|산업재해/, 'industrial'],
];

function kindOf(text: string): InsuranceKind | null {
  const c = compact(text);
  for (const [re, k] of KIND_WORDS) if (re.test(c)) return k;
  return null;
}

/** 고지 년월: "2026년 10월", "2026.10", "2026-10" (고지·귀속·부과 라벨 가까이 우선) */
function monthOf(text: string): Extracted<string> {
  const t = normText(text);
  // 완전한 날짜(납부기한 2026-11-10, 2026년 11월 10일)는 년월 후보가 아니다
  const re = /(20\d{2})\s*(?:년|[-./])\s*(0?[1-9]|1[0-2])(?!\d)(?!\s*[-./]\s*\d)(?!\s*월\s*\d{1,2}\s*일)\s*월?/g;
  const labeled: string[] = [];
  const any: string[] = [];
  for (let m = re.exec(t); m; m = re.exec(t)) {
    const v = `${m[1]}-${m[2]!.padStart(2, '0')}`;
    const before = t.slice(Math.max(0, m.index - 12), m.index);
    (/고지|귀속|부과|납부|청구|해당/.test(before) ? labeled : any).push(v);
  }
  const pick = (xs: string[], c: number): Extracted<string> | null => {
    const u = [...new Set(xs)];
    if (u.length === 1) return { value: u[0]!, confidence: c, reason: null };
    if (u.length > 1) return { value: null, confidence: 0, reason: 'ambiguous', candidates: u.slice(0, 6) };
    return null;
  };
  return pick(labeled, 0.85) ?? pick(any, 0.6) ?? { value: null, confidence: 0, reason: 'not_found' };
}

/** 주민번호 칸 → 앞 7자리(뒤 6자리는 버린다). 가린 번호(900101-1******)도 받는다. */
function rrnFront(c: Cell): { front7: string | null; full: boolean } {
  const s = cellText(c).replace(/\s/g, '');
  const m = /^(\d{6})-?([0-9])([0-9*]{6})$/.exec(s);
  if (m) return { front7: m[1]! + m[2]!, full: /^\d{6}$/.test(m[3]!) };
  return { front7: null, full: false };
}

/** 생년월일 칸이 따로 있을 때('1990-01-01', '900101') */
function birthOf(c: Cell): string | null {
  const s = cellText(c).replace(/\s/g, '');
  const m = /^(19|20)(\d{2})[-./]?(\d{2})[-./]?(\d{2})$/.exec(s);
  if (m) {
    const iso = `${m[1]}${m[2]}-${m[3]}-${m[4]}`;
    return Number.isNaN(Date.parse(iso)) ? null : iso;
  }
  return null;
}

export function parseInsuranceNotice(out: SheetOutput): { result: InsuranceNoticeResult | null; warnings: WarningCode[]; confidence: number } {
  const warnings = new Set<WarningCode>(sheetWarnings(out));
  warnings.add('format_estimated');
  const header = findHeader(out, ROLES, ['name']);
  if (!header || !header.columns.some((c) => c.role === 'total' || c.role === 'employee' || c.role === 'employer')) {
    warnings.add('header_not_found');
    return { result: null, warnings: [...warnings], confidence: 0 };
  }
  const head = headText(out);
  // 파일의 보험: 시트 이름, 그다음 머리글 위쪽 줄(제목). 머리글 줄 글자는 보지 않는다(여러 보험 칸이 섞여 있다)
  const title = header.sheet.rows.slice(0, header.headerRow).map((r) => r.map(cellText).join(' ')).join('\n');
  const fileKind = kindOf(header.sheet.name) ?? kindOf(title.split('\n').find((l) => l.trim()) ?? '');
  // 돈 칸마다 보험 종류: 머리글(두 줄 머리글이면 윗줄 포함)에 이름이 있으면 그것, 없으면 파일의 보험.
  // 보수월액·기준소득월액 칸에 보험 이름이 없으면 모든 보험에 같이 쓴다('*')
  const money = header.columns
    .filter((c) => c.role === 'base' || c.role === 'total' || c.role === 'employee' || c.role === 'employer')
    .map((c) => ({ ...c, kind: kindOf(c.header) ?? (c.role === 'base' ? ('*' as const) : fileKind) }));
  const nameCol = header.columns.find((c) => c.role === 'name')!.index;
  const rrnCol = header.columns.find((c) => c.role === 'rrn')?.index;
  const kinds = [...new Set(money.filter((m) => m.role !== 'base').map((m) => m.kind).filter((k): k is InsuranceKind => k !== null && k !== '*'))];
  if (!kinds.length) warnings.add('header_not_found');
  const rows: InsuranceNoticeRow[] = [];
  header.sheet.rows.slice(header.headerRow + 1).forEach((row, k) => {
    const name = normText(cellText(row[nameCol])).replace(/[^\p{Script=Hangul}A-Za-z ]/gu, '').trim();
    if (!name || isTotalRow(row) || roleOf(name, ROLES)) return;
    let front7: string | null = null;
    let birth: string | null = null;
    if (rrnCol !== undefined) {
      const r = rrnFront(row[rrnCol] ?? null);
      front7 = r.front7;
      if (r.full) warnings.add('rrn_full_masked');
      birth = front7 ? birthFromRrnFront(front7) : birthOf(row[rrnCol] ?? null);
    }
    for (const kind of kinds) {
      const pick = (role: Role) => {
        const c = money.find((m) => m.kind === kind && m.role === role) ?? (role === 'base' ? money.find((m) => m.kind === '*' && m.role === 'base') : undefined);
        return c ? parseWon(row[c.index] ?? null) : null;
      };
      const entry = { base: pick('base'), total: pick('total'), employee: pick('employee'), employer: pick('employer') };
      if (entry.total === null && entry.employee === null && entry.employer === null) continue;
      // 근로자 + 사업주 = 합계면 확실, 합계만 있으면 보통, 어긋나면 낮게
      const parts = entry.employee !== null && entry.employer !== null ? entry.employee + entry.employer : null;
      const c = entry.total !== null && parts !== null ? (parts === entry.total ? 0.85 : 0.4) : 0.65;
      rows.push({ rowId: `${header.sheet.name}!${header.headerRow + 2 + k}:${kind}`, name: name.slice(0, 40), birthDate: birth, rrnFront7: front7, insurance: kind, ...entry, confidence: conf(c * (birth ? 1 : 0.9)) });
    }
  });
  if (!rows.length) warnings.add('no_rows');
  const month = monthOf(head);
  const confidence = conf(rows.length ? (rows.reduce((s, r) => s + r.confidence, 0) / rows.length) * (month.value ? 1 : 0.8) : 0);
  return { result: { extractor: 'insurance-notice-v1', estimated: true, profile: 'nhis-generic-v0', month, insurances: kinds, rows: rows.slice(0, 2000) }, warnings: [...warnings], confidence };
}
