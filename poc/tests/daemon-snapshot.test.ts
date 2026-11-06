// daemon.snapshot(엔진 main 전용 읽기 질의, D10 §3) → @sax/daemon DaemonSnapshot 계약(#100 주석 예시).
// 정책 null·프로필 0개·여러 프로필, 읽기 전용(DB 변경 없음), 꾸러미 알림 달 셈이 데몬 bundlePeriod와 같은지, 데몬이 그대로 받는지 본다.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { BundleService, bundleReminderPeriod, type DaemonSnapshotResult, type ProfileSnapshotRow } from '@sax/bundle';
import { daemonGate, bundlePeriod, planNotifications, type DaemonSnapshot, type ProfileSnapshot } from '@sax/daemon';
import { ColumnCipher, DaemonSettingsRepo, deriveColumnKey, DocumentRepo, EmployeeRepo, openDatabase, ProfileRepo, syntheticBizNo, type Db } from '@sax/db';
import type { Policy, RegistryStatus } from '@sax/engine/core';
import { COMMANDS, DAEMON_READ_QUERIES, MAIN_ONLY, PAYROLL_MAIN_ONLY, READ_QUERIES, RUN_COMMANDS } from '@sax/engine/protocol';

type P = Pick<Policy, 'expiresAt' | 'daemon'>;
type S = Pick<RegistryStatus, 'issuedAt' | 'expiresAt'>;
// 타입 계약: 엔진 응답이 데몬 DaemonSnapshot·ProfileSnapshot에 그대로 들어간다
const _snap: DaemonSnapshot = {} as DaemonSnapshotResult<P, S>;
const _prof: ProfileSnapshot = {} as ProfileSnapshotRow;
void _snap;
void _prof;

const NOW = new Date('2026-11-06T01:00:00.000Z'); // 한국 2026-11-06, 기본 알림 날 5일 → 꾸러미 달 2026-10
const root = path.resolve(import.meta.dirname, '..');
const entry = fs.readFileSync(path.join(root, 'packages/engine/src/entry.ts'), 'utf8');

function open(tag: string): { dir: string; db: Db; cipher: ColumnCipher } {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `sax-daemon-snap-${tag}-`));
  const key = new Uint8Array(randomBytes(32));
  return { dir, db: openDatabase(path.join(dir, 'db.sqlite'), key), cipher: new ColumnCipher(deriveColumnKey(key)) };
}
const changes = (db: Db): number => db.prepare('SELECT total_changes()').pluck().get() as number;

describe('daemon.snapshot 목록·배선', () => {
  it('main 전용 읽기 질의 하나, 기존 목록과 겹치지 않고, entry.ts가 BundleService로 보낸다', () => {
    assert.deepEqual([...DAEMON_READ_QUERIES], ['daemon.snapshot']);
    const others = new Set<string>([...READ_QUERIES, ...COMMANDS, ...RUN_COMMANDS, ...MAIN_ONLY, ...PAYROLL_MAIN_ONLY]);
    assert.ok(!others.has('daemon.snapshot'));
    assert.ok(entry.includes('for (const m of DAEMON_READ_QUERIES) {\n  PAYROLL.add(m);\n  ALLOWED.add(m);\n}'));
    assert.ok(entry.indexOf('if (PAYROLL.has(method))') < entry.indexOf('return data.handle(method, params);'));
  });

  it('꾸러미 알림 달 셈은 데몬 bundlePeriod와 같다(2026년 모든 날 × 알림 날 1·5·28·31 × 반기 여부)', () => {
    for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 86_400_000) {
      const day = new Date(t).toISOString().slice(0, 10);
      for (const rd of [1, 5, 28, 31]) for (const h of [false, true]) assert.equal(bundleReminderPeriod(day, rd, h), bundlePeriod(day, rd, h)?.period ?? null, `${day} ${rd} ${h}`);
    }
  });
});

describe('daemon.snapshot: 정책 null·프로필 0개', () => {
  let ctx: ReturnType<typeof open>;
  before(() => (ctx = open('empty')));
  after(() => {
    ctx.db.close();
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  });

  it('정책·status를 받은 적 없으면 null, 프로필이 없으면 빈 배열. 데몬은 policy none·status daemon_stop으로 본다(알림은 낸다)', async () => {
    const svc = new BundleService(ctx.db, ctx.cipher, { exportDir: path.join(ctx.dir, 'x'), now: () => NOW });
    const before = changes(ctx.db);
    const snap = (await svc.handle('daemon.snapshot', {})) as DaemonSnapshot;
    assert.deepEqual(snap, { policy: null, status: null, profiles: [] });
    assert.equal(changes(ctx.db), before, '읽기 전용');
    const g = daemonGate(snap, NOW.getTime());
    assert.deepEqual([g.notify, g.run, g.policy, g.status], [true, false, 'none', 'daemon_stop']);
  });
});

