// D07 validity_rules·schedules 저장소와 데몬 스냅숏의 db 몫(데몬 #98 계약, 엔진 #91 data-service가 부른다).
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  BundleExportRepo, CardRepo, daemonProfileInputs, DaemonSettingsRepo, DEFAULT_VALIDITY_RULES, DocumentRepo, normalizeRemindDays, normalizeWindow, openDatabase, ProfileRepo, RunRepo,
  ScheduleRepo, syntheticBizNo, ValidityRuleRepo, type Db, type ScheduleConsent,
} from '@sax/db';

let dir: string;
let db: Db;
let profileId: string;
before(() => {
  dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sax-sched-'));
  db = openDatabase(path.join(dir, 'db.sqlite'), new Uint8Array(randomBytes(32)));
  profileId = new ProfileRepo(db).upsert({ kind: 'business', displayName: '가게', bizNo: syntheticBizNo(5), corpNo: null, repName: null, bizType: null, bizItem: null, address: null, email: null, signMethod: null }).id;
});
after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('유효기간 규칙표(D07 validity_rules, §3)', () => {
  it('행이 없으면 §3 초기값, 사용자가 바꾼 종류만 행으로 남고 문서 저장소의 덮어쓰기 읽기와 맞는다', () => {
    const r = new ValidityRuleRepo(db);
    const all = r.list();
    assert.equal(all.length, DEFAULT_VALIDITY_RULES.length);
    assert.deepEqual(r.get('biz_registration_cert'), { docType: 'biz_registration_cert', defaultDays: 90, rule: 'fixed_days', userOverrideDays: null, remindDays: '7,1' });
    assert.equal(r.get('sme_cert')!.rule, 'fiscal_year_rule');
    assert.equal(r.get('no_such'), null);
    assert.equal(db.prepare('SELECT COUNT(*) FROM validity_rules').pluck().get(), 0, '씨앗 행을 넣지 않는다');

    assert.deepEqual(r.setOverrideDays('biz_registration_cert', 60), { docType: 'biz_registration_cert', defaultDays: 90, rule: 'fixed_days', userOverrideDays: 60, remindDays: '7,1' });
    assert.equal(new DocumentRepo(db).overrideDays('biz_registration_cert'), 60, 'DocumentRepo가 읽는 칸');
    assert.equal(r.setRemindDays('biz_registration_cert', [1, 14, 7, 7]).remindDays, '14,7,1', '큰 것부터·중복 제거');
    assert.equal(r.get('biz_registration_cert')!.userOverrideDays, 60, '알림 날만 바꿔도 덮어쓴 일수 유지');
    assert.equal(r.list().length, DEFAULT_VALIDITY_RULES.length, '바꾼 행이 초기값을 대신한다');
    assert.equal(r.setOverrideDays('biz_registration_cert', null).userOverrideDays, null);
    assert.ok(r.reset('biz_registration_cert'));
    assert.equal(r.get('biz_registration_cert')!.remindDays, '7,1');

    assert.throws(() => r.setOverrideDays('tax_invoice', 30), /rule_has_no_expiry/);
    assert.throws(() => r.setOverrideDays('national_tax_cert', 0), /bad_override_days/);
    assert.throws(() => r.setOverrideDays('no_such', 30), /unknown_doc_type/);
    assert.throws(() => r.setOverrideDays('Bad-Type', 30), /bad_doc_type/);
    for (const bad of ['', '7,,1', '400', '-1', '1,2,3,4,5,6', 'a']) assert.throws(() => normalizeRemindDays(bad), /bad_remind_days/, bad);
    assert.equal(normalizeRemindDays(' 0 , 30 '), '30,0');
  });
});

