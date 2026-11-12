// 계좌 자동조회 CODEF 토큰 엔드포인트(POST /v1/codef/token, 대표 결정 2026-11-12). CODEF OAuth는 모의 fetch(실제 CODEF를 부르지 않는다).
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { BundleCatalog } from '../packages/model/src/index.ts';
import { Logger, createServer, listen, migrate, openSqlite } from '../services/shared/src/index.ts';
import { CODEF_OAUTH_URL, CodefOAuth, GATEWAY, GatewayService, MIGRATIONS_DIR, MockCodefTokenSource, MockNtsSource, MockProvider, codefFromEnv, gatewayRouter, type CodefTokenSource } from '../services/gateway/src/index.ts';
import { client, edKey } from './services-kit.ts';
import { accountStack, signedDesktop, signedPhone, type Signed, type Stack } from './services-stack.ts';

const GW = 'https://gw.test.invalid';
const PATH = '/v1/codef/token';
const FAKE_PUBLIC_KEY = Buffer.alloc(294, 7).toString('base64');

interface Env {
  s: Stack;
  server: Server;
  req: ReturnType<typeof client>;
  logs: string[];
  pc: Signed;
  call(body?: unknown, who?: Signed): ReturnType<Env['req']>;
}

async function start(codef: CodefTokenSource | null): Promise<Env> {
  const s = await accountStack();
  const db = openSqlite();
  await migrate(db, 'gateway', MIGRATIONS_DIR);
  const svc = new GatewayService({
    db,
    provider: new MockProvider(),
    catalog: BundleCatalog.load(),
    runKey: edKey().priv,
    cacheSecret: randomBytes(32),
    sidKey: randomBytes(32),
    tagKey: randomBytes(32),
    scopeKey: randomBytes(32),
    models: { decide: 'm-d', respond: 'm-r' },
    nts: new MockNtsSource(),
    suspender: { suspend: async () => undefined },
    now: s.clock.now,
    sleep: async () => undefined,
  });
  const logs: string[] = [];
  const server = createServer(gatewayRouter({ svc, codef, verifier: s.verifier, directory: s.directory, publicOrigin: GW }), { logger: new Logger('gateway', (l) => logs.push(l), s.clock.now) });
  const req = client(await listen(server));
  const pc = await signedDesktop(s, 'codef@example.com');
  const call = async (body: unknown = {}, who: Signed = pc) => req('POST', PATH, { headers: who.headers('POST', GW, PATH, await who.token()), body });
  return { s, server, req, logs, pc, call };
}

/** CODEF OAuth 모의 fetch: 받은 요청(헤더·본문)을 남기고 정해진 응답을 준다. */
function oauthFetch(reply: () => Response) {
  const seen: Array<{ url: string; auth: string; body: string; ct: string }> = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    seen.push({ url: String(url), auth: h.get('authorization') ?? '', body: String(init?.body ?? ''), ct: h.get('content-type') ?? '' });
    return reply();
  }) as typeof fetch;
  return { fn, seen };
}