describe('daemon.snapshot: 여러 프로필', () => {
  let ctx: ReturnType<typeof open>;
  let biz: string;
  let personal: string;
  before(() => {
    ctx = open('multi');
    const base = { corpNo: null, repName: null, bizType: null, bizItem: null, address: null, email: null, signMethod: null };
    const profiles = new ProfileRepo(ctx.db);
    biz = profiles.upsert({ kind: 'business', displayName: '가게', bizNo: syntheticBizNo(21), ...base }).id;
    personal = profiles.upsert({ kind: 'personal', displayName: '개인', bizNo: null, ...base }).id;
    new EmployeeRepo(ctx.db, ctx.cipher).create({ profileId: biz, name: '김직원', birthDate: '1990-01-01', hiredOn: '2025-01-02', basePay: 2_500_000, dependents: 1, rrn: '900101-1234567' });
    // 개인 프로필은 알림 날 20일 → 오늘(11-06)은 꾸러미 알림 달이 아니다
    new DaemonSettingsRepo(ctx.db).set(personal, { reminderDay: 20 });
    const docs = new DocumentRepo(ctx.db);
    for (const [profileId, docType] of [[biz, 'biz_registration_cert'], [biz, 'tax_payment_cert'], [personal, 'resident_registration']] as const) {
      const content = Buffer.from(randomUUID());
      docs.insert({
        id: randomUUID(), profileId, docType, displayName: docType, issuedAt: '2026-10-01', expiresAt: null, issuer: '홈택스',
        path: path.join(ctx.dir, `${docType}.pdf`), bytes: content.length, sha256: createHash('sha256').update(content).digest('hex'), meta: null, runId: null,
      });
    }
  });
  after(() => {
    ctx.db.close();
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  });

  it('프로필마다 db 몫·서류·빠진 것. 서류는 그 프로필 것만, 경로·해시 없음. 꾸러미 알림 달이 아니면 missing null. 읽기 전용', async () => {
    const svc = new BundleService(ctx.db, ctx.cipher, { exportDir: path.join(ctx.dir, 'x'), now: () => NOW });
    const before = changes(ctx.db);
    const snap = (await svc.handle('daemon.snapshot', {})) as DaemonSnapshot;
    assert.equal(changes(ctx.db), before, '읽기 전용(쓰기 없음)');
    assert.deepEqual(snap.profiles.map((p) => p.profileId).sort(), [biz, personal].sort());
    const b = snap.profiles.find((p) => p.profileId === biz)!;
    const p = snap.profiles.find((x) => x.profileId === personal)!;
    assert.deepEqual(b.documents.map((d) => d.docType).sort(), ['biz_registration_cert', 'tax_payment_cert']);
    assert.deepEqual(p.documents.map((d) => d.docType), ['resident_registration']);
    for (const d of [...b.documents, ...p.documents]) assert.deepEqual(Object.keys(d).sort(), ['displayName', 'docType', 'expiresAt', 'id', 'issuedAt', 'meta']);
    assert.equal(b.settings.reminderDay, 5);
    assert.equal(b.missing?.month, '2026-10', '오늘(11-06)은 기본 5일 뒤라 10월 꾸러미');
    assert.equal(b.missing?.payroll?.state, 'none', '직원이 있으니 급여 기능 켜짐 → 10월 급여 없음');
    assert.equal(p.settings.reminderDay, 20);
    assert.equal(p.missing, null);
    const json = JSON.stringify(snap);
    assert.ok(!json.includes('1234567') && !json.includes(ctx.dir), '주민번호·보관함 경로 없음');
    // 데몬이 그대로 받는다
    for (const prof of snap.profiles) assert.doesNotThrow(() => planNotifications(prof, '2026-11-06'));
    assert.ok(planNotifications(b, '2026-11-06').notifications.some((n) => n.notification.id.startsWith('bundle.')), '꾸러미 알림 후보');
  });

  it('정책·status는 데몬이 쓰는 칸만 낸다(서명·다른 정책 값은 빼고)', async () => {
    const daemon = { windowJitterMin: 20, startupGraceMin: 5, retryAfterMin: 15 };
    const policy = { expiresAt: '2026-11-09T00:00:00Z', issuedAt: '2026-11-02T00:00:00Z', daemon, portalMode: { hometax: 'postprocess' }, signatures: ['sig'] };
    const status = { issuedAt: '2026-11-05T00:00:00Z', expiresAt: '2026-11-07T00:00:00Z', killPlaybooks: ['x'], signatures: ['sig'] };
    const svc = new BundleService(ctx.db, ctx.cipher, { exportDir: path.join(ctx.dir, 'x'), now: () => NOW, daemon: { policy: () => policy, status: () => status } });
    const snap = (await svc.handle('daemon.snapshot', {})) as DaemonSnapshot;
    assert.deepEqual(snap.policy, { expiresAt: '2026-11-09T00:00:00Z', daemon });
    assert.deepEqual(snap.status, { issuedAt: '2026-11-05T00:00:00Z', expiresAt: '2026-11-07T00:00:00Z' });
    const g = daemonGate(snap, NOW.getTime());
    assert.deepEqual([g.policy, g.status, g.run], ['fresh', 'fresh', false]);
  });
});
