// 정산내역 형식 규칙(M6-5, J-01 배달앱·J-02 오픈마켓). 사장님이 관리자 페이지에서 내려받은 엑셀·CSV를 읽는다.
// 형식 근거: 각 플랫폼의 공개 도움말·화면 설명에 나오는 칸 이름(정산일·주문금액·수수료·정산금액 등)으로 만든 "추정" 규칙이다.
// 실물 파일을 받기 전까지 모든 프로필은 estimated=true이고 결과에 format_estimated 경고가 붙는다(README §정산 형식).
// 세액 계산·매출 신고 판단은 하지 않는다. 더한 값은 표시용이고 파일 안 합계 줄과 다르면 경고만 단다.
import type { SheetOutput } from './sandbox/index.ts';
import { cellText, findHeader, headText, isTotalRow, sheetWarnings, type RoleRule } from './table.ts';
import type { Extracted, SettlementChannel, SettlementColumn, SettlementPlatform, SettlementResult, SettlementRole, SettlementRow, WarningCode } from './types.ts';
import { compact, conf, findDates, parseWon } from './util.ts';

const ROLES: RoleRule<SettlementRole>[] = [
  { role: 'payout', any: ['최종정산금액', '정산금액', '정산예정금액', '지급금액', '지급예정금액', '입금금액', '입금예정금액', '입금액', '정산액'], not: ['수수료', '부가세'] },
  { role: 'vat', any: ['부가세', '부가가치세'] },
  { role: 'fee', any: ['수수료', '이용료', '중개', '배달비', '배달대행', '광고비', '광고', '결제대행', 'pg', '서비스요금', '판매수수료', '차감'], not: ['부가세', '정산금액'], multi: true },
  { role: 'discount', any: ['할인', '쿠폰', '프로모션'], not: ['수수료'] },
  { role: 'gross', any: ['총주문금액', '주문금액', '매출금액', '매출액', '판매금액', '판매가', '결제금액', '상품금액', '거래금액', '주문총액', '판매액'], not: ['수수료', '정산', '할인', '취소'] },
  { role: 'order_count', any: ['주문수', '주문건수', '건수', '판매수량', '수량'] },
  { role: 'order_id', any: ['주문번호', '상품주문번호', '주문id'] },
  { role: 'date', any: ['정산일', '정산예정일', '정산기준일', '지급일', '입금일', '입금예정일', '주문일', '주문일시', '결제일', '거래일', '매출일', '판매일', '구매확정일', '일자', '날짜'] },
];

/** 플랫폼 이름(시트·앞쪽 글자에서). 판정이 아니라 화면에 "배달의민족 정산으로 보여요" 정도로 쓴다 */
const PLATFORMS: Array<[RegExp, SettlementPlatform, SettlementChannel]> = [
  [/배달의민족|배민/, 'baemin', 'delivery'],
  [/쿠팡이츠|coupangeats/i, 'coupang_eats', 'delivery'],
  [/요기요|yogiyo/i, 'yogiyo', 'delivery'],
  [/땡겨요/, 'ddangyo', 'delivery'],
  [/스마트스토어|네이버페이|smartstore/i, 'smartstore', 'market'],
  [/쿠팡(?!이츠)|coupangwing|wing/i, 'coupang', 'market'],
  [/11번가|11st/i, '11st', 'market'],
  [/g마켓|지마켓|옥션|esm/i, 'esm', 'market'],
];

function platformOf(text: string): { platform: SettlementPlatform; channel: SettlementChannel } | null {
  const c = compact(text);
  for (const [re, platform, channel] of PLATFORMS) if (re.test(c)) return { platform, channel };
  return null;
}

function dateOf(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  return findDates(v, { compactYmd: true })[0]?.iso ?? null;
}

const sumOrNull = (xs: Array<number | null>) => (xs.some((x) => x !== null) ? xs.reduce<number>((s, x) => s + (x ?? 0), 0) : null);

