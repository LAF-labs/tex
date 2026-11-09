// 엔진 → 게이트웨이 인증 호스트(gateway-auth.ts, ADR-040 예정, 클라우드 설계 노트 gateway-auth-design.md 2번).
// 시험: 허용 밖 경로·메서드 거부(기기 세션을 부르지 않음), 로그인 안 됨이면 account.signed_out, 게이트웨이 토큰 캐시 무효화(전체 범위 토큰과 따로),
// 서버가 범위를 줄이지 않으면 그 토큰을 엔진에 주지 않음, 토큰·헤더·htu는 기록에 없음, 엔진 auth 포트 배선.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { GATEWAY_ORIGIN, GATEWAY_PATHS, type Egress } from '@sax/net';
import { b64, certNotAfter, initialDeviceList, issueCert, uuid4, type DesktopKeys, type DeviceToken, type DpopSigner, type SignedCert } from '@sax/remote';
import { authPortResponder, GATEWAY_AUTH_HTU, GatewayAuthHost, GW_INVALIDATE_PER_MIN, type GatewayDevice, type GwAuthResult } from '../apps/desktop/src/gateway-auth.ts';
import { DeviceSession, GATEWAY_SCOPES, RemoteIdentityFile, type RemoteIdentity } from '../apps/desktop/src/remote-account.ts';
import { cloudPorts } from '../apps/desktop/src/remote-cloud.ts';
import type { AccountClient } from '../apps/desktop/src/remote-ports.ts';
import { softDesktopKeys } from './remote-dev-stack.ts';

const src = (f: string) => readFileSync(path.join(import.meta.dirname, '..', f), 'utf8');
const DECIDE = GATEWAY_ORIGIN + GATEWAY_PATHS.decide;

/** 헤더를 돌려주는 가짜 기기 세션. 부른 횟수를 센다. */
function fakeDevice(over: Partial<GatewayDevice> = {}) {
  const calls: string[] = [];
  let cleared = 0;
  const d: GatewayDevice = {
    gatewayAuth: async (htm, htu) => {
      calls.push(`${htm} ${htu}`);
      return { Authorization: 'DPoP sxd1.gw-token', DPoP: 'proof.jwt' };
    },
    clearGatewayToken: () => void cleared++,
    ...over,
  };
  return { d, calls, cleared: () => cleared };
}

function hostWith(device: GatewayDevice | null, now = () => 1_000_000) {
  const logs: Array<[string, Record<string, string | number>]> = [];
  const h = new GatewayAuthHost({ device: () => device, log: (n, x) => logs.push([n, x]), now });
  return { h, logs };
}

