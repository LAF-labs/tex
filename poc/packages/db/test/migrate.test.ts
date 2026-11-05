// M1-2 마이그레이션 체계(D07 §7): 버전 테이블, 순방향, 실패 시 통째 되돌림·백업, 새 판 DB 거부, 배포한 판 SQL 변경 거부.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { appliedMigrations, backupName, isEncryptedFile, listBackups, MIGRATIONS, MigrationError, openDatabase, restoreBackup, type Migration } from '@sax/db';

const dirs: string[] = [];
const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sax-mig-'));
  dirs.push(d);
  return path.join(d, 'db.sqlite');
};
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const key = () => new Uint8Array(randomBytes(32));
const tables = (db: ReturnType<typeof openDatabase>): string[] =>
  (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as Array<{ name: string }>).map((r) => r.name);

// D07 §2 요약 DDL의 테이블 전부
const D07_TABLES = [
  'bundle_entries', 'bundle_exports', 'bundle_items', 'card_fetches', 'card_txn_memos', 'card_txns', 'cash_sales', 'clock_guard', 'cooldowns', 'counterparties',
  'documents', 'employees', 'gate_requests', 'irreversible_log', 'payroll_lines', 'payroll_months', 'playbook_packages', 'policy', 'profiles', 'rate_counters',
  'rate_tables', 'receipts', 'registry_state', 'remote_cmd_seen', 'remote_devices', 'remote_pair_state', 'run_events', 'runs', 'schedules', 'settings', 'shifts',
  'temp_previews', 'usage_local', 'validity_rules',
];

