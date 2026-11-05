// 스키마 마이그레이션(D07 §7): 버전 테이블 + 순방향 전용, 앱 업데이트 시 자동 적용, 실패 시 이전 판 DB 백업 유지.
// - 대기 중인 판 전부를 트랜잭션 하나로 적용한다. 중간에 실패하면 SQLite가 통째로 되돌리고 DB는 이전 판 그대로다.
// - 적용 전에 DB 파일(암호문 그대로)을 같은 db 폴더에 백업한다. 이것은 **적용 전 상태의 사본**이다: 트랜잭션 되돌림 자체가
//   실패해 파일이 상했을 때(디스크 손상 등) 이전 판으로 돌아갈 곳이다. 새 판을 적용한 뒤의 복구 지점이 아니다(그건 다음 판 적용 때 다시 만든다).
// - 이미 적용한 판의 SQL이 바뀌었으면(sha256 불일치) 열지 않는다. 배포한 마이그레이션은 고치지 않고 새 판을 더한다.
// - DB가 앱보다 새 판이면 열지 않는다(옛 앱이 새 스키마를 망가뜨리지 않게).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3-multiple-ciphers';
import { MIGRATIONS, type Migration } from './schema.ts';

type Db = Database.Database;

export type MigrationErrorCode = 'db.schema_newer' | 'db.migration_failed' | 'db.migration_mismatch' | 'db.migration_invalid';

export class MigrationError extends Error {
  readonly code: MigrationErrorCode;
  readonly version: number | null;
  constructor(code: MigrationErrorCode, version: number | null, cause?: unknown) {
    // 메시지에는 코드와 판 번호만 둔다(값 없음 원칙, D12).
    super(version === null ? code : `${code}:v${version}`, cause === undefined ? undefined : { cause });
    this.code = code;
    this.version = version;
  }
}

export interface MigrateOptions {
  /** 시험용. 기본은 schema.ts의 MIGRATIONS */
  migrations?: readonly Migration[];
  /** 백업할 DB 파일 경로. 없으면(메모리 DB) 백업하지 않는다 */
  file?: string | null;
  /** 남겨 둘 백업 개수(가장 최근 것부터). 기본 2 */
  keepBackups?: number;
  now?: () => Date;
}

export interface MigrateResult {
  from: number;
  to: number;
  applied: number[];
  backup: string | null;
}

export interface AppliedMigration {
  version: number;
  name: string;
  sha256: string;
  appliedAt: string;
}

export const migrationSha256 = (m: Migration): string => createHash('sha256').update(m.sql).digest('hex');

const VERSION_TABLE = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY, name TEXT NOT NULL, sha256 TEXT NOT NULL, applied_at TEXT NOT NULL
)`;

function checkList(list: readonly Migration[]): void {
  list.forEach((m, i) => {
    if (m.version !== i + 1 || !m.name || !m.sql.trim()) throw new MigrationError('db.migration_invalid', m.version);
  });
}

function hasVersionTable(db: Db): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'`).get() !== undefined;
}

export function appliedMigrations(db: Db): AppliedMigration[] {
  if (!hasVersionTable(db)) return [];
  return (db.prepare('SELECT version, name, sha256, applied_at FROM schema_migrations ORDER BY version').all() as Array<Record<string, unknown>>).map((r) => ({
    version: Number(r.version),
    name: String(r.name),
    sha256: String(r.sha256),
    appliedAt: String(r.applied_at),
  }));
}

/** 백업 파일 이름: db.sqlite.pre-v3-20261105T101500Z.bak. 같은 db 폴더(같은 DACL)에 둔다. */
export function backupName(file: string, fromVersion: number, at: Date): string {
  const ts = at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return path.join(path.dirname(file), `${path.basename(file)}.pre-v${fromVersion}-${ts}.bak`);
}