describe('CODEF 토큰: /v1/codef/token', () => {
  let e: Env;
  let src: MockCodefTokenSource;
  beforeEach(async () => {
    src = new MockCodefTokenSource({ publicKey: FAKE_PUBLIC_KEY });
    e = await start(src);
  });
  afterEach(() => (e.server.close(), e.s.close()));

  it('기기 인증된 데스크톱에 토큰·만료·환경·공개키만 준다(시크릿 없음), 토큰은 접근 로그에 없고 aid도 없다', async () => {
    const r = await e.call();
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(Object.keys(r.json).sort(), ['accessToken', 'env', 'expiresAt', 'publicKey']);
    assert.match(r.json.accessToken, /^mock-codef-token-/);
    assert.equal(r.json.env, 'sandbox');
    assert.equal(r.json.publicKey, FAKE_PUBLIC_KEY);
    assert.ok(Date.parse(r.json.expiresAt) > Date.now());
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const line = e.logs.filter((l) => l.includes(PATH));
    assert.equal(line.length, 1);
    assert.ok(!line[0]!.includes(r.json.accessToken));
    assert.ok(!/"aid":"/.test(line[0]!), line[0]);
  });

  it('토큰 없음·폰 토큰은 거부하고 원천을 부르지 않는다', async () => {
    assert.equal((await e.req('POST', PATH, { body: {} })).json.error, 'gateway.unauthorized');
    const phone = await signedPhone(e.s, e.pc);
    const r = await e.req('POST', PATH, { headers: phone.headers('POST', GW, PATH, await phone.token()), body: {} });
    assert.equal(r.json.error, 'account.scope_denied');
    assert.equal(src.calls, 0);
  });

  it('본문에 키가 있으면 400, 기기당 시간당 한도를 넘으면 429', async () => {
    assert.equal((await e.call({ clientSecret: 'x' })).json.error, 'gateway.param_rejected');
    for (let i = 0; i < GATEWAY.codefTokenPerDeviceHour; i++) assert.equal((await e.call()).status, 200);
    const r = await e.call();
    assert.equal(r.status, 429);
    assert.equal(r.json.error, 'policy.rate_limited');
  });
});

describe('CODEF 토큰: 꺼짐·원천 장애', () => {
  it('CODEF_ENV가 없으면 503 gateway.codef_off', async () => {
    const e = await start(null);
    try {
      const r = await e.call();
      assert.equal(r.status, 503);
      assert.equal(r.json.error, 'gateway.codef_off');
    } finally {
      e.server.close();
      e.s.close();
    }
  });

  it('CODEF OAuth가 실패하면 503 gateway.upstream_error(내용 없음)', async () => {
    const f = oauthFetch(() => new Response('{"error":"invalid_client"}', { status: 401 }));
    const e = await start(new CodefOAuth({ env: 'demo', clientId: 'client-id-0001', clientSecret: 'secret-0001', publicKey: FAKE_PUBLIC_KEY, fetchFn: f.fn }));
    try {
      const r = await e.call();
      assert.equal(r.status, 503);
      assert.deepEqual(r.json, { error: 'gateway.upstream_error' });
    } finally {
      e.server.close();
      e.s.close();
    }
  });
});

describe('CodefOAuth: client credentials·캐시', () => {
  it('Basic 인증·form 본문으로 받고, 만료 1시간 전까지 다시 쓰며, 동시 요청은 한 번만 받는다', async () => {
    let now = 1_000_000;
    const f = oauthFetch(() => Response.json({ access_token: `tok-${'a'.repeat(30)}`, token_type: 'bearer', expires_in: 604799, scope: 'read' }));
    const o = new CodefOAuth({ env: 'prod', clientId: 'client-id-0001', clientSecret: 'secret-0001', publicKey: FAKE_PUBLIC_KEY, fetchFn: f.fn, now: () => now });
    const [a, b] = await Promise.all([o.token(), o.token()]);
    assert.equal(f.seen.length, 1);
    assert.equal(a, b);
    assert.equal(f.seen[0]!.url, CODEF_OAUTH_URL);
    assert.equal(f.seen[0]!.auth, `Basic ${Buffer.from('client-id-0001:secret-0001').toString('base64')}`);
    assert.equal(f.seen[0]!.body, 'grant_type=client_credentials&scope=read');
    assert.equal(f.seen[0]!.ct, 'application/x-www-form-urlencoded');
    assert.equal(a.expiresAt, now + 604799_000);
    now += 604799_000 - 2 * 3600_000;
    await o.token();
    assert.equal(f.seen.length, 1, '만료 2시간 전이면 캐시');
    now += 90 * 60_000;
    await o.token();
    assert.equal(f.seen.length, 2, '만료 30분 전이면 새로 받는다');
  });

  it('모양이 틀린 토큰·7일보다 긴 수명은 믿지 않는다', async () => {
    const bad = new CodefOAuth({ env: 'demo', clientId: 'client-id-0001', clientSecret: 'secret-0001', publicKey: FAKE_PUBLIC_KEY, fetchFn: oauthFetch(() => Response.json({ access_token: 'a\nb' })).fn });
    await assert.rejects(bad.token());
    const long = new CodefOAuth({ env: 'demo', clientId: 'client-id-0001', clientSecret: 'secret-0001', publicKey: FAKE_PUBLIC_KEY, now: () => 0, fetchFn: oauthFetch(() => Response.json({ access_token: 't'.repeat(40), expires_in: 99_999_999 })).fn });
    assert.equal((await long.token()).expiresAt, 7 * 24 * 3600_000);
  });
});

describe('codefFromEnv', () => {
  const fail = (n: string): never => {
    throw new Error(`config_${n}`);
  };
  it('없으면 꺼짐(null), mock은 모의, 값이 틀리면 기동 거부', () => {
    assert.equal(codefFromEnv({}, fail), null);
    assert.ok(codefFromEnv({ CODEF_ENV: 'mock' }, fail) instanceof MockCodefTokenSource);
    assert.throws(() => codefFromEnv({ CODEF_ENV: 'staging' }, fail), /config_CODEF_ENV/);
    assert.throws(() => codefFromEnv({ CODEF_ENV: 'demo' }, fail), /config_CODEF_CLIENT_ID/);
    assert.throws(() => codefFromEnv({ CODEF_ENV: 'demo', CODEF_CLIENT_ID: 'client-id-0001' }, fail), /config_CODEF_CLIENT_SECRET/);
    assert.throws(() => codefFromEnv({ CODEF_ENV: 'demo', CODEF_CLIENT_ID: 'client-id-0001', CODEF_CLIENT_SECRET: 'secret-0001', CODEF_PUBLIC_KEY: 'short' }, fail), /config_CODEF_PUBLIC_KEY/);
    const ok = codefFromEnv({ CODEF_ENV: 'demo', CODEF_CLIENT_ID: 'client-id-0001', CODEF_CLIENT_SECRET: 'secret-0001', CODEF_PUBLIC_KEY: FAKE_PUBLIC_KEY.replace(/(.{64})/g, '$1\n') }, fail);
    assert.ok(ok instanceof CodefOAuth);
    assert.equal(ok.env, 'demo');
    assert.equal(ok.publicKey, FAKE_PUBLIC_KEY);
    // 기본은 demo(키만 넣으면 데모 호스트)
    const dflt = codefFromEnv({ CODEF_CLIENT_ID: 'client-id-0001', CODEF_CLIENT_SECRET: 'secret-0001', CODEF_PUBLIC_KEY: FAKE_PUBLIC_KEY }, fail);
    assert.equal(dflt?.env, 'demo');
  });
});
