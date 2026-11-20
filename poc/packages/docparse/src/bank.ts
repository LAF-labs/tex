import type { Cell, SheetOutput, SheetTable } from './sandbox/index.ts';
import { cellText, isTotalRow, roleOf, sheetWarnings, type RoleRule } from './table.ts';
import { compact, findDates, isoDate, normText, parseWon } from './util.ts';

export type BankRole = 'date' | 'time' | 'in' | 'out' | 'amount' | 'kind' | 'balance' | 'payer' | 'memo' | 'counter_account';
export const BANK_ROLES: readonly BankRole[] = ['date', 'time', 'in', 'out', 'amount', 'kind', 'balance', 'payer', 'memo', 'counter_account'];

const RULES: RoleRule<BankRole>[] = [
  { role: 'balance', any: ['거래후잔액', '잔액', '잔고'] },
  { role: 'counter_account', any: ['상대계좌번호', '상대계좌', '상대방계좌', '입금계좌번호', '출금계좌번호'] },
  { role: 'in', any: ['맡기신금액', '입금액', '입금금액', '입금(원)', '받은금액', '입금'], not: ['입금자', '입금인', '입금처', '계좌', '은행', '보낸'] },
  { role: 'out', any: ['찾으신금액', '출금액', '출금금액', '출금(원)', '지급금액', '지급액', '보낸금액', '출금'], not: ['출금자', '출금처', '계좌', '은행'] },
  { role: 'date', any: ['거래일시', '거래일자', '거래날짜', '거래일', '일시', '일자', '날짜'], not: ['시간'] },
  { role: 'time', any: ['거래시간', '거래시각', '시간', '시각'] },
  { role: 'payer', any: ['기재내용', '입금자명', '입금자', '입금인', '보낸분받는분', '보낸분', '받는분', '의뢰인', '송금인', '상대방', '거래상대', '예금주', '통장표시', '거래내용', '내용'] },
  { role: 'memo', any: ['적요', '거래구분', '거래종류', '거래유형', '메모', '비고'] },
  { role: 'kind', any: ['입출금구분', '입출구분', '입지구분', '구분'] },
  { role: 'amount', any: ['거래금액', '금액'], not: ['잔액'] },
];

export interface BankColumn {
  role: BankRole;
  index: number;
  header: string;
}

/** 사람이 고른(또는 기억한) 열. index는 머리글 줄의 칸 번호 */
export interface BankMapping {
  sheet: string;
  headerRow: number;
  columns: Partial<Record<BankRole, number>>;
}

export interface BankRow {
  occurredAt: string;
  day: string;
  direction: 'in' | 'out';
  amount: number;
  balance: number | null;
  payer: string | null;
  memo: string | null;
  counterAccount: string | null;
}

export type BankWarning = 'header_not_found' | 'no_rows' | 'rows_skipped' | 'no_amount_column' | 'sheet_truncated' | 'format_estimated' | 'both_amounts' | string;

export interface BankParse {
  extractor: 'bank-v1';
  signature: string | null;
  mapping: BankMapping | null;
  headers: string[];
  columns: BankColumn[];
  rows: BankRow[];
  skipped: number;
  period: { from: string | null; to: string | null };
  totals: { in: number; out: number; inCount: number; outCount: number };
  accountLast4: string | null;
  bankHint: string | null;
  sample: string[][];
  warnings: BankWarning[];
}

const BANKS: Array<[RegExp, string]> = [
  [/국민은행|KB국민|kb스타|kbstar/i, '국민'],
  [/신한은행|신한/, '신한'],
  [/우리은행/, '우리'],
  [/하나은행|KEB/, '하나'],
  [/농협|NH/, '농협'],
  [/기업은행|IBK/i, '기업'],
  [/카카오뱅크/, '카카오뱅크'],
  [/토스뱅크/, '토스뱅크'],
  [/케이뱅크/, '케이뱅크'],
  [/새마을금고|MG/, '새마을금고'],
  [/우체국/, '우체국'],
  [/수협/, '수협'],
  [/부산은행/, '부산'],
  [/대구은행|아이엠뱅크|iM뱅크/i, '아이엠뱅크'],
  [/경남은행/, '경남'],
  [/광주은행/, '광주'],
  [/전북은행/, '전북'],
  [/제주은행/, '제주'],
  [/SC제일|제일은행/, 'SC제일'],
  [/씨티/, '씨티'],
  [/신협/, '신협'],
];

function preface(sheet: SheetTable, headerRow: number): string {
  return [sheet.name, ...sheet.rows.slice(0, Math.max(headerRow, 1)).map((r) => r.map(cellText).join(' '))].join('\n');
}

function accountLast4Of(text: string): string | null {
  const m = normText(text).match(/계좌(?:번호)?\s*[:：]?\s*([\d-]{8,24})/);
  if (!m) return null;
  const d = m[1]!.replace(/-/g, '');
  return d.length >= 8 ? d.slice(-4) : null;
}

