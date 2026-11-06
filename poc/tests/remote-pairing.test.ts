// D08 §4 페어링(SP-2 페어링 SAS): PC 역할·폰 역할을 한 프로세스에서 메모리 릴레이로 돌린다.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AIK_PURPOSES, CTX, MemoryRelay, MobilePairing, addDevice, b64, decodeQr, deriveSas, docScopeJson, ed25519Keygen, encodeQr, fromB64, revokeDevice, softSigner,
  toHex, upsertDevice, utf8, verifyCert, verifyDeviceList, type DeviceListJson,
} from '@sax/remote';
import { DAY, RELAY, mockDesktop, mockPhone, pairOnce, pairWorld, until } from './remote-support.ts';

describe('페어링 정상 흐름', () => {
  it('QR → XXpsk0 → 양쪽 같은 SAS → PC 입력 → pair.ok 검증 → 기기 목록 v2', async () => {
    const w = await pairWorld();
    const { pc, phone } = await pairOnce(w);
    assert.equal(pc.pairId, phone.pairId);
    assert.equal(w.mob.state, 'paired');
    assert.equal(w.pc.state, 'paired');
    assert.match(w.mob.sas!, /^\d{6}$/);
    assert.equal(w.mob.newDesktopWarning, false);
    assert.equal(phone.deviceList.listVersion, 2);
    assert.equal(w.published.length, 1);
    assert.equal(w.enrolled.length, 1, 'PC가 폰을 한 번 대리 등록한다');
    assert.equal(w.enrolled[0]!.deviceId, w.phone.keys.deviceId);
    assert.deepEqual(w.enrolled[0]!.roomId, w.pc.roomId, '이 페어링 룸 id로 등록한다');
    assert.equal(w.enrolled[0]!.phoneState, 'show_sas', 'pair.ok 전(룸이 열려 있을 때) 등록한다');
    assert.deepEqual(phone.aikPub, w.desk.keys.aik.publicKey);
    const chk = verifyDeviceList(phone.deviceList, w.desk.keys.aik.publicKey);
    assert.ok(chk.ok);
    assert.equal(chk.ok && chk.devices.filter((d) => d.role === 'mobile').length, 1);
    const cert = verifyCert(phone.cert, w.desk.keys.aik.publicKey)!;
    assert.equal(cert.device_id, w.phone.keys.deviceId);
    assert.ok(cert.not_after - Date.now() > 89 * DAY);
    assert.equal(cert.Px, undefined, 'Px는 M7-7(제안)이라 넣지 않는다');
    assert.deepEqual(pc.docScope, { slots: ['business'], docTypes: '*' });
    pc.channel.close();
  });

  it('우편함 ID·토큰은 서로 다른 32B 난수이고, 릴레이가 본 프레임에 평문으로 나오지 않는다', async () => {
    const w = await pairWorld();
    const { pc } = await pairOnce(w);
    const vals = [pc.mbxId, pc.tokRead, pc.tokWrite].map(toHex);
    assert.equal(new Set(vals).size, 3);
    const seen = w.relay.observed.map((o) => toHex(o.frame)).join('|');
    for (const v of vals) assert.ok(!seen.includes(v), 'token visible to relay');
    assert.ok(!seen.includes(toHex(utf8(w.phone.keys.name))), 'device name visible to relay');
    assert.ok(!seen.includes(toHex(w.phone.keys.noise.publicKey)), 'phone static visible to relay');
  });

  it('SAS 유도는 핸드셰이크 해시에 결정적이고 6자리(앞자리 0 유지)', () => {
    const h = new Uint8Array(64);
    assert.equal(deriveSas(h), deriveSas(h.slice()));
    let zeroLead = false;
    for (let i = 0; i < 200 && !zeroLead; i++) zeroLead = deriveSas(new Uint8Array(64).fill(i)).startsWith('0');
    assert.match(deriveSas(h), /^\d{6}$/);
  });

  it('24시간 안에 등록된 PC면 PAIR_OK 검사 뒤(저장 전) 전면 경고 표시', async () => {
    const desk = await mockDesktop(Date.now() - 2 * 3_600_000);
    const w = await pairWorld({ desk });
    const { qr } = w.pc.offer();
    assert.ok(w.mob.scan(qr));
    assert.equal(w.mob.newDesktopWarning, false, '스캔만으로는 알 수 없다(서버 목록을 받지 않는다)');
    const w2 = await pairWorld({ desk });
    await pairOnce(w2);
    assert.equal(w2.mob.newDesktopWarning, true);
  });

  it('서류 열람 범위: 기본 사업자만, 개인 프로필이 없으면 개인을 켤 수 없다', () => {
    assert.equal(docScopeJson({ business: true, personal: false }, true), '{"slots":["business"],"docTypes":"*"}');
    assert.equal(docScopeJson({ business: true, personal: true }, false), '{"slots":["business"],"docTypes":"*"}');
    assert.equal(docScopeJson({ business: true, personal: true }, true), '{"slots":["business","personal"],"docTypes":"*"}');
  });
});

