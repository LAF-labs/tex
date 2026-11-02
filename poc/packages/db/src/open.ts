import fs from 'node:fs';
import Database from 'better-sqlite3-multiple-ciphers';
import { MIGRATIONS } from './schema.ts';

export type Db = Database.Database;

/**
 * 암호화 DB 열기(D07 §1.3). 키는 금고 getDbKeyOnce()로 받은 32바이트.
 * - cipher=sqlcipher, legacy=4 명시, 키는 Buffer로 함수형 key()에 전달(PRAGMA key 문자열을 만들지 않는다)
 * - temp_store=MEMORY: 정렬·임시 테이블이 평문 파일로 남지 않게
 */
export function openDatabase(file: string, key: Uint8Array): Db {
  if (key.length !== 32) throw new Error('db key must be 32 bytes');
  const db = new Database(file);
  try {
    db.pragma(`cipher='sqlcipher'`);
    db.pragma('legacy=4');
    const kb = Buffer.from(key);
    db.key(kb);
    kb.fill(0);
    // 잘못된 키면 여기서 SQLITE_NOTADB
    db.prepare('SELECT count(*) AS n FROM sqlite_master').get();
    db.pragma('temp_store=MEMORY');
    db.pragma('foreign_keys=ON');
    db.pragma('journal_mode=WAL');
    // 원장 armed·토큰 소비는 전원이 나가도 남아야 한다(D03 §2 R-G7 synchronous=FULL). WAL 기본값은 NORMAL이다.
    db.pragma('synchronous=FULL');
    migrate(db);
    if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
    return db;
  } catch (e) {
    db.close();
    throw e;
  }
}

function migrate(db: Db): void {
  const current = Number(db.pragma('user_version', { simple: true }));
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.pragma(`user_version=${m.version}`);
    })();
  }
}

/** 파일 머리가 평문 SQLite 서명("SQLite format 3\0")이 아닌지 확인한다. */
export function isEncryptedFile(file: string): boolean {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    return !head.equals(Buffer.from('SQLite format 3\0', 'latin1'));
  } finally {
    fs.closeSync(fd);
  }
}
