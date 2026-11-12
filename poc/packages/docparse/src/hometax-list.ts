// 홈택스 전자세금계산서 "발급 목록조회" [내려받기] 엑셀(09 §5.1 매출 원천 보강). 앱 밖에서 직접 발급한 매출도 받을 돈 건으로 들인다.
// 열 근거: 2026-11-11 실화면 기록(목록 그리드 data-col_id: 작성일자·발급일자·전송일자·공급받는자 등록번호·상호·대표자·품목명·합계·공급가액·세액·승인번호).
// 내려받은 파일의 머리글 글자는 아직 실물로 확인하지 않았다("추정"). 공급자·공급받는자 칸이 같은 이름(상호·대표자명·등록번호)으로 두 번 나오는
// 한 줄 머리글과, 위 줄에 "공급자"/"공급받는자"가 있는 두 줄 머리글을 모두 받는다. 판정 없음: 줄을 다듬어 돌려줄 뿐이다.
import type { Cell, SheetOutput, SheetTable } from './sandbox/index.ts';
import { cellText, isTotalRow, sheetWarnings } from './table.ts';
import { compact, findDates, normText, parseWon } from './util.ts';

export interface HometaxInvoiceRow {
  /** 승인번호 숫자 24자리 */
  approvalNo: string;
  writtenOn: string;
  issuedOn: string | null;
  supplierBizNo: string | null;
  buyerBizNo: string | null;
  buyerName: string | null;
  buyerRep: string | null;
  item: string | null;
  total: number;
  supply: number | null;
  tax: number | null;
}

export interface HometaxListParse {
  extractor: 'hometax-issue-list-v1';
  rows: HometaxInvoiceRow[];
  skipped: number;
  duplicates: number;
  period: { from: string | null; to: string | null };
  warnings: string[];
}

type Role = 'written' | 'issued' | 'approval' | 'supplier_biz' | 'buyer_biz' | 'buyer_name' | 'buyer_rep' | 'item' | 'total' | 'supply' | 'tax';

const digits = (v: Cell | undefined) => cellText(v ?? null).replace(/\D/g, '');
const dayOf = (v: Cell | undefined): string | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' && Number.isInteger(v) && v >= 20000101 && v <= 20991231) {
    const s = String(v);
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  }
  return findDates(String(v), { compactYmd: true })[0]?.iso ?? null;
};
const textOf = (v: Cell | undefined) => {
  const t = normText(cellText(v ?? null));
  return t ? t.slice(0, 120) : null;
};

/** 머리글 한 칸(위 줄 무리 이름과 이은 것) → 역할. 무리 이름이 없으면 같은 이름의 n번째로 공급자/공급받는자를 가른다 */
function roleOfHeader(h: string, group: 'supplier' | 'buyer' | null, nth: number): Role | null {
  const c = compact(h);
  const buyer = group === 'buyer' || c.includes('공급받는자') || (group === null && nth >= 1);
  const supplier = group === 'supplier' || (c.includes('공급자') && !c.includes('공급받는자'));
  if (c.includes('승인번호')) return 'approval';
  if (c.includes('작성일')) return 'written';
  if (c.includes('발급일')) return 'issued';
  if (c.includes('합계금액') || c === '합계') return 'total';
  if (c.includes('공급가액')) return 'supply';
  if (c === '세액' || c.endsWith('세액')) return 'tax';
  if (c.includes('품목')) return 'item';
  if (c.includes('등록번호') || c.includes('사업자번호')) return buyer && !supplier ? 'buyer_biz' : 'supplier_biz';
  if (c.includes('상호') || c.includes('법인명')) return buyer && !supplier ? 'buyer_name' : null;
  if (c.includes('대표자') || c === '성명') return buyer && !supplier ? 'buyer_rep' : null;
  return null;
}

