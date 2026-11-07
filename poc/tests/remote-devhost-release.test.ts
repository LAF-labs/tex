// 팀장 지시(2026-11-06, #124): 릴리스 빌드(__DEV__ = false)에서 피싱 QR이 같은 LAN의 *.local(평문 ws)을 릴레이로 주면 3단계에서 거절한다.
// 앱의 개발 스택 판정(apps/mobile/src/devhost.ts, RN 의존 없음)과 @sax/remote의 평문 개발 호스트 스위치를 함께 고정한다.
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { MobilePairing, allowDevLanHosts, b64, checkHtu, devLanHostsAllowed, encodeQr, fromB64, randomBytes, relayOrigin, relayUrl, signAcctClaim, verifyAcctClaim } from '@sax/remote';
import { DEV_ACCOUNT_KEY, RELAY_ALLOWLIST, RELEASE_ACCOUNT_KEYS, resolveDevConfig } from '../apps/mobile/src/devhost.ts';
import { ACCOUNT_KEY, mockPhone, pairOnce, pairWorld, testAcctClaim } from './remote-support.ts';

/** 운영 계정 서비스 acct_claim 공개키(2026-11-06 회전, 팀장 전달). 바이너리 고정 값이 이것과 같아야 한다. */
const PROD_ACCT_CLAIM_PUB = 'm505XiZjib3UhZGHVJKoS7FZ3FdVOJ0aS/XFpN4zPYQ=';
/** dev/test-account-key.ts의 시험 시드(공개된 시험 키). 개발 스택만 이 키로 서명한다. */
const DEV_TEST_SEED = Uint8Array.from(Buffer.from('372cad9361b4e90ef21b02dd9191bc93b1149bc015d73f783203f8a4806fa1ee', 'hex'));

const qrFor = (relayHost: string) =>
  encodeQr({ intent: 'pair', relayHost, roomId: randomBytes(16), desktopStatic: randomBytes(32), psk: randomBytes(32), exp: Math.floor(Date.now() / 1000) + 120 });

describe('릴리스 설정에서 *.local 릴레이 거절(#124)', () => {
  afterEach(() => allowDevLanHosts(false));

  it('릴리스 설정(__DEV__=false)에서 QR 릴레이 ws://x.local은 거절', () => {
    // 릴리스: 실기기·시뮬레이터 어느 쪽이든, 개발 호스트 값이 박혀 있어도 개발 스택을 쓰지 않는다.
    for (const isDevice of [true, false]) {
      const cfg = resolveDevConfig({ isDev: false, isDevice, envHost: 'evil.local:8787' });
      assert.deepEqual(cfg, { devLocal: false, devStack: false, devRelayHost: 'localhost:8787', allowLan: false, relayAllowlist: RELAY_ALLOWLIST, accountKeys: RELEASE_ACCOUNT_KEYS });
      allowDevLanHosts(cfg.allowLan);
      for (const host of ['x.local:8787', 'evil.local:8787', 'localhost:8787']) {
        const m = new MobilePairing({ keys: mockPhone().keys, accountKeys: [], relayAllowlist: cfg.relayAllowlist });
        assert.equal(m.scan(qrFor(host)), false, host);
        assert.equal(m.failure, 'relay_not_allowed', host);
      }
      // 허용 목록을 우회해도 평문 ws·http는 *.local에 열리지 않는다(스위치가 꺼져 있다).
      assert.equal(devLanHostsAllowed(), false);
      assert.throws(() => relayUrl('x.local:8787', '/v1/rooms/x', true), /insecure only/);
      assert.throws(() => relayOrigin('x.local:8787', true), /insecure only/);
      assert.throws(() => checkHtu('http://x.local:8787/v1/device-tokens'), /bad htu/);
    }
  });

  it('시뮬레이터 개발 빌드: localhost만, mDNS 평문은 꺼짐', () => {
    const cfg = resolveDevConfig({ isDev: true, isDevice: false, envHost: 'mac.local:8787' });
    assert.equal(cfg.devLocal, true);
    assert.equal(cfg.allowLan, false);
    assert.deepEqual(cfg.relayAllowlist, [...RELAY_ALLOWLIST, 'localhost:8787']);
  });

  it('실기기 개발 빌드: 소문자 <이름>.local:포트만 개발 호스트, 그때만 mDNS 평문을 켠다', () => {
    const cfg = resolveDevConfig({ isDev: true, isDevice: true, envHost: 'mac-mini.local:8787' });
    assert.deepEqual(cfg, {
      devLocal: false, devStack: true, devRelayHost: 'mac-mini.local:8787', allowLan: true, relayAllowlist: [...RELAY_ALLOWLIST, 'mac-mini.local:8787'], accountKeys: [DEV_ACCOUNT_KEY],
    });
    allowDevLanHosts(cfg.allowLan);
    assert.equal(relayOrigin('mac-mini.local:8787', true), 'http://mac-mini.local:8787');
    assert.equal(checkHtu('http://mac-mini.local:8787/v1/x'), 'http://mac-mini.local:8787/v1/x');
    // 다른 .local 이름은 허용 목록에서 막힌다(평문 스위치와 별개).
    const m = new MobilePairing({ keys: mockPhone().keys, accountKeys: [], relayAllowlist: cfg.relayAllowlist });
    assert.equal(m.scan(qrFor('evil.local:8787')), false);
    assert.equal(m.failure, 'relay_not_allowed');
    for (const envHost of [undefined, '192.168.0.4:8787', 'evil.example:8787', 'Mac.local:8787', 'a.b.local:8787', 'mac.local']) {
      const c = resolveDevConfig({ isDev: true, isDevice: true, envHost });
      assert.equal(c.devStack, false, String(envHost));
      assert.equal(c.allowLan, false, String(envHost));
      assert.deepEqual(c.relayAllowlist, RELAY_ALLOWLIST, String(envHost));
    }
  });
});

