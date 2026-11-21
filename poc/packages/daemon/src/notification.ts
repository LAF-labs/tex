
export type NotificationKind = 'doc.expiring' | 'bundle.ready' | 'payroll.unconfirmed' | 'card.stale';

export type TitleKey = 'daemon.doc.expiring' | 'daemon.bundle.ready' | 'daemon.payroll.unconfirmed' | 'daemon.card.stale';

export const TITLE_KEY: Readonly<Record<NotificationKind, TitleKey>> = Object.freeze({
  'doc.expiring': 'daemon.doc.expiring',
  'bundle.ready': 'daemon.bundle.ready',
  'payroll.unconfirmed': 'daemon.payroll.unconfirmed',
  'card.stale': 'daemon.card.stale',
});

export interface DocExpiringPayload {
  docType: string;
  daysLeft: number;
  stage: number;
  estimated: boolean;
}
export interface BundleReadyPayload {
  month: string;
  halfYear: boolean;
  missingCount: number;
}
export interface PayrollUnconfirmedPayload {
  month: string;
  state: 'none' | 'draft' | 'confirmed';
  employeesWithoutLine: number;
}
export interface CardStalePayload {
  daysSinceFetch: number | null;
}

interface PayloadOf {
  'doc.expiring': DocExpiringPayload;
  'bundle.ready': BundleReadyPayload;
  'payroll.unconfirmed': PayrollUnconfirmedPayload;
  'card.stale': CardStalePayload;
}

interface NotificationBase<K extends NotificationKind> {
  id: string;
  kind: K;
  profileId: string;
  docId?: string;
  dueOn: string;
  title: TitleKey;
  payload: PayloadOf[K];
  target: { to: 'doc'; id: string } | { to: 'view'; view: 'bundle' | 'card' | 'payroll' };
}

export type DaemonNotification = { [K in NotificationKind]: NotificationBase<K> }[NotificationKind];

/** 서류 종류 표시 이름(D07 §3 표). 없으면 '서류' */
export const DOC_TYPE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  biz_registration_cert: '사업자등록증명',
  national_tax_cert: '납세증명서(국세)',
  resident_copy: '주민등록 등본',
  resident_abstract: '주민등록 초본',
  localtax_cert: '지방세 납세증명',
  localtax_item_cert: '지방세 세목별 과세증명',
  nhis_eligibility: '건강보험 자격득실확인서',
  land_register: '토지대장',
  building_register: '건축물대장',
  sme_cert: '중소기업확인서',
  insure4_cert: '4대보험 완납증명',
});

const label = (docType: string) => DOC_TYPE_LABELS[docType] ?? '서류';
const monthLabel = (m: string) => `${Number(m.slice(5, 7))}월`;

/** OS 알림·폰 알림 문구. 고정 문구 + payload의 숫자·달·종류 이름만 들어간다 */
export function notificationText(n: DaemonNotification): { title: string; body: string } {
  switch (n.kind) {
    case 'doc.expiring': {
      const p = n.payload;
      const when = p.daysLeft === 0 ? '오늘 만료돼요' : `${p.daysLeft}일 뒤 만료돼요`;
      return { title: '서류 만료가 다가와요', body: `${label(p.docType)}, ${when}${p.estimated ? ' (추정)' : ''}` };
    }
    case 'bundle.ready': {
      const p = n.payload;
      const what = p.halfYear ? `${monthLabel(p.month)}까지 반기` : monthLabel(p.month);
      return { title: '세무사 꾸러미 준비됨', body: p.missingCount ? `${what} 꾸러미, 빠진 것 ${p.missingCount}개` : `${what} 꾸러미, 다 모였어요` };
    }
    case 'payroll.unconfirmed': {
      const p = n.payload;
      const why = p.state === 'none' ? '급여대장이 아직 없어요' : p.state === 'draft' ? '급여대장을 아직 확인하지 않았어요' : `급여대장에 빠진 직원 ${p.employeesWithoutLine}명`;
      return { title: '확인 안 한 급여', body: `${monthLabel(p.month)} ${why}` };
    }
    case 'card.stale': {
      const p = n.payload;
      return { title: '사업용 카드 내역', body: p.daysSinceFetch === null ? '아직 가져온 적 없어요. [최신화]를 눌러 주세요' : `${p.daysSinceFetch}일 전 최신화, [최신화]를 눌러 주세요` };
    }
  }
}

export class UnsafePayloadError extends Error {
  readonly field: string;
  constructor(field: string) {
    super(`daemon.unsafe_payload:${field}`);
    this.field = field;
  }
}

/** 작은 정수 상한. 일수·건수는 이보다 작다. 금액(원)은 대개 이보다 크다 → 실수로 금액을 넣으면 걸린다 */
export const PAYLOAD_INT_MAX = 999;
const SAFE_STRING = /^(\d{4}-(0[1-9]|1[0-2])|[a-z][a-z0-9_]{0,40}|none|draft|confirmed)$/;

/** payload 안전 검사(금액·식별자 없음). 위반하면 던진다 */
export function assertSafePayload(p: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(p)) {
    if (v === null || typeof v === 'boolean') continue;
    if (typeof v === 'number') {
      if (!Number.isInteger(v) || Math.abs(v) > PAYLOAD_INT_MAX) throw new UnsafePayloadError(k);
      continue;
    }
    if (typeof v === 'string') {
      if (!SAFE_STRING.test(v)) throw new UnsafePayloadError(k);
      continue;
    }
    throw new UnsafePayloadError(k);
  }
}

/**
 * 폰 알림(P-07) 릴레이 큐 메시지 종류 **제안**(구현은 폰·클라우드 트랙). 데몬은 만들기만 하고 보내지 않는다.
 * docId·profileId는 빼고 문구 키와 payload만 싣는다(폰은 문구를 같은 표로 그린다). 봉투는 E2EE(D08), 서버는 종류만 본다.
 */
export interface DaemonRelayMessage {
  t: 'daemon.notify';
  v: 1;
  kind: NotificationKind;
  title: TitleKey;
  dueOn: string;
  payload: DaemonNotification['payload'];
}

export const toRelayMessage = (n: DaemonNotification): DaemonRelayMessage => ({ t: 'daemon.notify', v: 1, kind: n.kind, title: n.title, dueOn: n.dueOn, payload: { ...n.payload } });
