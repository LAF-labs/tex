// 다중 인스턴스 한도(팀장 결정 2026-11-05 (가), D09 §4·D08 §8): DB 고정 창 카운터와 KST 당일 솔트 행.
// SQLite로 돌리고, SAX_PG_TEST_URL이 있으면 같은 시험을 PostgreSQL에도 돌린다(기본은 건너뜀).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  FORBIDDEN_COLUMN,
  LIMITS_MIGRATIONS_DIR,
  LIMITS_VISIBILITY,
  MemoryLimiter,
  SecretKeySalt,
  SqlKeySalt,
  SqlLimiter,
  migrate,
  openPg,
  openSqlite,
  schemaColumns,
  sqlLimits,
  type Limiter,
  type Sql,
} from '../services/shared/src/index.ts';
import { Clock, D } from './services-kit.ts';

async function fresh(open: () => Sql): Promise<Sql> {
  const db = open();
  await migrate(db, 'limits', LIMITS_MIGRATIONS_DIR);
  return db;
}

function limiterCases(name: string, make: (clock: Clock) => Promise<{ limiter: Limiter; close(): Promise<void> }>) {
  describe(`한도 카운터 (${name})`, () => {
    it('창 안에서 한도까지 통과, 넘으면 거부하고 Retry-After는 창 끝까지', async () => {
      const c = new Clock();
      const { limiter, close } = await make(c);
      for (let i = 1; i <= 3; i++) assert.deepEqual(await limiter.hit('k', 3, 60_000), { ok: true, n: i, retryAfterSec: 60 });
      c.advance(15_000);
      const over = await limiter.hit('k', 3, 60_000);
      assert.equal(over.ok, false);
      assert.equal(over.n, 4);
      assert.equal(over.retryAfterSec, 45);
      // 넘은 뒤에도 한도 + 1에서 멈춘다(계속 두드려도 카운터가 커지지 않음)
      assert.equal((await limiter.hit('k', 3, 60_000)).n, 4);
      assert.deepEqual(await limiter.count('k', 60_000), { n: 4, retryAfterSec: 45 });
      // 창이 지나면 1부터
      c.advance(45_000);
      assert.deepEqual(await limiter.count('k', 60_000), { n: 0, retryAfterSec: 0 });
      assert.deepEqual(await limiter.hit('k', 3, 60_000), { ok: true, n: 1, retryAfterSec: 60 });
      await close();
    });

    it('같은 키라도 창 길이가 다르면 따로 센다, reset은 그 창만 비운다', async () => {
      const c = new Clock();
      const { limiter, close } = await make(c);
      await limiter.hit('k', 1, 60_000);
      assert.equal((await limiter.hit('k', 1, 60_000)).ok, false);
      assert.equal((await limiter.hit('k', 1, 3_600_000)).ok, true);
      await limiter.reset('k', 60_000);
      assert.equal((await limiter.hit('k', 1, 60_000)).ok, true);
      assert.equal((await limiter.hit('k', 1, 3_600_000)).ok, false);
      await close();
    });
  });
}

limiterCases('메모리', async (c) => ({ limiter: new MemoryLimiter(c.now), close: async () => undefined }));
limiterCases('SQLite', async (c) => {
  const db = await fresh(() => openSqlite());
  return { limiter: new SqlLimiter(db, c.now), close: () => db.close() };
});

