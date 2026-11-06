// 배포 구성(Vercel 함수 + Supabase): 진입점·환경 접두·경로 복원·cron 보호·재작성 규칙 덮음·마이그레이션 내보내기·역할 분리.
// PostgreSQL 역할 분리 시험은 SAX_PG_TEST_URL(빈 DB, 초superuser, 역할은 trust로 비밀번호 없이 접속)일 때만 돈다.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  LIMITS_MIGRATIONS_DIR,
  SUPABASE_SERVICES,
  SqlLimiter,
  exportSupabase,
  functionEntry,
  limitsSchemaOf,
  listen,
  migrate,
  openPg,
  openSqlite,
  restorePath,
  roleOf,
  schemaColumns,
  serviceEnv,
} from '../services/shared/src/index.ts';
import { MIGRATIONS_DIR as ACCOUNT_MIGRATIONS, accountFunction } from '../services/account/src/index.ts';
import { client } from './services-kit.ts';

const DEPLOY = path.join(import.meta.dirname, '..', 'services', 'deploy');
const hex = () => randomBytes(32).toString('hex');

describe('함수 진입점 공용(serviceEnv·restorePath·functionEntry)', () => {
  it('서비스 접두 값이 공통 값보다 앞서고, 다른 서비스 접두 값은 넘어가지 않는다', () => {
    const e = serviceEnv('ACCOUNT', { INTERNAL_TOKEN: 'shared', DATABASE_URL: 'common', ACCOUNT__DATABASE_URL: 'acct', RELAY__QUEUE_KEY: 'relay-only' });
    assert.deepEqual(e, { INTERNAL_TOKEN: 'shared', DATABASE_URL: 'acct' });
    assert.throws(() => serviceEnv('acct', {}), /config_service_prefix/);
  });

  it('재작성 규칙의 __p로 원래 경로·쿼리를 되살린다(없거나 이상하면 null)', () => {
    assert.equal(restorePath('/api/account?__p=/v1/auth/code'), '/v1/auth/code');
    assert.equal(restorePath('/api/relay?__p=/v1/mailboxes/abc/envelopes&since=3'), '/v1/mailboxes/abc/envelopes?since=3');
    assert.equal(restorePath('/api/account'), null);
    assert.equal(restorePath('/api/account?__p=v1/x'), null);
    assert.equal(restorePath('/api/account?__p=//evil.example/x'), null);
  });

  it('cron 경로는 32자 이상 CRON_SECRET의 Bearer로만, 정리를 돌린다. 경로가 없으면 404', async () => {
    let swept = 0;
    const secret = hex();
    const entry = functionEntry({ cronSecret: secret, build: async () => ({ listener: async (_req, res) => void res.end('svc'), sweep: async () => void swept++ }) });
    const server = http.createServer((req, res) => void entry(req, res));
    const req = client(await listen(server));
    assert.equal((await req('GET', '/api/x?__p=/internal/v1/cron')).status, 401);
    assert.equal((await req('GET', '/api/x?__p=/internal/v1/cron', { headers: { authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await req('GET', '/api/x?__p=/internal/v1/cron', { headers: { authorization: `Bearer ${secret}` } })).status, 200);
    assert.equal(swept, 1);
    assert.equal((await req('GET', '/api/x')).status, 404);
    assert.equal((await req('GET', '/api/x?__p=/v1/anything')).text, 'svc');
    server.close();
    const weak = functionEntry({ cronSecret: 'short', build: async () => ({ listener: async () => undefined, sweep: async () => undefined }) });
    const s2 = http.createServer((q, r) => void weak(q, r));
    assert.equal((await client(await listen(s2))('GET', '/api/x?__p=/internal/v1/cron', { headers: { authorization: 'Bearer short' } })).status, 401);
    s2.close();
  });
});

describe('계정 함수(실제 조립, ACCOUNT__ 접두 env, DDL 없음)', () => {
  it('재작성된 경로로 로그인 코드를 발급하고, DPoP htu는 원래 경로를 본다. 정리 cron이 돈다', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sax-deploy-'));
    const file = path.join(dir, 'account.db');
    const pre = openSqlite(file); // 함수는 마이그레이션을 하지 않는다: 배포 절차가 미리 적용한 DB를 흉내 낸다
    await migrate(pre, 'account', ACCOUNT_MIGRATIONS);
    await migrate(pre, 'limits', LIMITS_MIGRATIONS_DIR);
    await pre.close();
    const cron = hex();
    const fn = accountFunction({
      CRON_SECRET: cron,
      INTERNAL_TOKEN: hex(),
      ACCOUNT__SAX_SQLITE_FILE: file,
      ACCOUNT__TOKEN_SIGNING_SEED: hex(),
      ACCOUNT__CODE_MAC_KEY: hex(),
      ACCOUNT__LIMIT_ID_KEY: hex(),
      ACCOUNT__ACCOUNT_PUBLIC_ORIGIN: 'https://tax.test.invalid',
      ACCOUNT__WEBAUTHN_RP_ID: 'tax.test.invalid',
      ACCOUNT__WEBAUTHN_ORIGINS: 'https://tax.test.invalid',
      ACCOUNT__BILLING_RETURN_URL: 'https://tax.test.invalid/done',
      ACCOUNT__PG_PROVIDER: 'mock',
      ACCOUNT__MAIL_PROVIDER: 'mock',
      RELAY__SAX_SQLITE_FILE: path.join(dir, 'relay.db'),
    });
    const server = http.createServer((q, r) => void fn(q, r));
    const req = client(await listen(server));
    const r = await req('POST', '/api/account?__p=/v1/auth/code', { body: { email: 'fn@example.com' } });
    assert.equal(r.status, 200, r.text);
    assert.match(String(r.json.loginId), /.{16,}/);
    assert.equal((await req('GET', '/api/account?__p=/v1/me')).json.error, 'account.unauthorized');
    assert.equal((await req('GET', '/api/account/internal/v1/cron')).status, 404, '내부 경로는 __p로만(재작성 규칙이 붙인다)');
    assert.equal((await req('GET', '/api/account?__p=/internal/v1/cron', { headers: { authorization: `Bearer ${cron}` } })).status, 200);
    assert.ok(!fs.existsSync(path.join(dir, 'relay.db')), '다른 서비스 env는 쓰지 않는다');
    server.close();
  });

  it('Vercel api/*.js는 빌드된 dist의 진입점을 기본 내보내기로 둔다', () => {
    for (const s of SUPABASE_SERVICES) {
      const src = fs.readFileSync(path.join(DEPLOY, 'vercel', 'api', `${s.name}.js`), 'utf8');
      assert.match(src, new RegExp(`import \\{ ${s.name}Function \\} from '\\.\\./\\.\\./\\.\\./${s.name}/dist/vercel\\.js';`));
      assert.match(src, new RegExp(`export default ${s.name}Function\\(\\);`));
    }
  });
});

interface Rewrite {
  source: string;
  destination: string;
}
const vercel = JSON.parse(fs.readFileSync(path.join(DEPLOY, 'vercel', 'vercel.json'), 'utf8')) as { rewrites: Rewrite[]; crons: { path: string }[]; functions: Record<string, unknown> };
/** 재작성 소스 → 정규식(`:path*`만 쓴다) */
const toRe = (src: string) => new RegExp(`^${src.replace(/[.]/g, '\\.').replace('/:path*', '(?:/(.*))?')}$`);
const routeOf = (p: string) => vercel.rewrites.find((r) => toRe(r.source).test(p));

/** 각 서비스 라우터의 실제 경로(app.ts의 r.add) */
function routes(svc: string): string[] {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'services', svc, 'src', 'app.ts'), 'utf8');
  return [...src.matchAll(/r\.add\(\s*'[A-Z]+',\s*'([^']+)'/g)].map((m) => m[1]!.replace(/:[a-z]+/g, 'x'));
}

describe('vercel.json 재작성 규칙(tax.laf-co.com 한 origin)', () => {
  it('모든 공개 경로가 자기 서비스 함수로 가고 __p가 원래 경로와 같다', () => {
    for (const svc of ['account', 'gateway', 'relay', 'push']) {
      for (const p of routes(svc).filter((x) => x.startsWith('/v1/'))) {
        const r = routeOf(p);
        assert.ok(r, `${svc} ${p}`);
        if (p === '/v1/rooms') {
          assert.equal(r!.destination, 'https://rooms.tax.laf-co.com/v1/rooms', '룸 발급은 룸 호스트로');
          continue;
        }
        assert.ok(r!.destination.startsWith(`/api/${svc}?__p=`), `${svc} ${p} → ${r!.destination}`);
        const m = toRe(r!.source).exec(p)!;
        assert.equal(r!.destination.replace(`/api/${svc}?__p=`, '').replace(':path*', m[1] ?? ''), p.replace(/\/$/, ''));
      }
    }
  });

  it('/internal/*과 /healthz는 공개 경로로 닿지 않고, 내부 API는 /api/<서비스>/internal/*로만(내부 비밀 필요)', () => {
    for (const p of ['/internal/v1/devices/x', '/healthz', '/internal/v1/cron']) assert.equal(routeOf(p), undefined, p);
    for (const svc of ['account', 'gateway', 'relay', 'push']) assert.equal(routeOf(`/api/${svc}/internal/v1/devices/x`)?.destination, `/api/${svc}?__p=/internal/:path*`);
    for (const r of vercel.rewrites) if (!r.source.startsWith('/api/')) assert.ok(!r.destination.includes('/internal'), r.source);
  });

  it('정리 cron은 서비스마다 하나, 재작성 규칙으로 /internal/v1/cron에 닿는다. 게이트웨이 함수는 더 오래 돈다', () => {
    assert.deepEqual(vercel.crons.map((c) => c.path).sort(), ['account', 'gateway', 'push', 'relay'].map((s) => `/api/${s}/internal/v1/cron`));
    for (const c of vercel.crons) assert.ok(routeOf(c.path), c.path);
    assert.deepEqual(vercel.functions['api/gateway.js'], { maxDuration: 60 });
  });
});

describe('Supabase 마이그레이션 내보내기', () => {
  it('저장소의 supabase/migrations가 생성 결과와 같다(마이그레이션을 바꾸면 export-supabase.ts를 다시 돌린다)', () => {
    const dir = path.join(DEPLOY, 'supabase', 'migrations');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    const want = exportSupabase();
    assert.deepEqual(files, want.map((m) => m.name));
    for (const m of want) assert.equal(fs.readFileSync(path.join(dir, m.name), 'utf8'), m.sql, m.name);
  });

  it('비밀번호·키 같은 값은 생성 SQL에 없다', () => {
    for (const m of exportSupabase()) assert.ok(!/PASSWORD\s+'|ENCRYPTED PASSWORD|sk-|eyJ/i.test(m.sql), m.name);
  });

  const pgUrl = process.env.SAX_PG_TEST_URL;
  it('PostgreSQL: 적용 뒤 역할마다 자기 스키마만 읽고 쓰고, 다른 서비스 테이블·DDL은 거부(D08 §8 분리 저장)', { skip: !pgUrl }, async () => {
    const admin = openPg(pgUrl!);
    for (const s of SUPABASE_SERVICES) await admin.exec(`DROP SCHEMA IF EXISTS ${s.name} CASCADE; DROP SCHEMA IF EXISTS ${limitsSchemaOf(s.name)} CASCADE;`);
    for (const m of exportSupabase()) await admin.exec(m.sql);
    const as = (svc: string) => {
      const u = new URL(pgUrl!);
      u.username = roleOf(svc);
      u.password = '';
      return openPg(u.toString(), 1);
    };
    for (const s of SUPABASE_SERVICES) {
      const db = as(s.name);
      // 자기 스키마 테이블 = 마이그레이션 컬럼 표의 테이블
      const own = await db.all<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name <> 'schema_migrations'", [s.name]);
      assert.deepEqual(own.map((r) => r.table_name).sort(), Object.keys(schemaColumns(s.migrationsDir)).sort(), s.name);
      // 한도 표는 search_path로 바로 쓴다(코드 변경 없음)
      const lim = new SqlLimiter(db, Date.now);
      assert.equal((await lim.hit(`deploy-${s.name}`, 5, 60_000)).n, 1);
      await lim.reset(`deploy-${s.name}`, 60_000);
      await assert.rejects(db.exec('CREATE TABLE nope (x INTEGER)'), /permission denied/);
      const other = s.name === 'account' ? 'relay' : 'account';
      await assert.rejects(db.all(`SELECT * FROM ${other}.schema_migrations`), /permission denied/);
      await assert.rejects(db.all(`SELECT * FROM ${limitsSchemaOf(other)}.lim_salts`), /permission denied/);
      await db.close();
    }
    const done = await admin.all<{ service: string; version: number }>('SELECT service, version FROM relay.schema_migrations ORDER BY service');
    assert.deepEqual(done.map((r) => `${r.service}:${r.version}`), ['limits:1', 'relay:1']);
    await admin.close();
  });
});
