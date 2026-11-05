// D08 §5 상시 세션(Noise_IK) + hello. PC는 미폐기·단조 타임스탬프가 아니면 무응답으로 버린다.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CAP, acceptDesktopSession, fromB64, monotonicClock, openMobileSession, type PairRecord } from '@sax/remote';
import { pairOnce, pairWorld } from './remote-support.ts';

async function setup() {
  const w = await pairWorld();
  const { pc, phone } = await pairOnce(w);
  pc.channel.close();
  const rec: PairRecord = { pairId: pc.pairId, phoneStatic: pc.phone.Sm, revoked: false, ikTsMax: 0 };
  const persisted: number[] = [];
  const connect = async (o: { ts?: () => number; noise?: typeof w.phone.keys.noise; phoneListVersion?: number } = {}) => {
    const pcLink = await w.relay.joinMailbox(pc.mbxId, pc.tokRead, 'desktop');
    const phLink = await w.relay.joinMailbox(fromB64(phone.mbxId), fromB64(phone.tokWrite), 'mobile');
    const pcSide = acceptDesktopSession(pcLink, {
      noise: w.desk.keys.noise, pair: rec, hello: { appVersion: 'pc-1', deviceListVersion: pc.deviceList.listVersion, capabilities: [CAP.receipt, CAP.cash] },
      persistTs: async (_p, t) => {
        persisted.push(t);
      },
    });
    const phSide = openMobileSession(phLink, {
      pairId: phone.pairId, noise: o.noise ?? w.phone.keys.noise, desktopStatic: phone.desktopStatic, nextTimestamp: o.ts ?? monotonicClock(0), responseTimeoutMs: 300,
      hello: { appVersion: 'm-1', deviceListVersion: o.phoneListVersion ?? phone.deviceList.listVersion, capabilities: [CAP.receipt, CAP.cash] },
    });
    const [a, b] = await Promise.all([pcSide, phSide]);
    pcLink.close();
    phLink.close();
    return { pc: a, phone: b };
  };
  return { w, pc, phone, rec, persisted, connect };
}

describe('상시 세션 IK', () => {
  it('연결 → hello 교환 → ping/pong', async () => {
    const s = await setup();
    const pcLink = await s.w.relay.joinMailbox(s.pc.mbxId, s.pc.tokRead, 'desktop');
    const phLink = await s.w.relay.joinMailbox(fromB64(s.phone.mbxId), fromB64(s.phone.tokWrite), 'mobile');
    const [a, b] = await Promise.all([
      acceptDesktopSession(pcLink, { noise: s.w.desk.keys.noise, pair: s.rec, hello: { appVersion: 'pc', deviceListVersion: 2, capabilities: [] }, persistTs: async () => {} }),
      openMobileSession(phLink, { pairId: s.phone.pairId, noise: s.w.phone.keys.noise, desktopStatic: s.phone.desktopStatic, nextTimestamp: monotonicClock(0), hello: { appVersion: 'm', deviceListVersion: 2, capabilities: [CAP.receipt] } }),
    ]);
    assert.ok(a && b);
    assert.equal(a.peerHello.appVersion, 'm');
    assert.equal(b.peerHello.appVersion, 'pc');
    assert.equal(a.deviceListMismatch, false);
    b.channel.send('ping', {});
    const e = await a.channel.recv(1000);
    assert.equal(e?.type, 'ping');
    a.channel.send('pong', {});
    assert.equal((await b.channel.recv(1000))?.type, 'pong');
  });

  it('타임스탬프 재사용(msg1 재전송)은 무응답', async () => {
    const s = await setup();
    const first = await s.connect({ ts: () => 1000 });
    assert.ok(first.pc && first.phone);
    const again = await s.connect({ ts: () => 1000 });
    assert.equal(again.pc, null);
    assert.equal(again.phone, null);
    assert.deepEqual(s.persisted, [1000]);
  });

  it('폐기된 폰·다른 폰 키는 무응답', async () => {
    const s = await setup();
    s.rec.revoked = true;
    assert.equal((await s.connect()).phone, null);
    s.rec.revoked = false;
    const { mockPhone } = await import('./remote-support.ts');
    assert.equal((await s.connect({ noise: mockPhone().keys.noise })).phone, null);
    assert.deepEqual(s.persisted, []);
  });

  it('deviceListVersion이 다르면 표시한다(C-20)', async () => {
    const s = await setup();
    const r = await s.connect({ phoneListVersion: 1 });
    assert.equal(r.pc?.deviceListMismatch, true);
    assert.equal(r.phone?.deviceListMismatch, true);
  });

  it('해제된 우편함은 릴레이가 연결을 받지 않는다', async () => {
    const s = await setup();
    s.w.relay.revokeMailbox(s.pc.mbxId);
    await assert.rejects(() => s.w.relay.joinMailbox(fromB64(s.phone.mbxId), fromB64(s.phone.tokWrite), 'mobile'));
  });

  it('토큰을 바꿔 쓰면(PC 토큰으로 폰 자리) 거부', async () => {
    const s = await setup();
    await assert.rejects(() => s.w.relay.joinMailbox(s.pc.mbxId, s.pc.tokRead, 'mobile'));
  });

  it('IK 뒤 hello가 오지 않으면 채널과 링크를 닫는다(우편함 자리를 놓는다)', async () => {
    const s = await setup();
    let n = 0;
    // msg1·msg2만 통과시키고 hello부터 버린다
    s.w.relay.faults = { drop: 0.5, rand: () => (++n <= 2 ? 1 : 0) };
    const pcLink = await s.w.relay.joinMailbox(s.pc.mbxId, s.pc.tokRead, 'desktop');
    const phLink = await s.w.relay.joinMailbox(fromB64(s.phone.mbxId), fromB64(s.phone.tokWrite), 'mobile');
    const [a, b] = await Promise.all([
      acceptDesktopSession(pcLink, { noise: s.w.desk.keys.noise, pair: s.rec, hello: { appVersion: 'pc', deviceListVersion: 2, capabilities: [] }, persistTs: async () => {}, helloTimeoutMs: 200 }),
      openMobileSession(phLink, { pairId: s.phone.pairId, noise: s.w.phone.keys.noise, desktopStatic: s.phone.desktopStatic, nextTimestamp: monotonicClock(0), hello: { appVersion: 'm', deviceListVersion: 2, capabilities: [] }, helloTimeoutMs: 200 }),
    ]);
    assert.equal(a, null);
    assert.equal(b, null);
    assert.equal(phLink.closed, true);
    assert.equal(pcLink.closed, true);
    s.w.relay.faults = {};
    // 자리가 비었으니 다시 들어갈 수 있다
    const again = await s.w.relay.joinMailbox(fromB64(s.phone.mbxId), fromB64(s.phone.tokWrite), 'mobile');
    assert.equal(again.closed, false);
    again.close();
  });

  it('monotonicClock은 시계가 뒤로 가도 증가', () => {
    let t = 100;
    const c = monotonicClock(500, () => t);
    assert.equal(c(), 501);
    t = 1000;
    assert.equal(c(), 1000);
    t = 10;
    assert.equal(c(), 1001);
  });
});
