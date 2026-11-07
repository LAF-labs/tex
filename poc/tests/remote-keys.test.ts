// 데스크톱 DesktopKeys ↔ 금고 crypto.*(apps/desktop/src/remote-keys.ts vaultDesktopKeys, remote-ports.ts VaultKeysFactory, D05 §5.1·D08 §4.2·§6).
// 실제 금고 서비스의 control 포트(main이 쥔 포트)로 붙여, @sax/remote의 받는 쪽 검증기가 금고 키로 만든 결과를 받는지 본다.
// 개인키는 금고 안에만 있다: 어댑터는 rpc만 부르고, 용도 허용 목록 밖·형식이 틀린 결과는 거부한다.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { MessageChannel } from 'node:worker_threads';
import { vaultDesktopKeys, VaultKeysError } from '../apps/desktop/src/remote-keys.ts';
import { VaultClient } from '@sax/engine';
import { appPaths, FileEventLog, wrapPort } from '@sax/platform';
import {
  CTX, deviceAuthHeaders, ed25519Keygen, initialDeviceList, issueCert, makeCashEntry, makeQBundle, openXfer, qbundleWindow, sealXfer, softSigner,
  ulid, verifyCert, verifyDeviceList, verifyQBundle, VM_PURPOSES, x25519Dh, x25519Public, type Xfer,
} from '@sax/remote';
import { MemoryKeyStore, Vault } from '@sax/vault';

