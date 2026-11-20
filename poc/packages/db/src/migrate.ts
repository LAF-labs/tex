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
    super(version === null ? code : `${code}:v${version}`, cause === undefined ? undefined : { cause });
    this.code = code;
    this.version = version;
  }
}

export interface MigrateOptions {
  migrations?: readonly Migration[];
  file?: string | null;
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

function freeBackupPath(file: string, fromVersion: number, at: Date): string {
  const base = backupName(file, fromVersion, at);
  if (!fs.existsSync(base)) return base;
  for (let n = 2; ; n++) {
    const p = base.replace(/\.bak$/, `-${n}.bak`);
    if (!fs.existsSync(p)) return p;
  }
}

function backup(db: Db, file: string, fromVersion: number, at: Date): string {
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
      throw new MigrationError('db.migration_failed', pending[0]!.version, e);
    }
  }
  const insert = (m: Migration, appliedAt: string) =>
    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, name, sha256, applied_at) VALUES (?, ?, ?, ?)').run(m.version, m.name, migrationSha256(m), appliedAt);

  let running: number | null = null;
  try {
    db.transaction(() => {
      db.exec(VERSION_TABLE);
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
    if (backupPath && rolledBackCleanly(db, current)) fs.rmSync(backupPath, { force: true });
    throw new MigrationError('db.migration_failed', running, e);
  }
  if (opts.file && backupPath) pruneBackups(opts.file, opts.keepBackups ?? 2);
  return { from: current, to: latest, applied: pending.map((m) => m.version), backup: backupPath };
}