export function parseSettlement(out: SheetOutput, expected?: SettlementChannel): { result: SettlementResult | null; warnings: WarningCode[]; confidence: number } {
  const warnings = new Set<WarningCode>(sheetWarnings(out));
  warnings.add('format_estimated');
  // 날짜와, 정산금액 또는 매출 칸 하나는 있어야 정산 표로 본다
  const header = findHeader(out, ROLES, ['date', 'payout']) ?? findHeader(out, ROLES, ['date', 'gross']);
  if (!header) {
    warnings.add('header_not_found');
    return { result: null, warnings: [...warnings], confidence: 0 };
  }
  const columns: SettlementColumn[] = header.columns.map((c) => ({ ...c }));
  const col = (role: SettlementRole) => columns.find((c) => c.role === role)?.index;
  const feeCols = columns.filter((c) => c.role === 'fee').map((c) => c.index);
  const rows: SettlementRow[] = [];
  let fileTotals: SettlementResult['fileTotals'] = null;
  const num = (row: (typeof header.sheet.rows)[number], i: number | undefined) => (i === undefined ? null : parseWon(row[i] ?? null));
  for (const row of header.sheet.rows.slice(header.headerRow + 1)) {
    if (!row.length || row.every((c) => cellText(c).trim() === '')) continue;
    const fees = feeCols.length ? sumOrNull(feeCols.map((i) => {
      const v = num(row, i);
      return v === null ? null : Math.abs(v);
    })) : null;
    const entry: SettlementRow = { date: dateOf(row[col('date')!] ?? null), gross: num(row, col('gross')), fees, payout: num(row, col('payout')), vat: num(row, col('vat')), orderCount: num(row, col('order_count')) };
    if (isTotalRow(row)) {
      fileTotals = { gross: entry.gross, fees: entry.fees, payout: entry.payout };
      continue;
    }
    // 날짜도 금액도 없는 줄(안내 문구·빈 줄)은 뺀다
    if (entry.date === null && entry.gross === null && entry.payout === null) continue;
    rows.push(entry);
    if (rows.length >= 5000) {
      warnings.add('sheet_truncated');
      break;
    }
  }
  if (!rows.length) warnings.add('no_rows');
  const totals = { gross: sumOrNull(rows.map((r) => r.gross)), fees: sumOrNull(rows.map((r) => r.fees)), payout: sumOrNull(rows.map((r) => r.payout)), vat: sumOrNull(rows.map((r) => r.vat)), rows: rows.length };
  let totalsAgree: boolean | null = null;
  if (fileTotals) {
    const pairs = (['gross', 'fees', 'payout'] as const).filter((k) => fileTotals![k] !== null && totals[k] !== null);
    totalsAgree = pairs.length > 0 && pairs.every((k) => fileTotals![k] === totals[k]);
    if (!totalsAgree) warnings.add('total_mismatch');
  }
  const dates = rows.map((r) => r.date).filter((d): d is string => d !== null).sort();
  const found = platformOf(headText(out));
  const channel: Extracted<SettlementChannel> = found ? { value: found.channel, confidence: 0.8, reason: null } : expected ? { value: expected, confidence: 0.5, reason: null } : { value: null, confidence: 0, reason: 'not_found' };
  if (expected && found && found.channel !== expected) warnings.add('channel_mismatch');
  const platform: Extracted<SettlementPlatform> = found ? { value: found.platform, confidence: 0.8, reason: null } : { value: null, confidence: 0, reason: 'not_found' };
  // 신뢰도: 칸을 찾은 정도(정산금액·매출·수수료) × 파일 합계와 맞음. 추정 규칙이라 0.85를 넘기지 않는다
  const coverage = [col('payout') !== undefined, col('gross') !== undefined, feeCols.length > 0].filter(Boolean).length / 3;
  const confidence = conf(Math.min(0.85, (0.45 + 0.4 * coverage) * (totalsAgree === false ? 0.7 : totalsAgree ? 1 : 0.9) * (rows.length ? 1 : 0)));
  const result: SettlementResult = {
    extractor: 'settlement-v1',
    channel,
    platform,
    profile: `generic-${found?.channel ?? expected ?? 'unknown'}-v0`,
    estimated: true,
    sheet: header.sheet.name,
    headerRow: header.headerRow,
    columns,
    period: { from: dates[0] ?? null, to: dates[dates.length - 1] ?? null },
    rows,
    totals,
    fileTotals,
  };
  return { result, warnings: [...warnings], confidence };
}
