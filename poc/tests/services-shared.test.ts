// 클라우드 공통 모듈(services/shared): 라우터 오류 코드, 무내용 로그, 일 회전 솔트, 서명 입력 규칙, 기기 토큰·DPoP.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Server } from 'node:http';
import {
  DailySalt,
  JtiCache,
  Logger,
  Router,
  TokenIssuer,
  TokenVerifier,
  createServer,
  ed25519RawPublic,
  fail,
  json,
  jcs,
  listen,
  looksSensitive,
  migrate,
  openSqlite,
  sanitize,
  sigInput,
  verifyDpop,
} from '../services/shared/src/index.ts';
import { Clock, client, dpop, edKey } from './services-kit.ts';

describe('shared: HTTP 라우터는 본문·경로를 되풀이하지 않고 D16 코드로만 답한다', () => {
  let server: Server;
  let req: ReturnType<typeof client>;
  const logs: string[] = [];
  before(async () => {
    const r = new Router()
      .add('GET', '/v1/things/:id', (ctx) => json(200, { id: ctx.params.id }))
      .add('POST', '/v1/things', () => fail('request.param_rejected'))
      .add('GET', '/v1/boom', () => {
        throw new Error('secret 900101-1234567 in stack');
      });
    server = createServer(r, { logger: new Logger('t', (l) => logs.push(l)) });
    req = client(await listen(server));
  });
  after(() => server.close());

  it('없는 경로 404, 다른 메서드 405, 경로 변수 안전 문자 밖이면 404', async () => {
    assert.deepEqual((await req('GET', '/v1/nope')).json, { error: 'request.not_found' });
    assert.deepEqual((await req('DELETE', '/v1/things/a')).json, { error: 'request.method_not_allowed' });
    assert.equal((await req('GET', '/v1/things/%3Cscript%3E')).status, 404);
    assert.deepEqual((await req('GET', '/v1/things/abc-1')).json, { id: 'abc-1' });
  });

  it('처리 중 예외는 500 server.internal, 예외 메시지·스택은 응답·로그 어디에도 없다', async () => {
    const r = await req('GET', '/v1/boom');
    assert.deepEqual([r.status, r.json], [500, { error: 'server.internal' }]);
    assert.ok(!logs.some((l) => l.includes('secret') || looksSensitive(l)));
  });

  it('보안 헤더: no-store, nosniff', async () => {
    const r = await req('GET', '/v1/things/x');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  });

  it('로그는 라우트 패턴만 남긴다(경로 변수 값 없음)', () => {
    assert.ok(logs.some((l) => l.includes('"route":"/v1/things/:id"')));
    assert.ok(!logs.some((l) => l.includes('abc-1')));
  });
});

describe('shared: 로그 정제·탐지기·일 회전 솔트', () => {
  it('sanitize는 허용 키만, 문자열의 비안전 문자는 지운다', () => {
    const o = sanitize({ t: 'x', svc: 'a', route: '/v1/x', email: 'a@b.com', status: 200, code: 'ok"\n{', extra: 1 });
    assert.deepEqual(Object.keys(o).sort(), ['code', 'route', 'status', 'svc', 't']);
    assert.ok(!String(o.code).includes('\n'));
  });

  it('탐지기는 주민번호·사업자번호·카드·이메일·긴 토큰·IPv4를 잡는다', () => {
    for (const s of ['900101-1234567', '123-45-67890', '4111 1111 1111 1111', 'a@example.com', 'A'.repeat(43), '10.0.0.1']) assert.ok(looksSensitive(s), s);
    assert.ok(!looksSensitive('{"route":"/v1/devices/:id","status":200,"aid":"0123456789abcdef0123456789abcdef"}'));
  });

  it('일 회전 솔트: 같은 날 같은 값, KST 날짜가 바뀌면 다른 값(옛 솔트는 버려진다)', () => {
    const c = new Clock(Date.UTC(2026, 10, 10, 14, 0, 0)); // KST 23:00
    const s = new DailySalt('ip', c.now);
    const a = s.hash('203.0.113.7');
    assert.equal(s.hash('203.0.113.7'), a);
    assert.match(a, /^[0-9a-f]{32}$/);
    c.advance(3600_000 + 1); // KST 다음 날 00:00
    assert.notEqual(s.hash('203.0.113.7'), a);
  });
});

