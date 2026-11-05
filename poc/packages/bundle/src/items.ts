// 세무사 꾸러미 항목 구성(ADR-032 결정 2·8, 02 §17): 1층 모든 업체 공통 고정, 2층 업종 묶음(설정에서 고르면 생김), 3층 사장님 추가.
// 모델을 부르지 않는다(ADR-032 결정 11).
import type { BundleCadence, BundleItem, BundleItemSource, BundleRepo } from '@sax/db';

export type BuiltinKind = 'tax_invoice' | 'payroll' | 'card' | 'paper_receipt';
export type IndustryKind = 'settlement_delivery' | 'settlement_market' | 'cash_sales';
/** 2층 업종 코드(설정 bundle.industries) */
export type Industry = 'restaurant' | 'online_seller' | 'cash_business';

export const TIER1: ReadonlyArray<{ kind: BuiltinKind; name: string }> = [
  { kind: 'tax_invoice', name: '매출·매입 세금계산서' },
  { kind: 'payroll', name: '급여대장' },
  { kind: 'card', name: '사업용 신용카드 사용내역' },
  { kind: 'paper_receipt', name: '종이 세무자료(종이 세금계산서·계산서·간이영수증)' },
];

export const TIER2: Readonly<Record<Industry, { kind: IndustryKind; name: string }>> = {
  restaurant: { kind: 'settlement_delivery', name: '배달앱 월별 정산내역' },
  online_seller: { kind: 'settlement_market', name: '오픈마켓 월별 정산내역' },
  cash_business: { kind: 'cash_sales', name: '현금매출 내역(영수증 미발행)' },
};

export const INDUSTRIES = Object.keys(TIER2) as Industry[];

export class BundleError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

/**
 * 1층·2층 항목을 맞춘다(여러 번 불러도 같다). 고른 업종의 2층 항목은 켜고, 고르지 않은 업종의 항목은 끈다(지난달 기록은 남는다).
 * payrollEnabled가 false면 급여대장 항목은 남기되 "급여대장 파일 첨부"로 쓴다(ADR-032 결정 11: 기능을 안 쓰는 업체는 파일 첨부).
 */
export function ensureItems(repo: BundleRepo, profileId: string, industries: readonly Industry[], at?: string): BundleItem[] {
  for (const i of industries) if (!INDUSTRIES.includes(i)) throw new BundleError(`unknown_industry:${i}`);
  const have = repo.items(profileId);
  for (const t of TIER1) if (!have.some((h) => h.tier === 1 && h.kind === t.kind)) repo.addItem({ profileId, tier: 1, kind: t.kind, name: t.name, cadence: 'monthly', source: 'builtin' }, at);
  for (const ind of INDUSTRIES) {
    const def = TIER2[ind];
    const cur = have.find((h) => h.tier === 2 && h.kind === def.kind);
    const want = industries.includes(ind);
    if (!cur && want) repo.addItem({ profileId, tier: 2, kind: def.kind, name: def.name, cadence: 'monthly', source: 'industry' }, at);
    else if (cur && cur.enabled !== want) repo.setEnabled(cur.id, want);
  }
  return repo.items(profileId);
}

/** 3층 항목 추가: "세무사 꾸러미에 항목 추가"(이름·주기) 또는 붙여 넣은 요청에서 고른 후보 */
export function addCustomItem(repo: BundleRepo, profileId: string, name: string, cadence: BundleCadence, source: Extract<BundleItemSource, 'user' | 'pasted_request'> = 'user', at?: string): BundleItem {
  const n = name.trim().replace(/\s+/g, ' ');
  if (!n) throw new BundleError('name_required');
  if (repo.items(profileId).some((i) => i.tier === 3 && i.enabled && i.name === n)) throw new BundleError('duplicate_item');
  return repo.addItem({ profileId, tier: 3, kind: 'custom', name: n, cadence, source }, at);
}

/** 그달에 해당하는 항목의 기간 키. 분기 항목은 그 분기, 한 번 항목은 'once' */
export function periodFor(month: string, cadence: BundleCadence): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new BundleError('invalid_month');
  if (cadence === 'monthly') return month;
  if (cadence === 'quarterly') return `${month.slice(0, 4)}-Q${Math.ceil(Number(month.slice(5)) / 3)}`;
  return 'once';
}

export function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}