describe('스키마 마이그레이션(D07 §7)', () => {
  it('새 DB: D07 §2 테이블 전부 + 버전 테이블, user_version = 최신 판, 백업 없음', () => {
    const file = tmp();
    const db = openDatabase(file, key());
    assert.deepEqual(tables(db).filter((t) => t !== 'schema_migrations'), D07_TABLES);
    assert.equal(db.pragma('user_version', { simple: true }), MIGRATIONS.length);
    assert.deepEqual(appliedMigrations(db).map((m) => m.version), MIGRATIONS.map((m) => m.version));
    assert.equal(db.pragma('foreign_key_check').length, 0);
    db.close();
    assert.deepEqual(listBackups(file), []);
    assert.ok(isEncryptedFile(file));
  });

  it('버전 테이블 이전(PoC v2, user_version만) DB: 기록을 채우고 v3~ 적용, 기존 행 유지, 적용 전 암호문 백업', () => {
    const file = tmp();
    const k = key();
    const v2 = openDatabase(file, k, { migrations: MIGRATIONS.slice(0, 2) });
    v2.prepare(`INSERT INTO settings (key, value_json) VALUES ('x', '1')`).run();
    // PoC 판은 버전 테이블이 없었다
    v2.exec('DROP TABLE schema_migrations');
    assert.equal(v2.pragma('user_version', { simple: true }), 2);
    v2.close();

    const db = openDatabase(file, k);
    assert.equal(db.pragma('user_version', { simple: true }), MIGRATIONS.length);
    assert.deepEqual(appliedMigrations(db).map((m) => m.version), MIGRATIONS.map((m) => m.version));
    assert.equal(db.prepare(`SELECT value_json FROM settings WHERE key='x'`).pluck().get(), '1');
    db.close();
    const backups = listBackups(file);
    assert.equal(backups.length, 1);
    assert.match(path.basename(backups[0]!), /^db\.sqlite\.pre-v2-\d{8}T\d{6}Z\.bak$/);
    assert.ok(isEncryptedFile(backups[0]!), '백업도 암호문');
    if (process.platform !== 'win32') assert.equal(fs.statSync(backups[0]!).mode & 0o777, 0o600);
    // 백업은 같은 키로 열리고 v2 그대로다
    const b = openDatabase(backups[0]!, k, { migrations: MIGRATIONS.slice(0, 2) });
    assert.equal(b.pragma('user_version', { simple: true }), 2);
    assert.ok(!tables(b).includes('employees'));
    b.close();
  });

  it('실패하면 대기 중인 판 전부를 되돌린다: DB는 이전 판 그대로, 오류는 판 번호만, 기존 백업은 지우지 않는다', () => {
    const file = tmp();
    const k = key();
    openDatabase(file, k, { migrations: MIGRATIONS.slice(0, 1) }).close();
    for (const n of [2, 3]) openDatabase(file, k, { migrations: MIGRATIONS.slice(0, n), now: () => new Date(Date.UTC(2026, 10, 5, 10, n)) }).close();
    const before = listBackups(file);
    assert.equal(before.length, 2);
    const broken: Migration[] = [...MIGRATIONS.slice(0, 4), { version: 5, name: 'broken', sql: 'CREATE TABLE ok_part (x INTEGER); CREATE TABLE settings (dup TEXT);' }];
    assert.throws(
      () => openDatabase(file, k, { migrations: broken }),
      (e: unknown) => e instanceof MigrationError && e.code === 'db.migration_failed' && e.version === 5 && e.message === 'db.migration_failed:v5',
    );
    const db = openDatabase(file, k, { migrations: MIGRATIONS.slice(0, 3) });
    assert.equal(db.pragma('user_version', { simple: true }), 3, 'v4도 되돌려졌다(한 트랜잭션)');
    assert.ok(!tables(db).includes('employees') && !tables(db).includes('ok_part'));
    db.close();
    assert.deepEqual(listBackups(file), before, '실패한 시도는 오래된 복구 지점을 지우지 않고, 사본도 남기지 않는다');
    // 같은 초에 다시 실패해도 EEXIST가 아니라 MigrationError
    const at = () => new Date(Date.UTC(2026, 10, 5, 12));
    for (let i = 0; i < 2; i++) assert.throws(() => openDatabase(file, k, { migrations: broken, now: at }), (e: unknown) => e instanceof MigrationError && e.code === 'db.migration_failed');
    assert.deepEqual(listBackups(file), before);
  });

  it('같은 이름의 백업이 이미 있으면 -2를 붙이고, 정리는 성공한 뒤에만 한다', () => {
    const file = tmp();
    const k = key();
    openDatabase(file, k, { migrations: MIGRATIONS.slice(0, 2) }).close();
    const at = new Date(Date.UTC(2026, 10, 5, 13));
    fs.writeFileSync(backupName(file, 2, at), 'x');
    const db = openDatabase(file, k, { migrations: MIGRATIONS.slice(0, 3), now: () => at });
    db.close();
    assert.deepEqual(listBackups(file).map((b) => path.basename(b)), ['db.sqlite.pre-v2-20261105T130000Z-2.bak', 'db.sqlite.pre-v2-20261105T130000Z.bak'].sort());
  });

  it('앱보다 새 판 DB는 열지 않는다', () => {
    const file = tmp();
    const k = key();
    openDatabase(file, k).close();
    assert.throws(() => openDatabase(file, k, { migrations: MIGRATIONS.slice(0, 3) }), (e: unknown) => e instanceof MigrationError && e.code === 'db.schema_newer');
  });

  it('이미 적용한 판의 SQL이 바뀌면 열지 않는다(배포한 마이그레이션은 고치지 않는다)', () => {
    const file = tmp();
    const k = key();
    openDatabase(file, k, { migrations: MIGRATIONS.slice(0, 2) }).close();
    const edited = MIGRATIONS.slice(0, 2).map((m) => (m.version === 2 ? { ...m, sql: m.sql + '\n-- edited' } : m));
    assert.throws(() => openDatabase(file, k, { migrations: edited }), (e: unknown) => e instanceof MigrationError && e.code === 'db.migration_mismatch' && e.version === 2);
  });

  it('판 번호는 1부터 빈틈없이', () => {
    assert.throws(() => openDatabase(tmp(), key(), { migrations: [MIGRATIONS[0]!, { version: 3, name: 'gap', sql: 'SELECT 1' }] }), /db\.migration_invalid/);
    MIGRATIONS.forEach((m, i) => assert.equal(m.version, i + 1));
  });

  it('백업은 최근 2개만 남기고, restoreBackup은 지금 파일을 .unreadable-로 옮긴 뒤 되돌린다', () => {
    const file = tmp();
    const k = key();
    openDatabase(file, k, { migrations: MIGRATIONS.slice(0, 1) }).close();
    for (const n of [2, 3, 4]) openDatabase(file, k, { migrations: MIGRATIONS.slice(0, n), now: () => new Date(Date.UTC(2026, 10, 5, 10, n)) }).close();
    const backups = listBackups(file);
    assert.deepEqual(backups.map((b) => path.basename(b).replace(/-\d{8}T\d{6}Z\.bak$/, '')), ['db.sqlite.pre-v2', 'db.sqlite.pre-v3']);
    const moved = restoreBackup(file, backups[0]!, new Date(Date.UTC(2026, 10, 5, 11)));
    assert.ok(moved && fs.existsSync(moved) && /\.unreadable-20261105T110000Z$/.test(moved));
    const db = openDatabase(file, k, { migrations: MIGRATIONS.slice(0, 2) });
    assert.equal(db.pragma('user_version', { simple: true }), 2);
    db.close();
    assert.throws(() => restoreBackup(file, path.join(path.dirname(file), 'elsewhere.bak')), /db\.migration_invalid/);
  });
});
