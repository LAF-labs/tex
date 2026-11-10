// 엔진 게이트웨이 인증(ADR-040 결정 3·5): main auth 포트로 요청마다 헤더를 받는 portGatewayAuth와 Egress.toGateway의 401 1회 재시도.
// 포트 건너편은 데스크톱 GatewayAuthHost(결정 2의 공통 계약)를 그대로 붙인다. 게이트웨이는 tests/fixtures/gateway-mock.ts 합성.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { openDatabase, type Db } from '@sax/db';
import { gatewayIntentModel, GW_AUTH_TIMEOUT_MS, IntentResolver, portGatewayAuth } from '@sax/engine';
import { BundleCatalog } from '@sax/model';
import { Egress, GATEWAY_ORIGIN, GatewayError, type GatewayAuth } from '@sax/net';
import type { PortLike } from '@sax/platform';
import { GatewayAuthHost, type GatewayDevice } from '../apps/desktop/src/gateway-auth.ts';
import { startGatewayMock, type GatewayMock } from './fixtures/gateway-mock.ts';

const catalog = BundleCatalog.load();
const RUN = { runId: 'run_0123456789ab' };
const gwCode = (p: Promise<unknown>, c: string) => assert.rejects(p, (e: unknown) => e instanceof GatewayError && e.code === c, c);

/** 메모리 포트 한 쌍(비동기 전달, 실제 MessagePort처럼). sent는 엔진 쪽이 보낸 것. */
function portPair() {
  const ls: Array<Array<(m: unknown) => void>> = [[], []];
  const sent: unknown[] = [];
  const mk = (me: 0 | 1): PortLike => ({
    postMessage: (m) => {
      if (me === 0) sent.push(structuredClone(m));
      queueMicrotask(() => ls[1 - me]!.forEach((f) => f(structuredClone(m))));
    },
    onMessage: (f) => void ls[me]!.push(f),
    close: () => {},
  });
  return { engine: mk(0), main: mk(1), sent };
}

/** 데스크톱 호스트를 붙인 auth 포트. device를 바꿔 로그인 안 됨 등을 만든다. */
function wired(o: { device?: () => GatewayDevice | null; timeoutMs?: number; answer?: boolean } = {}) {
  const pair = portPair();
  const stats = { auth: 0, cleared: 0 };
  const device: GatewayDevice = {
    gatewayAuth: async () => {
      stats.auth++;
      return { Authorization: `DPoP sxd1.gw-token-${stats.cleared}`, DPoP: `proof-${stats.auth}` };
    },
    clearGatewayToken: () => void stats.cleared++,
  };
  const host = new GatewayAuthHost({ device: o.device ?? (() => device) });
  // main은 auth 포트 메시지를 받은 순서대로 하나씩 처리해야 한다. 그래야 invalidate가 다음 gw.auth보다 먼저 캐시를 지운다
  // (동시에 처리하면 재시도가 지우기 전의 옛 토큰을 받아 두 번째도 401이다. 데스크톱 EngineHost.onAuth 후속).
  let q: Promise<unknown> = Promise.resolve();
  if (o.answer !== false) pair.main.onMessage((m) => void (q = q.then(() => host.handle(m)).then((r) => r && pair.main.postMessage(r))));
  const auth = portGatewayAuth(pair.engine, { timeoutMs: o.timeoutMs });
  return { auth, pair, stats };
}

let mock: GatewayMock;
before(async () => (mock = await startGatewayMock()));
after(() => mock.close());
beforeEach(() => {
  mock.opts = {};
  mock.calls.length = 0;
});
const egressOf = (auth: GatewayAuth) =>
  new Egress({ env: {}, testOrigins: { gateway: mock.origin }, gateway: { auth, bundles: catalog.allowEntries() } });

