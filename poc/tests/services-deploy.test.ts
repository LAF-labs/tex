// 배포 구성(Vercel 함수 + Supabase): 진입점·환경 접두·경로 복원·내부 경로 기본 거부·cron 보호·한 프로세스 조립(서비스 사이 함수 호출)·재작성 규칙·마이그레이션 내보내기·역할 분리.
// PostgreSQL 역할 분리 시험은 SAX_PG_TEST_URL(빈 DB, 초superuser, 역할은 trust로 비밀번호 없이 접속)일 때만 돈다.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  LIMITS_MIGRATIONS_DIR,
  SUPABASE_SERVICES,
  SqlLimiter,
  SqlNonceStore,
  cronEntry,
  ed25519Private,
  ed25519RawPublic,
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
  signInternalCall,
  type Sql,
} from '../services/shared/src/index.ts';
import { MIGRATIONS_DIR as ACCOUNT_MIGRATIONS } from '../services/account/src/index.ts';
import { MIGRATIONS_DIR as GATEWAY_MIGRATIONS } from '../services/gateway/src/index.ts';
import { MIGRATIONS_DIR as RELAY_MIGRATIONS } from '../services/relay/src/index.ts';
import { MIGRATIONS_DIR as PUSH_MIGRATIONS } from '../services/push/src/index.ts';
import { INTERNAL_FUNCTION_ROUTES, buildCloud, cloudFunction, cronFunction, internalFunction } from '../services/cloud/src/index.ts';
import { client } from './services-kit.ts';

const DEPLOY = path.join(import.meta.dirname, '..', 'services', 'deploy');
const hex = () => randomBytes(32).toString('hex');