export function listBackups(file: string): string[] {
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}.pre-v`;
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => n.startsWith(prefix) && n.endsWith('.bak'))
    .map((n) => ({ n, v: Number(/^\.pre-v(\d+)-/.exec(n.slice(path.basename(file).length))?.[1] ?? 0) }))
    .sort((a, b) => a.v - b.v || (a.n < b.n ? -1 : 1))
    .map(({ n }) => path.join(dir, n));
}

/** 같은 초에 다시 시도하면 이름이 겹친다. 겹치면 -2, -3…을 붙인다(COPYFILE_EXCL로 덮어쓰지 않는다) */
function freeBackupPath(file: string, fromVersion: number, at: Date): string {
  const base = backupName(file, fromVersion, at);
  if (!fs.existsSync(base)) return base;
  for (let n = 2; ; n++) {
    const p = base.replace(/\.bak$/, `-${n}.bak`);
    if (!fs.existsSync(p)) return p;
  }
}

function backup(db: Db, file: string, fromVersion: number, at: Date): string {
  // WAL 내용을 본 파일에 합친 뒤 복사한다. 파일은 암호문이라 사본도 같은 키로만 열린다.
  db.pragma('wal_checkpoint(TRUNCATE)');
  const dest = freeBackupPath(file, fromVersion, at);
  fs.copyFileSync(file, dest, fs.constants.COPYFILE_EXCL);
  if (process.platform !== 'win32') fs.chmodSync(dest, 0o600);
  return dest;
}

/** 실패 뒤 DB가 적용 전 판 그대로인지: 트랜잭션 밖이고, user_version이 같고, quick_check가 ok(아니면 이번 백업을 남긴다) */
export function rolledBackCleanly(db: Db, version: number): boolean {
  try {
    return !db.inTransaction && db.pragma('user_version', { simple: true }) === version && db.pragma('quick_check', { simple: true }) === 'ok';
  } catch {
    return false;
  }
}

/** 오래된 백업 정리. 마이그레이션이 성공한 뒤에만 부른다(실패한 시도가 복구 지점을 지우지 않게) */
function pruneBackups(file: string, keep: number): void {
  const all = listBackups(file);
  for (const old of all.slice(0, Math.max(0, all.length - keep))) fs.rmSync(old, { force: true });
}

/**
 * 백업으로 되돌린다. DB를 닫은 상태에서 부른다(복구 화면, ADR-029 흐름에서 사용자가 고른 뒤).
 * 지금 파일은 지우지 않고 `.unreadable-<ts>`로 옮겨 둔다(D07 §1.3과 같은 원칙).
 */
export function restoreBackup(file: string, backupPath: string, at: Date = new Date()): string | null {
  if (!listBackups(file).includes(backupPath)) throw new MigrationError('db.migration_invalid', null);
  let moved: string | null = null;
  if (fs.existsSync(file)) {
    moved = `${file}.unreadable-${at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`;
    fs.renameSync(file, moved);
  }
  for (const side of ['-wal', '-shm']) fs.rmSync(file + side, { force: true });
  fs.copyFileSync(backupPath, file);
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
  return moved;
}

export function migrate(db: Db, opts: MigrateOptions = {}): MigrateResult {
  const list = opts.migrations ?? MIGRATIONS;
  checkList(list);
  const latest = list.length;
  const now = opts.now ?? (() => new Date());
  const userVersion = Number(db.pragma('user_version', { simple: true }));
  const applied = appliedMigrations(db);
  const recorded = applied.reduce((m, a) => Math.max(m, a.version), 0);
  const current = Math.max(userVersion, recorded);

  if (current > latest) throw new MigrationError('db.schema_newer', current);
  for (const a of applied) {
    const m = list[a.version - 1];
    if (!m || migrationSha256(m) !== a.sha256) throw new MigrationError('db.migration_mismatch', a.version);
  }

  const pending = list.filter((m) => m.version > current);
  const needsBackfill = applied.length < current;
  if (!pending.length && !needsBackfill && hasVersionTable(db)) return { from: current, to: current, applied: [], backup: null };

  const at = now();
  let backupPath: string | null = null;
  if (pending.length && current > 0 && opts.file) {
    try {
      backupPath = backup(db, opts.file, current, at);
    } catch (e) {
      // 백업을 못 만들면 적용하지 않는다. DB는 그대로다
      throw new MigrationError('db.migration_failed', pending[0]!.version, e);
    }
  }
  const insert = (m: Migration, appliedAt: string) =>
    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, name, sha256, applied_at) VALUES (?, ?, ?, ?)').run(m.version, m.name, migrationSha256(m), appliedAt);

  let running: number | null = null;
  try {
    db.transaction(() => {
      db.exec(VERSION_TABLE);
      // 버전 테이블 이전 DB(user_version만 있던 PoC): 이미 적용된 판을 기록으로 채운다.
      for (const m of list) if (m.version <= current) insert(m, at.toISOString());
      for (const m of pending) {
        running = m.version;
        db.exec(m.sql);
        insert(m, at.toISOString());
      }
      running = null;
      db.pragma(`user_version=${latest}`);
    })();
  } catch (e) {
    // 되돌림이 끝나 DB가 이전 판 그대로임을 확인했을 때만 이번 사본을 지운다(재시도마다 사본이 쌓이지 않게).
    // 확인하지 못하면(되돌림 실패·파일 손상) 사본을 남긴다: 그때가 이 백업이 필요한 경우다. 프로세스가 도중에 죽어도 사본이 남는다
    if (backupPath && rolledBackCleanly(db, current)) fs.rmSync(backupPath, { force: true });
    throw new MigrationError('db.migration_failed', running, e);
  }
  if (opts.file && backupPath) pruneBackups(opts.file, opts.keepBackups ?? 2);
  return { from: current, to: latest, applied: pending.map((m) => m.version), backup: backupPath };
}
