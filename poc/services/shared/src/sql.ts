// SQL 계층: 운영은 PostgreSQL(D09 §1·§9.1, 표준 기능만), 로컬 시험은 Node 내장 node:sqlite.
// SQL은 두 방언의 공통 부분집합으로 쓰고 자리표시자는 $1..$n이다. 방언 차이는 마이그레이션의 {{BLOB}}·{{BIGINT}} 치환과 forUpdate뿐이다.
// ADR-029 결정 6: 메타데이터성 테이블에 서버 시각 컬럼을 두지 않는다. 서비스별 스키마 린트(lintSchema)가 금지 컬럼 이름을 막는다.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import { pgConnectConfig } from './pg-tls.ts';

export type Param = string | number | Buffer | null;

export interface Sql {
  readonly dialect: 'sqlite' | 'pg';
  all<T = Record<string, unknown>>(text: string, params?: Param[]): Promise<T[]>;
  one<T = Record<string, unknown>>(text: string, params?: Param[]): Promise<T | undefined>;
  /** 영향받은 행 수 */
  run(text: string, params?: Param[]): Promise<number>;
  exec(script: string): Promise<void>;
  /** 직렬화된 트랜잭션. pg는 행 잠금(forUpdate)과 함께 쓴다. */
  tx<T>(fn: (q: Sql) => Promise<T>): Promise<T>;
  /** pg: ' FOR UPDATE', sqlite: ''(전역 직렬화) */
  readonly forUpdate: string;
  close(): Promise<void>;
}

const toSqlite = (text: string) => text.replace(/\$(\d+)/g, '?$1');

function normRow(r: Record<string, unknown>): Record<string, unknown> {
  for (const k of Object.keys(r)) {
    const v = r[k];
    if (v instanceof Uint8Array && !Buffer.isBuffer(v)) r[k] = Buffer.from(v);
  }
  return r;
}

class SqliteSql implements Sql {
  readonly dialect = 'sqlite' as const;
  readonly forUpdate = '';
  private readonly db: DatabaseSync;
  private lock: Promise<unknown> = Promise.resolve();
  private readonly inner: boolean;
  constructor(db: DatabaseSync, inner = false) {
    this.db = db;
    this.inner = inner;
  }
  private serial<T>(fn: () => T | Promise<T>): Promise<T> {
    if (this.inner) return Promise.resolve().then(fn);
    const p = this.lock.then(fn, fn);
    this.lock = p.catch(() => undefined);
    return p;
  }
  all<T>(text: string, params: Param[] = []): Promise<T[]> {
    return this.serial(() => this.db.prepare(toSqlite(text)).all(...params).map((r) => normRow(r as Record<string, unknown>)) as T[]);
  }
  async one<T>(text: string, params: Param[] = []): Promise<T | undefined> {
    return (await this.all<T>(text, params))[0];
  }
  run(text: string, params: Param[] = []): Promise<number> {
    return this.serial(() => Number(this.db.prepare(toSqlite(text)).run(...params).changes));
  }
  exec(script: string): Promise<void> {
    return this.serial(() => this.db.exec(script));
  }
  tx<T>(fn: (q: Sql) => Promise<T>): Promise<T> {
    if (this.inner) return fn(this);
    return this.serial(async () => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const r = await fn(new SqliteSql(this.db, true));
        this.db.exec('COMMIT');
        return r;
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    });
  }
  async close(): Promise<void> {
    if (!this.inner) this.db.close();
  }
}

/** 시험·로컬: 파일 경로 또는 ':memory:' */
export function openSqlite(file = ':memory:'): Sql {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  return new SqliteSql(db);
}

// int8(BIGINT)을 문자열이 아니라 수로 읽는다(값은 epoch ms·카운터라 2^53 안).
pg.types.setTypeParser(20, (v: string) => Number(v));

type PgQueryable = pg.Pool | pg.PoolClient;

