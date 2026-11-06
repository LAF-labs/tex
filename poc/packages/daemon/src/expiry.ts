// 만료 계산(D10 §4, D07 §3 유효기간 규칙표).
// - documents.expires_at이 우선이다. 이 값은 엔진(DocumentService.decideExpiry)이 문서를 넣을 때 정했다: 문서에서 읽은 값은
//   규칙 범위 안일 때만 쓰고, 아니면 규칙표 값 + 사용자 확인(needsUser). 데몬은 그 결정을 다시 하지 않고 meta.expiry를 읽는다.
// - expires_at이 없으면 validity_rules 행으로 계산한다(fixed_days, fiscal_year_rule). 둘 다 없으면 "만료 미정"이고 알리지 않는다.
// - 규칙표에서 나온 날짜는 추정이다(사업자등록증명 90일은 제출처 관행, 사용자 결정 2026-11-01: "추정"으로 표시).
// - 같은 종류에 더 새 서류가 있으면 옛 서류는 superseded로 두고 알리지 않는다(다시 발급한 뒤 옛 알림이 계속 뜨지 않게).
import type { DocumentRow } from '@sax/db';
import { addDays, addMonthsToDay, daysBetween, isDate, lastDayOf } from './time.ts';

/** D07 validity_rules 한 행 */
export interface ValidityRuleRow {
  docType: string;
  defaultDays: number | null;
  rule: 'fixed_days' | 'fiscal_year_rule' | 'none';
  userOverrideDays: number | null;
  /** 알림 날짜(만료 n일 전, 쉼표 구분). D07 기본 '7,1' */
  remindDays: string;
}

/** documents 행 중 만료 계산에 쓰는 칸(DocumentRow와 구조가 같다) */
export type ExpiryDocInput = Pick<DocumentRow, 'id' | 'docType' | 'displayName' | 'issuedAt' | 'expiresAt' | 'meta'>;

export type ExpiryBasis = 'document' | 'user' | 'rule' | 'fiscal_year_rule';

export interface Expiry {
  docId: string;
  docType: string;
  /** 사람이 읽는 이름(문서함 display_name). 알림 payload에는 넣지 않는다 */
  name: string;
  expiresOn: string | null;
  basis: ExpiryBasis | null;
  /** 규칙표에서 나온 날짜(문서에 적힌 값·사용자 확인 값이 아님) → 화면에 "추정" */
  estimated: boolean;
  /** 사용자 확인 필요(엔진 meta.expiry.needsUser) */
  needsUser: boolean;
  /** 오늘부터 만료일까지(당일 0, 지나면 음수) */
  daysLeft: number | null;
  /** schedules.next_due_at 후보: 제출 예정일이 있으면 그날, 없으면 만료일 − lead_days */
  nextDueOn: string | null;
  /** 알림 날짜(만료 n일 전), 큰 것부터 */
  remindDays: number[];
  /** 같은 종류에 더 새 서류가 있다(알리지 않는다) */
  superseded: boolean;
}

export interface ExpiryOptions {
  /** 한국 시간 오늘 */
  today: string;
  /** D10 §4 lead_days(기본 7, 사용자 조정) */
  leadDays?: number;
  /** 사업연도 끝 달(1~12, 기본 12월). fiscal_year_rule 평가용 */
  fiscalYearEndMonth?: number;
  /** 문서별 제출 예정일(D10 §4 "제출 예정일 입력 시 그 날짜 기준") */
  submitOn?: Readonly<Record<string, string>>;
}

/** D07 remind_days 기본값 */
export const DEFAULT_REMIND_DAYS = '7,1';
/** D10 §4 lead_days 기본값 */
export const DEFAULT_LEAD_DAYS = 7;

/** '7,1' → [7, 1]. 0~365 정수만, 큰 것부터, 중복 제거. 읽을 수 없으면 기본값 */
export function parseRemindDays(s: string | null | undefined): number[] {
  const parse = (x: string) =>
    [...new Set(x.split(',').map((p) => p.trim()).filter((p) => /^\d{1,3}$/.test(p)).map(Number).filter((n) => n <= 365))].sort((a, b) => b - a);
  const v = parse(s ?? '');
  return v.length ? v : parse(DEFAULT_REMIND_DAYS);
}

/**
 * 중소기업확인서형 회계연도 규칙(D07 §3 "직전 사업연도 말일 + 3개월부터 1년"). 발급일이 들어가는 유효 구간의 마지막 날.
 * 구간 = [사업연도 말일 + 3개월 다음 날, 사업연도 말일 + 15개월]. 12월 결산이면 4월 1일 ~ 다음 해 3월 31일.
 */