describe('릴리스 빌드의 acct_claim 고정 키(2026-11-06 회전)', () => {
  const release = resolveDevConfig({ isDev: false, isDevice: true, envHost: undefined });
  const keys = () => release.accountKeys.map((k) => fromB64(k));

  it('릴리스 키는 운영 공개키 하나뿐이고 시험 키는 섞이지 않는다', () => {
    assert.deepEqual(release.accountKeys, [PROD_ACCT_CLAIM_PUB]);
    assert.ok(!release.accountKeys.includes(DEV_ACCOUNT_KEY));
    const k = fromB64(PROD_ACCT_CLAIM_PUB);
    assert.equal(k.length, 32);
    assert.equal(b64(k), PROD_ACCT_CLAIM_PUB, '표준 base64 정규형');
    // 개발 빌드(시뮬레이터·실기기 개발)는 시험 키만
    for (const isDevice of [false, true]) {
      const d = resolveDevConfig({ isDev: true, isDevice, envHost: isDevice ? 'mac.local:8787' : undefined });
      assert.deepEqual(d.accountKeys, [DEV_ACCOUNT_KEY]);
    }
  });

  it('릴리스 키로 검증하면 시험 키·임의 키가 서명한 acct_claim은 서명 불일치로 거절', () => {
    const aik = randomBytes(32);
    const now = Date.now();
    const devSigned = signAcctClaim(DEV_TEST_SEED, { account_id: 'acc_dev', email: 'owner@example.test', aik_pub: b64(aik), iat: now, exp: now + 600_000 });
    // 같은 클레임이 시험 키로는 통과한다(서명 자체는 맞다)
    assert.equal(verifyAcctClaim(devSigned, { accountKeys: [fromB64(DEV_ACCOUNT_KEY)], aikPub: aik }).ok, true);
    assert.deepEqual(verifyAcctClaim(devSigned, { accountKeys: keys(), aikPub: aik }), { ok: false, reason: 'signature' });
    assert.deepEqual(verifyAcctClaim(testAcctClaim(aik), { accountKeys: keys(), aikPub: aik }), { ok: false, reason: 'signature' });
  });

  it('릴리스 키를 넣은 폰은 운영 키로 서명되지 않은 PAIR_OK를 저장하지 않는다', async () => {
    const w = await pairWorld({ accountKeys: keys() });
    await assert.rejects(() => pairOnce(w));
    assert.equal(w.mob.failure, 'acct_claim_invalid');
    // 같은 페어링이 클레임 서명 키를 고정 목록에 넣은 폰에서는 통과한다(키 목록만 다르다)
    const ok = await pairWorld({ accountKeys: [...keys(), ACCOUNT_KEY.publicKey] });
    const { phone } = await pairOnce(ok);
    assert.equal(phone.identity.account.email, 'owner@example.test');
  });
});
