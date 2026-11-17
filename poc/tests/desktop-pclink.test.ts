// 새 PC 연결의 main 쪽 흐름(apps/desktop/src/remote-pclink.ts, ADR-048 결정 3, D08 §4.3): 가장자리 경우를 가짜 우편함으로 본다.
// 실제 계정 서비스·금고에 붙인 끝에서 끝 시험은 desktop-remote-cloud.test.ts에 있다.
import assert from 'node:assert/strict';
import { hkdfSync } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  AIK_PURPOSES, PCLINK_STEP_MS, VD_PURPOSES, addDevice, b64, ed25519Keygen, hpkeOpen, hpkeSeal, initialDeviceList, pcLinkHello, randomBytes, softNoiseStatic, softSigner, uuid4,
  x25519Keygen, type DeviceListJson, type PcLinkChallenge, type PcLinkGrant, type PcLinkHello, type PcLinkReveal,
} from '../packages/remote/src/index.ts';
import type { DeviceManagerSession } from '../apps/desktop/src/remote-devices.ts';
import { PCLINK_RESTART_MS, PcLinkHost, PcLinkJoin } from '../apps/desktop/src/remote-pclink.ts';
import type { AccountClient, DeviceAuth, PcLinkRequest, PcLinkVault, ServerDevice } from '../apps/desktop/src/remote-ports.ts';

/** RK → AIK 시드(D08 §3, 금고의 aikSeedFromRk와 같은 식). */
const aikSeed = (rk: Uint8Array) => new Uint8Array(hkdfSync('sha256', rk, new Uint8Array(0), 'aik', 32));

const fail = (code: string): never => {
  throw Object.assign(new Error(code), { code });
};

/** 계정 서비스의 연결 우편함 대역(순서 규칙은 서버와 같다). calls에 부른 메서드를 남긴다. */
function mailbox() {
  const devices: ServerDevice[] = [];
  const links = new Map<string, { hello: PcLinkHello; challenge: PcLinkChallenge | null; reveal: PcLinkReveal | null; grant: PcLinkGrant | null }>();
  const calls: string[] = [];
  let list: DeviceListJson | null = null;
  const client = {
    devicesBySession: async () => (calls.push('devicesBySession'), devices.map((d) => ({ ...d }))),
    enrollDesktop: async (_s: string, b: { deviceId: string; platform: 'windows' | 'macos'; name: string; Sx: string; Vx: string }) => {
      calls.push('enrollDesktop');
      if (devices.filter((d) => d.role === 'desktop' && d.state !== 'revoked').length >= 3) fail('account.device_limit');
      devices.push({ deviceId: b.deviceId, role: 'desktop', platform: b.platform, name: b.name, state: 'pending', registeredAt: 1, Sx: b.Sx, Vx: b.Vx, deleteAfter: null });
    },
    pcLinkHello: async (_s: string, id: string, hello: PcLinkHello) => {
      calls.push('pcLinkHello');
      if (!devices.some((d) => d.deviceId === id && (d.state === 'pending' || d.state === 'active'))) fail('account.device_not_found');
      links.set(id, { hello, challenge: null, reveal: null, grant: null });
    },
    pcLinkAnswer: async (_s: string, id: string) => {
      const l = links.get(id) ?? fail('account.link_not_found');
      return { challenge: l.challenge, grant: l.grant };
    },
    pcLinkReveal: async (_s: string, id: string, reveal: PcLinkReveal) => {
      const l = links.get(id) ?? fail('account.link_not_found');
      if (!l.challenge || l.reveal) fail('account.link_state');
      l.reveal = reveal;
    },
    pcLinkCancel: async (_s: string, id: string) => void (calls.push('pcLinkCancel'), links.delete(id)),
    pcLinks: async (): Promise<PcLinkRequest[]> =>
      [...links].filter(([, l]) => !l.grant).map(([id, l]) => {
        const d = devices.find((x) => x.deviceId === id)!;
        return { deviceId: id, name: d.name, platform: d.platform as 'windows' | 'macos', createdAt: 1, hello: l.hello, challengedBy: l.challenge?.device_id ?? null, reveal: l.reveal };
      }),
    pcLinkChallenge: async (_a: DeviceAuth, id: string, c: PcLinkChallenge) => {
      const l = links.get(id) ?? fail('account.link_not_found');
      if (l.challenge) fail('account.link_state');
      l.challenge = c;
    },
    pcLinkGrant: async (_a: DeviceAuth, id: string, g: PcLinkGrant) => {
      calls.push('pcLinkGrant');
      const l = links.get(id) ?? fail('account.link_not_found');
      if (!l.reveal || l.grant || devices.find((d) => d.deviceId === id)?.state !== 'active') fail('account.link_state');
      l.grant = g;
    },
    pcLinkDrop: async (_a: DeviceAuth, id: string) => {
      calls.push('pcLinkDrop');
      links.delete(id);
      const i = devices.findIndex((d) => d.deviceId === id && d.state === 'pending');
      if (i >= 0) devices.splice(i, 1);
    },
    putDeviceList: async (_a: DeviceAuth, l: DeviceListJson) => {
      calls.push('putDeviceList');
      for (const e of l.entries) {
        const d = devices.find((x) => x.deviceId === e.entry.device_id) ?? fail('request.param_rejected');
        if (d.state === 'pending') d.state = 'active';
      }
      list = l;
    },
  } satisfies Partial<AccountClient>;
  return { client, devices, links, calls, serverList: () => list };
}

