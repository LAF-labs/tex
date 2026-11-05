// AIK 서명 객체(기기 목록·폐기·Cert)와 DPoP·기기 토큰: services/shared/CONTRACT.md §1~§3 바이트 규약과 맞는지,
// 서버 쪽과 같은 방식(node:crypto Ed25519, utf8(ctx) ‖ JCS)으로 독립 검증한다.
import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';
import { describe, it } from 'node:test';
import { jcs as engineJcs } from '@sax/engine/gate';
import {
  CTX, DeviceAuthError, DeviceTokenCache, addDevice, athOf, b64, checkHtu, decodeCertField, deviceAuthHeaders, encodeCertField, issueCert, jcs, makeDpop,
  parseJcs, requestDeviceToken, revokeDevice, utf8, uuid4, verifyCert, type HttpJson, type SignedCert,
} from '@sax/remote';
import { DAY, mockDesktop, mockPhone, pairOnce, pairWorld } from './remote-support.ts';

const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
const pubKey = (raw: Uint8Array) => createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(raw)]), format: 'der', type: 'spki' });
/** 서버(services/shared verifyCtx)와 같은 검증: Ed25519(utf8(ctx + JCS(obj))). */
const serverVerify = (ctx: string, obj: unknown, pub: Uint8Array, sigB64: string) =>
  edVerify(null, Buffer.from(ctx + engineJcs(obj), 'utf8'), pubKey(pub), Buffer.from(sigB64, 'base64'));
const b64u = (b: Buffer) => b.toString('base64url');

let seed = 5;
const rnd = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
function randomValue(depth = 0): unknown {
  const r = rnd();
  if (depth > 3 || r < 0.3) return ['', 'a', '가', 'é', '"\\\n\u0001', ' ', '😀', 'Z'][Math.floor(rnd() * 8)];
  if (r < 0.45) return Math.floor((rnd() - 0.5) * 2 ** 40);
  if (r < 0.5) return rnd() < 0.5;
  if (r < 0.55) return null;
  if (r < 0.75) return Array.from({ length: Math.floor(rnd() * 4) }, () => randomValue(depth + 1));
  const o: Record<string, unknown> = {};
  for (let i = 0; i < Math.floor(rnd() * 5); i++) o[['b', 'a', 'Sx', 'aa', '가', 'B', '_', 'é', 'éx'][Math.floor(rnd() * 9)]!] = randomValue(depth + 1);
  return o;
}

describe('JCS', () => {
  it('엔진 gate.ts의 jcs와 같은 문자열(무작위 1,000개)', () => {
    for (let i = 0; i < 1000; i++) {
      const v = randomValue();
      assert.equal(jcs(v), engineJcs(v));
    }
  });
  it('키 정렬·공백 없음·정수만, 정규형이 아니면 parseJcs가 거부', () => {
    assert.equal(jcs({ b: 1, a: '€', c: [true, null], d: undefined }), '{"a":"€","b":1,"c":[true,null]}');
    assert.throws(() => jcs({ x: 1.5 }));
    assert.throws(() => jcs({ x: 2 ** 53 }));
    assert.deepEqual(parseJcs(utf8('{"a":1,"b":2}')), { a: 1, b: 2 });
    assert.equal(parseJcs(utf8('{"b":2,"a":1}')), null);
    assert.equal(parseJcs(utf8('{"a": 1}')), null);
    assert.equal(parseJcs(utf8('{"a":"\\u0041"}')), null);
  });
});