describe('SAS 입력(PC)', () => {
  it('틀린 6자리 3번이면 룸 폐기, 폰은 시간 초과로 실패', async () => {
    const w = await pairWorld();
    const { qr } = w.pc.offer();
    const pcRun = w.pc.run(await w.relay.joinRoom(w.pc.roomId, 'desktop'));
    assert.ok(w.mob.scan(qr));
    const phRun = w.mob.run(await w.relay.joinRoom(w.mob.roomId, 'mobile'));
    await pcRun;
    await until(() => w.mob.state === 'show_sas');
    const wrong = w.mob.sas === '000000' ? '111111' : '000000';
    assert.deepEqual(await w.pc.submitSas(wrong), { ok: false, triesLeft: 2 });
    assert.deepEqual(await w.pc.submitSas('12345'), { ok: false, triesLeft: 1 });
    assert.deepEqual(await w.pc.submitSas(wrong), { ok: false, triesLeft: 0 });
    assert.equal(w.pc.state, 'failed');
    await assert.rejects(() => w.pc.submitSas(w.mob.sas!));
    assert.equal(await phRun, null);
    assert.equal(w.mob.state, 'failed');
    assert.equal(w.published.length, 0, '기기 목록을 올리지 않는다');
  });

  it('QR TTL(120초)이 지나면 SAS가 맞아도 거부', async () => {
    let t = Date.now();
    const w = await pairWorld({ now: () => t });
    const { qr } = w.pc.offer();
    const pcRun = w.pc.run(await w.relay.joinRoom(w.pc.roomId, 'desktop'));
    assert.ok(w.mob.scan(qr));
    void w.mob.run(await w.relay.joinRoom(w.mob.roomId, 'mobile'));
    await pcRun;
    t += 121_000;
    assert.equal((await w.pc.submitSas(w.mob.sas!)).ok, false);
    assert.equal(w.pc.state, 'failed');
  });

  it('대리 등록이 거부되면(룸 소비 실패·상한) 목록을 올리지 않고 pair.ok도 보내지 않는다', async () => {
    const w = await pairWorld({ enrollFails: true });
    await assert.rejects(() => pairOnce(w));
    assert.equal(w.pc.state, 'failed');
    assert.equal(w.published.length, 0);
    assert.equal(w.mob.state, 'failed');
  });

  it('이미 같은 키로 목록에 있는 폰(다시 연결)은 다시 등록하지 않는다', async () => {
    const w = await pairWorld();
    const { pc } = await pairOnce(w);
    pc.channel.close();
    const w2 = await pairWorld({ relay: w.relay, desk: { ...w.desk, deviceList: w.published[0]! }, phone: w.phone, knownAik: w.desk.keys.aik.publicKey, seenListVersion: 2 });
    await pairOnce(w2);
    assert.equal(w2.enrolled.length, 0);
    assert.equal(w2.published.length, 1);
  });
});