/** 쓰던 PC: 계정 열쇠(RK)에서 나온 AIK, 목록, 금고 대역(sealRk). */
async function oldPc(m: ReturnType<typeof mailbox>, now: () => number) {
  const rk = randomBytes(32);
  const aik = softSigner(aikSeed(rk), AIK_PURPOSES);
  const keys = { noise: softNoiseStatic(x25519Keygen().secretKey), vd: softSigner(ed25519Keygen().secretKey, VD_PURPOSES) };
  const deviceId = uuid4();
  let list = await initialDeviceList(aik, { deviceId, role: 'desktop', noisePub: keys.noise.publicKey, signPub: keys.vd.publicKey, registeredAt: 1 });
  m.devices.push({ deviceId, role: 'desktop', platform: 'windows', name: '사무실 PC', state: 'active', registeredAt: 1, Sx: b64(keys.noise.publicKey), Vx: b64(keys.vd.publicKey), deleteAfter: null });
  let seals = 0;
  let sealError: Error | null = null;
  const vault: PcLinkVault = {
    key: async () => fail('account.failed'),
    sealRk: async (recipient, info, aad) => {
      if (sealError) throw sealError;
      return (seals++, hpkeSeal(recipient, info, aad, rk));
    },
    importRk: async () => fail('account.failed'),
  };
  const session: DeviceManagerSession = {
    deviceId,
    aikPub: b64(aik.publicKey),
    get deviceList() {
      return list;
    },
    auth: async () => ({}),
    clearToken: () => {},
    setDeviceList: async (l) => void (list = l),
  };
  const logs: string[] = [];
  const records: Array<Record<string, string | number>> = [];
  const host = new PcLinkHost({
    client: m.client,
    exclusive: (f) => f(session, (g) => g(session.auth), async () => {}),
    aik: async () => aik,
    vault: async () => vault,
    now,
    log: (_n, d) => void (logs.push(String(d.result)), records.push(d)),
  });
  return { rk, aik, deviceId, host, session, logs, records, seals: () => seals, failSeal: (e: Error | null) => void (sealError = e), list: () => list, setList: (l: DeviceListJson) => void (list = l) };
}