describe('엔진 auth 포트(ADR-040 결정 2·3)', () => {
  it('요청마다 {gw.auth, id, htm, htu}만 보내고(본문 해시 없음), 받은 헤더로 게이트웨이에 보낸다', async () => {
    const { auth, pair, stats } = wired();
    const r = (await egressOf(auth).toGateway({ surface: 'runTokens', body: RUN })) as { runToken: string };
    assert.equal(typeof r.runToken, 'string');
    assert.deepEqual(pair.sent, [{ t: 'gw.auth', id: 1, htm: 'POST', htu: `${GATEWAY_ORIGIN}/v1/run-tokens` }]);
    const c = mock.calls.at(-1)!;
    assert.equal(c.headers.authorization, 'DPoP sxd1.gw-token-0');
    assert.equal(c.headers.dpop, 'proof-1');
    await egressOf(auth).toGateway({ surface: 'runTokens', body: RUN });
    assert.equal((pair.sent.at(-1) as { id: number }).id, 2, 'id는 요청마다 새로');
    assert.equal(stats.auth, 2, 'DPoP 증명은 요청마다 새로 받는다');
  });

  it('로그인 안 됨(account.signed_out)이면 게이트웨이를 부르지 않고 gateway.unavailable', async () => {
    const { auth } = wired({ device: () => null });
    await gwCode(egressOf(auth).toGateway({ surface: 'runTokens', body: RUN }), 'gateway.unavailable');
    assert.equal(mock.calls.length, 0);
  });

  it('auth 포트가 시간 안에 답하지 않으면 gateway.unavailable, 늦은 답은 버린다. 기본 상한은 5초', async () => {
    assert.equal(GW_AUTH_TIMEOUT_MS, 5_000);
    const { auth, pair } = wired({ answer: false, timeoutMs: 30 });
    await gwCode(egressOf(auth).toGateway({ surface: 'runTokens', body: RUN }), 'gateway.unavailable');
    pair.main.postMessage({ t: 'gw.auth.result', id: 1, headers: { authorization: 'DPoP late', dpop: 'late' } });
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(mock.calls.length, 0);
  });

  it('모양이 틀린 답(키 더 있음·CR/LF·DPoP 아님·문자열 아님·실패 코드)은 쓰지 않는다', async () => {
    const bad: unknown[] = [
      { authorization: 'DPoP t', dpop: 'p', cookie: 'x' },
      { authorization: 'DPoP t\r\nX-Evil: 1', dpop: 'p' },
      { authorization: 'Bearer t', dpop: 'p' },
      { authorization: 'DPoP t', dpop: 7 },
      undefined,
    ];
    for (const headers of bad) {
      const pair = portPair();
      pair.main.onMessage((m) => {
        const id = (m as { id: number }).id;
        pair.main.postMessage(headers === undefined ? { t: 'gw.auth.result', id, code: 'auth.denied' } : { t: 'gw.auth.result', id, headers });
      });
      await gwCode(egressOf(portGatewayAuth(pair.engine)).toGateway({ surface: 'runTokens', body: RUN }), 'gateway.unavailable');
    }
    assert.equal(mock.calls.length, 0);
  });

  it('close: 기다리던 요청은 unavailable, 그 뒤 요청·invalidate는 보내지 않는다', async () => {
    const { auth, pair } = wired({ answer: false });
    const p = auth.headers({ method: 'POST', url: `${GATEWAY_ORIGIN}/v1/decide`, bodySha256: '0'.repeat(64) });
    auth.close();
    await gwCode(p, 'gateway.unavailable');
    await gwCode(auth.headers({ method: 'POST', url: `${GATEWAY_ORIGIN}/v1/decide`, bodySha256: '0'.repeat(64) }), 'gateway.unavailable');
    auth.invalidate();
    assert.equal(pair.sent.length, 1);
  });
});