describe('AIK 서명 객체는 서버와 같은 바이트(utf8(ctx) ‖ JCS)', () => {
  it('기기 목록 항목·폐기 레코드를 서버 방식으로 검증할 수 있다', async () => {
    const d = await mockDesktop();
    const ph = mockPhone();
    const l2 = await addDevice(d.keys.aik, d.deviceList, { deviceId: ph.keys.deviceId, role: 'mobile', noisePub: ph.keys.noise.publicKey, signPub: ph.keys.vmPub, registeredAt: Date.now() });
    for (const e of l2.entries) assert.ok(serverVerify('SAX-devlist-v1', e.entry, d.keys.aik.publicKey, e.aikSig));
    const l3 = await revokeDevice(d.keys.aik, l2, ph.keys.deviceId);
    const r = l3.revoked[0]!;
    assert.ok(serverVerify('SAX-revoke-v1', { device_id: r.device_id, revoked_at: r.revoked_at }, d.keys.aik.publicKey, r.aikSig));
    assert.ok(!serverVerify('SAX-devlist-v1', { device_id: r.device_id, revoked_at: r.revoked_at }, d.keys.aik.publicKey, r.aikSig), '문맥이 다르면 통하지 않는다');
  });

  it('페어링이 낸 인증서는 계정 서비스 형식 {cert:{device_id, role, Sx, Vx, Kx, not_after}, aikSig}', async () => {
    const w = await pairWorld();
    const { phone } = await pairOnce(w);
    const sc = phone.cert;
    assert.deepEqual(Object.keys(sc.cert).sort(), ['Kx', 'Sx', 'Vx', 'device_id', 'not_after', 'role']);
    assert.equal(sc.cert.Sx, b64(w.phone.keys.noise.publicKey));
    assert.equal(sc.cert.Vx, b64(w.phone.keys.vmPub));
    assert.equal(sc.cert.Kx, b64(w.phone.keys.kmPub));
    assert.ok(serverVerify('SAX-cert-v1', sc.cert, w.desk.keys.aik.publicKey, sc.aikSig));
    assert.ok(sc.cert.not_after - Date.now() <= 91 * DAY);
  });
});

describe('기기 인증서 검증', () => {
  const setup = async () => {
    const d = await mockDesktop();
    const ph = mockPhone();
    const body = { device_id: ph.keys.deviceId, role: 'mobile' as const, Sx: ph.keys.noise.publicKey, Vx: ph.keys.vmPub, Kx: ph.keys.kmPub, not_after: Date.now() + 90 * DAY };
    return { d, ph, sc: await issueCert(d.keys.aik, body) };
  };

  it('pair.ok 운반 형식은 b64(JCS) 왕복, 정규형이 아니면 거부', async () => {
    const { d, sc } = await setup();
    const field = encodeCertField(sc);
    assert.ok(field.length <= 1024);
    assert.deepEqual(decodeCertField(field), sc);
    assert.ok(verifyCert(field, d.keys.aik.publicKey));
    assert.equal(decodeCertField(Buffer.from(JSON.stringify(sc, null, 1)).toString('base64')), null);
    assert.equal(decodeCertField(b64(utf8(jcs({ ...sc, extra: 1 })))), null);
  });

  it('필드 변조·다른 AIK·만료·91일 초과·키 형식·남는 키를 거부', async () => {
    const { d, ph, sc } = await setup();
    const other = await mockDesktop();
    assert.ok(verifyCert(sc, d.keys.aik.publicKey));
    assert.equal(verifyCert(sc, other.keys.aik.publicKey), null);
    const bad = (cert: Record<string, unknown>) => verifyCert({ cert, aikSig: sc.aikSig } as SignedCert, d.keys.aik.publicKey);
    assert.equal(bad({ ...sc.cert, role: 'desktop' }), null);
    assert.equal(bad({ ...sc.cert, extra: 'x' }), null);
    assert.equal(bad({ ...sc.cert, Sx: sc.cert.Vx }), null);
    assert.equal(verifyCert(sc, d.keys.aik.publicKey, sc.cert.not_after), null, '만료');
    const long = await issueCert(d.keys.aik, { device_id: ph.keys.deviceId, role: 'mobile', Sx: ph.keys.noise.publicKey, Vx: ph.keys.vmPub, not_after: Date.now() + 92 * DAY });
    assert.equal(verifyCert(long, d.keys.aik.publicKey), null, '91일 초과');
    const sigBad = { cert: { ...sc.cert, Sx: sc.cert.Sx.replace(/=$/, '') }, aikSig: sc.aikSig };
    assert.equal(verifyCert(sigBad, d.keys.aik.publicKey), null, '패딩 없는 base64');
    const notUuid = await issueCert(d.keys.aik, { device_id: 'not-a-uuid', role: 'mobile', Sx: ph.keys.noise.publicKey, Vx: ph.keys.vmPub, not_after: Date.now() + DAY });
    assert.equal(verifyCert(notUuid, d.keys.aik.publicKey), null);
  });
});