describe('shared: 서명 입력·기기 토큰·DPoP', () => {
  it('서명 입력 = utf8(맥락) ‖ utf8(JCS(객체)), 키 순서와 무관', () => {
    assert.equal(sigInput('SAX-cert-v1', { b: 1, a: 'x' }).toString('utf8'), 'SAX-cert-v1{"a":"x","b":1}');
    assert.equal(jcs({ z: [1, { y: 2, x: 1 }] }), '{"z":[1,{"x":1,"y":2}]}');
  });

  it('기기 토큰: 다른 kid·변조·만료·정규형 아닌 토큰 거부', () => {
    const k = edKey();
    const c = new Clock();
    const iss = new TokenIssuer('k1', k.priv);
    const ver = new TokenVerifier({ k1: ed25519RawPublic(k.priv) });
    const claims = { acc: 'a', dev: 'd', role: 'desktop' as const, scp: ['gateway' as const], cnf: edKey().b64 };
    const t = iss.issue(claims, c.now()).token;
    assert.equal(ver.verify(t, c.now(), 'gateway.unauthorized').acc, 'a');
    assert.throws(() => new TokenVerifier({ k2: ed25519RawPublic(k.priv) }).verify(t, c.now(), 'gateway.unauthorized'));
    const [p, body, sig] = t.split('.');
    const tampered = JSON.parse(Buffer.from(body!, 'base64url').toString()) as Record<string, unknown>;
    tampered.scp = ['gateway', 'slots'];
    assert.throws(() => ver.verify(`${p}.${Buffer.from(jcs(tampered)).toString('base64url')}.${sig}`, c.now(), 'gateway.unauthorized'));
    assert.throws(() => ver.verify(`${p}.${Buffer.from(JSON.stringify(JSON.parse(Buffer.from(body!, 'base64url').toString()), null, 1)).toString('base64url')}.${sig}`, c.now(), 'gateway.unauthorized'));
    c.advance(16 * 60_000);
    assert.throws(() => ver.verify(t, c.now(), 'gateway.unauthorized'));
  });

  it('DPoP: 메서드·주소·토큰 해시·키가 모두 맞아야 하고 jti는 1회', () => {
    const v = edKey();
    const now = Date.UTC(2026, 10, 10);
    const jti = new JtiCache();
    const base = { method: 'POST', htu: 'https://g.test/v1/x', token: 'tok', cnf: v.raw, now, jti, code: 'account.dpop_invalid' as const };
    const h = dpop('POST', 'https://g.test/v1/x', 'tok', v, now);
    verifyDpop(h, base);
    assert.throws(() => verifyDpop(h, base));
    assert.throws(() => verifyDpop(dpop('GET', 'https://g.test/v1/x', 'tok', v, now), base));
    assert.throws(() => verifyDpop(dpop('POST', 'https://g.test/v1/y', 'tok', v, now), base));
    assert.throws(() => verifyDpop(dpop('POST', 'https://g.test/v1/x', 'other', v, now), base));
    assert.throws(() => verifyDpop(dpop('POST', 'https://g.test/v1/x', 'tok', edKey(), now), base));
    assert.throws(() => verifyDpop(dpop('POST', 'https://g.test/v1/x', 'tok', v, now + 61_000), base));
    assert.throws(() => verifyDpop(undefined, base));
  });
});

describe('shared: 마이그레이션', () => {
  it('같은 마이그레이션을 두 번 돌려도 한 번만 적용된다', async () => {
    const { MIGRATIONS_DIR } = await import('../services/account/src/main.ts');
    const db = openSqlite();
    await migrate(db, 'account', MIGRATIONS_DIR);
    await migrate(db, 'account', MIGRATIONS_DIR);
    const r = await db.all<{ version: number }>("SELECT version FROM schema_migrations WHERE service = 'account'");
    assert.deepEqual(r.map((x) => Number(x.version)), [1]);
    await db.close();
  });
});