describe('함수 진입점 공용(serviceEnv·restorePath·functionEntry·cronEntry)', () => {
  it('서비스 접두 값이 공통 값보다 앞서고, 다른 서비스 접두 값은 넘어가지 않는다', () => {
    const e = serviceEnv('ACCOUNT', { INTERNAL_CALL_KEY: 'shared', DATABASE_URL: 'common', ACCOUNT__DATABASE_URL: 'acct', RELAY__QUEUE_KEY: 'relay-only' });
    assert.deepEqual(e, { INTERNAL_CALL_KEY: 'shared', DATABASE_URL: 'acct' });
    assert.throws(() => serviceEnv('acct', {}), /config_service_prefix/);
  });

  it('재작성 규칙의 __p로 원래 경로·쿼리를 되살린다(없거나 이상하면 null)', () => {
    assert.equal(restorePath('/api/sax?__p=/v1/auth/code'), '/v1/auth/code');
    assert.equal(restorePath('/api/sax?__p=/v1/mailboxes/abc/envelopes&since=3'), '/v1/mailboxes/abc/envelopes?since=3');
    assert.equal(restorePath('/api/sax'), null);
    assert.equal(restorePath('/api/sax?__p=v1/x'), null);
    assert.equal(restorePath('/api/sax?__p=//evil.example/x'), null);
  });

  const serve = async (h: (q: http.IncomingMessage, r: http.ServerResponse) => Promise<void>) => {
    const server = http.createServer((q, r) => void h(q, r));
    return { req: client(await listen(server)), close: () => server.close() };
  };

  it('공개 함수: /internal/*은 점 구간·인코딩으로 우회해도 404이고 처리기에 닿지 않는다. 공개 경로만 처리기로', async () => {
    const seen: string[] = [];
    const f = await serve(functionEntry({ build: async () => async (q, r) => void (seen.push(q.url!), r.end('svc')) }));
    for (const p of ['/internal/v1/devices/x', '/internal', '/v1/../internal/v1/devices/x', '/v1/%2e%2e/internal/v1/devices/x', '/v1/%2E%2E/internal/v1/cron', '/./internal/v1/devices/x']) {
      const r = await f.req('GET', `/api/sax?__p=${encodeURIComponent(p)}`);
      assert.equal(r.status, 404, p);
      assert.equal(r.json.error, 'request.not_found', p);
    }
    assert.equal((await f.req('GET', '/api/sax')).status, 404);
    assert.equal((await f.req('GET', '/api/sax?__p=/v1/anything&q=1')).text, 'svc');
    assert.deepEqual(seen, ['/v1/anything?q=1']);
    f.close();
  });

  it('내부 함수: 허용 목록(메서드·경로)만 처리기로, 공개 경로·다른 내부 경로·다른 메서드는 404', async () => {
    const seen: string[] = [];
    const f = await serve(functionEntry({ internal: (m, p) => m === 'GET' && p === '/internal/v1/devices/x', build: async () => async (q, r) => void (seen.push(q.url!), r.end('svc')) }));
    for (const [m, p] of [['GET', '/v1/me'], ['GET', '/internal/v1/devices/y'], ['POST', '/internal/v1/devices/x'], ['GET', '/internal/v1/devices/x/../y']]) assert.equal((await f.req(m!, `/api/internal?__p=${encodeURIComponent(p!)}`)).status, 404, `${m} ${p}`);
    assert.equal((await f.req('GET', '/api/internal?__p=/internal/v1/devices/x')).text, 'svc');
    assert.deepEqual(seen, ['/internal/v1/devices/x']);
    f.close();
  });

  it('cron 함수는 GET + 32자 이상 CRON_SECRET의 Bearer로만 정리를 돌린다', async () => {
    let swept = 0;
    const secret = hex();
    const f = await serve(cronEntry({ cronSecret: secret, sweep: async () => void swept++ }));
    assert.equal((await f.req('GET', '/api/cron')).status, 401);
    assert.equal((await f.req('GET', '/api/cron', { headers: { authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await f.req('POST', '/api/cron', { headers: { authorization: `Bearer ${secret}` } })).status, 401);
    assert.equal((await f.req('GET', '/api/cron', { headers: { authorization: `Bearer ${secret}` } })).status, 200);
    assert.equal(swept, 1);
    f.close();
    const weak = await serve(cronEntry({ cronSecret: 'short', sweep: async () => void swept++ }));
    assert.equal((await weak.req('GET', '/api/cron', { headers: { authorization: 'Bearer short' } })).status, 401);
    weak.close();
    assert.equal(swept, 1);
  });
});

/** 함수 env(서비스 접두 + 공통). 배포 절차가 미리 마이그레이션한 sqlite 파일을 흉내 낸다(함수는 DDL을 하지 않는다) */
async function cloudEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sax-cloud-'));
  const file = (svc: string) => path.join(dir, `${svc}.db`);
  for (const [svc, mig] of [['account', ACCOUNT_MIGRATIONS], ['gateway', GATEWAY_MIGRATIONS], ['relay', RELAY_MIGRATIONS], ['push', PUSH_MIGRATIONS]] as const) {
    const db = openSqlite(file(svc));
    await migrate(db, svc, mig);
    await migrate(db, 'limits', LIMITS_MIGRATIONS_DIR);
    await db.close();
  }
  const seed = hex();
  const internalKey = hex();
  const origin = 'https://tax.test.invalid';
  const env: NodeJS.ProcessEnv = {
    CRON_SECRET: hex(),
    INTERNAL_CALL_KEY: internalKey,
    TOKEN_PUBLIC_KEYS: `k1:${ed25519RawPublic(ed25519Private(Buffer.from(seed, 'hex'))).toString('base64')}`,
    ACCOUNT__SAX_SQLITE_FILE: file('account'),
    ACCOUNT__TOKEN_SIGNING_SEED: seed,
    ACCOUNT__CODE_MAC_KEY: hex(),
    ACCOUNT__LIMIT_ID_KEY: hex(),
    ACCOUNT__ACCOUNT_PUBLIC_ORIGIN: origin,
    ACCOUNT__WEBAUTHN_RP_ID: 'tax.test.invalid',
    ACCOUNT__WEBAUTHN_ORIGINS: origin,
    ACCOUNT__BILLING_RETURN_URL: `${origin}/done`,
    ACCOUNT__PG_PROVIDER: 'mock',
    ACCOUNT__MAIL_PROVIDER: 'mock',
    GATEWAY__SAX_SQLITE_FILE: file('gateway'),
    GATEWAY__GATEWAY_PUBLIC_ORIGIN: origin,
    GATEWAY__RUN_TOKEN_SEED: hex(),
    GATEWAY__LIMIT_ID_KEY: hex(),
    GATEWAY__CACHE_KEY_SECRET: hex(),
    GATEWAY__SAFETY_ID_KEY: hex(),
    GATEWAY__REPLAY_TAG_KEY: hex(),
    GATEWAY__RUN_SCOPE_KEY: hex(),
    GATEWAY__GW_PROVIDER: 'mock',
    GATEWAY__NTS_PROVIDER: 'mock',
    GATEWAY__MODEL_DECIDE: 'm-decide',
    GATEWAY__MODEL_RESPOND: 'm-respond',
    RELAY__SAX_SQLITE_FILE: file('relay'),
    RELAY__QUEUE_KEY: hex(),
    RELAY__LIMIT_ID_KEY: hex(),
    RELAY__RELAY_PUBLIC_ORIGIN: origin,
    PUSH__SAX_SQLITE_FILE: file('push'),
    PUSH__PUSH_TOKEN_KEY: hex(),
    PUSH__LIMIT_ID_KEY: hex(),
    PUSH__PUSH_PUBLIC_ORIGIN: origin,
    PUSH__PUSH_PROVIDER: 'mock',
  };
  return { env, file, internalKey: Buffer.from(internalKey, 'hex') };
}

async function seedDevice(db: Sql, deviceId: string): Promise<void> {
  const acc = `acc-${deviceId}`;
  await db.run("INSERT INTO accounts (id, email, status, created_at) VALUES ($1, $2, 'active', 0)", [acc, `${deviceId}@example.com`]);
  await db.run("INSERT INTO devices (device_id, account_id, role, platform, name, sx, vx, registered_at, state) VALUES ($1, $2, 'desktop', 'windows', 'PC', 'AA==', 'AA==', 0, 'active')", [deviceId, acc]);
}

describe('한 프로세스 조립(@sax/svc-cloud): 서비스 사이 호출은 HTTP 없이 함수로(팀장 결정 2026-11-06 #135 (1))', () => {
  let c: Awaited<ReturnType<typeof cloudEnv>>;
  const realFetch = globalThis.fetch;
  const outbound: string[] = [];
  before(async () => {
    c = await cloudEnv();
    globalThis.fetch = ((u: string | URL | Request, init?: RequestInit) => (outbound.push(String(u)), realFetch(u, init))) as typeof fetch;
  });
  after(() => void (globalThis.fetch = realFetch));

  it('ACCOUNT_INTERNAL_URL 없이 조립되고, 기기 상태·자동 정지·정지 알림(푸시 토큰 삭제)이 송신 0건으로 계정 서비스에 직접 닿는다', async () => {
    const cloud = await buildCloud(c.env);
    try {
      await seedDevice(cloud.account.db, 'dev-1');
      assert.deepEqual(await cloud.directory.get('dev-1'), { accountId: 'acc-dev-1', deviceId: 'dev-1', role: 'desktop', state: 'active' });
      await cloud.push.svc.register('dev-1', 'ios', 'a'.repeat(64));
      assert.equal((await cloud.push.db.all('SELECT device_id FROM push_tokens')).length, 1);
      await cloud.suspender.suspend('dev-1');
      assert.equal((await cloud.directory.get('dev-1'))?.state, 'suspended');
      assert.equal((await cloud.push.db.all('SELECT device_id FROM push_tokens')).length, 0, '정지 알림이 같은 프로세스의 푸시 서비스로 갔다');
      await cloud.sweep();
      assert.deepEqual(outbound, []);
    } finally {
      await cloud.close();
    }
  });

  it('공개 함수: 경로마다 자기 서비스 라우터로 가고, 내부 경로는 어떤 방식으로 와도 404(서명이 있어도)', async () => {
    const fn = cloudFunction(c.env);
    const server = http.createServer((q, r) => void fn(q, r));
    const req = client(await listen(server));
    const r = await req('POST', '/api/sax?__p=/v1/auth/code', { body: { email: 'fn@example.com' } });
    assert.equal(r.status, 200, r.text);
    assert.equal((await req('GET', '/api/sax?__p=/v1/me')).json.error, 'account.unauthorized');
    assert.equal((await req('POST', '/api/sax?__p=/v1/run-tokens', { body: {} })).status, 401, '게이트웨이 라우터');
    assert.equal((await req('POST', '/api/sax?__p=/v1/mailboxes', { body: {} })).status, 401, '릴레이 라우터');
    assert.equal((await req('PUT', '/api/sax?__p=/v1/push-token', { body: {} })).status, 401, '푸시 라우터');
    const dev = '/internal/v1/devices/dev-1';
    for (const [m, p] of [['GET', dev], ['POST', `${dev}/auto-suspend`], ['POST', `${dev}/stopped`], ['POST', '/internal/v1/queues/purge'], ['GET', '/internal/v1/cron']]) {
      const x = await req(m!, `/api/sax?__p=${p}`, { headers: { authorization: signInternalCall(c.internalKey, m!, p!) } });
      assert.equal(x.status, 404, `${m} ${p}`);
    }
    server.close();
  });

  it('내부 함수: 기기 상태 GET만, 서명 없음·다른 키·오래된 ts·재전송은 401, 공개 경로와 자동 정지는 404', async () => {
    const pre = openSqlite(c.file('account'));
    await seedDevice(pre, 'dev-2');
    await pre.close();
    const fn = internalFunction(c.env);
    const server = http.createServer((q, r) => void fn(q, r));
    const req = client(await listen(server));
    const p = '/internal/v1/devices/dev-2';
    const at = `/api/internal?__p=${p}`;
    assert.equal((await req('GET', at)).status, 401, '서명 없음');
    assert.equal((await req('GET', at, { headers: { authorization: signInternalCall(randomBytes(32), 'GET', p) } })).status, 401, '다른 키');
    assert.equal((await req('GET', at, { headers: { authorization: signInternalCall(c.internalKey, 'GET', p, '', Date.now() - 61_000) } })).status, 401, '오래된 ts');
    assert.equal((await req('GET', at, { headers: { authorization: signInternalCall(c.internalKey, 'GET', p, '', Date.now() + 61_000) } })).status, 401, '미래 ts');
    const sig = signInternalCall(c.internalKey, 'GET', p);
    const ok = await req('GET', at, { headers: { authorization: sig } });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.state, 'active');
    assert.equal((await req('GET', at, { headers: { authorization: sig } })).status, 401, '재전송');
    // 1회용 nonce는 DB에 있다: 다른 인스턴스(새 함수)로 같은 서명을 다시 보내도 401
    const fn2 = internalFunction(c.env);
    const s2 = http.createServer((q, r) => void fn2(q, r));
    assert.equal((await client(await listen(s2))('GET', at, { headers: { authorization: sig } })).status, 401, '다른 인스턴스 재전송');
    s2.close();
    // 공개 경로·허용 목록 밖 내부 경로는 서명이 있어도 404
    for (const [m, q] of [['GET', '/v1/me'], ['POST', '/internal/v1/devices/dev-2/auto-suspend'], ['POST', '/v1/auth/code']]) {
      assert.equal((await req(m!, `/api/internal?__p=${q}`, { headers: { authorization: signInternalCall(c.internalKey, m!, q!) } })).status, 404, `${m} ${q}`);
    }
    assert.deepEqual(INTERNAL_FUNCTION_ROUTES.map((r) => r.method), ['GET']);
    server.close();
  });

  it('cron 함수가 네 서비스 정리를 돌린다', async () => {
    const fn = cronFunction(c.env);
    const server = http.createServer((q, r) => void fn(q, r));
    const req = client(await listen(server));
    assert.equal((await req('GET', '/api/cron')).status, 401);
    assert.equal((await req('GET', '/api/cron', { headers: { authorization: `Bearer ${c.env.CRON_SECRET}` } })).status, 200);
    server.close();
  });

  it('Vercel api/*.js는 빌드된 cloud dist의 진입점을 기본 내보내기로 둔다(함수 셋: 공개·내부·정리)', () => {
    const dir = path.join(DEPLOY, 'vercel', 'api');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['cron.js', 'internal.js', 'sax.js']);
    for (const [f, fn] of [['sax', 'cloudFunction'], ['internal', 'internalFunction'], ['cron', 'cronFunction']]) {
      const src = fs.readFileSync(path.join(dir, `${f}.js`), 'utf8');
      assert.match(src, new RegExp(`import \\{ ${fn} \\} from '\\.\\./\\.\\./\\.\\./cloud/dist/index\\.js';`));
      assert.match(src, new RegExp(`export default ${fn}\\(\\);`));
    }
  });
});

