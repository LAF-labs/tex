// 데몬 알림 계획(D10 §2 notify, 02 §5·§17, ADR-032·033): 만료 단계, 월초 꾸러미(reminderDay·반기납부), 확인 안 한 급여,
// 카드 [최신화] 알림만, 일정 끔·강등, payload 안전(금액·식별자 없음), 고정 문구, 폰 릴레이 메시지 제안.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MissingReport } from '@sax/bundle';
import {
  assertSafePayload,
  bundlePeriod,
  decideSchedule,
  notificationText,
  planNotifications,
  toRelayMessage,
  UnsafePayloadError,
  type ProfileSnapshot,
  type ScheduleRow,
} from '@sax/daemon';

const P = 'prof-1';
const missing = (o: Partial<MissingReport> = {}): MissingReport => ({
  month: '2026-10',
  emptyItems: [],
  payroll: null,
  cardWithoutEvidence: [],
  memosNeedCheck: 0,
  cardSlipEnough: false,
  invoiceSumGaps: [],
  ...o,
});
const snap = (o: Partial<ProfileSnapshot> = {}): ProfileSnapshot => ({
  profileId: P,
  documents: [],
  validityRules: [],
  schedules: [],
  settings: { reminderDay: 5, halfYearWithholding: false },
  bundleSentPeriods: [],
  missing: null,
  cardFetchedOn: '2026-11-02',
  ...o,
});
const sched = (o: Partial<ScheduleRow> = {}): ScheduleRow => ({ id: 's1', profileId: P, docType: 'national_tax_cert', playbookId: 'hometax.tax_cert', mode: 'notify', windowJson: null, consentJson: null, nextDueAt: null, enabled: true, ...o });
const ids = (s: ProfileSnapshot, today: string) => planNotifications(s, today).notifications.map((n) => n.notification.id);
/** 서류 알림만(이 묶음의 스냅숏은 꾸러미 알림 날 뒤라 꾸러미 알림이 함께 나온다) */
const docIds = (s: ProfileSnapshot, today: string) => ids(s, today).filter((i) => i.startsWith('doc.'));
const taxDoc = { id: 'd1', docType: 'national_tax_cert', displayName: '납세증명서(국세)', issuedAt: '2026-11-01', expiresAt: '2026-11-30', meta: null };

describe('서류 만료 알림', () => {
  it('D-8에는 없고 D-7에 7단계, D-1에 1단계(만료일이 id에 들어가 날짜를 고치면 새 알림)', () => {
    const s = snap({ documents: [taxDoc] });
    assert.deepEqual(docIds(s, '2026-11-22'), []);
    assert.deepEqual(docIds(s, '2026-11-23'), ['doc.expiring:d1:2026-11-30:7']);
    assert.deepEqual(docIds(s, '2026-11-29'), ['doc.expiring:d1:2026-11-30:1']);
    assert.deepEqual(docIds(s, '2026-11-30'), ['doc.expiring:d1:2026-11-30:1']);
    assert.deepEqual(docIds(s, '2026-12-01'), []);
  });
  it('알림 모양: docId·dueOn(만료일)·고정 문구 키·payload(종류·남은 날·단계·추정)', () => {
    const [p] = planNotifications(snap({ documents: [taxDoc] }), '2026-11-23').notifications;
    assert.deepEqual(p!.notification, {
      id: 'doc.expiring:d1:2026-11-30:7',
      kind: 'doc.expiring',
      profileId: P,
      docId: 'd1',
      dueOn: '2026-11-30',
      title: 'daemon.doc.expiring',
      payload: { docType: 'national_tax_cert', daysLeft: 7, stage: 7, estimated: false },
      target: { to: 'doc', id: 'd1' },
    });
    assert.deepEqual(notificationText(p!.notification), { title: '서류 만료가 다가와요', body: '납세증명서(국세) · 7일 뒤 만료돼요' });
  });
  it('사용자가 끈 일정(enabled=0)의 종류는 알리지 않는다', () => {
    assert.deepEqual(docIds(snap({ documents: [taxDoc], schedules: [sched({ enabled: false })] }), '2026-11-23'), []);
  });
  it('semi_auto·auto 일정도 notify로 강등하고 원인 코드를 남긴다(Phase 1). 동의 결속이 깨졌으면 consent_missing', () => {
    const ok = JSON.stringify({ playbookId: 'hometax.tax_cert', major: 1, effects: ['issue_document'], docType: 'national_tax_cert', profileId: P, consentedAt: '2026-11-01T00:00:00Z', deviceSig: 'sig' });
    assert.deepEqual(decideSchedule(sched({ mode: 'semi_auto', consentJson: ok })).reasons, ['daemon.demoted_to_notify']);
    assert.deepEqual(decideSchedule(sched({ mode: 'auto', consentJson: '{}' })).reasons, ['daemon.demoted_to_notify', 'daemon.consent_missing']);
    assert.equal(decideSchedule(sched({ mode: 'auto' })).mode, 'notify');
    const plan = planNotifications(snap({ documents: [taxDoc], schedules: [sched({ mode: 'auto', consentJson: ok })] }), '2026-11-23');
    assert.equal(plan.notifications.filter((n) => n.notification.kind === 'doc.expiring').length, 1);
  });
  it('일정 창(window_json)을 알림 창으로 쓰고, 깨진 창은 기본 창 + window_invalid', () => {
    const w = planNotifications(snap({ documents: [taxDoc], schedules: [sched({ windowJson: '{"days":[1,2,3,4,5],"from":"10:00","to":"12:00"}' })] }), '2026-11-23').notifications[0]!.window;
    assert.deepEqual(w, { days: [1, 2, 3, 4, 5], fromMin: 600, toMin: 720 });
    const d = decideSchedule(sched({ windowJson: '{"days":[9],"from":"10:00","to":"09:00"}' }));
    assert.deepEqual(d.reasons, ['daemon.window_invalid']);
    assert.deepEqual(d.window, { days: [0, 1, 2, 3, 4, 5, 6], fromMin: 540, toMin: 1080 });
  });
  it('다른 프로필의 일정은 무시한다', () => {
    assert.deepEqual(docIds(snap({ documents: [taxDoc], schedules: [sched({ profileId: 'other', enabled: false })] }), '2026-11-23'), ['doc.expiring:d1:2026-11-30:7']);
  });
});