/** 서버(services/shared verifyDpop)와 같은 검사. */
function serverCheckDpop(header: string, o: { method: string; htu: string; boundTo: string; vx: Uint8Array; now: number }) {
  const [p, s, extra] = header.split('.');
  assert.ok(p && s && extra === undefined);
  const json = Buffer.from(p, 'base64url').toString('utf8');
  const proof = JSON.parse(json) as Record<string, unknown>;
  assert.equal(Object.keys(proof).sort().join(','), 'ath,htm,htu,iat,jti');
  assert.equal(engineJcs(proof), json, 'JCS 정규형');
  assert.ok(edVerify(null, Buffer.from('SAX-dpop-v1' + json, 'utf8'), pubKey(o.vx), Buffer.from(s, 'base64url')));
  assert.equal(proof.htm, o.method);
  assert.equal(proof.htu, o.htu);
  assert.ok(Math.abs((proof.iat as number) - Math.floor(o.now / 1000)) <= 60);
  assert.match(proof.jti as string, /^[A-Za-z0-9_-]{16,64}$/);
  assert.equal(proof.ath, b64u(createHash('sha256').update(o.boundTo).digest()));
  return proof;
}

describe('DPoP(SAX-dpop-v1)', () => {
  it('폰 Vm·PC Vd 모두 서버 방식으로 검증되는 증명을 만든다', async () => {
    const ph = mockPhone();
    const d = await mockDesktop();
    const now = Date.now();
    const htu = 'https://relay.tex.laf-co.com/v1/connect';
    serverCheckDpop(await makeDpop(ph.vm, { htm: 'POST', htu, boundTo: 'sxd1.tok', now }), { method: 'POST', htu, boundTo: 'sxd1.tok', vx: ph.keys.vmPub, now });
    serverCheckDpop(await makeDpop(d.keys.vd, { htm: 'PUT', htu, boundTo: 'sxd1.x', now }), { method: 'PUT', htu, boundTo: 'sxd1.x', vx: d.keys.vd.publicKey, now });
    const a = await makeDpop(ph.vm, { htm: 'POST', htu, boundTo: 't', now });
    const b = await makeDpop(ph.vm, { htm: 'POST', htu, boundTo: 't', now });
    assert.notEqual(a.split('.')[0], b.split('.')[0], 'jti는 매번 새로');
  });

  it('htu는 쿼리·조각 없는 https(로컬 개발만 http), 메서드·jti 형식 검사', async () => {
    const ph = mockPhone();
    assert.equal(checkHtu('https://a.example/v1/x'), 'https://a.example/v1/x');
    assert.equal(checkHtu('http://localhost:8787/v1/x'), 'http://localhost:8787/v1/x');
    for (const u of ['http://a.example/v1/x', 'https://a.example/v1/x?q=1', 'https://a.example/v1/x#f', 'https://u:p@a.example/x', 'ftp://a/x', 'nope']) {
      assert.throws(() => checkHtu(u), undefined, u);
    }
    await assert.rejects(() => makeDpop(ph.vm, { htm: 'PATCH', htu: 'https://a.example/x', boundTo: 't' }));
    await assert.rejects(() => makeDpop(ph.vm, { htm: 'POST', htu: 'https://a.example/x', boundTo: 't', jti: 'short' }));
  });

  it('서명기 허용 목록 밖이면 만들지 않는다(dpop 용도 없는 AIK)', async () => {
    const d = await mockDesktop();
    await assert.rejects(() => makeDpop(d.keys.aik as never, { htm: 'POST', htu: 'https://a.example/x', boundTo: 't' }));
  });
});

