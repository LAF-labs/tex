// 데몬 만료 계산(D10 §4, D07 §3): expires_at 우선, 규칙표 대체(fixed_days·fiscal_year_rule), 추정 표시, 옛 서류 제외, 판 입력 모양.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BoardDoc } from '../apps/desktop/src/board.ts';
import { computeExpiries, expiryStage, fiscalYearExpiry, parseRemindDays, toBoardDocs, type DaemonBoardDoc, type ExpiryDocInput, type ValidityRuleRow } from '@sax/daemon';

const doc = (o: Partial<ExpiryDocInput> & { id: string }): ExpiryDocInput => ({ docType: 'national_tax_cert', displayName: '납세증명서(국세)', issuedAt: '2026-11-01', expiresAt: null, meta: null, ...o });
const rule = (o: Partial<ValidityRuleRow> & { docType: string }): ValidityRuleRow => ({ defaultDays: 90, rule: 'fixed_days', userOverrideDays: null, remindDays: '7,1', ...o });

describe('만료일 출처', () => {
  it('documents.expires_at이 있으면 그 값과 엔진 meta.expiry 출처·확인 필요를 그대로 쓴다', () => {
    const [e] = computeExpiries([doc({ id: 'a', expiresAt: '2026-11-30', meta: { expiry: { source: 'document', needsUser: false, reasons: [] } } })], [], { today: '2026-11-06' });
    assert.equal(e!.expiresOn, '2026-11-30');
    assert.equal(e!.basis, 'document');
    assert.equal(e!.estimated, false);
    assert.equal(e!.daysLeft, 24);
  });
  it('엔진이 규칙표 값으로 둔 날짜(source rule)는 추정이고, needsUser가 따라온다', () => {
    const [e] = computeExpiries([doc({ id: 'a', expiresAt: '2026-11-30', meta: { expiry: { source: 'rule', needsUser: true, reasons: ['valid_until_not_found'] } } })], [], { today: '2026-11-06' });
    assert.equal(e!.basis, 'rule');
    assert.equal(e!.estimated, true);
    assert.equal(e!.needsUser, true);
  });
  it('meta 없이 expires_at만 있으면 사용자가 넣은 값으로 본다(추정 아님)', () => {
    const [e] = computeExpiries([doc({ id: 'a', expiresAt: '2026-12-01' })], [], { today: '2026-11-06' });
    assert.equal(e!.basis, 'user');
    assert.equal(e!.estimated, false);
  });
  it('사업자등록증명 90일(사용자 결정 11-01): 규칙표로 발급일 포함 90일, 추정 표시', () => {
    const [e] = computeExpiries([doc({ id: 'b', docType: 'biz_registration_cert', displayName: '사업자등록증명', issuedAt: '2026-11-01' })], [rule({ docType: 'biz_registration_cert' })], { today: '2026-11-06' });
    assert.equal(e!.expiresOn, '2027-01-29'); // 11-01 + 89일
    assert.equal(e!.estimated, true);
    assert.equal(toBoardDocs([e!])[0]!.name, '사업자등록증명 (추정)');
  });
  it('사용자 조정 일수(user_override_days)가 기본값보다 우선한다', () => {
    const [e] = computeExpiries([doc({ id: 'b', docType: 'biz_registration_cert', issuedAt: '2026-11-01' })], [rule({ docType: 'biz_registration_cert', userOverrideDays: 30 })], { today: '2026-11-06' });
    assert.equal(e!.expiresOn, '2026-11-30');
  });
  it('규칙 none·규칙 없음·발급일 없음이면 만료 미정이고 알림 단계가 없다', () => {
    const out = computeExpiries(
      [doc({ id: 'n', docType: 'tax_invoice' }), doc({ id: 'x', docType: 'unknown' }), doc({ id: 'y', docType: 'biz_registration_cert', issuedAt: null })],
      [rule({ docType: 'tax_invoice', rule: 'none', defaultDays: null }), rule({ docType: 'biz_registration_cert' })],
      { today: '2026-11-06' },
    );
    assert.deepEqual(out.map((e) => e.expiresOn), [null, null, null]);
    assert.deepEqual(toBoardDocs(out), []);
  });
});