describe('월초 세무사 꾸러미 준비됨(bundle.reminderDay)', () => {
  it('알림 날 전에는 없고, 그날부터 그 달 말까지 지난달 꾸러미를 알린다', () => {
    assert.equal(bundlePeriod('2026-11-04', 5, false), null);
    assert.deepEqual(bundlePeriod('2026-11-05', 5, false), { period: '2026-10', remindOn: '2026-11-05', until: '2026-11-30' });
    assert.deepEqual(bundlePeriod('2026-11-30', 5, false)?.period, '2026-10');
    assert.equal(bundlePeriod('2026-12-04', 5, false), null);
  });
  it('반기납부(payroll.halfYearWithholding)면 1·7월에만', () => {
    assert.equal(bundlePeriod('2026-11-05', 5, true), null);
    assert.deepEqual(bundlePeriod('2027-01-05', 5, true)?.period, '2026-12');
    assert.deepEqual(bundlePeriod('2027-07-05', 5, true)?.period, '2027-06');
    const n = planNotifications(snap({ settings: { reminderDay: 5, halfYearWithholding: true }, cardFetchedOn: '2027-01-02' }), '2027-01-05').notifications[0]!.notification;
    assert.equal(n.kind, 'bundle.ready');
    assert.deepEqual(notificationText(n).body, '12월까지 반기 꾸러미 · 다 모였어요');
  });
  it('reminderDay가 그 달 날 수를 넘으면 말일', () => {
    assert.deepEqual(bundlePeriod('2027-02-28', 31, false)?.remindOn, '2027-02-28');
  });
  it('빠진 것 수는 @sax/bundle missingReport에서, 보낸 꾸러미는 다시 알리지 않는다', () => {
    const m = missing({ emptyItems: [{ itemId: 'i1', name: '급여대장', tier: 1, period: '2026-10', status: 'missing' }, { itemId: 'i2', name: '종이 증빙', tier: 1, period: '2026-10', status: 'partial' }] });
    const n = planNotifications(snap({ missing: m }), '2026-11-05').notifications.find((x) => x.notification.kind === 'bundle.ready')!.notification;
    assert.deepEqual(n.payload, { month: '2026-10', halfYear: false, missingCount: 2 });
    assert.equal(notificationText(n).body, '10월 꾸러미 · 빠진 것 2개');
    assert.deepEqual(ids(snap({ missing: m, bundleSentPeriods: ['2026-10'] }), '2026-11-05'), []);
  });
  it('다른 달의 missingReport는 쓰지 않는다(빠진 것 0으로)', () => {
    const n = planNotifications(snap({ missing: missing({ month: '2026-09', emptyItems: [{ itemId: 'i', name: 'x', tier: 1, period: '2026-09', status: 'missing' }] }) }), '2026-11-05').notifications[0]!.notification;
    assert.equal((n.payload as { missingCount: number }).missingCount, 0);
  });
});