describe('폰 스캔 검사(3단계)', () => {
  it('만료·허용 목록 밖 릴레이·형식 오류', async () => {
    const w = await pairWorld();
    const { qr } = w.pc.offer();
    const q = decodeQr(qr)!;
    const mk = () => new MobilePairing({ keys: w.phone.keys, relayAllowlist: [RELAY] });
    let m = mk();
    assert.equal(m.scan(encodeQr({ ...q, exp: Math.floor(Date.now() / 1000) - 1 })), false);
    assert.equal(m.failure, 'qr_expired');
    m = mk();
    assert.equal(m.scan(encodeQr({ ...q, relayHost: 'evil.example' })), false);
    assert.equal(m.failure, 'relay_not_allowed');
    m = mk();
    assert.equal(m.scan('https://sax.example/pair?x=1'), false);
    assert.equal(m.failure, 'qr_invalid');
    m = mk();
    assert.equal(m.scan(encodeQr({ ...q, intent: 'recover' })), false);
  });

  it('실패 뒤 다시 스캔하면 지난 실패를 지우고, 진행 중에는 스캔을 받지 않는다', async () => {
    const w = await pairWorld();
    const { qr } = w.pc.offer();
    const m = new MobilePairing({ keys: w.phone.keys, relayAllowlist: [RELAY] });
    assert.equal(m.scan('garbage'), false);
    assert.equal(m.failure, 'qr_invalid');
    assert.equal(m.scan(qr), true);
    assert.equal(m.failure, null);
    assert.equal(m.sas, null);
    assert.equal(m.state, 'scanned');
    m.state = 'show_sas';
    assert.throws(() => m.scan(qr), /busy/);
  });

  it('스캔은 계정 서버 없이 QR만 본다(폰은 기기 목록을 조회하지 않는다)', async () => {
    const w = await pairWorld();
    const { qr } = w.pc.offer();
    const m = new MobilePairing({ keys: w.phone.keys, relayAllowlist: [RELAY] });
    assert.equal(m.scan(qr), true);
    assert.equal(m.state, 'scanned');
  });
});

describe('PAIR_OK 기기 목록 검사(3단계를 7단계에서)', () => {
  it('PAIR_OK 목록에 QR의 Sd가 데스크톱으로 없으면 중단(키를 저장하지 않는다)', async () => {
    // 같은 AIK의 다른 PC 목록을 들고 온 PC: 서명은 맞지만 자기 Sd가 목록에 없다.
    const aik = ed25519Keygen().secretKey;
    const a = await mockDesktop(Date.now() - 30 * DAY, aik);
    const b = await mockDesktop(Date.now() - 30 * DAY, aik);
    const w = await pairWorld({ desk: { ...a, deviceList: b.deviceList } });
    await assert.rejects(() => pairOnce(w));
    assert.equal(w.mob.failure, 'desktop_unknown');
    assert.equal(w.mob.state, 'failed');
  });

  it('이미 본 것보다 낮은 listVersion은 거부', async () => {
    const w = await pairWorld({ seenListVersion: 5 });
    await assert.rejects(() => pairOnce(w));
    assert.equal(w.mob.failure, 'devlist_invalid');
  });

  it('PAIR_OK 목록이 PAIR_OK의 AIK로 서명되지 않았으면 거부', async () => {
    // 장악된 PC: 인증서는 계정 AIK로 서명하지만 기기 목록은 다른 키로 서명해 보낸다.
    const desk = await mockDesktop();
    const forged = softSigner(ed25519Keygen().secretKey, AIK_PURPOSES);
    const real = desk.keys.aik;
    desk.keys.aik = { publicKey: real.publicKey, sign: (purpose, msg) => (purpose === CTX.devlist ? forged.sign(purpose, msg) : real.sign(purpose, msg)) };
    const w = await pairWorld({ desk });
    await assert.rejects(() => pairOnce(w));
    assert.equal(w.mob.failure, 'devlist_invalid');
  });
});