describe('회계연도 규칙(중소기업확인서)', () => {
  it('12월 결산: 4월 1일 ~ 다음 해 3월 31일 구간', () => {
    assert.equal(fiscalYearExpiry('2026-05-10'), '2027-03-31');
    assert.equal(fiscalYearExpiry('2026-04-01'), '2027-03-31'); // 경계: 구간 첫날
    assert.equal(fiscalYearExpiry('2026-03-31'), '2026-03-31'); // 경계: 전 구간 마지막 날
    assert.equal(fiscalYearExpiry('2026-01-15'), '2026-03-31');
  });
  it('6월 결산: 10월 1일 ~ 다음 해 9월 30일', () => {
    assert.equal(fiscalYearExpiry('2026-10-01', 6), '2027-09-30');
    assert.equal(fiscalYearExpiry('2026-09-30', 6), '2026-09-30');
  });
  it('2월 결산(윤년 말일)', () => {
    assert.equal(fiscalYearExpiry('2028-06-01', 2), '2029-05-31');
  });
  it('computeExpiries가 fiscal_year_rule 행을 평가하고 추정으로 표시한다', () => {
    const [e] = computeExpiries([doc({ id: 's', docType: 'sme_cert', issuedAt: '2026-05-10' })], [rule({ docType: 'sme_cert', rule: 'fiscal_year_rule', defaultDays: null })], { today: '2026-11-06' });
    assert.equal(e!.expiresOn, '2027-03-31');
    assert.equal(e!.basis, 'fiscal_year_rule');
    assert.equal(e!.estimated, true);
  });
});

describe('알림 단계와 다음 기한', () => {
  it('remind_days 해석: 기본 7,1, 큰 것부터, 잘못된 값은 기본', () => {
    assert.deepEqual(parseRemindDays('7,1'), [7, 1]);
    assert.deepEqual(parseRemindDays('1, 30 ,7,7'), [30, 7, 1]);
    assert.deepEqual(parseRemindDays('abc'), [7, 1]);
    assert.deepEqual(parseRemindDays(null), [7, 1]);
    assert.deepEqual(parseRemindDays('0'), [0]);
  });
  it('단계 경계: D-8 없음, D-7 → 7, D-2 → 7, D-1 → 1, 당일 → 1, 지남 → 없음', () => {
    assert.equal(expiryStage(8, [7, 1]), null);
    assert.equal(expiryStage(7, [7, 1]), 7);
    assert.equal(expiryStage(2, [7, 1]), 7);
    assert.equal(expiryStage(1, [7, 1]), 1);
    assert.equal(expiryStage(0, [7, 1]), 1);
    assert.equal(expiryStage(-1, [7, 1]), null);
    assert.equal(expiryStage(0, [30, 7, 0]), 0);
  });
  it('next_due_at = 만료일 − lead_days(기본 7), 제출 예정일이 있으면 그날', () => {
    const docs = [doc({ id: 'a', expiresAt: '2026-11-30' }), doc({ id: 'b', docType: 'localtax_cert', expiresAt: '2026-11-30' })];
    const out = computeExpiries(docs, [], { today: '2026-11-06', submitOn: { b: '2026-11-20' } });
    assert.equal(out.find((e) => e.docId === 'a')!.nextDueOn, '2026-11-23');
    assert.equal(out.find((e) => e.docId === 'b')!.nextDueOn, '2026-11-20');
    assert.equal(computeExpiries([docs[0]!], [], { today: '2026-11-06', leadDays: 3 })[0]!.nextDueOn, '2026-11-27');
  });
});

describe('옛 서류와 판 입력', () => {
  it('같은 종류에 더 새로 발급한 서류가 있으면 옛 서류는 superseded, 판·알림에서 빠진다', () => {
    const out = computeExpiries(
      [doc({ id: 'old', issuedAt: '2026-10-01', expiresAt: '2026-10-30' }), doc({ id: 'new', issuedAt: '2026-11-01', expiresAt: '2026-11-30' })],
      [],
      { today: '2026-11-06' },
    );
    assert.equal(out.find((e) => e.docId === 'old')!.superseded, true);
    assert.equal(out.find((e) => e.docId === 'new')!.superseded, false);
    assert.deepEqual(toBoardDocs(out).map((d) => d.id), ['new']);
  });
  it('입력 순서와 무관하게 만료일 → id 순', () => {
    const a = [doc({ id: 'b', docType: 't1', expiresAt: '2026-12-01' }), doc({ id: 'a', docType: 't2', expiresAt: '2026-11-20' })];
    assert.deepEqual(computeExpiries(a, [], { today: '2026-11-06' }).map((e) => e.docId), ['a', 'b']);
    assert.deepEqual(computeExpiries([...a].reverse(), [], { today: '2026-11-06' }).map((e) => e.docId), ['a', 'b']);
  });
  it('DaemonBoardDoc은 데스크톱 board.ts BoardDoc과 서로 대입된다(모양이 같다)', () => {
    const x: DaemonBoardDoc = { id: 'a', name: 'n', expiresOn: null, needsUser: false };
    const y: BoardDoc = x;
    const z: DaemonBoardDoc = y;
    assert.deepEqual(Object.keys(z).sort(), ['expiresOn', 'id', 'name', 'needsUser']);
  });
});