function findListHeader(sheet: SheetTable): { headerRow: number; cols: Map<Role, number> } | null {
  const limit = Math.min(sheet.rows.length, 30);
  let best: { headerRow: number; cols: Map<Role, number> } | null = null;
  for (let r = 0; r < limit; r++) {
    const row = sheet.rows[r] ?? [];
    const above = r > 0 ? (sheet.rows[r - 1] ?? []) : [];
    const cols = new Map<Role, number>();
    const seen = new Map<string, number>();
    let carry = '';
    const width = Math.max(row.length, above.length);
    for (let i = 0; i < width; i++) {
      const cell = row[i] ?? null;
      const a = compact(cellText(above[i] ?? null));
      if (a) carry = a;
      const group = carry.includes('공급받는자') ? 'buyer' : carry.includes('공급자') ? 'supplier' : null;
      // 아랫줄이 비었으면(세로로 합친 칸) 윗줄 글자를 머리글로 본다
      const h = cellText(cell) || (r > 0 ? cellText(above[i] ?? null) : '');
      const key = compact(h);
      const nth = seen.get(key) ?? 0;
      seen.set(key, nth + 1);
      const role = roleOfHeader(h, group, nth);
      if (role && !cols.has(role)) cols.set(role, i);
    }
    // 두 줄 머리글이면 아랫줄이 역할을 더 많이 갖는다(윗줄 무리 이름과 이어 본다)
    if (cols.has('approval') && cols.has('written') && cols.has('total') && (!best || cols.size > best.cols.size)) best = { headerRow: r, cols };
  }
  return best;
}

/** 발급 목록 엑셀 → 세금계산서 줄. 같은 승인번호는 한 번만(뒤의 것은 duplicates로 센다) */
export function parseHometaxIssueList(out: SheetOutput): HometaxListParse {
  const warnings = new Set<string>(sheetWarnings(out).filter((w) => w === 'sheet_truncated' || w === 'encoding_euc_kr'));
  warnings.add('format_estimated');
  let found: { sheet: SheetTable; headerRow: number; cols: Map<Role, number> } | null = null;
  for (const s of out.sheets) {
    if (s.hidden) continue;
    const h = findListHeader(s);
    if (h) {
      found = { sheet: s, ...h };
      break;
    }
  }
  if (!found) return { extractor: 'hometax-issue-list-v1', rows: [], skipped: 0, duplicates: 0, period: { from: null, to: null }, warnings: [...warnings, 'header_not_found'] };
  const { sheet, headerRow, cols } = found;
  const at = (row: Cell[], r: Role) => (cols.has(r) ? row[cols.get(r)!] : undefined);
  const rows: HometaxInvoiceRow[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  let duplicates = 0;
  for (const row of sheet.rows.slice(headerRow + 1)) {
    if (!row.length || row.every((c) => cellText(c).trim() === '') || isTotalRow(row)) continue;
    const approvalNo = digits(at(row, 'approval'));
    const writtenOn = dayOf(at(row, 'written'));
    const total = parseWon(at(row, 'total') ?? null);
    if (approvalNo.length !== 24 || !writtenOn || total === null) {
      skipped++;
      continue;
    }
    if (seen.has(approvalNo)) {
      duplicates++;
      continue;
    }
    seen.add(approvalNo);
    const biz = (r: Role) => {
      const d = digits(at(row, r));
      return d.length === 10 ? d : null;
    };
    rows.push({
      approvalNo,
      writtenOn,
      issuedOn: dayOf(at(row, 'issued')),
      supplierBizNo: biz('supplier_biz'),
      buyerBizNo: biz('buyer_biz'),
      buyerName: textOf(at(row, 'buyer_name')),
      buyerRep: textOf(at(row, 'buyer_rep')),
      item: textOf(at(row, 'item')),
      total,
      supply: parseWon(at(row, 'supply') ?? null),
      tax: parseWon(at(row, 'tax') ?? null),
    });
    if (rows.length >= 5000) {
      warnings.add('sheet_truncated');
      break;
    }
  }
  if (skipped) warnings.add('rows_skipped');
  if (!rows.length) warnings.add('no_rows');
  const days = rows.map((r) => r.writtenOn).sort();
  return { extractor: 'hometax-issue-list-v1', rows, skipped, duplicates, period: { from: days[0] ?? null, to: days[days.length - 1] ?? null }, warnings: [...warnings] };
}