const pad2 = (s: string | number) => String(s).padStart(2, '0');

function timeOf(v: Cell): string | null {
  if (v === null) return null;
  if (typeof v === 'number') {
    if (v >= 0 && v < 1) {
      const secs = Math.round(v * 86400);
      return `${pad2(Math.floor(secs / 3600))}:${pad2(Math.floor((secs % 3600) / 60))}:${pad2(secs % 60)}`;
    }
    v = String(v).padStart(6, '0');
  }
  const t = normText(String(v));
  let m = t.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) return Number(m[1]) < 24 && Number(m[2]) < 60 ? `${pad2(m[1]!)}:${m[2]}${m[3] ? `:${m[3]}` : ''}` : null;
  m = t.match(/^(\d{2})(\d{2})(\d{2})?$/);
  if (m) return Number(m[1]) < 24 && Number(m[2]) < 60 ? `${m[1]}:${m[2]}${m[3] ? `:${m[3]}` : ''}` : null;
  return null;
}

function dateTimeOf(v: Cell): { day: string; time: string | null } | null {
  if (v === null) return null;
  if (typeof v === 'number') {
    if (Number.isInteger(v) && v >= 20000101 && v <= 20991231) {
      const day = isoDate(Math.floor(v / 10000), Math.floor((v % 10000) / 100), v % 100);
      return day ? { day, time: null } : null;
    }
    if (v > 36526 && v < 73051) {
      const ms = Math.round((v - 25569) * 86400000);
      const d = new Date(ms);
      const day = d.toISOString().slice(0, 10);
      const frac = v - Math.floor(v);
      return { day, time: frac > 0 ? timeOf(frac) : null };
    }
    return null;
  }
  const t = normText(String(v));
  const hit = findDates(t, { compactYmd: true })[0];
  if (!hit) return null;
  const rest = t.slice(hit.index + hit.length);
  return { day: hit.iso, time: timeOf(rest.trim() || null) };
}

const textOf = (v: Cell | undefined): string | null => {
  const t = normText(cellText(v ?? null));
  return t ? t.slice(0, 120) : null;
};

function directionOfKind(v: Cell | undefined): 'in' | 'out' | null {
  const t = compact(cellText(v ?? null));
  if (/입금|받|들어/.test(t)) return 'in';
  if (/출금|지급|보냄|나감|이체출/.test(t)) return 'out';
  return null;
}

function detect(out: SheetOutput): { sheet: SheetTable; headerRow: number; columns: BankColumn[] } | null {
  let best: { sheet: SheetTable; headerRow: number; columns: BankColumn[] } | null = null;
  for (const sheet of out.sheets) {
    if (sheet.hidden) continue;
    for (let r = 0; r < Math.min(sheet.rows.length, 40); r++) {
      const used = new Set<BankRole>();
      const columns: BankColumn[] = [];
      (sheet.rows[r] ?? []).forEach((c, i) => {
        if (typeof c !== 'string') return;
        const rule = roleOf(c, RULES);
        if (!rule || used.has(rule.role)) return;
        used.add(rule.role);
        columns.push({ role: rule.role, index: i, header: c.slice(0, 80) });
      });
      if (!used.has('date') || !(used.has('in') || used.has('out') || used.has('amount'))) continue;
      if (!best || columns.length > best.columns.length) best = { sheet, headerRow: r, columns };
    }
  }
  return best;
}

/**
 * 거래내역 표 읽기. mapping이 있으면(사람이 고른 열·기억한 서식) 그것을 쓰고, 없으면 머리글 사전으로 찾는다.
 * 결과의 rows는 날짜·금액을 읽은 줄만이다. 같은 줄이 두 번 있으면 둘 다 둔다(중복 판단은 엔진이 줄 열쇠로 한다).
 */