describe('게이트웨이 인증 호스트: 허용 목록', () => {
  it('POST + 세 경로만 헤더를 받는다. 답은 {t, id, headers:{authorization, dpop}} 그대로', async () => {
    assert.deepEqual([...GATEWAY_AUTH_HTU].sort(), ['https://tax.laf-co.com/v1/decide', 'https://tax.laf-co.com/v1/respond', 'https://tax.laf-co.com/v1/run-tokens']);
    const f = fakeDevice();
    const { h } = hostWith(f.d);
    let id = 1;
    for (const htu of GATEWAY_AUTH_HTU) {
      const r = await h.handle({ t: 'gw.auth', id, htm: 'POST', htu });
      assert.deepEqual(r, { t: 'gw.auth.result', id, headers: { authorization: 'DPoP sxd1.gw-token', dpop: 'proof.jwt' } });
      id++;
    }
    assert.deepEqual(f.calls, [...GATEWAY_AUTH_HTU].map((u) => `POST ${u}`));
  });

  it('허용 밖(메서드·경로·origin·쿼리·조각·..·끝 /·대소문자)은 auth.denied, 기기 세션을 부르지 않는다', async () => {
    const f = fakeDevice();
    const { h, logs } = hostWith(f.d);
    const bad: Array<[string, string]> = [
      ['GET', DECIDE],
      ['post', DECIDE],
      ['PUT', DECIDE],
      ['POST', GATEWAY_ORIGIN + '/v1/biz/status'],
      ['POST', GATEWAY_ORIGIN + '/v1/slots'],
      ['POST', GATEWAY_ORIGIN + '/v1/device-list'],
      ['POST', GATEWAY_ORIGIN + '/v1/acct-claim'],
      ['POST', GATEWAY_ORIGIN + '/v1/devices/enroll'],
      ['POST', 'http://tax.laf-co.com/v1/decide'],
      ['POST', 'https://tax.laf-co.com:443/v1/decide'],
      ['POST', 'https://tax.laf-co.com.evil.example/v1/decide'],
      ['POST', 'https://evil.example/v1/decide'],
      ['POST', 'https://TAX.laf-co.com/v1/decide'],
      ['POST', DECIDE + '?x=1'],
      ['POST', DECIDE + '#a'],
      ['POST', DECIDE + '/'],
      ['POST', GATEWAY_ORIGIN + '/v1/decide/../slots'],
      ['POST', GATEWAY_ORIGIN + '/v1/%64ecide'],
      ['POST', ' ' + DECIDE],
      ['POST', ''],
    ];
    for (const [i, [htm, htu]] of bad.entries()) assert.deepEqual(await h.handle({ t: 'gw.auth', id: i, htm, htu }), { t: 'gw.auth.result', id: i, code: 'auth.denied' }, `${htm} ${htu}`);
    assert.deepEqual(await h.handle({ t: 'gw.auth', id: 99, htm: 'POST', htu: 42 }), { t: 'gw.auth.result', id: 99, code: 'auth.bad_request' });
    assert.deepEqual(f.calls, []);
    // 기록은 이름·결과 코드만(htu는 엔진이 보낸 값이라 남기지 않는다)
    assert.ok(logs.every(([n, x]) => n === 'main.gw_auth' && JSON.stringify(x) === JSON.stringify({ result: x.result })));
    assert.ok(!JSON.stringify(logs).includes('evil'));
  });

  it('모양이 틀린 메시지(id 없음·음수·소수·모르는 t)는 답하지 않는다', async () => {
    const f = fakeDevice();
    const { h } = hostWith(f.d);
    for (const m of [null, 1, 'x', {}, { t: 'gw.auth', htm: 'POST', htu: DECIDE }, { t: 'gw.auth', id: -1, htm: 'POST', htu: DECIDE }, { t: 'gw.auth', id: 1.5, htm: 'POST', htu: DECIDE }, { t: 'gw.auth', id: '1', htm: 'POST', htu: DECIDE }, { t: 'gw.other', id: 1 }]) {
      assert.equal(await h.handle(m), null, JSON.stringify(m));
    }
    assert.deepEqual(f.calls, []);
  });
});

describe('게이트웨이 인증 호스트: 로그인 안 됨', () => {
  it('기기 세션이 없으면(로그인 전·신원 파일 없음) account.signed_out', async () => {
    const { h } = hostWith(null);
    assert.deepEqual(await h.handle({ t: 'gw.auth', id: 7, htm: 'POST', htu: DECIDE }), { t: 'gw.auth.result', id: 7, code: 'account.signed_out' });
    const thrower = new GatewayAuthHost({ device: async () => Promise.reject(new Error('init')) });
    assert.deepEqual(await thrower.handle({ t: 'gw.auth', id: 8, htm: 'POST', htu: DECIDE }), { t: 'gw.auth.result', id: 8, code: 'account.signed_out' });
  });

  it('금고 키를 못 읽음·서버가 인증서 거부 → signed_out, 범위 미지원 → scope_unavailable, 그 밖 → auth.unavailable', async () => {
    const cases: Array<[string | undefined, string]> = [
      ['account.keys_unavailable', 'account.signed_out'],
      ['account.cert_invalid', 'account.signed_out'],
      ['account.scope_unavailable', 'account.scope_unavailable'],
      ['account.device_suspended', 'auth.unavailable'],
      ['net.network', 'auth.unavailable'],
      [undefined, 'auth.unavailable'],
    ];
    for (const [code, want] of cases) {
      const f = fakeDevice({ gatewayAuth: async () => Promise.reject(Object.assign(new Error('x'), code ? { code } : {})) });
      const { h } = hostWith(f.d);
      assert.deepEqual(await h.handle({ t: 'gw.auth', id: 3, htm: 'POST', htu: DECIDE }), { t: 'gw.auth.result', id: 3, code: want }, String(code));
    }
  });

  it('헤더가 둘 다 문자열이 아니면 auth.unavailable(빈 값을 엔진에 주지 않는다)', async () => {
    const f = fakeDevice({ gatewayAuth: async () => ({ Authorization: 'DPoP x' }) });
    const { h } = hostWith(f.d);
    assert.deepEqual(await h.handle({ t: 'gw.auth', id: 4, htm: 'POST', htu: DECIDE }), { t: 'gw.auth.result', id: 4, code: 'auth.unavailable' });
  });
});