export function fiscalYearExpiry(issuedOn: string, fyEndMonth = 12): string {
  const m = String(Math.min(12, Math.max(1, Math.trunc(fyEndMonth)))).padStart(2, '0');
  const year = Number(issuedOn.slice(0, 4));
  let y = year;
  // 발급일 이전(당일 포함)에 시작한 구간 중 가장 늦은 것. 결산 달이 어떻든 두 해 안에 있다.
  while (y > year - 2 && addDays(addMonthsToDay(lastDayOf(`${y}-${m}`), 3), 1) > issuedOn) y--;
  return addMonthsToDay(lastDayOf(`${y}-${m}`), 15);
}

interface MetaExpiry {
  source?: unknown;
  needsUser?: unknown;
}

function fromRow(d: ExpiryDocInput): { expiresOn: string; basis: ExpiryBasis; needsUser: boolean } | null {
  if (!isDate(d.expiresAt)) return null;
  const e = ((d.meta ?? {}) as { expiry?: MetaExpiry }).expiry;
  const src = e?.source;
  const basis: ExpiryBasis = src === 'rule' ? 'rule' : src === 'document' ? 'document' : 'user';
  return { expiresOn: d.expiresAt, basis, needsUser: e?.needsUser === true };
}

function fromRule(d: ExpiryDocInput, r: ValidityRuleRow | undefined, fyEndMonth: number): { expiresOn: string; basis: ExpiryBasis } | null {
  if (!r || !isDate(d.issuedAt)) return null;
  if (r.rule === 'fixed_days') {
    const days = r.userOverrideDays ?? r.defaultDays;
    if (!days || days < 1) return null;
    // 엔진 decideExpiry와 같은 셈: 발급일 포함 days일 → 만료일 = 발급일 + (days − 1)
    return { expiresOn: addDays(d.issuedAt, days - 1), basis: 'rule' };
  }
  if (r.rule === 'fiscal_year_rule') return { expiresOn: fiscalYearExpiry(d.issuedAt, fyEndMonth), basis: 'fiscal_year_rule' };
  return null;
}

/** 문서마다 만료일·남은 날·알림 날짜. 입력 순서와 무관하게 만료일 → id 순으로 낸다 */
export function computeExpiries(docs: readonly ExpiryDocInput[], rules: readonly ValidityRuleRow[], opts: ExpiryOptions): Expiry[] {
  const byType = new Map(rules.map((r) => [r.docType, r]));
  const lead = Number.isInteger(opts.leadDays) && opts.leadDays! >= 0 ? opts.leadDays! : DEFAULT_LEAD_DAYS;
  const fy = opts.fiscalYearEndMonth ?? 12;
  const out: Expiry[] = docs.map((d) => {
    const rule = byType.get(d.docType);
    const row = fromRow(d);
    const calc = row ?? fromRule(d, rule, fy);
    const expiresOn = calc?.expiresOn ?? null;
    const basis = calc?.basis ?? null;
    const submit = opts.submitOn?.[d.id];
    return {
      docId: d.id,
      docType: d.docType,
      name: d.displayName ?? d.docType,
      expiresOn,
      basis,
      estimated: basis === 'rule' || basis === 'fiscal_year_rule',
      needsUser: row?.needsUser ?? false,
      daysLeft: expiresOn ? daysBetween(opts.today, expiresOn) : null,
      nextDueOn: isDate(submit) ? submit : expiresOn ? addDays(expiresOn, -lead) : null,
      remindDays: parseRemindDays(rule?.remindDays),
      superseded: false,
    };
  });
  // 종류별 가장 새 서류(발급일, 같으면 만료일)만 알림 대상
  const newest = new Map<string, Expiry>();
  const key = (e: Expiry) => `${docs.find((d) => d.id === e.docId)?.issuedAt ?? ''}|${e.expiresOn ?? ''}|${e.docId}`;
  for (const e of out) {
    if (!e.expiresOn) continue;
    const cur = newest.get(e.docType);
    if (!cur || key(e) > key(cur)) newest.set(e.docType, e);
  }
  for (const e of out) if (e.expiresOn && newest.get(e.docType) !== e) e.superseded = true;
  return out.sort((a, b) => (a.expiresOn ?? '9999').localeCompare(b.expiresOn ?? '9999') || a.docId.localeCompare(b.docId));
}

/**
 * 데스크톱 이번 달 판 "만료가 다가오는 서류" 카드 입력(apps/desktop/src/board.ts BoardDoc과 같은 모양).
 * 옛 서류·만료 미정은 빼고, 추정 날짜는 이름 뒤에 "(추정)"을 붙인다(BoardDoc에 추정 칸이 없어서. 칸이 생기면 estimated를 그리로).
 */
export interface DaemonBoardDoc {
  id: string;
  name: string;
  expiresOn: string | null;
  needsUser: boolean;
}

export const toBoardDocs = (expiries: readonly Expiry[]): DaemonBoardDoc[] =>
  expiries
    .filter((e) => e.expiresOn && !e.superseded)
    .map((e) => ({ id: e.docId, name: e.estimated ? `${e.name} (추정)` : e.name, expiresOn: e.expiresOn, needsUser: e.needsUser }));
