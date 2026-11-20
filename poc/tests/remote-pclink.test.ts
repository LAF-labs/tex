import assert from 'node:assert/strict';
import { hkdfSync, randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  AIK_PURPOSES, CTX, MAX_DESKTOPS, PCLINK_SAS_MAX_TRIES, PCLINK_STEP_MS, PcLinkApprover, addDevice, b64, checkPcLinkGrant, ed25519Keygen, ed25519Public, fromB64, hpkeOpen, hpkeSeal,
  initialDeviceList, parsePcLinkChallenge, parsePcLinkHello, parsePcLinkReveal, pcLinkHello, pcLinkReveal, pcLinkSas, pcLinkTranscript, randomBytes, softSigner, utf8, verifyCert,
  verifyDeviceList, x25519Keygen, type DeviceListJson, type PcLinkChallenge, type PcLinkHello,
} from '@sax/remote';

const aikSeed = (rk: Uint8Array) => new Uint8Array(hkdfSync('sha256', rk, new Uint8Array(0), 'aik', 32));

async function oldPc() {
  const rk = randomBytes(32);
  const aik = softSigner(aikSeed(rk), AIK_PURPOSES);
  const deviceId = randomUUID();
  const list = await initialDeviceList(aik, { deviceId, role: 'desktop', noisePub: x25519Keygen().publicKey, signPub: ed25519Keygen().publicKey, registeredAt: 1 });
  const sealRk = async (recipient: Uint8Array, info: Uint8Array, aad: Uint8Array) => hpkeSeal(recipient, info, aad, rk);
  return { rk, aik, deviceId, list, sealRk };
}
function newPc() {
  const link = x25519Keygen();
  const self = { deviceId: randomUUID(), noisePub: x25519Keygen().publicKey, signPub: ed25519Keygen().publicKey, linkPub: link.publicKey };
  return { link, self, ...pcLinkHello(self) };
}
function vaultImport(linkSk: Uint8Array, g: { enc: Uint8Array; ct: Uint8Array; info: Uint8Array; aad: Uint8Array; aikPub: Uint8Array }): Uint8Array {
  const rk = hpkeOpen(linkSk, g.enc, g.info, g.aad, g.ct);
  assert.deepEqual(ed25519Public(aikSeed(rk)), g.aikPub, '연 RK의 AIK = 6자리에 묶인 AIK');
  return rk;
}