describe('핸드셰이크 공격', () => {
  it('PSK가 다르면(QR 일부만 유출·변조) 핸드셰이크 실패', async () => {
    const w = await pairWorld();
    const { qr } = w.pc.offer();
    const q = decodeQr(qr)!;
    const pcRun = w.pc.run(await w.relay.joinRoom(w.pc.roomId, 'desktop'));
    assert.ok(w.mob.scan(encodeQr({ ...q, psk: new Uint8Array(32).fill(9) })));
    const r = await w.mob.run(await w.relay.joinRoom(w.mob.roomId, 'mobile'));
    await pcRun;
    assert.equal(r, null);
    assert.equal(w.pc.state, 'failed');
  });

  it('릴레이가 프레임을 바꾸면 실패(조용히)', async () => {
    const relay = new MemoryRelay();
    relay.faults = { tamper: 1, rand: () => 0.5 };
    const w = await pairWorld({ relay });
    const { qr } = w.pc.offer();
    const pcRun = w.pc.run(await w.relay.joinRoom(w.pc.roomId, 'desktop'));
    assert.ok(w.mob.scan(qr));
    const r = w.mob.run(await w.relay.joinRoom(w.mob.roomId, 'mobile'));
    await pcRun;
    assert.equal(w.pc.state, 'failed');
    assert.equal(await r, null);
  });

  it('다시 연결할 때 PAIR_OK의 AIK가 앞서 고정한 AIK와 다르면 중단(가짜 PC)', async () => {
    // 폰은 앞선 페어링에서 계정 AIK_A를 고정했는데, 가짜 PC는 자기 AIK_B로 서명한 목록을 보낸다.
    const realDesk = await mockDesktop(Date.now() - 30 * DAY);
    const fake = await mockDesktop(Date.now() - 30 * DAY);
    const w = await pairWorld({ desk: fake, knownAik: realDesk.keys.aik.publicKey });
    await assert.rejects(() => pairOnce(w));
    assert.equal(w.mob.failure, 'aik_mismatch');
  });

  it('룸은 1회용: 같은 룸에 다시 들어갈 수 없다', async () => {
    const w = await pairWorld();
    await pairOnce(w);
    await assert.rejects(() => w.relay.joinRoom(w.mob.roomId, 'mobile'));
  });
});

describe('기기 해제·폐기 레코드(§9.2)', () => {
  it('해제하면 폐기 레코드가 남고 listVersion이 오르며 항목이 다시 서명된다', async () => {
    const w = await pairWorld();
    const { phone } = await pairOnce(w);
    const v3 = await revokeDevice(w.desk.keys.aik, phone.deviceList, w.phone.keys.deviceId);
    const chk = verifyDeviceList(v3, w.desk.keys.aik.publicKey, 2);
    assert.ok(chk.ok);
    assert.equal(v3.listVersion, 3);
    assert.ok(chk.ok && chk.revokedIds.has(w.phone.keys.deviceId));
    assert.ok(chk.ok && !chk.devices.some((d) => d.deviceId === w.phone.keys.deviceId));
    // 폐기 숨기기: 옛 목록(v2)을 다시 주면 거부
    assert.equal(verifyDeviceList(phone.deviceList, w.desk.keys.aik.publicKey, 3).ok, false);
    // 섞기: v3의 폐기 레코드를 빼고 v2 항목을 넣으면 version_mix로 거부
    const mixed = { ...v3, revoked: [], entries: [...v3.entries, phone.deviceList.entries.find((e) => e.entry.role === 'mobile')!] };
    const r = verifyDeviceList(mixed, w.desk.keys.aik.publicKey, 3);
    assert.equal(r.ok, false);
    // 폐기된 기기를 목록에 다시 넣으면 거부
    await assert.rejects(() => addDevice(w.desk.keys.aik, v3, { deviceId: w.phone.keys.deviceId, role: 'mobile', noisePub: w.phone.keys.noise.publicKey, signPub: w.phone.keys.vmPub, registeredAt: 1 }));
  });

  it('폐기 레코드 서명은 SAX-revoke-v1 문맥이고 devlist 문맥 서명으로 대신할 수 없다', async () => {
    const w = await pairWorld();
    const { phone } = await pairOnce(w);
    const v3 = await revokeDevice(w.desk.keys.aik, phone.deviceList, w.phone.keys.deviceId);
    const rec = v3.revoked[0]!;
    const wrongCtx = b64(await w.desk.keys.aik.sign(CTX.devlist, fromB64(b64(utf8('x')))));
    assert.equal(verifyDeviceList({ ...v3, revoked: [{ ...rec, aikSig: wrongCtx }] }, w.desk.keys.aik.publicKey).ok, false);
  });

  it('금고 대역 서명기는 허용 목록 밖 용도를 거부한다', async () => {
    const d = await mockDesktop();
    await assert.rejects(() => d.keys.aik.sign('SAX-approve-v1' as never, new Uint8Array(1)));
    const p = mockPhone();
    await assert.rejects(() => p.vm.sign('SAX-devlist-v1' as never, new Uint8Array(1)));
  });
});