/** 새 PC: 기기 키와 금고 대역(넘겨받기 키는 메모리, importRk는 AIK 대조). */
function newPc(m: ReturnType<typeof mailbox>, aikPub: string, now: () => number) {
  const keys = { noise: softNoiseStatic(x25519Keygen().secretKey), vd: softSigner(ed25519Keygen().secretKey, VD_PURPOSES) };
  let link = x25519Keygen();
  let rk: Uint8Array | null = null;
  let keysMade = 0;
  const vault: PcLinkVault = {
    key: async () => (keysMade++, (link = x25519Keygen()).publicKey),
    sealRk: async () => fail('account.failed'),
    importRk: async (g) => {
      const got = hpkeOpen(link.secretKey, g.enc, g.info, g.aad, g.ct);
      const pub = softSigner(aikSeed(got), AIK_PURPOSES).publicKey;
      if (b64(pub) !== b64(g.aikPub)) throw new Error('aik_mismatch');
      rk = got;
      return pub;
    },
  };
  const start = () => PcLinkJoin.start({ client: m.client, session: 'sxs1.test', aikPub, keys, vault, platform: 'macos', name: '집 PC', now });
  return { keys, vault, start, rk: () => rk, keysMade: () => keysMade };
}

describe('새 PC 연결(main): 새 PC 쪽', () => {
  it('신청 기록(같은 Sx·Vx)이 있으면 그 기기 ID를 다시 쓰고 새로 신청하지 않는다, 없으면 신청한다', async () => {
    const m = mailbox();
    const t = 1_000_000;
    const e = await oldPc(m, () => t);
    const n = newPc(m, e.session.aikPub, () => t);
    const j1 = await n.start();
    assert.deepEqual(m.calls, ['devicesBySession', 'enrollDesktop', 'pcLinkHello']);
    assert.deepEqual([j1.stage, j1.code], ['wait', null]);
    await j1.cancel();
    assert.equal(m.links.size, 0);
    assert.equal(m.devices.find((d) => d.deviceId === j1.deviceId)?.state, 'pending', '그만둬도 신청 기록은 남는다');
    m.calls.length = 0;
    const j2 = await n.start();
    assert.equal(j2.deviceId, j1.deviceId);
    assert.deepEqual(m.calls, ['devicesBySession', 'pcLinkHello']);
    // 폐기된 기록은 다시 쓰지 않는다
    m.devices.find((d) => d.deviceId === j1.deviceId)!.state = 'revoked';
    assert.notEqual((await n.start()).deviceId, j1.deviceId);
  });

  it('계정 AIK와 다른 키로 답했거나, 내 기기 ID로 답했거나, 모양이 틀리면 account.link_mismatch', async () => {
    const m = mailbox();
    const e = await oldPc(m, () => 1);
    const n = newPc(m, e.session.aikPub, () => 1);
    const nonce = () => b64(randomBytes(32));
    for (const challenge of [
      { v: 1, device_id: e.deviceId, aik_pub: b64(ed25519Keygen().publicKey), nonce: nonce() },
      { v: 1, device_id: 'me', aik_pub: e.session.aikPub, nonce: nonce() },
      { v: 1, device_id: e.deviceId, aik_pub: e.session.aikPub, nonce: nonce(), extra: 1 },
    ]) {
      const j = await n.start();
      m.links.get(j.deviceId)!.challenge = (challenge.device_id === 'me' ? { ...challenge, device_id: j.deviceId } : challenge) as PcLinkChallenge;
      await assert.rejects(j.poll(), { code: 'account.link_mismatch' });
      assert.equal(m.links.get(j.deviceId)!.reveal, null, '난수를 공개하지 않는다');
    }
    // 쓰던 PC가 거절해 신청이 사라지면 account.link_not_found
    const j = await n.start();
    m.links.delete(j.deviceId);
    await assert.rejects(j.poll(), { code: 'account.link_not_found' });
  });

  it('6자리를 보인 뒤 승인 창(10분)이 지나면 새 키·새 약속으로 다시 신청한다. 받은 열쇠가 다른 계정 것이면 금고가 받지 않는다', async () => {
    const m = mailbox();
    let t = 1_000_000;
    const e = await oldPc(m, () => t);
    const n = newPc(m, e.session.aikPub, () => t);
    const j = await n.start();
    await e.host.begin(j.deviceId);
    assert.equal(await j.poll(), true);
    const code1 = j.code!;
    const commit1 = m.links.get(j.deviceId)!.hello.commit;
    t += PCLINK_RESTART_MS;
    assert.equal(await j.poll(), false, '아직 창 안');
    t += 1;
    assert.equal(await j.poll(), true);
    assert.deepEqual([j.stage, j.code], ['wait', null]);
    assert.notEqual(m.links.get(j.deviceId)!.hello.commit, commit1);
    assert.equal(n.keysMade(), 2, '넘겨받기 키도 새로 만든다');
    // 쓰던 PC: 앞 승인 상태는 버려지고 새 신청으로 보인다
    assert.deepEqual((await e.host.list()).map((x) => x.stage), ['new']);
    await e.host.begin(j.deviceId);
    await j.poll();
    assert.match(j.code!, /^\d{6}$/);
    assert.ok(code1);
    // 서버가 쓰던 PC인 척 다른 열쇠를 봉인해 넣으면(목록·인증서는 진짜 AIK로 서명할 수 없으니 여기서는 봉인문만 바꾼다) 금고가 받지 않는다
    assert.equal((await e.host.confirm(j.deviceId, j.code!)).ok, true);
    const l = m.links.get(j.deviceId)!;
    const good = l.grant!;
    assert.equal(good.deviceList.entries.length, 2);
    const evil = hpkeSeal(x25519Keygen().publicKey, new TextEncoder().encode('SAX-pclink-rk-v1'), randomBytes(32), randomBytes(32));
    l.grant = { ...good, enc: b64(evil.enc), ct: b64(evil.ct) };
    assert.equal(await j.poll(), true);
    assert.equal(j.stage, 'confirm');
    await assert.rejects(j.accept(), { code: 'account.link_mismatch' });
    assert.equal(n.rk(), null);
    // 호출자는 여기서 연결을 끝낸다. 다시 신청하면(이미 목록에 있는 PC) 같은 기기 ID로 열쇠만 다시 받는다
    await j.cancel();
    const j2 = await n.start();
    assert.equal(j2.deviceId, j.deviceId);
    await e.host.begin(j2.deviceId);
    await j2.poll();
    assert.equal((await e.host.confirm(j2.deviceId, j2.code!)).ok, true);
    await assert.rejects(j2.accept(), { code: 'account.link_state' }, '답을 보기 전에는 받지 않는다');
    await j2.poll();
    const done = await j2.accept();
    assert.deepEqual(n.rk(), e.rk);
    assert.equal(done.deviceId, j.deviceId);
    assert.equal(done.deviceList.entries.length, 2);
    assert.equal(m.links.size, 0, '받아 간 뒤 우편함을 비운다');
  });
});