describe('게이트웨이 인증 호스트: invalidate', () => {
  it('게이트웨이 토큰만 지우고 답하지 않는다. 1분에 상한, 1분이 지나면 다시 된다', async () => {
    let now = 5_000_000;
    const f = fakeDevice();
    const { h, logs } = hostWith(f.d, () => now);
    for (let i = 0; i < GW_INVALIDATE_PER_MIN + 3; i++) assert.equal(await h.handle({ t: 'gw.auth.invalidate' }), null);
    assert.equal(f.cleared(), GW_INVALIDATE_PER_MIN);
    assert.equal(logs.filter(([, x]) => x.result === 'limited').length, 3);
    now += 60_000;
    await h.handle({ t: 'gw.auth.invalidate' });
    assert.equal(f.cleared(), GW_INVALIDATE_PER_MIN + 1);
    // 로그인 전이면 지울 것이 없다(오류 없음)
    assert.equal(await hostWith(null).h.handle({ t: 'gw.auth.invalidate' }), null);
  });
});

/** 기기 토큰을 세는 가짜 계정 클라이언트(범위를 주면 그대로, 없으면 전체 범위). */
function tokenClient(o: { ignoreScopes?: boolean } = {}) {
  const asked: Array<readonly string[] | undefined> = [];
  let n = 0;
  const client = {
    deviceToken: async (_c: SignedCert, _d: DpopSigner, scopes?: readonly string[]): Promise<DeviceToken> => {
      asked.push(scopes);
      n++;
      const s = scopes && !o.ignoreScopes ? [...scopes] : ['gateway', 'relay', 'wake', 'slots', 'devlist', 'acct_op'];
      return { token: `sxd1.${scopes ? 'gw' : 'full'}-${n}`, expiresAt: Date.now() + 900_000, scopes: s };
    },
  } as unknown as AccountClient;
  return { client, asked };
}

async function identity(keys: DesktopKeys): Promise<RemoteIdentity> {
  const deviceId = uuid4();
  const cert = await issueCert(keys.aik, { device_id: deviceId, role: 'desktop', Sx: keys.noise.publicKey, Vx: keys.vd.publicKey, not_after: certNotAfter() });
  const deviceList = await initialDeviceList(keys.aik, { deviceId, role: 'desktop', noisePub: keys.noise.publicKey, signPub: keys.vd.publicKey, registeredAt: Date.now() - 1000 });
  return { v: 1, accountEmail: 'a@example.com', deviceId, aikPub: b64(keys.aik.publicKey), Sd: b64(keys.noise.publicKey), Vd: b64(keys.vd.publicKey), cert, deviceList, enrolledAt: Date.now() };
}