describe('Egress.toGateway 오류 의미(ADR-040 결정 5)', () => {
  it('401 → invalidate(게이트웨이 토큰만 지움) → 한 번만 다시 보내 성공', async () => {
    const { auth, pair, stats } = wired();
    mock.opts = { fail: { '/v1/run-tokens': { status: 401, code: 'gateway.unauthorized' } } };
    const host = { clear: 0 };
    // 새 토큰이면 통과하는 게이트웨이: invalidate가 오면 다음 요청부터 401을 거둔다.
    pair.main.onMessage((m) => {
      if ((m as { t: string }).t === 'gw.auth.invalidate') {
        host.clear++;
        mock.opts = {};
      }
    });
    const r = (await egressOf(auth).toGateway({ surface: 'runTokens', body: RUN })) as { runToken: string };
    assert.equal(typeof r.runToken, 'string');
    assert.equal(mock.calls.length, 2);
    assert.equal(host.clear, 1);
    assert.equal(stats.cleared, 1, 'main 호스트가 gateway 토큰 캐시를 지웠다');
    assert.deepEqual(pair.sent.map((m) => (m as { t: string }).t), ['gw.auth', 'gw.auth.invalidate', 'gw.auth']);
    assert.equal(mock.calls[1]!.headers.authorization, 'DPoP sxd1.gw-token-1', '다시 보낼 때는 새 토큰');
  });

  it('두 번째도 401이면 gateway.unauthorized로 끝난다(세 번째 없음)', async () => {
    const { auth, pair } = wired();
    mock.opts = { fail: { '/v1/decide': { status: 401, code: 'gateway.unauthorized' }, '/v1/run-tokens': { status: 401, code: 'gateway.unauthorized' } } };
    await gwCode(egressOf(auth).toGateway({ surface: 'runTokens', body: RUN }), 'gateway.unauthorized');
    assert.equal(mock.calls.length, 2);
    assert.equal(pair.sent.filter((m) => (m as { t: string }).t === 'gw.auth.invalidate').length, 1);
  });

  it('403(기기 정지·범위 거부)·429·5xx는 다시 보내지 않고 invalidate도 없다', async () => {
    for (const [status, code, want] of [
      [403, 'gateway.device_suspended', 'gateway.device_suspended'],
      [403, 'account.scope_denied', 'gateway.scope_denied'],
      [429, 'policy.rate_limited', 'gateway.rate_limited'],
      [503, 'gateway.upstream_error', 'gateway.upstream_error'],
    ] as const) {
      mock.calls.length = 0;
      const { auth, pair } = wired();
      mock.opts = { fail: { '/v1/run-tokens': { status, code } } };
      await gwCode(egressOf(auth).toGateway({ surface: 'runTokens', body: RUN }), want);
      assert.equal(mock.calls.length, 1, code);
      assert.ok(!pair.sent.some((m) => (m as { t: string }).t === 'gw.auth.invalidate'), code);
    }
  });

  it('invalidate가 없는 GatewayAuth는 401을 다시 보내지 않는다(같은 토큰이라 소용없다)', async () => {
    mock.opts = { fail: { '/v1/run-tokens': { status: 401, code: 'gateway.unauthorized' } } };
    await gwCode(egressOf({ headers: async () => ({ authorization: 'DPoP t', dpop: 'p' }) }).toGateway({ surface: 'runTokens', body: RUN }), 'gateway.unauthorized');
    assert.equal(mock.calls.length, 1);
  });
});

describe('intent.resolve: 인증 실패는 decide.unavailable(main은 연결 안 됨)', () => {
  let dir: string;
  let db: Db;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sax-gwauth-'));
    db = openDatabase(path.join(dir, 'db.sqlite'), new Uint8Array(randomBytes(32)));
  });
  after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('로그인 안 됨이면 게이트웨이 송신 없이 decide.unavailable, 로그인이면 auth 포트 헤더로 route', async () => {
    const out = wired({ device: () => null });
    const r = new IntentResolver(db, { model: gatewayIntentModel(egressOf(out.auth)) });
    await assert.rejects(r.handle('intent.resolve', { text: '계산서 끊어 줘' }), (e: Error & { code?: string }) => e.code === 'decide.unavailable');
    assert.equal(mock.calls.length, 0);
    mock.opts = { answers: { playbook: 'hometax.invoice.issue', mentions_tax_advice: 0.02 } };
    const r2 = new IntentResolver(db, { model: gatewayIntentModel(egressOf(wired().auth)) });
    assert.equal(((await r2.handle('intent.resolve', { text: '계산서 끊어 줘' })) as { outcome: string }).outcome, 'route');
    assert.ok(mock.calls.every((c) => c.headers.authorization === 'DPoP sxd1.gw-token-0'));
  });
});

describe('entry 배선', () => {
  const entry = readFileSync(path.join(import.meta.dirname, '../packages/engine/src/entry.ts'), 'utf8');
  it('init 셋째 포트(auth)가 있으면 portGatewayAuth로 Egress 게이트웨이를 구성하고, 없으면 게이트웨이 없이 둔다', () => {
    assert.match(entry, /init\(msg as unknown as EngineInit, e\.ports\[0\], e\.ports\[1\], e\.ports\[2\]\)/);
    assert.match(entry, /new Egress\(authPort \? \{ gateway: \{ auth: portGatewayAuth\(wrapPort\(authPort, 'electron'\)\), bundles: BundleCatalog\.load\(\)\.allowEntries\(\) \} \} : \{\}\)/);
  });
  it('엔진 소스는 기기 토큰·키를 만들거나 금고 crypto.*를 부르지 않는다', () => {
    const dir = path.join(import.meta.dirname, '../packages/engine/src');
    const bad: string[] = [];
    for (const f of fs.readdirSync(dir, { recursive: true }) as string[]) {
      if (!f.endsWith('.ts')) continue;
      const s = readFileSync(path.join(dir, f), 'utf8');
      if (/crypto\.(signVd|signAik|noiseDH|hpkeOpen|publicKeys)|device-tokens/.test(s)) bad.push(f);
    }
    assert.deepEqual(bad, []);
  });
});
