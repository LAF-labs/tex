// M6-14 '빠진 것' 화면 데이터: missingReport를 화면 순서의 구획으로 바꾼다. 문구는 데스크톱이 key로 갖는다.
// - 'open': 사장님이 채울 것(빈 항목·확인 안 한 급여). 'collapsed': 확인용 표시(카드 증빙 대조·메모 다시 잇기·세금계산서 합계 차이)
// - 어떤 구획도 보내기를 막거나 확인을 강제하지 않는다(yulmu 2026-11-05, ADR-032). 빈 구획은 내지 않는다.
import type { MissingReport } from './month.ts';

export type MissingSection =
  | { key: 'empty_items'; display: 'open'; count: number; rows: MissingReport['emptyItems'] }
  | { key: 'payroll'; display: 'open'; count: number; payroll: NonNullable<MissingReport['payroll']> }
  | { key: 'card_without_evidence'; display: 'collapsed'; count: number; rows: MissingReport['cardWithoutEvidence'] }
  | { key: 'memos_need_check'; display: 'collapsed'; count: number }
  | { key: 'invoice_sum_gaps'; display: 'collapsed'; count: number; rows: MissingReport['invoiceSumGaps'] };

export interface MissingView {
  month: string;
  sections: MissingSection[];
  /** 펼쳐 보이는 구획의 건수 합(홈 '이번 달 판' 배지용). 접힌 구획은 세지 않는다 */
  openCount: number;
  /** "카드 전표로 충분"이 켜져 카드 대조 구획을 뺐다(화면에 끄기 링크) */
  cardSlipEnough: boolean;
}

export function missingView(r: MissingReport): MissingView {
  const s: MissingSection[] = [];
  if (r.emptyItems.length) s.push({ key: 'empty_items', display: 'open', count: r.emptyItems.length, rows: r.emptyItems });
  if (r.payroll) s.push({ key: 'payroll', display: 'open', count: Math.max(1, r.payroll.employeesWithoutLine.length), payroll: r.payroll });
  if (r.cardWithoutEvidence.length) s.push({ key: 'card_without_evidence', display: 'collapsed', count: r.cardWithoutEvidence.length, rows: r.cardWithoutEvidence });
  if (r.memosNeedCheck) s.push({ key: 'memos_need_check', display: 'collapsed', count: r.memosNeedCheck });
  if (r.invoiceSumGaps.length) s.push({ key: 'invoice_sum_gaps', display: 'collapsed', count: r.invoiceSumGaps.length, rows: r.invoiceSumGaps });
  return { month: r.month, sections: s, openCount: s.filter((x) => x.display === 'open').reduce((a, x) => a + x.count, 0), cardSlipEnough: r.cardSlipEnough };
}