describe('갱신 일정(D07 schedules, D10)', () => {
  const consent = (o: Partial<ScheduleConsent> = {}): ScheduleConsent => ({
    playbookId: 'hometax.biz_registration_cert', major: 1, effects: ['issue_document'], docType: 'biz_registration_cert', profileId, consentedAt: '2026-11-06T01:00:00Z', deviceSig: 'c2lnLXRlc3Q', ...o,
  });

  it('notify는 동의 없이, 기본 창은 매일 09~18, 동의는 null로 읽는다(데몬 ScheduleRow 모양)', () => {
    const s = new ScheduleRepo(db);
    const a = s.upsert({ profileId, docType: 'national_tax_cert', playbookId: 'hometax.national_tax_cert' });
    assert.deepEqual({ ...a, id: '' }, {
      id: '', profileId, docType: 'national_tax_cert', playbookId: 'hometax.national_tax_cert', mode: 'notify',
      windowJson: '{"days":[0,1,2,3,4,5,6],"from":"09:00","to":"18:00"}', consentJson: null, nextDueAt: null, lastRunId: null, enabled: true,
    });
    const b = s.upsert({ id: a.id, profileId, docType: 'national_tax_cert', playbookId: 'hometax.national_tax_cert', window: { days: [5, 1, 1, 3], from: '10:00', to: '24:00' } });
    assert.equal(b.windowJson, '{"days":[1,3,5],"from":"10:00","to":"24:00"}', '정렬·중복 제거');
    assert.equal(s.setEnabled(a.id, false).enabled, false);
    assert.equal(s.upsert({ id: a.id, profileId, docType: 'national_tax_cert', playbookId: 'hometax.national_tax_cert' }).enabled, false, '빠진 칸은 그대로');
    assert.equal(s.setNextDue(a.id, '2026-12-01').nextDueAt, '2026-12-01');
    assert.deepEqual(s.list(profileId).map((x) => x.id), [a.id]);
    assert.ok(s.delete(a.id));
    assert.equal(s.get(a.id), null);
  });

  it('semi_auto·auto는 이 일정에 결속된 동의 객체(B-27)가 있어야 저장, notify로 내리면 동의를 지운다', () => {
    const s = new ScheduleRepo(db);
    const base = { profileId, docType: 'biz_registration_cert', playbookId: 'hometax.biz_registration_cert' };
    assert.throws(() => s.upsert({ ...base, mode: 'semi_auto' }), /consent_required/);
    assert.throws(() => s.upsert({ ...base, mode: 'semi_auto', consent: consent({ docType: 'national_tax_cert' }) }), /consent_required/, '다른 서류 종류에 준 동의');
    assert.throws(() => s.upsert({ ...base, mode: 'auto', consent: consent({ effects: ['Send!'] }) }), /consent_required/);
    const x = s.upsert({ ...base, mode: 'semi_auto', consent: consent() });
    assert.deepEqual(JSON.parse(x.consentJson!), consent());
    assert.equal(s.upsert({ id: x.id, ...base, window: { days: [1], from: '09:00', to: '12:00' } }).consentJson, x.consentJson, '창만 바꾸면 동의 유지');
    const n = s.upsert({ id: x.id, ...base, mode: 'notify' });
    assert.equal(n.consentJson, null);
    s.delete(x.id);
  });

  it('입력 검사: 프로필·종류·플레이북 id·창·날짜, 만료 없는 종류는 일정 없음, 실행 기록은 runs 행이 있어야', () => {
    const s = new ScheduleRepo(db);
    const base = { profileId, docType: 'localtax_cert', playbookId: 'gov24.localtax_cert' };
    assert.throws(() => s.upsert({ ...base, profileId: randomUUID() }), /profile_not_found/);
    assert.throws(() => s.upsert({ ...base, docType: 'paper_receipt' }), /doc_type_not_renewable/);
    assert.throws(() => s.upsert({ ...base, playbookId: 'NoDots' }), /bad_playbook_id/);
    assert.throws(() => s.upsert({ ...base, window: { days: [], from: '09:00', to: '18:00' } }), /bad_window/);
    assert.throws(() => normalizeWindow({ days: [7], from: '09:00', to: '18:00' }), /bad_window/);
    assert.throws(() => normalizeWindow({ days: [1], from: '18:00', to: '09:00' }), /bad_window/);
    assert.throws(() => normalizeWindow({ days: [1], from: '9:00', to: '18:00' }), /bad_window/);
    assert.throws(() => s.upsert({ ...base, nextDueAt: '내일' }), /bad_next_due_at/);
    const a = s.upsert(base);
    assert.throws(() => s.upsert({ ...base, id: a.id, profileId: new ProfileRepo(db).upsert({ kind: 'personal', displayName: '본인', bizNo: null, corpNo: null, repName: null, bizType: null, bizItem: null, address: null, email: null, signMethod: null }).id }), /schedule_profile_mismatch/);
    assert.throws(() => s.recordRun(a.id, randomUUID()), /run_not_found/);
    assert.throws(() => s.setEnabled(randomUUID(), true), /schedule_not_found/);
    const runId = randomUUID();
    new RunRepo(db).create({ id: runId, playbookId: 'gov24.localtax_cert', playbookVersion: '1.0.0', packageDigest: 'a'.repeat(64), profileId, trigger: 'local', inputsHash: 'b'.repeat(64) });
    assert.equal(s.recordRun(a.id, runId).lastRunId, runId);
    s.delete(a.id);
  });
});

