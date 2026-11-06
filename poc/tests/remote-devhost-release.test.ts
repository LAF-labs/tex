// 팀장 지시(2026-11-06, #124): 릴리스 빌드(__DEV__ = false)에서 피싱 QR이 같은 LAN의 *.local(평문 ws)을 릴레이로 주면 3단계에서 거절한다.
// 앱의 개발 스택 판정(apps/mobile/src/devhost.ts, RN 의존 없음)과 @sax/remote의 평문 개발 호스트 스위치를 함께 고정한다.
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { MobilePairing, allowDevLanHosts, checkHtu, devLanHostsAllowed, encodeQr, randomBytes, relayOrigin, relayUrl } from '@sax/remote';
import { RELAY_ALLOWLIST, resolveDevConfig } from '../apps/mobile/src/devhost.ts';
import { mockPhone } from './remote-support.ts';

const qrFor = (relayHost: string) =>
  encodeQr({ intent: 'pair', relayHost, roomId: randomBytes(16), desktopStatic: randomBytes(32), psk: randomBytes(32), exp: Math.floor(Date.now() / 1000) + 120 });

describe('릴리스 설정에서 *.local 릴레이 거절(#124)', () => {
  afterEach(() => allowDevLanHosts(false));

  it('릴리스 설정(__DEV__=false)에서 QR 릴레이 ws://x.local은 거절', () => {
    // 릴리스: 실기기·시뮬레이터 어느 쪽이든, 개발 호스트 값이 박혀 있어도 개발 스택을 쓰지 않는다.
    for (const isDevice of [true, false]) {
      const cfg = resolveDevConfig({ isDev: false, isDevice, envHost: 'evil.local:8787' });
      assert.deepEqual(cfg, { devLocal: false, devStack: false, devRelayHost: 'localhost:8787', allowLan: false, relayAllowlist: RELAY_ALLOWLIST });
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
    assert.deepEqual(cfg, { devLocal: false, devStack: true, devRelayHost: 'mac-mini.local:8787', allowLan: true, relayAllowlist: [...RELAY_ALLOWLIST, 'mac-mini.local:8787'] });
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