describe('DeviceSession 게이트웨이 토큰 캐시', () => {
  const session = async (c: AccountClient) => {
    const keys = softDesktopKeys();
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sax-gw-'));
    return new DeviceSession(c, async () => keys, new RemoteIdentityFile(dir), await identity(keys), Date.now);
  };

  it("범위 ['gateway']로 따로 받고 캐시한다. 동시 요청은 한 번만 받는다. 전체 범위 토큰과 섞이지 않는다", async () => {
    const t = tokenClient();
    const s = await session(t.client);
    const [a, b, c] = await Promise.all([s.gatewayAuth('POST', DECIDE), s.gatewayAuth('POST', DECIDE), s.gatewayAuth('POST', GATEWAY_ORIGIN + GATEWAY_PATHS.respond)]);
    assert.deepEqual(t.asked, [GATEWAY_SCOPES]);
    for (const h of [a, b, c]) {
      assert.equal(h!.Authorization, 'DPoP sxd1.gw-1');
      assert.match(h!.DPoP!, /^[\w-]+\.[\w-]+$/);
    }
    const full = await s.auth('GET', 'https://tax.laf-co.com/v1/acct-claim');
    assert.equal(full.Authorization, 'DPoP sxd1.full-2');
    assert.deepEqual(t.asked, [GATEWAY_SCOPES, undefined]);
  });

  it('clearGatewayToken 뒤에는 새 게이트웨이 토큰, 전체 범위 토큰은 그대로(clearToken도 게이트웨이 토큰을 건드리지 않는다)', async () => {
    const t = tokenClient();
    const s = await session(t.client);
    assert.equal((await s.gatewayAuth('POST', DECIDE)).Authorization, 'DPoP sxd1.gw-1');
    assert.equal((await s.auth('POST', 'https://tax.laf-co.com/v1/slots')).Authorization, 'DPoP sxd1.full-2');
    s.clearGatewayToken();
    assert.equal((await s.gatewayAuth('POST', DECIDE)).Authorization, 'DPoP sxd1.gw-3');
    assert.equal((await s.auth('POST', 'https://tax.laf-co.com/v1/slots')).Authorization, 'DPoP sxd1.full-2');
    s.clearToken();
    assert.equal((await s.gatewayAuth('POST', DECIDE)).Authorization, 'DPoP sxd1.gw-3');
    assert.equal(t.asked.length, 3);
  });

  it('서버가 범위를 줄이지 않으면(전체 범위 토큰) account.scope_unavailable, 엔진에 헤더가 가지 않는다', async () => {
    const t = tokenClient({ ignoreScopes: true });
    const s = await session(t.client);
    await assert.rejects(s.gatewayAuth('POST', DECIDE), { code: 'account.scope_unavailable' });
    const logs: string[] = [];
    const h = new GatewayAuthHost({ device: () => s, log: (n, x) => logs.push(n + JSON.stringify(x)) });
    const r = (await h.handle({ t: 'gw.auth', id: 1, htm: 'POST', htu: DECIDE })) as GwAuthResult;
    assert.deepEqual(r, { t: 'gw.auth.result', id: 1, code: 'account.scope_unavailable' });
    assert.ok(!JSON.stringify(r).includes('sxd1') && !logs.join().includes('sxd1'));
  });
});

describe('클라우드 포트: 범위를 줄인 기기 토큰 요청', () => {
  it('scopes를 주면 본문 {cert, scopes}, 안 주면 지금처럼 {cert}', async () => {
    const bodies: unknown[] = [];
    const egress = {
      cloud: async (req: { body?: string }) => {
        bodies.push(JSON.parse(req.body!));
        return { status: 200, json: { token: 'sxd1.x', expiresAt: Date.now() + 900_000, scopes: ['gateway'] } };
      },
    } as unknown as Egress;
    const { account } = cloudPorts({ egress, env: 'prod' });
    const keys = softDesktopKeys();
    const cert = (await identity(keys)).cert;
    await account.deviceToken(cert, keys.vd);
    await account.deviceToken(cert, keys.vd, GATEWAY_SCOPES);
    assert.deepEqual(Object.keys(bodies[0] as object), ['cert']);
    assert.deepEqual((bodies[1] as { scopes: unknown }).scopes, ['gateway']);
    assert.deepEqual((bodies[1] as { cert: unknown }).cert, (bodies[0] as { cert: unknown }).cert);
  });
});

