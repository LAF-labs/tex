import { domainToASCII } from 'node:url';
import { jcs, sha256hex } from '../gate.ts';
import { READBACK_FIELDS, type PortalConfig, type ReadbackKey, type SelectorKey } from '../portal.ts';


export type Phase = 'login' | 'form' | 'input' | 'readback' | 'gate' | 'sign' | 'verify' | 'mail';

export type Cond =
  | { fieldsFilled: ReadbackKey[] }
  | { readbackEquals: { fieldKey: ReadbackKey; ref: string } }
  | { sumEquals: { parts: [ReadbackKey, ReadbackKey]; total: ReadbackKey } };

export type Step = { id: string; phase: Phase } & (
  | { type: 'goto'; url: 'issueForm' }
  | { type: 'checkpoint'; name: string; expect: SelectorKey; reentry: 'reload' }
  | { type: 'fill'; target: SelectorKey; value: string; ifAbsent?: 'clear' }
  | { type: 'click'; target: SelectorKey }
  | { type: 'wait'; target: SelectorKey; for: 'filled'; timeoutMs: number }
  | { type: 'assert'; cond: Cond; code: string }
  | { type: 'readback'; fields: readonly ReadbackKey[] }
  | { type: 'gate'; authorizes: string[]; waitMs: number }
  | { type: 'submit'; target: SelectorKey; verify: string }
  | { type: 'verify'; lookup: 'invoice'; baseline: 'pre_gate_snapshot'; on: { committed: string; not_committed: string; unknown: string } }
  | { type: 'verify'; lookup: 'mail'; baseline: 'none'; skipUnless: 'email'; on: { committed: string; not_committed: string; unknown: string } }
  | { type: 'end'; status: 'success' | 'completed_with_issues' | 'failed' | 'handoff'; code?: string }
);

export const H01 = {
  id: 'hometax.invoice.issue',
  version: '2.1.1-poc6',
  docType: 'H-01' as const,
  steps: [
    { id: 's10', phase: 'form', type: 'goto', url: 'issueForm' },
    { id: 's11', phase: 'form', type: 'checkpoint', name: 'form', expect: 'form.root', reentry: 'reload' },
    { id: 's12', phase: 'input', type: 'fill', target: 'form.counterpartBizNo', value: '$inputs.counterpart.bizNo' },
    { id: 's13', phase: 'input', type: 'click', target: 'form.lookupCounterpart' },
    { id: 's14', phase: 'input', type: 'wait', target: 'form.counterpartName', for: 'filled', timeoutMs: 10_000 },
    { id: 's15', phase: 'input', type: 'fill', target: 'form.counterpartEmail', value: '$inputs.email', ifAbsent: 'clear' },
    { id: 's16', phase: 'input', type: 'fill', target: 'form.itemName', value: '$inputs.items[0].name' },
    { id: 's17', phase: 'input', type: 'fill', target: 'form.supplyAmount', value: '$inputs.amounts.supply' },
    { id: 's18', phase: 'input', type: 'fill', target: 'form.taxAmount', value: '$inputs.amounts.tax' },
    { id: 's19a', phase: 'readback', type: 'assert', cond: { fieldsFilled: ['counterpartBizNo', 'itemName', 'supplyAmount', 'taxAmount', 'issueDate'] }, code: 'assert.fields_missing' },
    { id: 's19b', phase: 'readback', type: 'readback', fields: READBACK_FIELDS },
    { id: 's19c', phase: 'readback', type: 'assert', cond: { readbackEquals: { fieldKey: 'supplierBizNo', ref: '$profile.bizNo' } }, code: 'assert.supplier_mismatch' },
    { id: 's19d', phase: 'readback', type: 'assert', cond: { sumEquals: { parts: ['supplyAmount', 'taxAmount'], total: 'totalAmount' } }, code: 'assert.total_mismatch' },
    { id: 's19e', phase: 'readback', type: 'assert', cond: { readbackEquals: { fieldKey: 'issueDate', ref: '$inputs.issueDate' } }, code: 'assert.issue_date_mismatch' },
    { id: 's20', phase: 'gate', type: 'gate', authorizes: ['s21'], waitMs: 600_000 },
    { id: 's21', phase: 'sign', type: 'submit', target: 'form.issueButton', verify: 's30' },
    { id: 's30', phase: 'verify', type: 'verify', lookup: 'invoice', baseline: 'pre_gate_snapshot', on: { committed: 's33', not_committed: 's36', unknown: 's37' } },
    { id: 's33', phase: 'mail', type: 'verify', lookup: 'mail', baseline: 'none', skipUnless: 'email', on: { committed: 's34', not_committed: 's35', unknown: 's35' } },
    { id: 's34', phase: 'mail', type: 'end', status: 'success' },
    { id: 's35', phase: 'mail', type: 'end', status: 'completed_with_issues', code: 'mail.not_confirmed' },
    { id: 's36', phase: 'verify', type: 'end', status: 'failed', code: 'verify.not_committed' },
    { id: 's37', phase: 'verify', type: 'end', status: 'handoff', code: 'verify.unknown' },
  ] satisfies Step[] as Step[],
};

const digits = (s: string) => s.replace(/[\s,원]/g, '');

/** fieldKey별 정규화. 숫자 칸에 숫자 밖 문자가 남으면 그대로 둔다(바가 무장 거부로 드러낸다). */
export function normalizeField(key: ReadbackKey, raw: string): string {
  const s = raw.replace(/\s+/g, ' ').trim();
  switch (key) {
    case 'supplierBizNo':
    case 'counterpartBizNo':
      return s.replace(/-/g, '');
    case 'supplyAmount':
    case 'taxAmount':
    case 'totalAmount':
    case 'itemCount': {
      const d = digits(s);
      return /^\d+$/.test(d) ? d.replace(/^0+(?=\d)/, '') : d;
    }
    case 'issueDate': {
      const m = /^(\d{4})[-./]?(\d{2})[-./]?(\d{2})$/.exec(s);
      return m ? `${m[1]}-${m[2]}-${m[3]}` : s;
    }
    case 'counterpartEmail': {
      const at = s.lastIndexOf('@');
      return at > 0 ? `${s.slice(0, at)}@${s.slice(at + 1).toLowerCase()}` : s;
    }
    default:
      return s;
  }
}

/** HMAC 입력용 이메일: 소문자 + 도메인 punycode(ADR-021). */
export function canonicalEmail(email: string): string {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at <= 0) return e;
  return `${e.slice(0, at)}@${domainToASCII(e.slice(at + 1)) || e.slice(at + 1)}`;
}

/** 업무 중복 키(D02 §7): JCS(공급자번호, 공급받는자번호, 공급가, 세액, 작성일, 품목명[])의 해시. 실제 제출 값(readback)으로 만든다. */
export function businessKey(rb: Readonly<Record<ReadbackKey, string>>): string {
  return sha256hex(jcs([rb.supplierBizNo, rb.counterpartBizNo, rb.supplyAmount, rb.taxAmount, rb.issueDate, [rb.itemName]]));
}

/** packageDigest(B-08): IR + 셀렉터 + 조회 정의 + 정책 + 프로필 버전. */
export function packageDigest(portal: PortalConfig, profileVersion: string): string {
  return sha256hex(jcs({ ir: { id: H01.id, version: H01.version, steps: H01.steps }, portal, profileVersion }));
}