interface Rewrite {
  source: string;
  destination: string;
}
const vercel = JSON.parse(fs.readFileSync(path.join(DEPLOY, 'vercel', 'vercel.json'), 'utf8')) as { rewrites: Rewrite[]; crons: { path: string }[]; functions: Record<string, unknown> };
/** 재작성 소스 → 정규식(`:path*`, `:id`만 쓴다) */
const toRe = (src: string) => new RegExp(`^${src.replace(/[.]/g, '\\.').replace('/:path*', '(?:/(.*))?').replace('/:id', '/([^/]+)')}$`);
const routeOf = (p: string) => vercel.rewrites.find((r) => toRe(r.source).test(p));

/** 각 서비스 라우터의 실제 경로(app.ts의 r.add, 여러 줄 포함) */
function routes(svc: string): string[] {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'services', svc, 'src', 'app.ts'), 'utf8');
  return [...src.matchAll(/r\.add\(\s*'[A-Z]+',\s*'([^']+)'/g)].map((m) => m[1]!.replace(/:[a-z]+/g, 'x'));
}

describe('vercel.json 재작성 규칙(tax.laf-co.com 한 origin, 내부 경로 기본 거부)', () => {
  it('모든 공개 경로가 공개 함수로 가고 __p가 원래 경로와 같다. 서비스끼리 공개 경로가 겹치지 않는다', () => {
    const owner = new Map<string, string>();
    for (const svc of ['account', 'gateway', 'relay', 'push']) {
      for (const p of routes(svc).filter((x) => x.startsWith('/v1/'))) {
        assert.ok(!owner.has(p) || owner.get(p) === svc, `${p}: ${owner.get(p)} · ${svc}`);
        owner.set(p, svc);
        const r = routeOf(p);
        assert.ok(r, `${svc} ${p}`);
        if (p === '/v1/rooms') {
          assert.equal(r!.destination, 'https://rooms.tax.laf-co.com/v1/rooms', '룸 발급은 룸 호스트로');
          continue;
        }
        assert.ok(r!.destination.startsWith('/api/sax?__p='), `${svc} ${p} → ${r!.destination}`);
        const m = toRe(r!.source).exec(p)!;
        assert.equal(r!.destination.replace('/api/sax?__p=', '').replace(':path*', m[1] ?? ''), p.replace(/\/$/, ''));
      }
    }
  });

  it('공개 재작성은 /internal에 닿지 않는다. 내부 재작성은 기기 상태 GET 하나뿐이고 내부 함수로만 간다', () => {
    for (const p of ['/internal/v1/devices/x', '/healthz', '/internal/v1/cron', '/api/account/internal/v1/devices/x', '/api/relay/internal/v1/devices/x/stopped']) assert.equal(routeOf(p), undefined, p);
    const internal = vercel.rewrites.filter((r) => r.destination.includes('/internal'));
    assert.deepEqual(internal, [{ source: '/api/internal/internal/v1/devices/:id', destination: '/api/internal?__p=/internal/v1/devices/:id' }]);
    assert.equal(routeOf('/api/internal/internal/v1/devices/x/auto-suspend'), undefined);
    for (const r of vercel.rewrites) if (r !== internal[0]) assert.ok(!r.destination.includes('internal'), r.source);
  });

  it('정리 cron은 /api/cron 하나, 공개 함수는 게이트웨이 때문에 60초', () => {
    assert.deepEqual(vercel.crons.map((x) => x.path), ['/api/cron']);
    assert.deepEqual(Object.keys(vercel.functions).sort(), ['api/cron.js', 'api/internal.js', 'api/sax.js']);
    assert.deepEqual(vercel.functions['api/sax.js'], { maxDuration: 60 });
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
  it('PostgreSQL: 역할 간 교차 GRANT 0·search_path 고정, 역할마다 자기 스키마만 읽고 쓰고 다른 서비스 테이블·DDL은 거부(D08 §8 분리 저장, 팀장 결정 2026-11-06 #135 (2))', { skip: !pgUrl }, async () => {
    const admin = openPg(pgUrl!);
    for (const s of SUPABASE_SERVICES) await admin.exec(`DROP SCHEMA IF EXISTS ${s.name} CASCADE; DROP SCHEMA IF EXISTS ${limitsSchemaOf(s.name)} CASCADE;`);
    for (const m of exportSupabase()) await admin.exec(m.sql);
    const as = (svc: string) => {
      const u = new URL(pgUrl!);
      u.username = roleOf(svc);
      u.password = '';
      return openPg(u.toString(), 1);
    };
    const names = SUPABASE_SERVICES.map((x) => x.name);
    const schemasOf = (svc: string) => [svc, limitsSchemaOf(svc)];
    // 교차 GRANT 0(팀장 결정 2026-11-06 #135 (2)): 역할마다 다른 서비스 스키마·표·시퀀스 권한이 하나도 없고, 다른 역할의 구성원도 아니다
    for (const a of names) {
      const role = roleOf(a);
      const foreign = names.filter((b) => b !== a).flatMap(schemasOf);
      const tg = await admin.all<{ n: string }>('SELECT count(*)::text AS n FROM information_schema.role_table_grants WHERE grantee = $1 AND NOT (table_schema = ANY($2))', [role, schemasOf(a)]);
      assert.equal(tg[0]!.n, '0', `${role} 표 권한`);
      for (const sch of foreign) {
        const r = await admin.one<{ u: boolean; c: boolean }>("SELECT has_schema_privilege($1, $2, 'USAGE') AS u, has_schema_privilege($1, $2, 'CREATE') AS c", [role, sch]);
        assert.deepEqual(r, { u: false, c: false }, `${role} → ${sch}`);
        const tables = await admin.all<{ t: string }>('SELECT table_name AS t FROM information_schema.tables WHERE table_schema = $1', [sch]);
        assert.ok(tables.length > 0, sch);
        for (const { t } of tables) {
          const p = await admin.one<{ any: boolean }>("SELECT has_table_privilege($1, $2, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS any", [role, `${sch}.${t}`]);
          assert.equal(p!.any, false, `${role} → ${sch}.${t}`);
        }
      }
      const own = await admin.one<{ c: boolean }>("SELECT has_schema_privilege($1, $2, 'CREATE') OR has_schema_privilege($1, $3, 'CREATE') AS c", [role, a, limitsSchemaOf(a)]);
      assert.equal(own!.c, false, `${role} 자기 스키마 DDL 없음`);
      const mem = await admin.all('SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member OR r.oid = m.roleid WHERE r.rolname = $1', [role]);
      assert.equal(mem.length, 0, `${role} 역할 구성원 없음`);
      // search_path 고정: 역할 설정에 자기 두 스키마만(public 없음)
      const cfg = await admin.one<{ c: string[] }>('SELECT rolconfig AS c FROM pg_roles WHERE rolname = $1', [role]);
      assert.deepEqual(cfg!.c, [`search_path=${a}, ${limitsSchemaOf(a)}`], role);
    }
    for (const s of SUPABASE_SERVICES) {
      const db = as(s.name);
      assert.equal((await db.one<{ search_path: string }>('SHOW search_path'))!.search_path, `${s.name}, ${limitsSchemaOf(s.name)}`);
      // 자기 스키마 테이블 = 마이그레이션 컬럼 표의 테이블
      const own = await db.all<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name <> 'schema_migrations'", [s.name]);
      assert.deepEqual(own.map((r) => r.table_name).sort(), Object.keys(schemaColumns(s.migrationsDir)).sort(), s.name);
      // 한도 표·내부 호출 nonce 표는 search_path로 바로 쓴다(코드 변경 없음)
      const lim = new SqlLimiter(db, Date.now);
      assert.equal((await lim.hit(`deploy-${s.name}`, 5, 60_000)).n, 1);
      await lim.reset(`deploy-${s.name}`, 60_000);
      const nonces = new SqlNonceStore(db);
      const nonce = randomBytes(16).toString('base64url');
      assert.equal(await nonces.claim(nonce, Date.now() + 60_000, Date.now()), true);
      assert.equal(await nonces.claim(nonce, Date.now() + 60_000, Date.now()), false);
      await assert.rejects(db.exec('CREATE TABLE nope (x INTEGER)'), /permission denied|no schema has been selected/);
      await assert.rejects(db.exec('CREATE TABLE public.nope (x INTEGER)'), /permission denied/);
      // 모든 다른 서비스: 본 표·한도 표 모두 읽기 거부(릴레이 ↔ 계정 포함 모든 쌍)
      for (const other of names.filter((n) => n !== s.name)) {
        await assert.rejects(db.all(`SELECT * FROM ${other}.schema_migrations`), /permission denied/, `${s.name} → ${other}`);
        await assert.rejects(db.all(`SELECT * FROM ${limitsSchemaOf(other)}.lim_salts`), /permission denied/, `${s.name} → ${other}_limits`);
      }
      await db.close();
    }
    const relayDb = as('relay');
    await assert.rejects(relayDb.all('SELECT email FROM account.accounts'), /permission denied/);
    await relayDb.close();
    const accountDb = as('account');
    await assert.rejects(accountDb.all('SELECT * FROM relay.mailboxes'), /permission denied/);
    await accountDb.close();
    const done = await admin.all<{ service: string; version: number }>('SELECT service, version FROM relay.schema_migrations ORDER BY service, version');
    assert.deepEqual(done.map((r) => `${r.service}:${r.version}`), ['limits:1', 'limits:2', 'relay:1']);
    await admin.close();
  });
});