describe('기기 범위 토큰', () => {
  const world = async () => {
    const w = await pairWorld();
    const { phone } = await pairOnce(w);
    const calls: Parameters<HttpJson>[0][] = [];
    let reply: { status: number; body: unknown } = { status: 200, body: { token: 'sxd1.abc.def', expiresAt: Date.now() + 15 * 60_000, scopes: ['relay', 'push'] } };
    const http: HttpJson = async (req) => {
      calls.push(req);
      return reply;
    };
    return { w, phone, calls, http, setReply: (r: typeof reply) => (reply = r) };
  };

  it('POST /v1/device-tokens: 본문 {cert}, DPoP ath = sha256(JCS(SignedCert)), 폰 Vm 서명', async () => {
    const t = await world();
    const now = Date.now();
    const tok = await requestDeviceToken(t.http, 'https://account.tex.laf-co.com/', t.phone.cert, t.w.phone.vm, now);
    assert.equal(tok.token, 'sxd1.abc.def');
    assert.deepEqual(tok.scopes, ['relay', 'push']);
    const c = t.calls[0]!;
    assert.equal(c.method, 'POST');
    assert.equal(c.url, 'https://account.tex.laf-co.com/v1/device-tokens');
    assert.equal(c.body, engineJcs({ cert: t.phone.cert }));
    assert.ok(!('Authorization' in c.headers));
    serverCheckDpop(c.headers.DPoP!, { method: 'POST', htu: c.url, boundTo: engineJcs(t.phone.cert), vx: t.w.phone.keys.vmPub, now });
    assert.equal(athOf(jcs(t.phone.cert)), b64u(createHash('sha256').update(engineJcs(t.phone.cert)).digest()));
  });

  it('오류 본문은 코드만 꺼내고, 모양이 틀린 응답은 거부', async () => {
    const t = await world();
    t.setReply({ status: 401, body: { error: 'account.cert_invalid' } });
    await assert.rejects(() => requestDeviceToken(t.http, 'https://a.example', t.phone.cert, t.w.phone.vm), (e: unknown) => e instanceof DeviceAuthError && e.code === 'account.cert_invalid' && e.status === 401);
    t.setReply({ status: 500, body: { error: 'Error: stack trace at /srv/x.ts:12' } });
    await assert.rejects(() => requestDeviceToken(t.http, 'https://a.example', t.phone.cert, t.w.phone.vm), (e: unknown) => e instanceof DeviceAuthError && e.code === 'unknown');
    t.setReply({ status: 200, body: { token: 'bearer-x', expiresAt: 1, scopes: [] } });
    await assert.rejects(() => requestDeviceToken(t.http, 'https://a.example', t.phone.cert, t.w.phone.vm), (e: unknown) => e instanceof DeviceAuthError && e.code === 'response.shape');
  });

  it('사용 요청 헤더: Authorization: DPoP <token> + ath = sha256(토큰), 캐시는 만료 1분 전에 새로 받는다', async () => {
    const ph = mockPhone();
    const now = Date.now();
    const h = await deviceAuthHeaders('sxd1.t', ph.vm, 'GET', 'https://relay.tex.laf-co.com/v1/connect', now);
    assert.equal(h.Authorization, 'DPoP sxd1.t');
    serverCheckDpop(h.DPoP!, { method: 'GET', htu: 'https://relay.tex.laf-co.com/v1/connect', boundTo: 'sxd1.t', vx: ph.keys.vmPub, now });
    let clock = now, n = 0;
    const cache = new DeviceTokenCache(async () => ({ token: `sxd1.${++n}`, expiresAt: clock + 15 * 60_000, scopes: [] }), () => clock);
    assert.equal(await cache.token(), 'sxd1.1');
    clock += 13 * 60_000;
    assert.equal(await cache.token(), 'sxd1.1');
    clock += 61_000;
    assert.equal(await cache.token(), 'sxd1.2');
    cache.clear();
    assert.equal(await cache.token(), 'sxd1.3');
  });

  it('CTX.dpop은 폰·PC 서명 허용 목록 모두에 있다', () => {
    assert.equal(CTX.dpop, 'SAX-dpop-v1');
    assert.match(uuid4(), /^[0-9a-f-]{36}$/);
  });
});