describe('엔진 auth 포트 배선(소스)', () => {
  const host = src('apps/desktop/src/engine-host.ts');
  const app = src('apps/desktop/src/shell-app.ts');
  const gw = src('apps/desktop/src/gateway-auth.ts');

  it('엔진 init 포트 순서는 [중계, 게이트, auth]. 답하는 쪽이 붙기 전에는 account.signed_out', () => {
    assert.ok(host.includes('this.engine.postMessage(init, [relay.port2, gate.port1, auth.port1]);'));
    assert.ok(/r = h \? await h\(m\) : id === null \? null : \{ t: 'gw\.auth\.result', id, code: 'account\.signed_out' \}/.test(gw));
    // EngineHost는 auth 포트를 authPortResponder(받은 순서대로 하나씩)로만 처리한다.
    assert.ok(host.includes('const onAuth = authPortResponder(') && host.includes("this.authPort.on('message', (e) => void onAuth(e.data));"));
    assert.ok(!host.includes('private async onAuth('));
  });

  it('shell-app은 GatewayAuthHost(계정 기기 세션)를 붙인다. 이 모듈은 금고·키·전체 범위 auth를 쓰지 않는다', () => {
    assert.ok(app.includes('new GatewayAuthHost({') && app.includes('host.setGatewayAuth((m) => gwAuth.handle(m));'));
    assert.ok(!/@sax\/vault|\.auth\(|\bkeys\(|DesktopKeys|signVd|clearToken\(\)/.test(gw.replace(/^\s*(\/\/|\*|\/\*\*).*$/gm, '')));
  });
});

describe('auth 포트 순서(엔진 #216 시험에서 찾은 경합)', () => {
  const HTU = GATEWAY_ORIGIN + GATEWAY_PATHS.decide;
  /** 실제 GatewayAuthHost + 캐시를 지우면 새 토큰을 주는 기기. slow번째 device() 호출(invalidate 쪽)만 계정 읽기가 늦다. */
  function realHost(slow: number) {
    let gen = 0;
    let calls = 0;
    const device: GatewayDevice = {
      gatewayAuth: async () => ({ Authorization: `DPoP tok-${gen}`, DPoP: 'proof' }),
      clearGatewayToken: () => void gen++,
    };
    return new GatewayAuthHost({ device: async () => (await new Promise((r) => setTimeout(r, calls++ === slow ? 20 : 0)), device) });
  }
  const auth = (r: GwAuthResult | undefined) => (r && 'headers' in r ? r.headers.authorization : r?.code);

  it('(대조) 동시에 처리하면 invalidate 직후 재시도가 지우기 전의 옛 토큰을 받는다', async () => {
    const host = realHost(0);
    const [, retry] = await Promise.all([host.handle({ t: 'gw.auth.invalidate' }), host.handle({ t: 'gw.auth', id: 2, htm: 'POST', htu: HTU })]);
    assert.equal(auth(retry ?? undefined), 'DPoP tok-0');
  });

  it('authPortResponder(EngineHost가 쓰는 것)는 받은 순서대로: 401 → invalidate → 재시도가 새 토큰을 받는다', async () => {
    const host = realHost(1);
    const out: GwAuthResult[] = [];
    const onAuth = authPortResponder(() => (m) => host.handle(m), (r) => out.push(r));
    void onAuth({ t: 'gw.auth', id: 1, htm: 'POST', htu: HTU });
    void onAuth({ t: 'gw.auth.invalidate' });
    await onAuth({ t: 'gw.auth', id: 2, htm: 'POST', htu: HTU });
    assert.deepEqual(out.map((r) => [r.id, auth(r)]), [[1, 'DPoP tok-0'], [2, 'DPoP tok-1']]);
  });

  it('답이 늦은 요청 뒤의 요청도 순서를 지키고, 던지면 auth.unavailable로 답하고 다음 것을 계속 처리한다', async () => {
    const out: GwAuthResult[] = [];
    let n = 0;
    const onAuth = authPortResponder(
      () => async (m) => {
        const id = (m as { id: number }).id;
        if (n++ === 0) await new Promise((r) => setTimeout(r, 20));
        if (id === 2) throw new Error('x');
        return { t: 'gw.auth.result', id, code: 'auth.denied' };
      },
      (r) => out.push(r),
    );
    void onAuth({ t: 'gw.auth', id: 1, htm: 'POST', htu: HTU });
    void onAuth({ t: 'gw.auth', id: 2, htm: 'POST', htu: HTU });
    await onAuth({ t: 'gw.auth', id: 3, htm: 'POST', htu: HTU });
    assert.deepEqual(out.map((r) => [r.id, auth(r)]), [[1, 'auth.denied'], [2, 'auth.unavailable'], [3, 'auth.denied']]);
  });

  it('답하는 쪽이 붙기 전에는 gw.auth에 account.signed_out, invalidate·모르는 메시지에는 답하지 않는다', async () => {
    const out: GwAuthResult[] = [];
    const onAuth = authPortResponder(() => null, (r) => out.push(r));
    await onAuth({ t: 'gw.auth.invalidate' });
    await onAuth({ t: 'x' });
    await onAuth({ t: 'gw.auth', id: 7, htm: 'POST', htu: HTU });
    assert.deepEqual(out, [{ t: 'gw.auth.result', id: 7, code: 'account.signed_out' }]);
  });
});