describe('새 PC 연결(main): 쓰던 PC 쪽', () => {
  it('승인 창이 지난 신청은 버리지 않고 숨긴다(새 PC가 다시 신청한다). 6자리를 3번 틀리면 신청을 버리고 자리가 빈다', async () => {
    const m = mailbox();
    let t = 1_000_000;
    const e = await oldPc(m, () => t);
    const n = newPc(m, e.session.aikPub, () => t);
    const j = await n.start();
    await e.host.begin(j.deviceId);
    await j.poll();
    assert.deepEqual((await e.host.list()).map((x) => [x.stage, x.triesLeft]), [['code', 3]]);
    t += PCLINK_STEP_MS + 1;
    assert.deepEqual(await e.host.list(), [], '내가 답했지만 시간이 지난 신청');
    await assert.rejects(e.host.confirm(j.deviceId, j.code!), { code: 'account.link_state' });
    assert.ok(!m.calls.includes('pcLinkDrop'));
    assert.equal(e.seals(), 0);
    // 새 PC가 다시 신청하면 처음부터
    t += PCLINK_RESTART_MS;
    await j.poll();
    await e.host.begin(j.deviceId);
    await j.poll();
    const wrong = j.code === '111111' ? '222222' : '111111';
    for (const left of [2, 1]) assert.deepEqual((await e.host.confirm(j.deviceId, wrong)).requests.map((x) => x.triesLeft), [left]);
    assert.deepEqual(await e.host.confirm(j.deviceId, wrong), { ok: false, requests: [] });
    assert.ok(m.calls.includes('pcLinkDrop'));
    assert.ok(!m.devices.some((d) => d.deviceId === j.deviceId), '신청 기록도 지워진다');
    assert.ok(e.logs.includes('code_tries'));
    assert.equal(e.seals(), 0, '열쇠는 봉인하지 않았다');
    await assert.rejects(j.poll(), { code: 'account.link_not_found' });
    // 형식이 틀린 6자리도 한 번으로 센다(금고·서버에 가지 않는다)
    const j2 = await n.start();
    await e.host.begin(j2.deviceId);
    await j2.poll();
    assert.deepEqual((await e.host.confirm(j2.deviceId, '12345')).requests.map((x) => x.triesLeft), [2]);
  });

  it('새 PC의 응답이 약속과 다르면(키가 중간에 바뀜) 신청을 버린다. 서버가 준 hello의 기기 ID가 다르면 보이지 않는다', async () => {
    const m = mailbox();
    const e = await oldPc(m, () => 1);
    const n = newPc(m, e.session.aikPub, () => 1);
    const j = await n.start();
    // 서버가 수신 키를 자기 키로 바꿨다(약속은 그대로)
    const l = m.links.get(j.deviceId)!;
    l.hello = { ...l.hello, Hx: b64(x25519Keygen().publicKey) };
    await e.host.begin(j.deviceId);
    await j.poll();
    assert.deepEqual(await e.host.list(), []);
    assert.ok(e.logs.includes('commit_mismatch'));
    assert.equal(m.links.size, 0);
    // hello의 기기 ID가 경로와 다른 신청
    const j2 = await n.start();
    const other = pcLinkHello({ deviceId: uuid4(), noisePub: n.keys.noise.publicKey, signPub: n.keys.vd.publicKey, linkPub: x25519Keygen().publicKey }).hello;
    m.links.get(j2.deviceId)!.hello = other;
    assert.deepEqual(await e.host.list(), []);
    await assert.rejects(e.host.begin(j2.deviceId), { code: 'account.link_mismatch' });
  });

  it('목록을 먼저 올리고 그 뒤에 열쇠를 봉인한다. 서버가 목록을 거절하면 봉인하지 않는다. 이미 목록에 있는 PC(열쇠만 못 받은 PC)는 목록을 다시 올리지 않는다', async () => {
    const m = mailbox();
    const e = await oldPc(m, () => 1);
    const n = newPc(m, e.session.aikPub, () => 1);
    const j = await n.start();
    await e.host.begin(j.deviceId);
    await j.poll();
    // 서버가 목록을 거절(한도)
    const put = m.client.putDeviceList;
    m.client.putDeviceList = async () => fail('account.device_limit');
    await assert.rejects(e.host.confirm(j.deviceId, j.code!), { code: 'account.device_limit' });
    assert.equal(e.seals(), 0);
    assert.equal(e.list().entries.length, 1, '이 PC의 목록도 그대로다');
    m.client.putDeviceList = put;
    // 승인 상태는 사라졌다. 새 PC가 다시 신청해 처음부터 한다
    assert.deepEqual(await e.host.list(), []);
    await j.cancel();
    const j2 = await n.start();
    await e.host.begin(j2.deviceId);
    await j2.poll();
    m.calls.length = 0;
    assert.equal((await e.host.confirm(j2.deviceId, j2.code!)).ok, true);
    assert.deepEqual(m.calls.filter((c) => c === 'putDeviceList' || c === 'pcLinkGrant'), ['putDeviceList', 'pcLinkGrant']);
    assert.equal(e.seals(), 1);
    assert.equal(m.serverList()!.entries.length, 2);
    // 새 PC가 열쇠를 받지 못하고 끊겼다(목록에는 있다): 다시 신청하면 목록은 그대로 두고 열쇠만 다시 보낸다
    const j3 = await n.start();
    assert.equal(j3.deviceId, j2.deviceId);
    await e.host.begin(j3.deviceId);
    await j3.poll();
    m.calls.length = 0;
    assert.equal((await e.host.confirm(j3.deviceId, j3.code!)).ok, true);
    assert.deepEqual(m.calls.filter((c) => c === 'putDeviceList' || c === 'pcLinkGrant'), ['pcLinkGrant']);
    await j3.poll();
    await j3.accept();
    assert.deepEqual(n.rk(), e.rk);
    // 목록의 PC가 3대면 이 PC에서 막는다(서버에 가기 전)
    let list = e.list();
    list = await addDevice(e.aik, list, { deviceId: uuid4(), role: 'desktop', noisePub: x25519Keygen().publicKey, signPub: ed25519Keygen().publicKey, registeredAt: 2 });
    e.setList(list);
    const n4 = newPc(m, e.session.aikPub, () => 1);
    m.devices.length = 1; // 서버 쪽 한도는 따로 본다. 여기서는 이 PC의 목록 한도만
    const j4 = await n4.start();
    await e.host.begin(j4.deviceId);
    await j4.poll();
    await assert.rejects(e.host.confirm(j4.deviceId, j4.code!), { code: 'account.device_limit' });
    assert.equal(e.seals(), 2);
  });

  it('금고가 봉인에 실패하면 로그에 멈춘 단계와 원인이 남는다. 목록은 이미 올라갔으니 새 PC가 다시 신청하면 열쇠만 다시 보낸다', async () => {
    const m = mailbox();
    const e = await oldPc(m, () => 1);
    const n = newPc(m, e.session.aikPub, () => 1);
    const j = await n.start();
    await e.host.begin(j.deviceId);
    await j.poll();
    // 금고가 돌려주는 오류는 코드가 없다(2026-11-17: Electron에 없는 암호 이름으로 봉인이 실패했다)
    e.failSeal(new Error('Unknown cipher'));
    m.calls.length = 0;
    await assert.rejects(e.host.confirm(j.deviceId, j.code!), { code: 'account.failed' });
    assert.deepEqual(m.calls.filter((c) => c === 'putDeviceList' || c === 'pcLinkGrant'), ['putDeviceList'], '목록은 올라갔고 열쇠는 보내지 못했다');
    assert.deepEqual(e.records.at(-1), { result: 'account.failed', step: 'seal', cause: 'Unknown_cipher' });
    // 보내는 단계에서 서버가 거절하면 step은 send, 원인은 서버 코드
    e.failSeal(null);
    await j.cancel();
    const j2 = await n.start();
    assert.equal(j2.deviceId, j.deviceId);
    await e.host.begin(j2.deviceId);
    await j2.poll();
    const grant = m.client.pcLinkGrant;
    m.client.pcLinkGrant = async () => fail('account.link_state');
    await assert.rejects(e.host.confirm(j2.deviceId, j2.code!), { code: 'account.link_state' });
    assert.deepEqual(e.records.at(-1), { result: 'account.link_state', step: 'send', cause: 'account.link_state' });
    m.client.pcLinkGrant = grant;
    // 다시 신청하면 목록은 그대로 두고 열쇠만 보낸다
    await j2.cancel();
    const j3 = await n.start();
    await e.host.begin(j3.deviceId);
    await j3.poll();
    m.calls.length = 0;
    assert.equal((await e.host.confirm(j3.deviceId, j3.code!)).ok, true);
    assert.deepEqual(m.calls.filter((c) => c === 'putDeviceList' || c === 'pcLinkGrant'), ['pcLinkGrant']);
    await j3.poll();
    await j3.accept();
    assert.deepEqual(n.rk(), e.rk);
  });
});