describe('새 PC 연결: 정상 흐름', () => {
  it('hello → challenge → reveal → 같은 6자리 → 승인 → 목록·인증서·RK가 새 PC에 간다', async () => {
    const e = await oldPc();
    const n = newPc();
    assert.ok(parsePcLinkHello(JSON.parse(JSON.stringify(n.hello))));
    const ap = new PcLinkApprover(n.hello, { deviceId: e.deviceId, aikPub: e.aik.publicKey });
    assert.equal(ap.state, 'awaiting_reveal');
    const r = pcLinkReveal(n.hello, JSON.parse(JSON.stringify(ap.challenge)), n.nonce);
    assert.match(r.sas, /^\d{6}$/);
    assert.equal(ap.reveal(JSON.parse(JSON.stringify(r.reveal))), true);
    assert.equal(ap.state, 'awaiting_sas');
    assert.equal(ap.confirm(r.sas), true);
    assert.equal(ap.state, 'approved');
    await assert.rejects(ap.grant({ aik: e.aik, deviceList: e.list, sealRk: e.sealRk }), /not listed/);
    const deviceList = await ap.listWithNew(e.aik, e.list);
    const grant = await ap.grant({ aik: e.aik, deviceList, sealRk: e.sealRk });
    assert.equal(deviceList.listVersion, 2);
    const chk = verifyDeviceList(deviceList, e.aik.publicKey);
    assert.ok(chk.ok && chk.devices.filter((d) => d.role === 'desktop').length === 2);

    const g = checkPcLinkGrant(n.hello, ap.challenge, r.transcript, JSON.parse(JSON.stringify(grant)));
    assert.ok(g.ok, JSON.stringify(g));
    if (!g.ok) return;
    assert.deepEqual(vaultImport(n.link.secretKey, g), e.rk);
    const cert = verifyCert(g.cert, e.aik.publicKey)!;
    assert.deepEqual([cert.device_id, cert.role, b64(cert.Sx), b64(cert.Vx)], [n.self.deviceId, 'desktop', n.hello.Sx, n.hello.Vx]);
    const aik2 = softSigner(aikSeed(e.rk), AIK_PURPOSES);
    const phone = { deviceId: randomUUID(), role: 'mobile' as const, noisePub: x25519Keygen().publicKey, signPub: ed25519Keygen().publicKey, registeredAt: 3 };
    assert.ok(verifyDeviceList(await addDevice(aik2, g.deviceList, phone), e.aik.publicKey).ok);
  });

  it('6자리는 두 난수와 모든 키에 달려 있다(하나만 바뀌어도 달라진다)', () => {
    const n = newPc();
    const c: PcLinkChallenge = { v: 1, device_id: randomUUID(), aik_pub: b64(ed25519Keygen().publicKey), nonce: b64(randomBytes(32)) };
    const base = pcLinkTranscript(n.hello, c, n.nonce);
    const variants: Uint8Array[] = [
      pcLinkTranscript(n.hello, { ...c, nonce: b64(randomBytes(32)) }, n.nonce),
      pcLinkTranscript(n.hello, { ...c, aik_pub: b64(ed25519Keygen().publicKey) }, n.nonce),
      pcLinkTranscript(n.hello, { ...c, device_id: randomUUID() }, n.nonce),
      pcLinkTranscript(n.hello, c, randomBytes(32)),
      pcLinkTranscript({ ...n.hello, Hx: b64(x25519Keygen().publicKey) }, c, n.nonce),
      pcLinkTranscript({ ...n.hello, Sx: b64(x25519Keygen().publicKey) }, c, n.nonce),
      pcLinkTranscript({ ...n.hello, Vx: b64(ed25519Keygen().publicKey) }, c, n.nonce),
    ];
    for (const v of variants) assert.notDeepEqual(v, base);
    assert.equal(pcLinkSas(base), pcLinkSas(pcLinkTranscript(n.hello, c, n.nonce)));
    assert.notEqual(CTX.pclinkSas, CTX.sas);
  });
});