describe('재시도와 신뢰할 수 없는 기기 목록', () => {
  it('목록을 올린 뒤 실패한 페어링은 같은 폰으로 다시 할 수 있다(항목 하나, 처음 등록 시각 유지)', async () => {
    const w = await pairWorld();
    const real = w.relay.registerMailbox.bind(w.relay);
    w.relay.registerMailbox = () => {
      throw new Error('mailbox down');
    };
    await assert.rejects(() => pairOnce(w));
    assert.equal(w.published.length, 1, '실패 전에 목록은 이미 올라갔다');
    const published = w.published[0]!;
    w.relay.registerMailbox = real;
    const w2 = await pairWorld({ relay: w.relay, desk: { ...w.desk, deviceList: published }, phone: w.phone });
    const { phone } = await pairOnce(w2);
    assert.equal(phone.deviceList.listVersion, 3);
    const mine = phone.deviceList.entries.filter((e) => e.entry.device_id === w.phone.keys.deviceId);
    assert.equal(mine.length, 1);
    assert.equal(mine[0]!.entry.registered_at, published.entries.find((e) => e.entry.device_id === w.phone.keys.deviceId)!.entry.registered_at);
    assert.ok(verifyDeviceList(phone.deviceList, w.desk.keys.aik.publicKey).ok);
  });

  it('같은 기기 ID인데 키가 다르거나 폐기된 ID면 다시 넣지 않는다', async () => {
    const d = await mockDesktop();
    const ph = mockPhone();
    const info = { deviceId: ph.keys.deviceId, role: 'mobile' as const, noisePub: ph.keys.noise.publicKey, signPub: ph.keys.vmPub, registeredAt: 1 };
    const l2 = await addDevice(d.keys.aik, d.deviceList, info);
    const other = mockPhone();
    await assert.rejects(() => upsertDevice(d.keys.aik, l2, { ...info, signPub: other.keys.vmPub }), /already used/);
    const l3 = await revokeDevice(d.keys.aik, l2, ph.keys.deviceId);
    await assert.rejects(() => upsertDevice(d.keys.aik, l3, info), /revoked/);
    const again = await upsertDevice(d.keys.aik, l2, info);
    assert.equal(again.listVersion, 3);
    assert.equal(again.entries.length, 2);
  });

  it('모양이 틀린 목록은 던지지 않고 shape로 끝난다', async () => {
    const d = await mockDesktop();
    const good = d.deviceList;
    const e0 = good.entries[0]!;
    const bads: unknown[] = [
      null, 7, {}, { ...good, listVersion: '1' }, { ...good, entries: [null] }, { ...good, entries: [{ aikSig: e0.aikSig }] },
      { ...good, entries: [{ entry: { ...e0.entry, Sx: e0.entry.Sx.replace(/=$/, '') }, aikSig: e0.aikSig }] },
      { ...good, entries: [{ entry: { ...e0.entry, Sx: '***' }, aikSig: e0.aikSig }] },
      { ...good, entries: [{ entry: { ...e0.entry, registered_at: 1.5 }, aikSig: e0.aikSig }] },
      { ...good, revoked: [null] }, { ...good, revoked: [{ device_id: 1, revoked_at: 1, aikSig: 'AAAA' }] },
    ];
    for (const b of bads) {
      const r = verifyDeviceList(b as DeviceListJson, d.keys.aik.publicKey);
      assert.equal(r.ok, false);
      assert.ok(!r.ok && (r.reason === 'shape' || r.reason === 'signature'), JSON.stringify(b)?.slice(0, 80));
    }
  });
});
