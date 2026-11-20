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
  openCount: number;
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
