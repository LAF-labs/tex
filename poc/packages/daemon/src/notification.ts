// 알림 출력 계약(D10 §2 notify, 08 P-07, 02 §17). 데몬이 내는 것은 이것뿐이다.
// - title은 고정 문구 키다. 문구는 notificationText가 키·payload로만 만든다(모델·외부 입력 문장 없음).
// - payload에는 금액·사업자번호·주민번호·이름·비밀이 없다: 작은 정수(일수·건수), 달(YYYY-MM), 서류 종류 키, 고정 열거값만.
//   assertSafePayload가 이를 강제하고 planNotifications가 낼 때마다 부른다.

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
  /** 만료까지 남은 날(0 = 오늘 만료) */
  daysLeft: number;
  /** 몇 일 전 알림 단계인가(remind_days 중 하나) */
  stage: number;
  /** 규칙표에서 나온 추정 날짜 */
  estimated: boolean;
}
export interface BundleReadyPayload {
  /** 꾸러미 달(반기납부면 반기 마지막 달) */
  month: string;
  halfYear: boolean;
  /** 비어 있거나 덜 된 항목 수(@sax/bundle missingReport.emptyItems) */
  missingCount: number;
}
export interface PayrollUnconfirmedPayload {
  month: string;
  state: 'none' | 'draft' | 'confirmed';
  /** 재직 중인데 줄이 없는 직원 수(이름은 넣지 않는다) */
  employeesWithoutLine: number;
}
export interface CardStalePayload {
  /** 마지막 최신화 뒤 지난 날. 한 번도 안 했으면 null */
  daysSinceFetch: number | null;
}

interface PayloadOf {
  'doc.expiring': DocExpiringPayload;
  'bundle.ready': BundleReadyPayload;
  'payroll.unconfirmed': PayrollUnconfirmedPayload;
  'card.stale': CardStalePayload;
}

interface NotificationBase<K extends NotificationKind> {
  /** 억제 키(같은 id는 한 번만, 그리고 하루 1회): kind:주제:단계 */
  id: string;
  kind: K;
  profileId: string;
  /** 문서 알림이면 documents.id(UUIDv4, 시각 비포함 D07) */
  docId?: string;
  /** 이 알림의 기준일(만료일·꾸러미 알림일) */
  dueOn: string;
  title: TitleKey;
  payload: PayloadOf[K];
  /** 누르면 갈 곳(이번 달 판·화면). 실행 시작은 없다 */
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
      return { title: '서류 만료가 다가와요', body: `${label(p.docType)} · ${when}${p.estimated ? ' (추정)' : ''}` };
    }
    case 'bundle.ready': {
      const p = n.payload;
      const what = p.halfYear ? `${monthLabel(p.month)}까지 반기` : monthLabel(p.month);
      return { title: '세무사 꾸러미 준비됨', body: p.missingCount ? `${what} 꾸러미 · 빠진 것 ${p.missingCount}개` : `${what} 꾸러미 · 다 모였어요` };
    }
    case 'payroll.unconfirmed': {
      const p = n.payload;
      const why = p.state === 'none' ? '급여대장이 아직 없어요' : p.state === 'draft' ? '급여대장을 아직 확인하지 않았어요' : `급여대장에 빠진 직원 ${p.employeesWithoutLine}명`;
      return { title: '확인 안 한 급여', body: `${monthLabel(p.month)} ${why}` };
    }
    case 'card.stale': {
      const p = n.payload;
      // 알림만 한다. 자동 조회는 없다(ADR-032 결정 3: [최신화]를 누르는 것이 곧 실행 승인)
      return { title: '사업용 카드 내역', body: p.daysSinceFetch === null ? '아직 가져온 적 없어요 · [최신화]를 눌러 주세요' : `${p.daysSinceFetch}일 전 최신화 · [최신화]를 눌러 주세요` };
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
