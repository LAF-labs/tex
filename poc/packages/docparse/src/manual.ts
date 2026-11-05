// 수동 메타 입력 폴백(M1-8·M6-4): 자동으로 핵심 칸을 못 읽었거나(needsManual) 사장님이 고칠 때 받는 값.
// 화면(확인 카드)은 parse 결과의 값·후보를 미리 채우고, 사장님이 확인·수정한 값만 이 모양으로 엔진에 넘긴다. 이 값이 정본이다.
import type { InsuranceKind } from './types.ts';
import { isoDate, isValidBizNo } from './util.ts';

export interface ManualCertificateMeta {
  kind: 'certificate';
  issuedOn: string;
  /** 서류에 유효기간이 없으면 null(규칙표로 계산) */
  validUntil: string | null;
}

export interface ManualReceiptMeta {
  kind: 'receipt';
  issuedOn: string;
  merchant: string;
  /** 모르면 null(간이영수증에는 없을 수 있다) */
  merchantBizNo: string | null;
  amount: number;
}

export interface ManualInsuranceRow {
  rowId: string;
  insurance: InsuranceKind;
  employee: number | null;
  employer: number | null;
}

export interface ManualInsuranceMeta {
  kind: 'insurance_notice';
  month: string;
  /** 고친 줄만 */
  rows: ManualInsuranceRow[];
}

export type ManualInput = ManualCertificateMeta | ManualReceiptMeta | ManualInsuranceMeta;
export type ManualError = 'kind' | 'issued_on' | 'valid_until' | 'merchant' | 'biz_no' | 'amount' | 'month' | 'rows';

const isIso = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && isoDate(Number(s.slice(0, 4)), Number(s.slice(5, 7)), Number(s.slice(8, 10))) === s;
const money = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= 100_000_000_000;

/** 화면에서 온 값(신뢰하지 않음)을 검사·정리한다. 틀린 칸 이름 목록 또는 정리된 값. */
export function checkManual(raw: unknown): { ok: true; value: ManualInput } | { ok: false; errors: ManualError[] } {
  const o = (raw ?? {}) as Record<string, unknown>;
  const errors: ManualError[] = [];
  if (o.kind === 'certificate') {
    if (!isIso(o.issuedOn)) errors.push('issued_on');
    if (o.validUntil !== null && !(isIso(o.validUntil) && (!isIso(o.issuedOn) || o.validUntil >= o.issuedOn))) errors.push('valid_until');
    return errors.length ? { ok: false, errors } : { ok: true, value: { kind: 'certificate', issuedOn: o.issuedOn as string, validUntil: o.validUntil as string | null } };
  }
  if (o.kind === 'receipt') {
    const merchant = typeof o.merchant === 'string' ? o.merchant.normalize('NFC').replace(/\s+/g, ' ').trim() : '';
    const biz = typeof o.merchantBizNo === 'string' ? o.merchantBizNo.replace(/\D/g, '') : null;
    if (!isIso(o.issuedOn)) errors.push('issued_on');
    if (!merchant || merchant.length > 60) errors.push('merchant');
    if (o.merchantBizNo !== null && !(biz && isValidBizNo(biz))) errors.push('biz_no');
    if (!money(o.amount)) errors.push('amount');
    return errors.length ? { ok: false, errors } : { ok: true, value: { kind: 'receipt', issuedOn: o.issuedOn as string, merchant, merchantBizNo: biz, amount: o.amount as number } };
  }
  if (o.kind === 'insurance_notice') {
    if (typeof o.month !== 'string' || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(o.month)) errors.push('month');
    const rows = Array.isArray(o.rows) ? o.rows : null;
    const kinds = new Set(['pension', 'health', 'ltc', 'employment', 'industrial']);
    const okRow = (r: unknown) => {
      const x = (r ?? {}) as Record<string, unknown>;
      return typeof x.rowId === 'string' && x.rowId.length <= 120 && kinds.has(x.insurance as string) && (x.employee === null || money(x.employee)) && (x.employer === null || money(x.employer));
    };
    if (!rows || rows.length > 2000 || !rows.every(okRow)) errors.push('rows');
    return errors.length ? { ok: false, errors } : { ok: true, value: { kind: 'insurance_notice', month: o.month as string, rows: (rows as ManualInsuranceRow[]).map((r) => ({ rowId: r.rowId, insurance: r.insurance, employee: r.employee, employer: r.employer })) } };
  }
  return { ok: false, errors: ['kind'] };
}
