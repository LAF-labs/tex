// 배달앱·오픈마켓 정산내역(J-01·J-02, D14 M6-5) 후처리: main이 docparse 샌드박스에서 받은 SettlementResult에서 꾸러미에 남길 요약만 고른다.
// 요약은 파일에서 읽은 값이다(판정 아님). 세무사 꾸러미 '정산·현금매출' 시트에 "파일에서 읽은 값"으로 적고, 매출·신고 금액을 계산하지 않는다.
// 모양이 맞는 값만 받는다. 행(rows)·열 이름(header)은 받지 않는다(파일 안 글자를 DB에 옮기지 않음).
import type { BundleItem } from '@sax/db';

export class SettlementInputError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
const fail = (code: string): never => {
  throw new SettlementInputError(code);
};

export const SETTLEMENT_PLATFORMS = ['baemin', 'coupang_eats', 'yogiyo', 'ddangyo', 'smartstore', 'coupang', '11st', 'esm', 'other'] as const;
export type SettlementPlatformId = (typeof SETTLEMENT_PLATFORMS)[number];
export const PLATFORM_KO: Record<SettlementPlatformId, string> = {
  baemin: '배달의민족', coupang_eats: '쿠팡이츠', yogiyo: '요기요', ddangyo: '땡겨요', smartstore: '스마트스토어', coupang: '쿠팡', '11st': '11번가', esm: 'G마켓·옥션', other: '기타',
};

/** documents.meta.settlement에 두는 요약 */
export interface SettlementSummary {
  channel: 'delivery' | 'market';
  platform: SettlementPlatformId | null;
  periodFrom: string | null;
  periodTo: string | null;
  gross: number | null;
  fees: number | null;
  payout: number | null;
  vat: number | null;
  rows: number;
  /** 실물 확인 전 형식 규칙으로 읽었다 */
  estimated: boolean;
  /** 파일 안 "합계" 줄과 우리가 더한 값이 다르다 */
  totalMismatch: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const dayOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : typeof v === 'string' && DAY.test(v) ? v : fail('bad_settlement'));
const intOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number.isSafeInteger(v) ? (v as number) : fail('bad_settlement'));
const extracted = (v: unknown): unknown => (isObj(v) ? v.value : fail('bad_settlement'));

/** docparse SettlementResult(extractor settlement-v1) → 요약. 품목 종류와 채널이 다르면 settlement_channel_mismatch */
export function settlementSummary(parsed: unknown, item: Pick<BundleItem, 'kind'>): SettlementSummary {
  if (!isObj(parsed) || parsed.extractor !== 'settlement-v1' || !isObj(parsed.totals) || !isObj(parsed.period)) return fail('bad_settlement');
  const channel = extracted(parsed.channel);
  if (channel !== 'delivery' && channel !== 'market') return fail('bad_settlement');
  if ((item.kind === 'settlement_delivery') !== (channel === 'delivery')) return fail('settlement_channel_mismatch');
  const platform = extracted(parsed.platform);
  if (platform !== null && !(SETTLEMENT_PLATFORMS as readonly unknown[]).includes(platform)) return fail('bad_settlement');
  const t = parsed.totals;
  const rows = Number.isSafeInteger(t.rows) && (t.rows as number) >= 0 ? (t.rows as number) : fail('bad_settlement');
  const periodFrom = dayOrNull(parsed.period.from);
  const periodTo = dayOrNull(parsed.period.to);
  if (periodFrom && periodTo && periodFrom > periodTo) fail('bad_settlement');
  const sum = { gross: intOrNull(t.gross), fees: intOrNull(t.fees), payout: intOrNull(t.payout), vat: intOrNull(t.vat) };
  let totalMismatch = false;
  if (parsed.fileTotals !== null && parsed.fileTotals !== undefined) {
    if (!isObj(parsed.fileTotals)) return fail('bad_settlement');
    for (const k of ['gross', 'fees', 'payout'] as const) {
      const f = intOrNull(parsed.fileTotals[k]);
      if (f !== null && sum[k] !== null && f !== sum[k]) totalMismatch = true;
    }
  }
  return { channel, platform: platform as SettlementPlatformId | null, periodFrom, periodTo, ...sum, rows, estimated: parsed.estimated === true, totalMismatch };
}

/** 정산 기간이 그달을 다 덮는가(덮으면 ready, 아니면 partial). 기간을 못 읽었으면 partial */
export function coversMonth(s: Pick<SettlementSummary, 'periodFrom' | 'periodTo'>, from: string, to: string): boolean {
  return s.periodFrom !== null && s.periodTo !== null && s.periodFrom <= from && s.periodTo >= to;
}

/** documents.meta에서 요약을 꺼낸다(없거나 모양이 다르면 null) */
export function summaryOf(meta: Record<string, unknown> | null): SettlementSummary | null {
  const s = meta?.settlement;
  return isObj(s) && (s.channel === 'delivery' || s.channel === 'market') ? (s as unknown as SettlementSummary) : null;
}
