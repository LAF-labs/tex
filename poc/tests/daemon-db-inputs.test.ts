// 데몬(#98) ← db 저장소 계약: daemonProfileInputs + DocumentRepo가 ProfileSnapshot 모양 그대로이고, 규칙표·일정을 바꾸면 데몬 결과가 따라 바뀐다.
// 엔진 daemon.snapshot(#91 data-service)은 이 둘에 missingReport만 더하면 된다.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { computeExpiries, planNotifications, type ProfileSnapshot, type ScheduleRow as DaemonScheduleRow, type ValidityRuleRow as DaemonRuleRow } from '@sax/daemon';
import { daemonProfileInputs, DocumentRepo, openDatabase, ProfileRepo, ScheduleRepo, syntheticBizNo, ValidityRuleRepo, type Db, type ScheduleRow, type ValidityRuleRow } from '@sax/db';

// 타입 계약: db 행은 데몬 행에 그대로 들어간다
const _rule: DaemonRuleRow = {} as ValidityRuleRow;
const _sched: DaemonScheduleRow = {} as ScheduleRow;
void _rule;
void _sched;

describe('데몬 입력 ← db 저장소(validity_rules·schedules·설정)', () => {
  let dir: string;
  let db: Db;
  let profileId: string;
  before(() => {
    dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sax-daemon-db-'));
    db = openDatabase(path.join(dir, 'db.sqlite'), new Uint8Array(randomBytes(32)));
    profileId = new ProfileRepo(db).upsert({ kind: 'business', displayName: '가게', bizNo: syntheticBizNo(7), corpNo: null, repName: null, bizType: null, bizItem: null, address: null, email: null, signMethod: null }).id;
    new DocumentRepo(db).insert({
      id: 'doc-biz', profileId, docType: 'biz_registration_cert', displayName: '사업자등록증명', issuedAt: '2026-09-01', expiresAt: null, issuer: '홈택스',
      path: '/v/biz.pdf', bytes: 1, sha256: 'a'.repeat(64), meta: null, runId: null,
    });
  });
  after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const snapshot = (): ProfileSnapshot => ({
    ...daemonProfileInputs(db, profileId),
    documents: new DocumentRepo(db).list().filter((d) => d.profileId === profileId),
    missing: null,
  });
  const docAlerts = (today: string) => planNotifications(snapshot(), today).notifications.map((n) => n.notification.id).filter((id) => id.startsWith('doc.'));

  it('규칙표 초기값(90일) → 사용자 덮어쓰기(60일)가 만료일에 반영, 알림 날 바꾸면 단계가 바뀐다', () => {
    const s0 = snapshot();
    const [e0] = computeExpiries(s0.documents, s0.validityRules, { today: '2026-11-06' });
    assert.ok(e0 && e0.expiresOn && e0.basis === 'rule' && e0.estimated);
    new ValidityRuleRepo(db).setOverrideDays('biz_registration_cert', 60);
    const s1 = snapshot();
    const [e1] = computeExpiries(s1.documents, s1.validityRules, { today: '2026-11-06' });
    assert.equal(Date.parse(e0.expiresOn!) - Date.parse(e1!.expiresOn!), 30 * 86_400_000, '30일 앞당겨짐');

    const d7 = new Date(Date.parse(e1!.expiresOn!) - 7 * 86_400_000).toISOString().slice(0, 10);
    const d14 = new Date(Date.parse(e1!.expiresOn!) - 14 * 86_400_000).toISOString().slice(0, 10);
    assert.deepEqual(docAlerts(d14), [], '기본 7,1이면 D-14 알림 없음');
    assert.deepEqual(docAlerts(d7), [`doc.expiring:doc-biz:${e1!.expiresOn}:7`]);
    new ValidityRuleRepo(db).setRemindDays('biz_registration_cert', '14,3');
    assert.deepEqual(docAlerts(d14), [`doc.expiring:doc-biz:${e1!.expiresOn}:14`]);
  });

  it('일정을 끄면 그 서류 알림이 멈추고, 켜면 다시(데몬 decideSchedules가 db 행을 그대로 읽는다)', () => {
    const [e] = computeExpiries(snapshot().documents, snapshot().validityRules, { today: '2026-11-06' });
    const d3 = new Date(Date.parse(e!.expiresOn!) - 3 * 86_400_000).toISOString().slice(0, 10);
    const s = new ScheduleRepo(db).upsert({ profileId, docType: 'biz_registration_cert', playbookId: 'hometax.biz_registration_cert', enabled: false });
    assert.equal(planNotifications(snapshot(), d3).schedules.get('biz_registration_cert')?.notify, false);
    assert.deepEqual(docAlerts(d3), []);
    new ScheduleRepo(db).setEnabled(s.id, true);
    assert.deepEqual(docAlerts(d3), [`doc.expiring:doc-biz:${e!.expiresOn}:3`]);
    assert.deepEqual(planNotifications(snapshot(), d3).schedules.get('biz_registration_cert')?.reasons, [], 'notify 행은 원인 코드 없음');
  });
});