class PgSql implements Sql {
  readonly dialect = 'pg' as const;
  readonly forUpdate = ' FOR UPDATE';
  private readonly c: PgQueryable;
  private readonly pool: pg.Pool | null;
  constructor(c: PgQueryable, pool: pg.Pool | null) {
    this.c = c;
    this.pool = pool;
  }
  async all<T>(text: string, params: Param[] = []): Promise<T[]> {
    return (await this.c.query(text, params)).rows as T[];
  }
  async one<T>(text: string, params: Param[] = []): Promise<T | undefined> {
    return (await this.all<T>(text, params))[0];
  }
  async run(text: string, params: Param[] = []): Promise<number> {
    return (await this.c.query(text, params)).rowCount ?? 0;
  }
  async exec(script: string): Promise<void> {
    await this.c.query(script);
  }
  async tx<T>(fn: (q: Sql) => Promise<T>): Promise<T> {
    if (!this.pool) return fn(this);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const r = await fn(new PgSql(client, null));
      await client.query('COMMIT');
      return r;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }
  async close(): Promise<void> {
    await this.pool?.end();
  }
}

/** 운영: DATABASE_URL. TLS는 고정 앵커로 항상 검증(pg-tls.ts, sslmode=verify-full). 풀 크기는 인스턴스당(함수는 1~2, 상시 서버는 10). */
export function openPg(url: string, max = 10): Sql {
  const pool = new pg.Pool({ ...pgConnectConfig(url), max });
  return new PgSql(pool, pool);
}

export function openFromEnv(env: NodeJS.ProcessEnv): Sql {
  if (env.DATABASE_URL) {
    const max = env.DATABASE_POOL_MAX ?? '10';
    if (!/^[1-9][0-9]?$/.test(max)) throw new Error('config_DATABASE_POOL_MAX');
    return openPg(env.DATABASE_URL, Number(max));
  }
  if (env.SAX_SQLITE_FILE) return openSqlite(env.SAX_SQLITE_FILE);
  throw new Error('config_DATABASE_URL');
}

export const subst = (sqlText: string, dialect: Sql['dialect']) =>
  sqlText.replaceAll('{{BLOB}}', dialect === 'pg' ? 'BYTEA' : 'BLOB').replaceAll('{{BIGINT}}', dialect === 'pg' ? 'BIGINT' : 'INTEGER');

/** migrations/NNN_*.sql을 차례로 적용한다(서비스 이름별 버전 기록). 이미 적용한 번호는 건너뛴다. */
export async function migrate(q: Sql, service: string, dir: string): Promise<number[]> {
  await q.exec('CREATE TABLE IF NOT EXISTS schema_migrations (service TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (service, version))');
  const done = new Set((await q.all<{ version: number }>('SELECT version FROM schema_migrations WHERE service = $1', [service])).map((r) => Number(r.version)));
  const files = fs.readdirSync(dir).filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f)).sort();
  const applied: number[] = [];
  for (const f of files) {
    const v = Number(f.slice(0, 3));
    if (done.has(v)) continue;
    const text = subst(fs.readFileSync(path.join(dir, f), 'utf8'), q.dialect);
    await q.tx(async (t) => {
      await t.exec(text);
      await t.run('INSERT INTO schema_migrations (service, version) VALUES ($1, $2)', [service, v]);
    });
    applied.push(v);
  }
  return applied;
}

/**
 * 스키마 린트: 마이그레이션 SQL에서 CREATE TABLE의 컬럼 이름을 뽑아, 금지 이름(평문 IP·본문·사업자번호 등)이 없고
 * 허용 목록(서비스 README의 가시성 표와 맞춘 목록)에 있는 컬럼만 있는지 본다. 시험이 이 함수로 D09 §1.1 표와 저장 컬럼을 대조한다.
 */
export function schemaColumns(dir: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8').replace(/--.*$/gm, '');
    for (const m of text.matchAll(/CREATE TABLE(?: IF NOT EXISTS)? (\w+) \(([\s\S]*?)\);/g)) {
      const cols = m[2]!
        .split(/,(?![^(]*\))/)
        .map((s) => s.trim())
        .filter((s) => s && !/^(PRIMARY KEY|UNIQUE|FOREIGN KEY|CHECK|CONSTRAINT)\b/i.test(s))
        .map((s) => s.split(/\s+/)[0]!);
      out[m[1]!] = [...(out[m[1]!] ?? []), ...cols];
    }
    for (const m of text.matchAll(/ALTER TABLE (\w+) ADD COLUMN (\w+)/g)) out[m[1]!] = [...(out[m[1]!] ?? []), m[2]!];
  }
  return out;
}

export const FORBIDDEN_COLUMN = /(^|_)(ip|ip_addr|body|content|prompt|response|bizno|biz_no|business_no|rrn|ssn|password|secret|plaintext|email_code|code_plain)($|_)/;