function sqlCases(name: string, open: () => Sql, skip: boolean) {
  describe(`DB 한도 (${name})`, { skip }, () => {
    it('두 인스턴스(연결)가 같은 카운터를 나눠 센다: 동시 hit도 한도를 넘겨 통과시키지 않는다', async () => {
      const c = new Clock();
      const a = await fresh(open);
      const b = open();
      const la = new SqlLimiter(a, c.now);
      const lb = new SqlLimiter(b, c.now);
      await la.reset('race', 60_000);
      const hits = await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 2 ? la : lb).hit('race', 10, 60_000)));
      assert.equal(hits.filter((h) => h.ok).length, 10);
      assert.deepEqual(hits.map((h) => h.n).sort((x, y) => x - y).slice(0, 10), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      assert.equal((await lb.count('race', 60_000)).n, 11);
      await la.reset('race', 60_000);
      await Promise.all([a.close(), b.close()]);
    });

    it('병렬 증가 N개 → 정확히 N(잃는 증가·중복 번호 없음, 연결 넷)', async () => {
      const c = new Clock();
      const first = await fresh(open);
      const dbs = [first, open(), open(), open()];
      const ls = dbs.map((d) => new SqlLimiter(d, c.now));
      await ls[0]!.reset('par', 60_000);
      const N = 200;
      const hits = await Promise.all(Array.from({ length: N }, (_, i) => ls[i % ls.length]!.hit('par', 10_000, 60_000)));
      assert.ok(hits.every((h) => h.ok));
      assert.deepEqual(
        hits.map((h) => h.n).sort((x, y) => x - y),
        Array.from({ length: N }, (_, i) => i + 1),
      );
      assert.equal((await ls[1]!.count('par', 60_000)).n, N);
      await ls[0]!.reset('par', 60_000);
      await Promise.all(dbs.map((d) => d.close()));
    });

    it('KST 자정 솔트 행 생성 경합: 날짜가 바뀐 첫 순간 여러 인스턴스가 동시에 읽어도 새 날 행은 하나, 모두 같은 솔트, 지난 날 행은 지워진다', async () => {
      const c = new Clock(Date.UTC(2026, 10, 10, 14, 59, 59, 999)); // KST 11-10 23:59:59.999
      const first = await fresh(open);
      const dbs = [first, open(), open(), open()];
      await first.run("DELETE FROM lim_salts WHERE label = 'mid'");
      const salts = Array.from({ length: 12 }, (_, i) => new SqlKeySalt(dbs[i % dbs.length]!, 'mid', c.now));
      const before = await salts[0]!.hash('198.51.100.1');
      c.advance(1); // KST 11-11 00:00:00.000
      const after = await Promise.all(salts.map((s) => s.hash('198.51.100.1')));
      assert.equal(new Set(after).size, 1);
      assert.notEqual(after[0], before);
      assert.deepEqual((await first.all<{ day: string }>("SELECT day FROM lim_salts WHERE label = 'mid'")).map((r) => r.day), ['2026-11-11']);
      await first.run("DELETE FROM lim_salts WHERE label = 'mid'");
      await Promise.all(dbs.map((d) => d.close()));
    });

    it('자정 시계 어긋남: 시계가 늦은 인스턴스가 자정 직후 기동해도 새 날 행을 지우지 않고, 그가 다시 만든 지난 날 행은 sweep이 지운다', async () => {
      const ahead = new Clock(Date.UTC(2026, 10, 10, 15, 0, 0, 5)); // KST 11-11 00:00:00.005
      const behind = new Clock(Date.UTC(2026, 10, 10, 14, 59, 59, 995)); // KST 11-10 23:59:59.995
      const a = await fresh(open);
      const b = open();
      await a.run("DELETE FROM lim_salts WHERE label = 'skew'");
      const today = await new SqlKeySalt(a, 'skew', ahead.now).hash('x');
      const days = async () => (await a.all<{ day: string }>("SELECT day FROM lim_salts WHERE label = 'skew' ORDER BY day")).map((r) => r.day);
      await new SqlKeySalt(b, 'skew', behind.now).hash('x'); // 늦은 인스턴스의 첫 읽기: 지난 날 행을 다시 만들지만 새 날 행은 지우지 않는다
      assert.deepEqual(await days(), ['2026-11-10', '2026-11-11']);
      // 1분 sweep이 지난 날 행을 지운다
      await new SqlLimiter(a, ahead.now).sweep();
      assert.deepEqual(await days(), ['2026-11-11']);
      // 새 날 행은 그대로라 새로 기동한 인스턴스도 같은 키를 본다
      assert.equal(await new SqlKeySalt(b, 'skew', ahead.now).hash('x'), today);
      await a.run("DELETE FROM lim_salts WHERE label = 'skew'");
      await Promise.all([a.close(), b.close()]);
    });

    it('당일 솔트는 인스턴스끼리 같고, 날짜(KST)가 바뀌면 새 솔트로 바뀌며 지난 날 행은 지워진다', async () => {
      const c = new Clock(Date.UTC(2026, 10, 10, 14, 0, 0)); // KST 11-10 23:00
      const a = await fresh(open);
      const b = open();
      await a.run("DELETE FROM lim_salts WHERE label = 'ip'");
      const sa = new SqlKeySalt(a, 'ip', c.now);
      const sb = new SqlKeySalt(b, 'ip', c.now);
      const [h1, h2] = await Promise.all([sa.hash('203.0.113.7'), sb.hash('203.0.113.7')]);
      assert.equal(h1, h2);
      assert.match(h1, /^[0-9a-f]{32}$/);
      assert.notEqual(await sa.hash('203.0.113.8'), h1);
      // 용도가 다르면 같은 값도 다른 키
      assert.notEqual(await new SqlKeySalt(a, 'email', c.now).hash('203.0.113.7'), h1);
      assert.deepEqual((await a.all<{ day: string }>("SELECT day FROM lim_salts WHERE label = 'ip'")).map((r) => r.day), ['2026-11-10']);

      c.advance(2 * 3600_000); // KST 11-11 01:00
      const next = await sb.hash('203.0.113.7');
      assert.notEqual(next, h1);
      assert.equal(await sa.hash('203.0.113.7'), next);
      assert.deepEqual((await a.all<{ day: string }>("SELECT day FROM lim_salts WHERE label = 'ip'")).map((r) => r.day), ['2026-11-11']);
      await a.run("DELETE FROM lim_salts WHERE label IN ('ip', 'email')");
      await Promise.all([a.close(), b.close()]);
    });

    it('sweep은 만료된 창만 지운다', async () => {
      const c = new Clock();
      const db = await fresh(open);
      const l = new SqlLimiter(db, c.now);
      await db.run("DELETE FROM lim_windows WHERE k LIKE '%|sw-%'");
      await l.hit('sw-short', 5, 60_000);
      await l.hit('sw-long', 5, D);
      c.advance(60_000);
      await l.sweep();
      const left = (await db.all<{ k: string }>("SELECT k FROM lim_windows WHERE k LIKE '%|sw-%'")).map((r) => r.k);
      assert.deepEqual(left, [`${D}|sw-long`]);
      await l.reset('sw-long', D);
      await db.close();
    });

    it('sqlLimits: 같은 용도는 같은 솔트 객체(캐시 공유), 키에는 평문이 없다', async () => {
      const c = new Clock();
      const db = await fresh(open);
      const lim = sqlLimits(db, c.now, Buffer.alloc(32, 7));
      assert.equal(lim.salt('dev'), lim.salt('dev'));
      const key = `devtok:${await lim.salt('dev').hash('dev_plain_id_123')}`;
      await lim.limiter.hit(key, 3, 60_000);
      const rows = await db.all<{ k: string }>('SELECT k FROM lim_windows');
      assert.ok(rows.some((r) => r.k === `60000|${key}`));
      assert.ok(rows.every((r) => !r.k.includes('dev_plain_id_123')));
      await lim.limiter.reset(key, 60_000);
      await db.run("DELETE FROM lim_salts WHERE label = 'dev'");
      await db.close();
    });
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sax-limits-'));
const file = path.join(tmp, 'limits.db');
sqlCases('SQLite 파일, 연결 둘', () => openSqlite(file), false);
const pgUrl = process.env.SAX_PG_TEST_URL;
sqlCases('PostgreSQL', () => openPg(pgUrl!), !pgUrl);

describe('한도 테이블 가시성(D09 §1.1)', () => {
  it('저장 컬럼이 가시성 표와 같고 금지 이름이 없다', () => {
    const cols = schemaColumns(LIMITS_MIGRATIONS_DIR);
    assert.deepEqual(Object.keys(cols).sort(), Object.keys(LIMITS_VISIBILITY).sort());
    for (const [t, cs] of Object.entries(cols)) {
      assert.deepEqual([...cs].sort(), Object.keys(LIMITS_VISIBILITY[t as keyof typeof LIMITS_VISIBILITY]).sort(), t);
      for (const c of cs) assert.ok(!FORBIDDEN_COLUMN.test(c), `${t}.${c}`);
    }
  });

  it('계정·기기 ID 키는 서버 비밀 HMAC: 같은 비밀이면 인스턴스끼리 같고, 비밀·용도·KST 날짜가 다르면 다르며, DB에 솔트 행이 없다', async () => {
    const c = new Clock(Date.UTC(2026, 10, 10, 14, 0, 0)); // KST 11-10 23:00
    const key = Buffer.alloc(32, 9);
    const db = await fresh(() => openSqlite());
    const a = sqlLimits(db, c.now, key).idSalt('dev');
    const b = sqlLimits(db, c.now, key).idSalt('dev');
    const h = await a.hash('dev_123');
    assert.match(h, /^[0-9a-f]{32}$/);
    assert.equal(await b.hash('dev_123'), h);
    assert.notEqual(await new SecretKeySalt(Buffer.alloc(32, 8), 'dev', c.now).hash('dev_123'), h);
    assert.notEqual(await sqlLimits(db, c.now, key).idSalt('acct').hash('dev_123'), h);
    assert.deepEqual(await db.all('SELECT label FROM lim_salts'), []);
    c.advance(2 * 3600_000); // KST 11-11
    assert.notEqual(await a.hash('dev_123'), h);
    assert.throws(() => new SecretKeySalt(Buffer.alloc(16), 'dev', c.now), /limit_id_key/);
    await db.close();
  });

  it('SqlKeySalt 용도 이름은 고정 문자열 형식만', () => {
    assert.throws(() => new SqlKeySalt(openSqlite(), 'IP Addr', Date.now), /salt_label/);
  });
});
