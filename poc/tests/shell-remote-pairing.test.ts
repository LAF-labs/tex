// 폰 연결 main 쪽(remote-pairing.ts, S-03, D08 §4.2): 실제 계정 서비스(개발 스택, acct-claim 서명) + 메모리 릴레이 + 실제 MobilePairing(폰).
// 폰은 앱에 고정한 계정 서비스 키로 pair.ok의 acctClaim을 검증한다(팀장 결정 2026-11-06, 설계 #120).
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { b64url, fromB64, MemoryRelay, MobilePairing, sha256Hash, toHex, type DesktopPairResult, type MobilePairResult } from '@sax/remote';
import { DesktopAccount, RemoteIdentityFile } from '../apps/desktop/src/remote-account.ts';
import { PairingHost, type PairView } from '../apps/desktop/src/remote-pairing.ts';
import type { RelayHttpClient } from '../apps/desktop/src/remote-ports.ts';
import { qrSvgDataUrl } from '../apps/desktop/src/remote-qr.ts';
import { softDesktopKeys, startDevStack, type DevStack } from './remote-dev-stack.ts';
import { decodeQrDataUrl } from './remote-qr-decode.ts';
import { mockPhone, until } from './remote-support.ts';

const EMAIL = 'owner@gyeonbon-test.example';
const RELAY_HOST = 'relay.sax.test';