describe('데몬 스냅숏의 db 몫(daemonProfileInputs)', () => {
  it('규칙표·일정·설정(기본 알림 날 5일)·보낸 꾸러미 달(급여 기록 제외)·카드 최신화 한국 날짜', () => {
    const empty = daemonProfileInputs(db, profileId);
    assert.deepEqual(empty.settings, { reminderDay: 5, halfYearWithholding: false });
    assert.deepEqual(empty.bundleSentPeriods, []);
    assert.equal(empty.cardFetchedOn, null);
    assert.equal(empty.validityRules.length, DEFAULT_VALIDITY_RULES.length);

    const st = new DaemonSettingsRepo(db);
    assert.deepEqual(st.set(profileId, { reminderDay: 10, halfYearWithholding: true, fiscalYearEndMonth: 6, leadDays: 14 }), { reminderDay: 10, halfYearWithholding: true, fiscalYearEndMonth: 6, leadDays: 14 });
    assert.deepEqual(st.set(profileId, { fiscalYearEndMonth: null, leadDays: null }), { reminderDay: 10, halfYearWithholding: true }, 'null은 기본값으로');
    assert.throws(() => st.set(profileId, { reminderDay: 29 }), /bad_reminder_day/);
    assert.throws(() => st.set(profileId, { leadDays: 1.5 }), /bad_lead_days/);
    db.prepare("INSERT INTO settings (key, value_json) VALUES (?, '\"x\"') ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json").run(`profile.${profileId}.bundle.reminderDay`);
    assert.equal(st.get(profileId).reminderDay, 5, '깨진 값은 기본값');
    st.set(profileId, { reminderDay: 10 });

    const ex = new BundleExportRepo(db);
    const rec = (period: string) => ex.record({ profileId, period, sha256: 'c'.repeat(64), path: `/x/${period}.xlsx` }, '2026-11-01T00:00:00Z');
    const sep = rec('2026-09');
    rec('2026-10');
    const pay = rec('payroll:2026-01..2026-10');
    ex.markSent(sep.id);
    ex.markSent(pay.id);
    const run = randomUUID();
    new RunRepo(db).create({ id: run, playbookId: 'card.fetch', playbookVersion: '1.0.0', packageDigest: 'a'.repeat(64), profileId, trigger: 'local', inputsHash: 'b'.repeat(64) });
    new CardRepo(db).replaceRange({ runId: run, profileId, rangeFrom: '2026-10-01', rangeTo: '2026-10-31', completedAt: '2026-10-31T16:30:00Z' }, []);
    const s = new ScheduleRepo(db).upsert({ profileId, docType: 'sme_cert', playbookId: 'sminfo.sme_cert' });

    const got = daemonProfileInputs(db, profileId);
    assert.deepEqual(got.bundleSentPeriods, ['2026-09'], '보낸 달만, 급여 기록 내보내기는 빼고');
    assert.equal(got.cardFetchedOn, '2026-11-01', 'UTC 16:30 = 한국 다음 날');
    assert.deepEqual(got.schedules.map((x) => x.id), [s.id]);
    assert.deepEqual(got.settings, { reminderDay: 10, halfYearWithholding: true });
  });
});