async function vault() {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'sax-remote-keys-'));
  const log = new FileEventLog(null, 'vault');
  const v = new Vault({ paths: appPaths(root), log, keyStore: new MemoryKeyStore() });
  const ctl = new MessageChannel();
  const eng = new MessageChannel();
  v.attachPort('control', wrapPort(ctl.port1, 'node'));
  v.attachPort('engine', wrapPort(eng.port1, 'node'));
  const control = new VaultClient(wrapPort(ctl.port2, 'node'));
  const engine = new VaultClient(wrapPort(eng.port2, 'node'));
  const calls: string[] = [];
  const rpc = (m: string, p?: Record<string, unknown>) => (calls.push(m), control.rpc(m, p));
  return {
    rpc, engine, log, calls,
    async close() {
      await v.shutdown();
      for (const c of [ctl, eng]) {
        c.port1.close();
        c.port2.close();
      }
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

const NOW = Date.now();

describe('vaultDesktopKeys(금고 control 포트)', () => {
  it('공개키는 crypto.publicKeys 한 번, control 포트 값과 같다(엔진 포트는 crypto.*를 거부한다)', async () => {
    const v = await vault();
    try {
      const k = await vaultDesktopKeys(v.rpc);
      assert.deepEqual(v.calls, ['crypto.publicKeys']);
      await assert.rejects(v.engine.rpc('crypto.publicKeys'), /vault: denied/);
      const pk = (await v.rpc('crypto.publicKeys')) as Record<string, Uint8Array>;
      assert.deepEqual(k.noise.publicKey, pk.noiseStatic);
      assert.deepEqual(k.vd.publicKey, pk.vd);
      assert.deepEqual(k.aik.publicKey, pk.aik);
      assert.deepEqual(k.kvPublic(), pk.kv);
      assert.deepEqual(k.qdPublic, pk.qd);
      // kvPublic은 사본(바꿔도 다음 값이 그대로)
      k.kvPublic().fill(0);
      assert.deepEqual(k.kvPublic(), pk.kv);
    } finally {
      await v.close();
    }
  });

  it('AIK: 첫 기기 목록·인증서를 금고 AIK로 만들고 @sax/remote가 금고 공개키로 검증한다', async () => {
    const v = await vault();
    try {
      const k = await vaultDesktopKeys(v.rpc);
      const list = await initialDeviceList(k.aik, { deviceId: '0b6a3f7e-2c1d-4e5f-9a8b-7c6d5e4f3a2b', role: 'desktop', noisePub: k.noise.publicKey, signPub: k.vd.publicKey, registeredAt: NOW });
      assert.equal(verifyDeviceList(list, k.aik.publicKey).ok, true);
      assert.equal(verifyDeviceList(list, k.vd.publicKey).ok, false);
      const cert = await issueCert(k.aik, { device_id: '0b6a3f7e-2c1d-4e5f-9a8b-7c6d5e4f3a2b', role: 'desktop', Sx: k.noise.publicKey, Vx: k.vd.publicKey, Kx: k.kvPublic(), not_after: NOW + 86_400_000 });
      assert.ok(verifyCert(cert, k.aik.publicKey, NOW));
      assert.ok(v.calls.filter((c) => c === 'crypto.signAik').length >= 2);
    } finally {
      await v.close();
    }
  });

  it('Vd: DPoP 헤더(SAX-dpop-v1)와 우편함 번들(SAX-qbundle-v1, Qx = 금고 Q_D)', async () => {
    const v = await vault();
    try {
      const k = await vaultDesktopKeys(v.rpc);
      const h = await deviceAuthHeaders('sxd1.TEST-TOKEN', k.vd, 'POST', 'https://account.tex.laf-co.com/v1/device-list', NOW);
      assert.equal(h.Authorization, 'DPoP sxd1.TEST-TOKEN');
      assert.ok(h.DPoP);
      const field = await makeQBundle(k.vd, { Qx: k.qdPublic, ...qbundleWindow(NOW), seq: 1 });
      const qb = verifyQBundle(field, k.vd.publicKey, { now: NOW });
      assert.deepEqual(qb?.Qx, k.qdPublic);
    } finally {
      await v.close();
    }
  });

  it('Noise DH: 금고 Sd × 상대 = 상대 × Sd(두 문맥), 결과를 보관하지 않는다', async () => {
    const v = await vault();
    try {
      const k = await vaultDesktopKeys(v.rpc);
      const peerSk = new Uint8Array(randomBytes(32));
      const peerPub = x25519Public(peerSk);
      for (const ctx of [CTX.pair, CTX.session] as const) assert.deepEqual(await k.noise.dh(peerPub, ctx), x25519Dh(peerSk, k.noise.publicKey));
      assert.equal(Object.keys(k).includes('shared'), false);
    } finally {
      await v.close();
    }
  });

  it('HPKE: 폰이 Q_D로 봉인한 큐 봉투를 금고가 연다(@sax/remote sealXfer → openXfer)', async () => {
    const v = await vault();
    try {
      const k = await vaultDesktopKeys(v.rpc);
      const vm = softSigner(ed25519Keygen().secretKey, VM_PURPOSES);
      const iat = Math.floor(NOW / 1000);
      const pairId = ulid(NOW);
      const x: Xfer = { pair_id: pairId, from: 'mobile', to: 'desktop', seq: 1, iat, exp: iat + 3600, qbundle_seq: 1, type: 'cash.entry', body: makeCashEntry('2026-11-06', 12000, NOW) };
      const outer = await sealXfer(x, vm, k.qdPublic, 3);
      const opened = await openXfer(outer, { hpkeOpen: k.hpkeOpen, pairId, phoneVm: vm.publicKey, mbxEpoch: 3, now: NOW });
      assert.deepEqual(opened, x);
      // 다른 우편함 세대(aad)·다른 기기 Vm은 열리지 않는다
      assert.equal(await openXfer(outer, { hpkeOpen: k.hpkeOpen, pairId, phoneVm: vm.publicKey, mbxEpoch: 4, now: NOW }), null);
      assert.ok(v.calls.includes('crypto.hpkeOpen'));
    } finally {
      await v.close();
    }
  });

  it('용도 허용 목록 밖은 금고에 보내기 전에 거부, 형식이 틀린 입력·64KiB 초과도 거부', async () => {
    const v = await vault();
    try {
      const k = await vaultDesktopKeys(v.rpc);
      v.calls.length = 0;
      await assert.rejects(k.vd.sign('SAX-devlist-v1' as never, new Uint8Array(1)), /purpose_not_allowed/);
      await assert.rejects(k.aik.sign('SAX-dpop-v1' as never, new Uint8Array(1)), /purpose_not_allowed/);
      await assert.rejects(k.aik.sign('SAX-token-v1' as never, new Uint8Array(1)), /purpose_not_allowed/);
      await assert.rejects(k.vd.sign(CTX.dpop, new Uint8Array(65_537)), /bad_params/);
      await assert.rejects(k.vd.sign(CTX.dpop, 'x' as never), /bad_params/);
      await assert.rejects(k.noise.dh(new Uint8Array(31), CTX.pair), /bad_params/);
      await assert.rejects(k.noise.dh(new Uint8Array(32), 'SAX-other-v1' as never), /bad_params/);
      await assert.rejects(k.hpkeOpen({ enc: new Uint8Array(32), ct: new Uint8Array(32), info: new TextEncoder().encode('SAX-other-v1'), aad: new Uint8Array(0) }), /bad_params/);
      assert.deepEqual(v.calls, [], '금고에 닿지 않았다');
      // 금고 규칙도 그대로(낮은 차수 점)
      await assert.rejects(k.noise.dh(new Uint8Array(32), CTX.pair), /bad_point/);
    } finally {
      await v.close();
    }
  });

  it('금고가 엉뚱한 모양을 돌려주면 거부(fail-closed)', async () => {
    const good = { noiseStatic: new Uint8Array(32), vd: new Uint8Array(32), qd: new Uint8Array(32), kv: new Uint8Array(32), aik: new Uint8Array(32) };
    await assert.rejects(vaultDesktopKeys(async () => null), VaultKeysError);
    await assert.rejects(vaultDesktopKeys(async () => ({ ...good, aik: new Uint8Array(31) })), /bad_result/);
    await assert.rejects(vaultDesktopKeys(async () => ({ ...good, vd: 'x' })), /bad_result/);
    let reply: unknown = { sig: new Uint8Array(63) };
    const k = await vaultDesktopKeys(async (m) => (m === 'crypto.publicKeys' ? good : reply));
    await assert.rejects(k.vd.sign(CTX.dpop, new Uint8Array(1)), /bad_result/);
    reply = { signature: new Uint8Array(64) };
    await assert.rejects(k.aik.sign(CTX.devlist, new Uint8Array(1)), /bad_result/);
    reply = { shared: new Uint8Array(16) };
    await assert.rejects(k.noise.dh(new Uint8Array(32).fill(9), CTX.pair), /bad_result/);
    reply = { pt: 'plain' };
    await assert.rejects(k.hpkeOpen({ enc: new Uint8Array(32), ct: new Uint8Array(32), info: new TextEncoder().encode('SAX-env-v1'), aad: new Uint8Array(0) }), /bad_result/);
    reply = { sig: new Uint8Array(64) };
    assert.equal((await k.vd.sign(CTX.dpop, new Uint8Array(1))).length, 64);
  });

  it('어댑터 소스: 금고 control rpc만 부른다(키 바이트·전역 fetch·파일 없음)', async () => {
    const src = await fs.readFile(path.resolve(import.meta.dirname, '../apps/desktop/src/remote-keys.ts'), 'utf8');
    const methods = [...src.matchAll(/control\('([a-zA-Z.]+)'/g)].map((m) => m[1]).sort();
    assert.deepEqual([...new Set(methods)], ['crypto.hpkeOpen', 'crypto.noiseDH', 'crypto.publicKeys', 'crypto.signAik', 'crypto.signVd']);
    assert.doesNotMatch(src, /\bfetch\(|node:fs|writeFile|secretKey|privateKey/);
    assert.match(src, /vaultDesktopKeys satisfies VaultKeysFactory/);
  });
});