describe('새 PC 연결: 가운데에서 바꾸는 경우', () => {
  it('서버가 새 PC의 수신 키를 자기 키로 바꾸면: 약속과 맞지 않아 실패하거나, 자기 약속을 내도 6자리가 달라 승인되지 않는다', async () => {
    const e = await oldPc();
    const n = newPc();
    const evil = x25519Keygen();
    const swapped: PcLinkHello = { ...n.hello, Hx: b64(evil.publicKey) };
    const ap1 = new PcLinkApprover(swapped, { deviceId: e.deviceId, aikPub: e.aik.publicKey });
    const r1 = pcLinkReveal(n.hello, ap1.challenge, n.nonce);
    assert.equal(ap1.reveal(r1.reveal), false);
    assert.equal(ap1.state, 'failed');
    await assert.rejects(ap1.listWithNew(e.aik, e.list), /not approved/);
    await assert.rejects(ap1.grant({ aik: e.aik, deviceList: e.list, sealRk: e.sealRk }), /not approved/);
    const forged = pcLinkHello({ ...n.self, linkPub: evil.publicKey });
    const ap2 = new PcLinkApprover(forged.hello, { deviceId: e.deviceId, aikPub: e.aik.publicKey });
    const shown = pcLinkReveal(n.hello, ap2.challenge, n.nonce).sas;
    assert.equal(ap2.reveal({ v: 1, nonce: b64(forged.nonce) }), true);
    const serverSide = pcLinkSas(pcLinkTranscript(forged.hello, ap2.challenge, forged.nonce));
    if (shown !== serverSide) {
      assert.equal(ap2.confirm(shown), false);
      assert.equal(ap2.triesLeft, PCLINK_SAS_MAX_TRIES - 1);
    }
  });

  it('6자리는 3번까지, 그 뒤와 10분 뒤에는 맞아도 승인되지 않는다', async () => {
    const e = await oldPc();
    const n = newPc();
    const ap = new PcLinkApprover(n.hello, { deviceId: e.deviceId, aikPub: e.aik.publicKey });
    const r = pcLinkReveal(n.hello, ap.challenge, n.nonce);
    ap.reveal(r.reveal);
    const wrong = r.sas === '000000' ? '000001' : '000000';
    assert.equal(ap.confirm(wrong), false);
    assert.equal(ap.confirm('12345'), false);
    assert.equal(ap.state, 'awaiting_sas');
    assert.equal(ap.confirm(wrong), false);
    assert.equal(ap.state, 'failed');
    assert.throws(() => ap.confirm(r.sas), /not awaiting sas/);

    let t = 1_000;
    const n2 = newPc();
    const late = new PcLinkApprover(n2.hello, { deviceId: e.deviceId, aikPub: e.aik.publicKey }, () => t);
    const r2 = pcLinkReveal(n2.hello, late.challenge, n2.nonce);
    assert.equal(late.reveal(r2.reveal), true);
    t += PCLINK_STEP_MS + 1;
    assert.equal(late.confirm(r2.sas), false);
    assert.equal(late.state, 'failed');

    const n3 = newPc();
    const again = new PcLinkApprover(n3.hello, { deviceId: e.deviceId, aikPub: e.aik.publicKey }, () => t);
    const r3 = pcLinkReveal(n3.hello, again.challenge, n3.nonce);
    again.reveal(r3.reveal);
    assert.equal(again.confirm(r3.sas), true);
    assert.equal(again.confirm(r3.sas), true);
    assert.deepEqual([again.state, again.triesLeft], ['approved', 3]);
    assert.equal(again.confirm(r3.sas === '000000' ? '000001' : '000000'), false);
    assert.deepEqual([again.state, again.triesLeft], ['awaiting_sas', 2]);
    await assert.rejects(again.listWithNew(e.aik, e.list), /not approved/);
    assert.equal(again.confirm(r3.sas), true);
    t += PCLINK_STEP_MS + 1;
    assert.equal(again.confirm(r3.sas), false, '10분이 지나면 맞아도 끝난다');
    assert.equal(again.state, 'failed');
  });

  it('새 PC는 다른 AIK로 서명한 목록·인증서, 자기 키가 바뀐 목록, 승인한 PC가 없는 목록, 다른 신청의 봉인문을 받지 않는다', async () => {
    const e = await oldPc();
    const n = newPc();
    const ap = new PcLinkApprover(n.hello, { deviceId: e.deviceId, aikPub: e.aik.publicKey });
    const r = pcLinkReveal(n.hello, ap.challenge, n.nonce);
    ap.reveal(r.reveal);
    ap.confirm(r.sas);
    const grant = await ap.grant({ aik: e.aik, deviceList: await ap.listWithNew(e.aik, e.list), sealRk: e.sealRk });
    const check = (g: unknown, c = ap.challenge) => checkPcLinkGrant(n.hello, c, r.transcript, g);
    assert.equal(check(grant).ok, true);
    assert.deepEqual(check({ ...grant, extra: 1 }), { ok: false, reason: 'shape' });
    assert.deepEqual(check({ ...grant, ct: b64(randomBytes(47)) }), { ok: false, reason: 'shape' });
    assert.deepEqual(check(null), { ok: false, reason: 'shape' });
    const fake = await oldPc();
    const fakeList = await addDevice(fake.aik, fake.list, { deviceId: n.self.deviceId, role: 'desktop', noisePub: n.self.noisePub, signPub: n.self.signPub, registeredAt: 2 });
    assert.deepEqual(check({ ...grant, deviceList: fakeList }), { ok: false, reason: 'list' });
    const fakeCh: PcLinkChallenge = { ...ap.challenge, aik_pub: b64(fake.aik.publicKey), device_id: fake.deviceId };
    const fakeSeal = hpkeSeal(n.link.publicKey, utf8(CTX.pclinkRk), pcLinkTranscript(n.hello, fakeCh, n.nonce), fake.rk);
    assert.throws(() => hpkeOpen(n.link.secretKey, fakeSeal.enc, utf8(CTX.pclinkRk), r.transcript, fakeSeal.ct));
    const other = await addDevice(e.aik, e.list, { deviceId: n.self.deviceId, role: 'desktop', noisePub: x25519Keygen().publicKey, signPub: n.self.signPub, registeredAt: 2 });
    assert.deepEqual(check({ ...grant, deviceList: other }), { ok: false, reason: 'not_listed' });
    assert.deepEqual(check({ ...grant, deviceList: e.list }), { ok: false, reason: 'not_listed' });
    assert.deepEqual(check(grant, { ...ap.challenge, device_id: randomUUID() }), { ok: false, reason: 'approver' });
    const g2 = structuredClone(grant) as typeof grant;
    g2.cert.cert.device_id = randomUUID();
    assert.deepEqual(check(g2), { ok: false, reason: 'cert' });
    const g = check(grant);
    assert.ok(g.ok);
    if (g.ok) assert.throws(() => hpkeOpen(n.link.secretKey, g.enc, g.info, randomBytes(32), g.ct));
  });

  it('입력 모양: 키 길이·UUID·남는 필드·자기 자신의 challenge를 거부한다. PC 한도(3대)를 넘으면 승인 뒤에도 목록을 만들지 않는다', async () => {
    const n = newPc();
    assert.equal(parsePcLinkHello({ ...n.hello, Hx: b64(randomBytes(31)) }), null);
    assert.equal(parsePcLinkHello({ ...n.hello, device_id: 'x' }), null);
    assert.equal(parsePcLinkHello({ ...n.hello, more: 1 }), null);
    assert.equal(parsePcLinkHello({ ...n.hello, v: 2 }), null);
    assert.equal(parsePcLinkChallenge({ v: 1, device_id: randomUUID(), aik_pub: 'a', nonce: b64(randomBytes(32)) }), null);
    assert.equal(parsePcLinkReveal({ v: 1, nonce: b64(randomBytes(16)) }), null);
    assert.throws(() => pcLinkReveal(n.hello, { v: 1, device_id: n.hello.device_id, aik_pub: b64(ed25519Keygen().publicKey), nonce: b64(randomBytes(32)) }, n.nonce), /bad challenge/);
    assert.throws(() => new PcLinkApprover({ ...n.hello, commit: 'zz' }, { deviceId: randomUUID(), aikPub: ed25519Keygen().publicKey }), /bad hello/);
    assert.equal(fromB64(n.hello.commit).length, 32);

    const e = await oldPc();
    let list: DeviceListJson = e.list;
    for (let i = 1; i < MAX_DESKTOPS; i++) list = await addDevice(e.aik, list, { deviceId: randomUUID(), role: 'desktop', noisePub: x25519Keygen().publicKey, signPub: ed25519Keygen().publicKey, registeredAt: i });
    const ap = new PcLinkApprover(n.hello, { deviceId: e.deviceId, aikPub: e.aik.publicKey });
    const r = pcLinkReveal(n.hello, ap.challenge, n.nonce);
    ap.reveal(r.reveal);
    ap.confirm(r.sas);
    let sealed = 0;
    await assert.rejects(ap.listWithNew(e.aik, list), /too many devices/);
    await assert.rejects(ap.grant({ aik: e.aik, deviceList: list, sealRk: async (...a) => (sealed++, e.sealRk(...a)) }), /not listed/);
    assert.equal(sealed, 0, '새 PC가 목록에 없으면 RK를 봉인하지 않는다');
  });
});