export function parseBankStatement(out: SheetOutput, mapping?: BankMapping | null): BankParse {
  const warnings = new Set<BankWarning>(sheetWarnings(out).filter((w) => w === 'sheet_truncated' || w === 'encoding_euc_kr' || w === 'hidden_rows_skipped'));
  let sheet: SheetTable | undefined;
  let headerRow = 0;
  let columns: BankColumn[] = [];
  if (mapping) {
    sheet = out.sheets.find((s) => s.name === mapping.sheet && !s.hidden);
    if (sheet) {
      headerRow = mapping.headerRow;
      const head = sheet.rows[headerRow] ?? [];
      columns = BANK_ROLES.filter((r) => Number.isInteger(mapping.columns[r])).map((r) => ({ role: r, index: mapping.columns[r]!, header: cellText(head[mapping.columns[r]!] ?? null).slice(0, 80) }));
    }
  } else {
    warnings.add('format_estimated');
    const found = detect(out);
    if (found) {
      sheet = found.sheet;
      headerRow = found.headerRow;
      columns = found.columns;
    }
  }
  const empty = (w: BankWarning): BankParse => ({
    extractor: 'bank-v1', signature: null, mapping: null, headers: (sheet?.rows[headerRow] ?? out.sheets.find((s) => !s.hidden)?.rows[0] ?? []).map((c) => cellText(c).slice(0, 80)),
    columns: [], rows: [], skipped: 0, period: { from: null, to: null }, totals: { in: 0, out: 0, inCount: 0, outCount: 0 }, accountLast4: null, bankHint: null,
    sample: (sheet ?? out.sheets.find((s) => !s.hidden))?.rows.slice(0, 8).map((r) => r.map((c) => cellText(c).slice(0, 40))) ?? [], warnings: [...warnings, w],
  });
  if (!sheet) return empty('header_not_found');
  const col = (r: BankRole) => columns.find((c) => c.role === r)?.index;
  if (col('date') === undefined) return empty('header_not_found');
  if (col('in') === undefined && col('out') === undefined && col('amount') === undefined) return empty('no_amount_column');
  const head = sheet.rows[headerRow] ?? [];
  const headers = head.map((c) => cellText(c).slice(0, 80));
  const signature = headers.map((h) => compact(h)).join('|').slice(0, 400) || null;
  const rows: BankRow[] = [];
  let skipped = 0;
  for (const raw of sheet.rows.slice(headerRow + 1)) {
    if (!raw.length || raw.every((c) => cellText(c).trim() === '')) continue;
    if (isTotalRow(raw)) continue;
    const dt = dateTimeOf(raw[col('date')!] ?? null);
    const amtOf = (i: number | undefined) => (i === undefined ? null : parseWon(raw[i] ?? null));
    let inAmt = amtOf(col('in'));
    let outAmt = amtOf(col('out'));
    if (col('amount') !== undefined && inAmt === null && outAmt === null) {
      const a = amtOf(col('amount'));
      const d = directionOfKind(raw[col('kind') ?? -1]);
      if (a !== null && a !== 0) {
        if (d === 'in' || (d === null && a > 0 && col('kind') === undefined)) inAmt = Math.abs(a);
        else if (d === 'out' || a < 0) outAmt = Math.abs(a);
      }
    }
    if (inAmt !== null && inAmt < 0) {
      outAmt = (outAmt ?? 0) + -inAmt;
      inAmt = null;
    }
    if (outAmt !== null && outAmt < 0) outAmt = -outAmt;
    const hasIn = inAmt !== null && inAmt > 0;
    const hasOut = outAmt !== null && outAmt > 0;
    if (!dt || (!hasIn && !hasOut)) {
      skipped++;
      continue;
    }
    if (hasIn && hasOut) warnings.add('both_amounts');
    const time = col('time') !== undefined ? timeOf(raw[col('time')!] ?? null) : dt.time;
    const base: Omit<BankRow, 'direction' | 'amount'> = {
      occurredAt: time ? `${dt.day} ${time}` : dt.day,
      day: dt.day,
      balance: col('balance') === undefined ? null : parseWon(raw[col('balance')!] ?? null),
      payer: col('payer') === undefined ? null : textOf(raw[col('payer')!]),
      memo: col('memo') === undefined ? null : textOf(raw[col('memo')!]),
      counterAccount: col('counter_account') === undefined ? null : (cellText(raw[col('counter_account')!] ?? null).replace(/\D/g, '') || null),
    };
    if (hasIn) rows.push({ ...base, direction: 'in', amount: inAmt! });
    if (hasOut) rows.push({ ...base, direction: 'out', amount: outAmt! });
    if (rows.length >= 20_000) {
      warnings.add('sheet_truncated');
      break;
    }
  }
  if (skipped) warnings.add('rows_skipped');
  if (!rows.length) warnings.add('no_rows');
  const days = rows.map((r) => r.day).sort();
  const totals = { in: 0, out: 0, inCount: 0, outCount: 0 };
  for (const r of rows) {
    if (r.direction === 'in') {
      totals.in += r.amount;
      totals.inCount++;
    } else {
      totals.out += r.amount;
      totals.outCount++;
    }
  }
  const pre = preface(sheet, headerRow);
  const bankHint = BANKS.find(([re]) => re.test(pre))?.[1] ?? null;
  return {
    extractor: 'bank-v1',
    signature,
    mapping: { sheet: sheet.name, headerRow, columns: Object.fromEntries(columns.map((c) => [c.role, c.index])) },
    headers,
    columns,
    rows,
    skipped,
    period: { from: days[0] ?? null, to: days[days.length - 1] ?? null },
    totals,
    accountLast4: accountLast4Of(pre),
    bankHint,
    sample: sheet.rows.slice(headerRow + 1, headerRow + 9).map((r) => r.map((c) => cellText(c).slice(0, 40))),
    warnings: [...warnings],
  };
}

/** 머리글 칸 하나의 역할 후보(열 고르기 화면 기본값) */
export const bankRoleOfHeader = (h: string): BankRole | null => roleOf(h, RULES)?.role ?? null;
