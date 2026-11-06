// 제품 배선(remote-wiring.ts): 실제 클라우드 포트(cloudPorts → @sax/net Egress cloudDevLocal)로 개발 스택(실제 계정·릴레이 서비스)에 붙어
// 로그인·첫 PC 등록 → 폰 연결(룸·QR 이미지·WS·6자리·대리 등록·목록·우편함·acct_claim)까지. 금고 키만 소프트 키로 바꾼다(키체인 없음).
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fromB64, MobilePairing, wsRelayClient, type MobilePairResult, type WebSocketLike } from '@sax/remote';
import { DesktopAccount, RemoteIdentityFile } from '../apps/desktop/src/remote-account.ts';
import { vaultDesktopKeys } from '../apps/desktop/src/remote-keys.ts';
import { PairingHost } from '../apps/desktop/src/remote-pairing.ts';
import { qrSvgDataUrl } from '../apps/desktop/src/remote-qr.ts';
import { cloudTarget, productRemote } from '../apps/desktop/src/remote-wiring.ts';
import { startCloudStack, type CloudStack } from './remote-cloud-stack.ts';
import { softDesktopKeys } from './remote-dev-stack.ts';
import { decodeQrDataUrl } from './remote-qr-decode.ts';
import { mockPhone, until } from './remote-support.ts';

const EMAIL = 'owner@gyeonbon-test.example';

describe('제품 배선: 어느 클라우드에 붙는가', () => {
  it('기본은 운영(tax.laf-co.com). 금고 키는 vaultDesktopKeys', () => {
    assert.deepEqual(cloudTarget({ isPackaged: false, env: {} }), { env: 'prod' });
    const r = productRemote({ isPackaged: true, env: {} });
    assert.equal(r.keys, vaultDesktopKeys);
    assert.equal(r.cloud?.relayHost, 'rooms.tax.laf-co.com');
    assert.equal(r.cloud?.insecureLocal, false);
  });
  it('설치본은 SAX_CLOUD_DEV를 무시하고 운영으로 간다', () => {
    assert.deepEqual(cloudTarget({ isPackaged: true, env: { SAX_CLOUD_DEV: 'localhost:8787' } }), { env: 'prod' });
    assert.equal(productRemote({ isPackaged: true, env: { SAX_CLOUD_DEV: 'localhost:8787' } }).cloud?.relayHost, 'rooms.tax.laf-co.com');
  });
  it('개발 실행 + SAX_CLOUD_DEV=localhost:<port>만 개발 스택, 그 밖의 값은 연결하지 않는다', () => {
    assert.deepEqual(cloudTarget({ isPackaged: false, env: { SAX_CLOUD_DEV: 'localhost:8787' } }), { env: 'dev', host: 'localhost:8787' });
    assert.equal(productRemote({ isPackaged: false, env: { SAX_CLOUD_DEV: '127.0.0.1:8787' } }).cloud?.insecureLocal, true);
    for (const bad of ['evil.example:8787', 'http://localhost:8787', 'localhost', '10.0.0.2:8787']) {
      assert.equal(cloudTarget({ isPackaged: false, env: { SAX_CLOUD_DEV: bad } }), null, bad);
      assert.equal(productRemote({ isPackaged: false, env: { SAX_CLOUD_DEV: bad } }).cloud, null, bad);
    }
  });
});

describe('제품 배선 + 개발 스택: 로그인 → 폰 연결 → pair.ok acctClaim', () => {
  let stack: CloudStack;
  let dir: string;
  before(async () => {
    stack = await startCloudStack();
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sax-wiring-'));
  });
  after(async () => {
    await stack.close();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('실제 포트로 끝까지: 폰이 계정 서비스 서명 acctClaim을 검증하고 계정 이메일을 본다', async () => {
    const remote = productRemote({ isPackaged: false, env: { SAX_CLOUD_DEV: stack.host } });
    const cloud = remote.cloud!;
    const keys = softDesktopKeys();
    const acct = new DesktopAccount({ client: cloud.account, keys: async () => keys, identity: new RemoteIdentityFile(dir), platform: 'macos', deviceName: 'Mac PC' });
    await acct.init();
    assert.equal((await acct.sendCode(EMAIL)).step, 'code_sent');
    const v = await acct.verify(stack.mail.lastCode(EMAIL)!);
    assert.equal(v.step, 'signed_in', JSON.stringify(v));

    let qr: string | null = null;
    const host = new PairingHost({
      account: cloud.account,
      relayHttp: cloud.relay,
      relay: wsRelayClient({ host: cloud.relayHost, open: cloud.openSocket, insecureLocal: cloud.insecureLocal }),
      relayHost: cloud.relayHost,
      device: acct.device()!,
      keys: async () => keys,
      qr: (t) => (qr = qrSvgDataUrl(t)),
      desktopName: 'Mac PC',
      closeAfterMs: 50,
    });
    const w = await host.start();
    assert.equal(w.step, 'waiting_phone', JSON.stringify(w));
    const text = decodeQrDataUrl(qr!);
    assert.ok(text);

    const phone = mockPhone('사장님 폰');
    const mob = new MobilePairing({ keys: phone.keys, accountKeys: [fromB64(stack.claimPub)], relayAllowlist: [stack.host], pairOkTimeoutMs: 10_000 });
    assert.ok(mob.scan(text), `scan: ${mob.failure}`);
    const phoneRelay = wsRelayClient({ host: stack.host, insecureLocal: true, open: (url) => new WebSocket(url) as unknown as WebSocketLike });
    const run = mob.run(await phoneRelay.joinRoom(mob.roomId, 'mobile'));
    await until(() => host.view().step === 'awaiting_sas', 10_000);
    const ok = await host.submitSas(mob.sas!);
    assert.equal(ok.step, 'paired', JSON.stringify(ok));
    const m = (await run) as MobilePairResult | null;
    assert.ok(m, `phone: ${mob.failure}`);
    assert.equal(m.identity.account.email, EMAIL);
    assert.equal(acct.device()!.deviceList.entries.length, 2, 'PC + 폰');
    assert.equal(acct.view().phones, 1);
  });
});