describe('확인 안 한 급여·카드 최신화', () => {
  it('missingReport.payroll이 있으면 확인 안 한 급여(직원 이름은 빼고 수만)', () => {
    const m = missing({ payroll: { state: 'draft', revision: 1, employeesWithoutLine: [{ id: 'e1', name: '홍길동' }] } });
    const n = planNotifications(snap({ missing: m }), '2026-11-05').notifications.find((x) => x.notification.kind === 'payroll.unconfirmed')!.notification;
    assert.deepEqual(n.payload, { month: '2026-10', state: 'draft', employeesWithoutLine: 1 });
    assert.ok(!JSON.stringify(n).includes('홍길동'));
    assert.equal(notificationText(n).body, '10월 급여대장을 아직 확인하지 않았어요');
  });
  it('급여 확인이 끝났으면(payroll null) 알리지 않는다', () => {
    assert.ok(!ids(snap({ missing: missing() }), '2026-11-05').some((i) => i.startsWith('payroll.')));
  });
  it('카드: 이번 달 1일 이후 최신화했으면 없음, 전이면 "n일 전 최신화", 한 번도 안 했으면 null. 자동 조회 없음', () => {
    assert.ok(!ids(snap({ cardFetchedOn: '2026-11-01' }), '2026-11-05').some((i) => i.startsWith('card.')));
    const n = planNotifications(snap({ cardFetchedOn: '2026-10-20' }), '2026-11-05').notifications.find((x) => x.notification.kind === 'card.stale')!.notification;
    assert.deepEqual(n.payload, { daysSinceFetch: 16 });
    assert.equal(notificationText(n).body, '16일 전 최신화 · [최신화]를 눌러 주세요');
    assert.deepEqual(n.target, { to: 'view', view: 'card' });
    const never = planNotifications(snap({ cardFetchedOn: null }), '2026-11-05').notifications.find((x) => x.notification.kind === 'card.stale')!.notification;
    assert.deepEqual(never.payload, { daysSinceFetch: null });
  });
  it('알림 날이 아니면 꾸러미·급여·카드 알림이 없다', () => {
    assert.deepEqual(ids(snap({ cardFetchedOn: null, missing: missing({ payroll: { state: 'none', revision: null, employeesWithoutLine: [] } }) }), '2026-11-04'), []);
  });
  it('순서: 만료(남은 날 적은 것) → 꾸러미 → 급여 → 카드', () => {
    const s = snap({ documents: [taxDoc, { ...taxDoc, id: 'd2', docType: 'localtax_cert', expiresAt: '2026-11-06' }], cardFetchedOn: null, missing: missing({ payroll: { state: 'none', revision: null, employeesWithoutLine: [] } }) });
    assert.deepEqual(
      planNotifications({ ...s, settings: { reminderDay: 5, halfYearWithholding: false } }, '2026-11-05').notifications.map((n) => n.notification.kind),
      ['doc.expiring', 'bundle.ready', 'payroll.unconfirmed', 'card.stale'],
    );
  });
});

describe('payload 안전과 폰 릴레이 제안(P-07)', () => {
  it('금액(큰 수)·소수·사업자번호·이름·객체는 payload에 못 들어간다', () => {
    assert.throws(() => assertSafePayload({ amount: 1_250_000 }), UnsafePayloadError);
    assert.throws(() => assertSafePayload({ n: 1.5 }), UnsafePayloadError);
    assert.throws(() => assertSafePayload({ bizNo: '123-45-67890' }), UnsafePayloadError);
    assert.throws(() => assertSafePayload({ name: '홍길동' }), UnsafePayloadError);
    assert.throws(() => assertSafePayload({ o: { a: 1 } }), UnsafePayloadError);
    assert.doesNotThrow(() => assertSafePayload({ month: '2026-10', docType: 'sme_cert', daysLeft: 7, estimated: true, daysSinceFetch: null, state: 'draft' }));
  });
  it('계획의 모든 payload가 안전 검사를 통과한다(여러 상황)', () => {
    const s = snap({ documents: [taxDoc], cardFetchedOn: null, missing: missing({ payroll: { state: 'confirmed', revision: 2, employeesWithoutLine: [{ id: 'e', name: '김' }] } }) });
    for (const day of ['2026-11-05', '2026-11-23', '2026-11-29']) for (const p of planNotifications(s, day).notifications) assertSafePayload(p.notification.payload as unknown as Record<string, unknown>);
  });
  it('릴레이 메시지는 docId·profileId 없이 종류·문구 키·기준일·payload만', () => {
    const n = planNotifications(snap({ documents: [taxDoc] }), '2026-11-23').notifications[0]!.notification;
    const m = toRelayMessage(n);
    assert.deepEqual(Object.keys(m).sort(), ['dueOn', 'kind', 'payload', 't', 'title', 'v']);
    assert.equal(m.t, 'daemon.notify');
    assert.ok(!JSON.stringify(m).includes('d1') && !JSON.stringify(m).includes(P));
  });
  it('잘못된 오늘 날짜는 거부한다', () => {
    assert.throws(() => planNotifications(snap(), '2026-13-01'), /invalid_today/);
  });
});