describe('폰 연결: 룸 → QR → 6자리 → 대리 등록·목록·우편함·acctClaim → pair.ok', () => {
  let root: string;
  let s: DevStack;
  let relay: MemoryRelay;
  let relayCalls: string[];
  let logs: Array<[string, Record<string, string | number>]>;
  let views: PairView[];
  let qrText: string | null;
  let paired: DesktopPairResult[];

  const relayHttp = (): RelayHttpClient => ({
    createRoom: async (auth, roomId) => {
      relayCalls.push('room');
      await auth('POST', 'https://relay.test.invalid/v1/rooms');
      const id = (await s.svc.deviceList((await s.svc.verifyEmailCode((await s.svc.startEmailCode(EMAIL)).loginId, s.mail.lastCode(EMAIL)!)).accountId)) as { deviceList: { entries: Array<{ entry: { device_id: string; role: string } }> } };
      s.rooms.open(b64url(roomId), id.deviceList.entries.find((e) => e.entry.role === 'desktop')!.entry.device_id);
      return { expiresAt: s.clock.now() + 120_000 };
    },
    registerMailbox: async (_a, id, r, w) => {
      relayCalls.push('mailbox');
      relay.registerMailbox(id, toHex(sha256Hash(r)), toHex(sha256Hash(w)));
    },
    deleteMailbox: async () => void relayCalls.push('mailbox_delete'),
  });

  const setup = async () => {
    const dir = await fsp.mkdtemp(path.join(root, 'u-'));
    const keys = softDesktopKeys();
    const acct = new DesktopAccount({ client: s.client, keys: async () => keys, identity: new RemoteIdentityFile(dir), platform: 'windows', deviceName: 'Windows PC', now: s.clock.now });
    await acct.init();
    await acct.sendCode(EMAIL);
    assert.equal((await acct.verify(s.mail.lastCode(EMAIL)!)).step, 'signed_in');
    const host = new PairingHost({
      account: s.client,
      relayHttp: relayHttp(),
      relay,
      relayHost: RELAY_HOST,
      device: acct.device()!,
      keys: async () => keys,
      qr: (t) => ((qrText = t), qrSvgDataUrl(t)),
      desktopName: 'Windows PC',
      now: s.clock.now,
      log: (n, d) => logs.push([n, d]),
      onView: (v) => views.push(v),
      onPaired: (r) => paired.push(r),
      closeAfterMs: 50,
    });
    return { acct, host, keys, dir };
  };
  /** 폰은 화면의 QR 이미지를 읽는다(jsQR로 다시 읽은 글자). */
  const phoneScan = async (accountKeys = [fromB64(s.claimSigner.publicKey)]) => {
    const phone = mockPhone('사장님 폰');
    const mob = new MobilePairing({ keys: phone.keys, accountKeys, relayAllowlist: [RELAY_HOST], now: s.clock.now, pairOkTimeoutMs: 5_000 });
    const shown = decodeQrDataUrl(views.findLast((v) => v.qr)!.qr!);
    assert.equal(shown, qrText, 'QR 이미지를 다시 읽으면 원문과 같다');
    assert.ok(mob.scan(shown!), `scan: ${mob.failure}`);
    const run = mob.run(await relay.joinRoom(mob.roomId, 'mobile'));
    return { phone, mob, run };
  };

  before(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sax-remote-pair-'));
  });
  after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });
  beforeEach(async () => {
    s = await startDevStack();
    relay = new MemoryRelay();
    relay.tokenHash = (t) => toHex(sha256Hash(t));
    relayCalls = [];
    logs = [];
    views = [];
    qrText = null;
    paired = [];
  });
  afterEach(() => s.close());

  it('정상: 폰이 계정 서비스 서명 acctClaim을 검증하고 저장 전 확인 화면에 계정 이메일, 서버 목록에 폰', async () => {
    const { host, acct, dir } = await setup();
    const v = await host.start();
    assert.equal(v.step, 'waiting_phone');
    assert.ok(v.qr!.startsWith('data:image/svg+xml;base64,'));
    assert.ok(!JSON.stringify(views).includes(qrText!), 'QR 글자(psk)는 화면 값에 없다');
    const { mob, run } = await phoneScan();
    await until(() => host.view().step === 'awaiting_sas', 5_000);
    assert.equal(host.view().phoneName, '사장님 폰');
    assert.equal(host.view().triesLeft, 3);
    const wrong = await host.submitSas(mob.sas === '000000' ? '111111' : '000000');
    assert.deepEqual([wrong.step, wrong.triesLeft, wrong.error], ['awaiting_sas', 2, 'pair.sas_wrong']);
    assert.equal((await host.submitSas('12a456')).error, 'pair.sas_shape');
    const ok = await host.submitSas(mob.sas!);
    assert.equal(ok.step, 'paired', JSON.stringify(ok));
    const m = (await run) as MobilePairResult;
    assert.ok(m, `phone: ${mob.failure}`);
    assert.equal(m.identity.account.email, EMAIL, '폰 저장 전 확인 화면: 서버가 서명한 계정 이메일');
    assert.equal(m.identity.desktopName, 'Windows PC');
    assert.deepEqual(relayCalls, ['room', 'mailbox']);
    assert.equal(paired.length, 1);
    // 서버(계정)와 신원 파일에 같은 새 목록(PC + 폰)
    const after = await new RemoteIdentityFile(dir).load(s.clock.now());
    assert.equal(after!.deviceList.entries.length, 2);
    assert.deepEqual(acct.device()!.deviceList, after!.deviceList);
    assert.ok(s.client.calls.includes('POST /v1/devices/enroll') && s.client.calls.includes('PUT /v1/device-list') && s.client.calls.includes('GET /v1/acct-claim'));
    const t = JSON.stringify(logs);
    for (const bad of ['사장님', mob.sas!, EMAIL]) assert.ok(!t.includes(bad), bad);
  });

  it('6자리를 3번 틀리면 끝(pair.sas_locked), 우편함을 만들지 않는다', async () => {
    const { host } = await setup();
    await host.start();
    const { mob, run } = await phoneScan();
    await until(() => host.view().step === 'awaiting_sas', 5_000);
    const bad = mob.sas === '000000' ? '111111' : '000000';
    await host.submitSas(bad);
    await host.submitSas(bad);
    const v = await host.submitSas(bad);
    assert.deepEqual([v.step, v.error], ['failed', 'pair.sas_locked']);
    assert.ok(!relayCalls.includes('mailbox'));
    assert.equal(await run, null);
  });

  it('우편함을 만든 뒤 acctClaim이 실패하면 우편함을 지우고 그 코드로 끝난다(폰은 저장하지 않는다)', async () => {
    const { host } = await setup();
    s.client.acctClaim = async () => {
      throw Object.assign(new Error('x'), { code: 'request.not_found' });
    };
    await host.start();
    const { mob, run } = await phoneScan();
    await until(() => host.view().step === 'awaiting_sas', 5_000);
    const v = await host.submitSas(mob.sas!);
    assert.deepEqual([v.step, v.error], ['failed', 'request.not_found']);
    await until(() => relayCalls.includes('mailbox_delete'));
    assert.deepEqual(relayCalls, ['room', 'mailbox', 'mailbox_delete']);
    assert.equal(paired.length, 0);
    void run;
  });

  it('폰이 계정 서비스 키를 모르면(다른 서버의 주장) 폰이 거절한다', async () => {
    const { host } = await setup();
    await host.start();
    const { mob, run } = await phoneScan([new Uint8Array(32).fill(1)]);
    await until(() => host.view().step === 'awaiting_sas', 5_000);
    await host.submitSas(mob.sas!);
    assert.equal(await run, null);
    assert.equal(mob.failure, 'acct_claim_invalid');
  });

  it('QR 시간이 지나면 pair.expired, 취소하면 처음으로', async () => {
    const { host } = await setup();
    await host.start();
    const { mob } = await phoneScan();
    await until(() => host.view().step === 'awaiting_sas', 5_000);
    s.clock.advance(121_000);
    const v = await host.submitSas(mob.sas!);
    assert.deepEqual([v.step, v.error], ['failed', 'pair.expired']);
    assert.equal((await host.start()).step, 'waiting_phone', '다시 하기는 새 룸');
    assert.equal(host.cancel().step, 'idle');
  });

  it('룸을 열지 못하면(서버 코드 그대로) 실패 화면', async () => {
    const { acct, keys } = await setup();
    const h = new PairingHost({
      account: s.client,
      relayHttp: { ...relayHttp(), createRoom: async () => Promise.reject(Object.assign(new Error('x'), { code: 'policy.rate_limited' })) },
      relay,
      relayHost: RELAY_HOST,
      device: acct.device()!,
      keys: async () => keys,
      qr: () => '',
      now: s.clock.now,
    });
    const v = await h.start();
    assert.deepEqual([v.step, v.error], ['failed', 'policy.rate_limited']);
  });
});
