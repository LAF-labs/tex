import { domainToASCII } from 'node:url';
import { jcs, sha256hex } from '../gate.ts';
import { READBACK_FIELDS, type PortalConfig, type ReadbackKey, type SelectorKey } from '../portal.ts';

// H-01 전자세금계산서 건별발급(D02 §8 v2.1)의 발급 구간. 로그인(s0~s6)·decide(모델)·캡차(s90~)·signFlow·save_pdf는
// PoC-3 이후에 붙인다. 스텝 id는 D02 §8과 같게 둔다.

export type Phase = 'login' | 'form' | 'input' | 'readback' | 'gate' | 'sign' | 'verify' | 'mail';

export type Cond =
  | { fieldsFilled: ReadbackKey[] }
  /** readback 값과 참조 값을 정규화해 비교한다(B-05). 대표 용도는 supplierBizNo == $profile.bizNo. */
  | { readbackEquals: { fieldKey: ReadbackKey; ref: string } }
  /** readback 값으로 합계 = 공급가액 + 세액(D02 §4.1). 바의 합계 줄이 실제 발급 금액과 다르지 않게. */
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
    // 포털이 미리 채운 이전 주소를 지우거나 덮는다(B-05).
    { id: 's15', phase: 'input', type: 'fill', target: 'form.counterpartEmail', value: '$inputs.email', ifAbsent: 'clear' },
    { id: 's16', phase: 'input', type: 'fill', target: 'form.itemName', value: '$inputs.items[0].name' },
    { id: 's17', phase: 'input', type: 'fill', target: 'form.supplyAmount', value: '$inputs.amounts.supply' },
    { id: 's18', phase: 'input', type: 'fill', target: 'form.taxAmount', value: '$inputs.amounts.tax' },
    { id: 's19a', phase: 'readback', type: 'assert', cond: { fieldsFilled: ['counterpartBizNo', 'itemName', 'supplyAmount', 'taxAmount', 'issueDate'] }, code: 'assert.fields_missing' },
    { id: 's19b', phase: 'readback', type: 'readback', fields: READBACK_FIELDS },
    { id: 's19c', phase: 'readback', type: 'assert', cond: { readbackEquals: { fieldKey: 'supplierBizNo', ref: '$profile.bizNo' } }, code: 'assert.supplier_mismatch' },
    { id: 's19d', phase: 'readback', type: 'assert', cond: { sumEquals: { parts: ['supplyAmount', 'taxAmount'], total: 'totalAmount' } }, code: 'assert.total_mismatch' },
    // 작성일자(과세기간)가 의도(KST 오늘)와 다르면 게이트를 열지 않는다(N-26).
    { id: 's19e', phase: 'readback', type: 'assert', cond: { readbackEquals: { fieldKey: 'issueDate', ref: '$inputs.issueDate' } }, code: 'assert.issue_date_mismatch' },
    { id: 's20', phase: 'gate', type: 'gate', authorizes: ['s21'], waitMs: 600_000 },
    // signFlow(간편인증·인증서·보안카드)는 PoC-3에서 실제 순서를 본 뒤 X 안에 넣는다(D02 §4.5).
    { id: 's21', phase: 'sign', type: 'submit', target: 'form.issueButton', verify: 's30' },
    { id: 's30', phase: 'verify', type: 'verify', lookup: 'invoice', baseline: 'pre_gate_snapshot', on: { committed: 's33', not_committed: 's36', unknown: 's37' } },
    // skipUnless email: 승인한 받는 이메일(readback counterpartEmail)이 있을 때만.
    { id: 's33', phase: 'mail', type: 'verify', lookup: 'mail', baseline: 'none', skipUnless: 'email', on: { committed: 's34', not_committed: 's35', unknown: 's35' } },
    { id: 's34', phase: 'mail', type: 'end', status: 'success' },
    { id: 's35', phase: 'mail', type: 'end', status: 'completed_with_issues', code: 'mail.not_confirmed' },
    // D02 §8은 not_committed → s11(재게이트)이다. PoC는 실행을 끝내고 다시 준비하게 한다(새 의도).
    { id: 's36', phase: 'verify', type: 'end', status: 'failed', code: 'verify.not_committed' },
    { id: 's37', phase: 'verify', type: 'end', status: 'handoff', code: 'verify.unknown' },
  ] satisfies Step[] as Step[],
};

// ---- 값 정규화(readback·비교·해시가 같은 함수를 쓴다) ----

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
