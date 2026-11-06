// 배포 구성(Vercel 함수 + Supabase): 진입점·환경 접두·경로 복원·내부 경로 기본 거부·cron 보호·한 프로세스 조립(서비스 사이 함수 호출)·재작성 규칙·마이그레이션 내보내기·역할 분리.
// PostgreSQL 역할 분리 시험은 SAX_PG_TEST_URL(빈 DB, 초superuser, 역할은 trust로 비밀번호 없이 접속)일 때만 돈다.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  LIMITS_MIGRATIONS_DIR,
  SUPABASE_PHASES,
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
  REWRITE_PARAMS,
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
import { materialize, rewriteLikeVercel } from '../services/deploy/check-vercel-output.ts';
import { TransparencyLog } from '../services/registry/src/index.ts';
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

  it('재작성 소스의 이름 붙은 매개변수(path·id)를 플랫폼이 쿼리에 다시 붙여도 원래 쿼리만 남긴다(운영 /registry/log/head.json 400 회귀)', () => {
    assert.equal(restorePath('/api/registry?__p=/registry/log/head.json&path=head.json'), '/registry/log/head.json');
    assert.equal(restorePath('/api/registry?path=proof%2Fconsistency&__p=/registry/log/proof/consistency&from=0&to=3'), '/registry/log/proof/consistency?from=0&to=3');
    assert.equal(restorePath('/api/registry?__p=/registry/log&path='), '/registry/log');
    assert.equal(restorePath('/api/internal?__p=/internal/v1/devices/dev-1&id=dev-1'), '/internal/v1/devices/dev-1');
    assert.equal(restorePath('/api/sax?__p=/v1/auth/code&path=code'), '/v1/auth/code');
    // 경로 끝과 다른 값은 원래 요청의 것: 남긴다(라우터가 판단)
    assert.equal(restorePath('/api/registry?__p=/registry/log/head.json&path=evil'), '/registry/log/head.json?path=evil');
    assert.equal(restorePath('/api/registry?__p=/registry/log/head.json&path=head.json&path=x'), '/registry/log/head.json?path=head.json&path=x');
    assert.equal(restorePath('/api/internal?__p=/internal/v1/devices/dev-1&id=dev-2'), '/internal/v1/devices/dev-1?id=dev-2');
  });

  it('점검 스크립트의 재작성 흉내는 운영에서 본 모양과 같다(소스 매개변수를 쿼리에 다시 붙임)', () => {
    assert.equal(rewriteLikeVercel(vercel.rewrites, '/registry/log/head.json'), '/api/registry?__p=/registry/log/head.json&path=head.json');
    assert.equal(rewriteLikeVercel(vercel.rewrites, '/registry/log/proof/consistency?from=0&to=3'), '/api/registry?__p=/registry/log/proof/consistency&path=proof%2Fconsistency&from=0&to=3');
    assert.equal(rewriteLikeVercel(vercel.rewrites, '/v1/me'), '/api/sax?__p=/v1/me');
    assert.equal(rewriteLikeVercel(vercel.rewrites, '/api/internal/internal/v1/devices/d1'), '/api/internal?__p=/internal/v1/devices/d1&id=d1');
    assert.equal(rewriteLikeVercel(vercel.rewrites, '/registry/status.json'), null, '버킷 외부 재작성');
    assert.equal(rewriteLikeVercel(vercel.rewrites, '/nope'), null);
    // 그 결과를 restorePath가 원래 경로·쿼리로 되돌린다
    for (const p of ['/registry/log/head.json', '/registry/log/proof/consistency?from=0&to=3', '/v1/mailboxes/mb/envelopes?since=2', '/api/internal/internal/v1/devices/d1']) {
      const want = p.startsWith('/api/internal/internal') ? p.replace('/api/internal', '') : p;
      assert.equal(restorePath(rewriteLikeVercel(vercel.rewrites, p)!), want, p);
    }
  });

  it('재작성 매개변수 이름은 vercel.json 소스의 이름과 같고, 어느 서비스 라우터도 그 이름을 쿼리 키로 읽지 않는다', () => {
    const names = new Set(vercel.rewrites.flatMap((r) => [...r.source.matchAll(/:([a-z]+)\*?/g)].map((m) => m[1]!)));
    assert.deepEqual([...names].sort(), [...REWRITE_PARAMS].sort());
    for (const svc of ['account', 'gateway', 'relay', 'push', 'registry']) {
      const dir = path.join(import.meta.dirname, '..', 'services', svc, 'src');
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
        const src = fs.readFileSync(path.join(dir, f), 'utf8');
        for (const n of REWRITE_PARAMS) {
          assert.ok(!new RegExp(`(query|searchParams)\\.(get|getAll|has)\\(\\s*'${n}'`).test(src), `${svc}/${f}: ${n}`);
          assert.ok(!new RegExp(`query\\(ctx, \\{[^}]*\\b${n}:`).test(src), `${svc}/${f}: ${n}`);
        }
      }
    }
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

  it('Vercel api/*.js는 빌드된 dist의 진입점을 기본 내보내기로 둔다(공개·내부·정리 + 레지스트리·레지스트리 재서명)', () => {
    const dir = path.join(DEPLOY, 'vercel', 'api');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['cron.js', 'internal.js', 'registry-cron.js', 'registry.js', 'sax.js']);
    for (const [f, fn, pkg] of [
      ['sax', 'cloudFunction', 'cloud'],
      ['internal', 'internalFunction', 'cloud'],
      ['cron', 'cronFunction', 'cloud'],
      ['registry', 'registryFunction', 'registry'],
      ['registry-cron', 'registryCronFunction', 'registry'],
    ]) {
      const src = fs.readFileSync(path.join(dir, `${f}.js`), 'utf8');
      assert.match(src, new RegExp(`import \\{ ${fn} \\} from '\\.\\./\\.\\./\\.\\./${pkg}/dist/index\\.js';`));
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

describe('Vercel 함수 묶음(파일 추적이 따라갈 수 있는 모듈만, 팀장 결정 2026-11-06)', () => {
  it('packages·services 소스에 createRequire가 없다(ajv/dist/2020이 묶음에서 빠져 모든 함수가 죽었다): 의존성은 정적 import로', () => {
    const root = path.join(import.meta.dirname, '..');
    const hits: string[] = [];
    const walk = (d: string): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f);
        else if (/\.(ts|js|mjs)$/.test(e.name) && /\bcreateRequire\b/.test(fs.readFileSync(f, 'utf8'))) hits.push(path.relative(root, f));
      }
    };
    for (const top of ['packages', 'services']) {
      for (const pkg of fs.readdirSync(path.join(root, top))) {
        const src = path.join(root, top, pkg, 'src');
        if (fs.existsSync(src)) walk(src);
      }
    }
    assert.deepEqual(hits, []);
  });

  it('점검 스크립트는 filePathMap의 링크를 배포 때처럼 되살린다(작업공간 링크·의존성 폴더)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sax-vc-'));
    try {
      fs.mkdirSync(path.join(root, 'poc/node_modules/.pnpm/x@1/node_modules/x'), { recursive: true });
      fs.writeFileSync(path.join(root, 'poc/node_modules/.pnpm/x@1/node_modules/x/index.js'), 'module.exports = 1;');
      fs.mkdirSync(path.join(root, 'poc/svc/node_modules'), { recursive: true });
      fs.symlinkSync('../../node_modules/.pnpm/x@1/node_modules/x', path.join(root, 'poc/svc/node_modules/x'));
      const func = path.join(root, 'out/a.func');
      fs.mkdirSync(path.join(func, 'poc/node_modules/.pnpm/x@1/node_modules/x'), { recursive: true });
      fs.writeFileSync(path.join(func, 'poc/node_modules/.pnpm/x@1/node_modules/x/index.js'), 'module.exports = 1;');
      fs.writeFileSync(path.join(func, '.vc-config.json'), JSON.stringify({ handler: 'poc/svc/h.js', filePathMap: { 'poc/svc/node_modules/x': 'poc/svc/node_modules/x' } }));
      const m = materialize(func, root, path.join(root, 'copy'));
      assert.equal(m.handler, 'poc/svc/h.js');
      // Windows는 symlink를 만들 때 대상의 `/`를 `\\`로 바꿔 저장한다. 같은 대상인지는 구분자를 맞춰 본다.
      assert.equal(fs.readlinkSync(path.join(m.dir, 'poc/svc/node_modules/x')).split(path.sep).join('/'), '../../node_modules/.pnpm/x@1/node_modules/x');
      assert.equal(fs.readFileSync(path.join(m.dir, 'poc/svc/node_modules/x/index.js'), 'utf8'), 'module.exports = 1;');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

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

  it('cron은 정리(/api/cron)와 레지스트리 재서명(/api/registry-cron) 둘, 공개 함수는 게이트웨이 때문에 60초', () => {
    assert.deepEqual(vercel.crons.map((x) => x.path), ['/api/cron', '/api/registry-cron']);
    assert.deepEqual(Object.keys(vercel.functions).sort(), ['api/cron.js', 'api/internal.js', 'api/registry-cron.js', 'api/registry.js', 'api/sax.js']);
    assert.deepEqual(vercel.functions['api/sax.js'], { maxDuration: 60 });
  });

  it('레지스트리: 공개 정적 GET은 공개 버킷의 같은 경로로, 로그 GET·게시 PUT만 레지스트리 함수로(__p가 원래 경로). 다른 함수와 겹치지 않는다', () => {
    const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'services', 'registry', 'src', 'app.ts'), 'utf8');
    const all = [...src.matchAll(/r\.add\(\s*'([A-Z]+)',\s*'([^']+)'/g)].map((m) => ({ method: m[1]!, path: m[2]!.replace(/:[a-z]+/g, 'x') }))
      // 상시 서버의 /healthz는 공개 origin에 두지 않는다
      .filter((x) => x.path !== '/healthz');
    assert.ok(all.length >= 12, String(all.length));
    assert.equal(routeOf('/healthz'), undefined);
    const BUCKET = 'https://gncmivowifnzqurroecr.supabase.co/storage/v1/object/public/sax-registry/';
    for (const { method, path: p } of all) {
      const r = routeOf(p);
      assert.ok(r, `${method} ${p}`);
      const fn = p.startsWith('/registry/log/') || p.startsWith('/admin/v1/');
      assert.equal(fn, method === 'PUT' || p.startsWith('/registry/log/'), `${method} ${p}`);
      if (fn) {
        assert.ok(r!.destination.startsWith('/api/registry?__p='), `${p} → ${r!.destination}`);
        const m = toRe(r!.source).exec(p)!;
        assert.equal(r!.destination.replace('/api/registry?__p=', '').replace(':path*', m[1] ?? ''), p);
      } else {
        assert.equal(method, 'GET', p);
        const m = toRe(r!.source).exec(p)!;
        assert.equal(r!.destination.replace(':path*', m[1] ?? ''), BUCKET + p.slice(1), p);
      }
    }
    // 버킷 재작성은 공개 접두 네 개뿐이고 공개 객체 URL(https, 버킷 sax-registry)로만 간다
    const ext = vercel.rewrites.filter((r) => r.destination.startsWith('https://') && r.destination.includes('/storage/'));
    assert.deepEqual(ext.map((r) => r.source), ['/registry/:path*', '/policy/:path*', '/packages/:path*', '/releases/:path*']);
    for (const r of ext) assert.equal(r.destination, `${BUCKET}${r.source.slice(1)}`);
    // 로그 재작성이 버킷 재작성보다 앞이다(첫 일치)
    const i = (s: string) => vercel.rewrites.findIndex((r) => r.source === s);
    assert.ok(i('/registry/log/:path*') < i('/registry/:path*'));
    assert.equal(routeOf('/registry/log')?.destination, '/api/registry?__p=/registry/log/:path*');
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

  it('적용된 단계의 파일은 바뀌지 않는다(증분 내보내기: 운영 tex-prod에 적용된 2026110600 단계 다이제스트 고정)', () => {
    const applied: Record<string, string> = {
      '20261106000000_sax_roles.sql': 'c5563037286098d40065cf9bb30fd3a230d542b0dee626959580d686fb18a76e',
      '20261106000100_sax_account.sql': 'e51b0c6b6c8b00d14dfd8da02c3459333dbe18b0ca36a3428b4c62c0a969440f',
      '20261106000200_sax_gateway.sql': '72d99c5c0e83aadfdde1ba2099975a02f047427dfb2898fc2ed2281aee56b64a',
      '20261106000300_sax_relay.sql': '550bb0ad245e0c00a9ba0b02c8c1efcd20af789eec0e38d2a823df830c1b4bf5',
      '20261106000400_sax_push.sql': '8128117933efbf53bb171b7a97716b41f5f6bf85f0bb33f5486fcd80aad155ea',
    };
    const out = new Map(exportSupabase().map((m) => [m.name, m.sql]));
    for (const [name, digest] of Object.entries(applied)) assert.equal(createHash('sha256').update(out.get(name) ?? '').digest('hex'), digest, name);
    // 새 단계는 뒤에 붙는다(이름 순서 = 적용 순서)
    const names = [...out.keys()];
    assert.deepEqual(names, [...names].sort());
    assert.deepEqual(names.slice(5), ['20261106010000_sax_roles_registry.sql', '20261106010100_sax_registry.sql']);
    assert.deepEqual(SUPABASE_PHASES.map((p) => p.services.map((s) => s.name)), [['account', 'gateway', 'relay', 'push'], ['registry']]);
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
    // 레지스트리 함수 역할(증분 단계 2026110601): 마이그레이션 없이 투명성 로그 append·헤드 재서명이 돈다(함수는 DDL을 하지 않는다)
    const regDb = as('registry');
    const log = await TransparencyLog.open({ db: regDb, signer: { keyId: 'timestamp-test', key: ed25519Private(randomBytes(32)) }, now: Date.now, migrate: false });
    assert.equal((await log.append({ kind: 'status', path: 'registry/status.json', sha256: '0'.repeat(64) })).index, 0);
    assert.equal(await log.refreshHead(0), true);
    assert.equal((await log.head()).treeSize, 1);
    await regDb.close();
    await admin.close();
  });
});
