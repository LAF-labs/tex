// 서류 종류별 유효기간 규칙(D07 §3)과 만료일·남은 기간. 날짜는 모두 한국 시간 달력 날짜(YYYY-MM-DD)다.
import type { DocMetaExtract, DocType, Field } from './extract.ts';

export interface ValidityRule {
  rule: 'fixed_days';
  /** 발급일을 포함해 센 날수. 만료일 = 발급일 + (days - 1). 초일 산입 여부는 실물로 확인 전이라 짧은 쪽(보수)으로 둔다. */
  days: number;
  /** 서류에 유효기간이 적히는가(적힌 값이 우선) */
  documentStates: boolean;
  basis: string;
}

export const VALIDITY_RULES: Record<DocType, ValidityRule> = {
  national_tax_cert: { rule: 'fixed_days', days: 30, documentStates: true, basis: '국세징수법 시행령 제96조: 발급일부터 30일, 납부고지된 국세가 있으면 그 지정납부기한까지' },
  biz_registration_cert: { rule: 'fixed_days', days: 90, documentStates: false, basis: '법정 유효기간 없음. 제출처 관행 기준 90일(D07 §3), 사용자가 바꿀 수 있다' },
};

/** 남은 기간 표시 출처: 문서에서 읽음 / 규칙표 추정 / 사용자가 확인·입력 */
export type ExpirySource = 'document' | 'rule' | 'user';

export interface ExpiryDecision {
  expiresOn: string | null;
  source: ExpirySource | null;
  /** 사용자 확인 없이 만료일을 확정하지 않는다(D17 §1 5단계) */
  needsUser: boolean;
  reasons: string[];
}

const DAY = 86_400_000;
const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);
const dayNum = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / DAY;

export function addDays(iso: string, days: number): string {
  return isoDay(Date.parse(`${iso}T00:00:00Z`) + days * DAY);
}

/** 한국 시간 오늘(UTC+9, 서머타임 없음) */
export function kstToday(now: Date = new Date()): string {
  return isoDay(now.getTime() + 9 * 3_600_000);
}

/** 만료일까지 남은 날. 만료일 당일 0, 지나면 음수. */
export function daysLeft(expiresOn: string, today: string): number {
  return Math.round(dayNum(expiresOn) - dayNum(today));
}

/**
 * 정하지 못한 유효기간(납세증명서)의 문서 후보 중 발급일 ~ 발급일 + 30일 안의 가장 이른 날짜(발급일을 모르면 가장 이른 후보).
 * 범위 밖 날짜는 쓸 수 없는 값이라 후보로 내지 않는다(넣으면 확인이 expires_after_legal_max로 거부된다).
 * 발급일을 고치면 쓸 수 있는 후보가 달라지므로, 후보 전부(options)가 있으면 그중에서 고른다.
 */
export function validityCandidate(f: Field, issued: string | null): string | undefined {
  const all = f.options ?? (f.suggested ? [f.suggested] : []);
  if (!issued) return all[0];
  const max = addDays(issued, VALIDITY_RULES.national_tax_cert.days);
  return all.find((d) => d >= issued && d <= max);
}

/**
 * 만료일 결정. 납세증명서는 문서에 적힌 유효기간이 발급일~발급일+30일 안에 있을 때만 쓴다.
 * 못 읽었거나 범위 밖이면 규칙표 값(짧은 쪽)을 쓰되 사용자 확인을 요구한다. 지정납부기한으로 짧아졌을 수 있어서다.
 * 정하지 못한 유효기간의 문서 후보가 규칙 값보다 이르면 그 후보를 쓴다(역시 확인 필요).
 */
export function decideExpiry(meta: DocMetaExtract, today: string, overrideDays?: number | null): ExpiryDecision {
  if (!meta.docType) return { expiresOn: null, source: null, needsUser: true, reasons: ['doc_type_unknown'] };
  const rule = VALIDITY_RULES[meta.docType];
  const issued = meta.issuedOn.value;
  const reasons: string[] = [];
  if (!issued) reasons.push(`issued_on_${meta.issuedOn.reason ?? 'not_found'}`);
  else if (issued > today || issued < '2000-01-01') reasons.push('issued_on_out_of_range');
  else if (meta.uncertain.includes('issuedOn')) reasons.push('issued_on_uncertain');
  // 사용자 조정 일수도 문서가 법정 유효기간을 갖는 종류(납세증명서)는 그 상한을 넘지 못한다
  const days = rule.documentStates ? Math.min(overrideDays ?? rule.days, rule.days) : (overrideDays ?? rule.days);
  const ruleExpiry = issued ? addDays(issued, days - 1) : null;
  if (!rule.documentStates) return { expiresOn: ruleExpiry, source: ruleExpiry ? 'rule' : null, needsUser: reasons.length > 0, reasons };
  const stated = meta.validUntil.value;
  if (stated && (!issued || (stated >= issued && stated <= addDays(issued, rule.days)))) {
    return { expiresOn: stated, source: 'document', needsUser: reasons.length > 0, reasons };
  }
  reasons.push(stated ? 'valid_until_out_of_range' : `valid_until_${meta.validUntil.reason ?? 'not_found'}`);
  // 유효기간을 정하지 못했어도(후보가 여럿, 오독 흔적) 발급일 이후 문서 후보 중 가장 이른 날짜가 규칙 날짜보다 이르면 그 날짜로 둔다.
  // 짧은 쪽(보수): 확인 전에도 문서보다 늦은 날짜를 보여 주지 않고, 그대로 확인해도 문서보다 늦은 날짜가 확인되지 않는다.
  const candidate = stated ? undefined : validityCandidate(meta.validUntil, issued);
  if (candidate && issued && ruleExpiry && candidate < ruleExpiry) return { expiresOn: candidate, source: 'document', needsUser: true, reasons };
  return { expiresOn: ruleExpiry, source: ruleExpiry ? 'rule' : null, needsUser: true, reasons };
}
