// 금고 장기 키 연산(D05 §5.1, D08 §2.1·§3, schemas/SIGNING.md §8): signVd·signAik(purpose‖msg), noiseDH, HPKE 개봉,
// 키 보관·감사, 그리고 받는 쪽(서버·폰) 방식으로 검증되는지(DPoP·기기 목록·인증서·Kv 배포).
import assert from 'node:assert/strict';
import { createCipheriv, createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, verify as edVerify } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { MessageChannel } from 'node:worker_threads';
import { VaultClient } from '@sax/engine';
import { appPaths, FileEventLog, wrapPort } from '@sax/platform';
import {
  AIK_PURPOSES as REMOTE_AIK, checkPcLinkGrant, CTX, deriveShareKey, deriveShareSignSeed, deviceAuthHeaders, ed25519Public, initialDeviceList, issueCert, newShareRowId, openShareRow, PcLinkApprover,
  pcLinkHello, pcLinkReveal, sealShareRow, SHARE_MAX_EPOCH, SHARE_PAD_BUCKETS, SHARE_SIGN_INFO as REMOTE_SHARE_SIGN_INFO, shareKeyInfo, signKv, VD_PURPOSES as REMOTE_VD,
  verifyCert, verifyDeviceList, verifyKv, type AikSigner, type ShareRowCore, type VdSigner,
} from '@sax/remote';
import {
  AIK_PURPOSES, aikSeedFromRk, CRYPTO_KEY_ITEMS, CRYPTO_RATE_PER_HOUR, ed25519FromSeed, hpkeOpenBase, hpkeSealBase, MemoryKeyStore, RK_LINK_INFO, RK_PREV_ITEM, RK_SEALS_PER_DAY, RPC_BY_PORT, rpcErrorCode,
  SHARE_EPOCH_MAX, SHARE_KEY_INFO_PREFIX, SHARE_SIGN_CONTEXT, SHARE_SIGN_INFO, SHARE_SIGN_MSG_MAX, Vault, VaultCrypto, VD_PURPOSES, x25519FromSeed, type KeyStore, type VaultPublicKeys,
} from '@sax/vault';
import { certSigOk, entrySigOk, opSigOk, revokeSigOk, type AcctOp } from '../services/account/src/index.ts';
import { athOf, jcs, JtiCache, verifyDpop } from '../services/shared/src/index.ts';

const hex = (s: string) => new Uint8Array(Buffer.from(s.replace(/\s+/g, ''), 'hex'));
const utf8 = (s: string) => new TextEncoder().encode(s);
const SPKI_ED = Buffer.from('302a300506032b6570032100', 'hex');
const SPKI_X = Buffer.from('302a300506032b656e032100', 'hex');
const PKCS8_X = Buffer.from('302e020100300506032b656e04220420', 'hex');
const edPub = (raw: Uint8Array) => createPublicKey({ key: Buffer.concat([SPKI_ED, raw]), format: 'der', type: 'spki' });
const verifyCtx = (pub: Uint8Array, ctx: string, msg: Uint8Array, sig: Uint8Array) => edVerify(null, Buffer.concat([Buffer.from(ctx, 'utf8'), msg]), edPub(pub), sig);

function setup(ks: KeyStore = new MemoryKeyStore(), now?: () => number) {
  const log = new FileEventLog(null, 'vault');
  return { c: new VaultCrypto({ keyStore: ks, log, now }), log, ks };
}

describe('HPKE Base 개봉(RFC 9180 A.2.1 시험 벡터)', () => {
  // DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, ChaCha20Poly1305, Base. RFC 9180 부록 A.2.1 값 그대로.
  const skRm = hex('8057991eef8f1f1af18f4a9491d16a1ce333f695d4db8e38da75975c4478e0fb');
  const pkRm = hex('4310ee97d88cc1f088a5576c77ab0cf5c3ac797f3d95139c6c84b5429c59662a');
  const encap = hex('1afa08d3dec047a643885163f1180476fa7ddb54c6a8029ea33f95796bf2ac4a');
  const info = hex('4f6465206f6e2061204772656369616e2055726e');
  const pt = hex('4265617574792069732074727574682c20747275746820626561757479');
  const aad0 = hex('436f756e742d30');
  const ct0 = hex('1c5250d8034ec2b784ba2cfd69dbdb8af406cfe3ff938e131f0def8c8b60b4db 21993c62ce81883d2dd1b51a28');

  it('seq 0 암호문을 연다, 공개키 유도가 맞다', () => {
    const r = x25519FromSeed(skRm);
    assert.deepEqual(r.pub, pkRm);
    assert.deepEqual(hpkeOpenBase(r.priv, r.pub, encap, info, aad0, ct0), pt);
  });

  it('봉인: RFC 9180 A.2.1의 임시 키로 같은 enc·암호문이 나온다, 임시 키를 주지 않으면 매번 다르고 열린다', () => {
    const skEm = hex('f4ec9b33b792c372c1d2c2063507b684ef925b8c75a42dbcbf57d63ccd381600');
    const s = hpkeSealBase(pkRm, info, aad0, pt, skEm);
    assert.deepEqual([s.enc, s.ct], [encap, ct0]);
    const r = x25519FromSeed(skRm);
    const a = hpkeSealBase(pkRm, info, aad0, pt);
    const b = hpkeSealBase(pkRm, info, aad0, pt);
    assert.notDeepEqual(a.enc, b.enc);
    assert.deepEqual(hpkeOpenBase(r.priv, r.pub, a.enc, info, aad0, a.ct), pt);
    assert.throws(() => hpkeSealBase(new Uint8Array(32), info, aad0, pt), /bad_point/);
  });

  it('암호문·aad·info·enc가 하나라도 다르면 open_failed', () => {
    const r = x25519FromSeed(skRm);
    const flip = (b: Uint8Array, i: number) => {
      const c = b.slice();
      c[i]! ^= 1;
      return c;
    };
    for (const [e, i2, a, c] of [
      [encap, info, aad0, flip(ct0, 0)], [encap, info, aad0, flip(ct0, ct0.length - 1)], [encap, info, flip(aad0, 0), ct0],
      [encap, flip(info, 0), aad0, ct0], [flip(encap, 3), info, aad0, ct0], [encap, info, aad0, ct0.subarray(0, 10)],
    ] as const) {
      assert.throws(() => hpkeOpenBase(r.priv, r.pub, e, i2, a, c), /open_failed|bad_point/);
    }
  });
});

/** 시험용 HPKE 봉인(RFC 9180 Base, 같은 스위트). 금고 구현과 따로 짰다. */
function sealTo(pkR: Uint8Array, skE: Uint8Array, info: Uint8Array, aad: Uint8Array, pt: Uint8Array) {
  const e = createPrivateKey({ key: Buffer.concat([PKCS8_X, skE]), format: 'der', type: 'pkcs8' });
  const encap = new Uint8Array(createPublicKey(e).export({ format: 'der', type: 'spki' }).subarray(-32));
  const dh = diffieHellman({ privateKey: e, publicKey: createPublicKey({ key: Buffer.concat([SPKI_X, pkR]), format: 'der', type: 'spki' }) });
  const I = (n: number, l: number) => Buffer.from(n.toString(16).padStart(l * 2, '0'), 'hex');
  const kem = Buffer.concat([Buffer.from('KEM'), I(32, 2)]);
  const suite = Buffer.concat([Buffer.from('HPKE'), I(32, 2), I(1, 2), I(3, 2)]);
  const ext = (s: Uint8Array, label: string, ikm: Uint8Array, id: Buffer) => createHmac('sha256', s).update(Buffer.concat([Buffer.from('HPKE-v1'), id, Buffer.from(label), ikm])).digest();
  const exp = (prk: Uint8Array, label: string, inf: Uint8Array, l: number, id: Buffer) =>
    createHmac('sha256', prk).update(Buffer.concat([I(l, 2), Buffer.from('HPKE-v1'), id, Buffer.from(label), inf, Buffer.from([1])])).digest().subarray(0, l);
  const none = new Uint8Array(0);
  const shared = exp(ext(none, 'eae_prk', dh, kem), 'shared_secret', Buffer.concat([encap, pkR]), 32, kem);
  const ksc = Buffer.concat([Buffer.from([0]), ext(none, 'psk_id_hash', none, suite), ext(none, 'info_hash', info, suite)]);
  const secret = ext(shared, 'secret', none, suite);
  const c = createCipheriv('chacha20-poly1305', exp(secret, 'key', ksc, 32, suite), exp(secret, 'base_nonce', ksc, 12, suite), { authTagLength: 16 });
  c.setAAD(aad, { plaintextLength: pt.length });
  return { enc: encap, ct: new Uint8Array(Buffer.concat([c.update(pt), c.final(), c.getAuthTag()])) };
}

describe('금고 장기 키 연산', () => {
  it('signVd: 서명 입력은 utf8(purpose)‖msg(0x00 없음), 허용 목록 밖·AIK 맥락·서버 전용 맥락은 거부', async () => {
    const { c, log } = setup();
    const { vd } = await c.publicKeys();
    const msg = utf8('{"a":1}');
    const sig = await c.signVd({ purpose: 'SAX-qbundle-v1', msg });
    assert.ok(verifyCtx(vd, 'SAX-qbundle-v1', msg, sig));
    assert.ok(!edVerify(null, Buffer.concat([Buffer.from('SAX-qbundle-v1'), Buffer.from([0]), msg]), edPub(vd), sig), '옛 0x00 구분 형식은 아니다');
    for (const purpose of ['SAX-token-v1', 'SAX-run-token-v1', 'SAX-cert-v1', 'SAX-qbundle-v2', '', 'SAX-dpop-v1\u0000']) {
      await assert.rejects(c.signVd({ purpose, msg }), /purpose_not_allowed/, purpose);
    }
    for (const bad of [undefined, {}, { purpose: 'SAX-dpop-v1' }, { purpose: 'SAX-dpop-v1', msg: 'x' }, { purpose: 'SAX-dpop-v1', msg: new Uint8Array(65_537) }]) {
      await assert.rejects(c.signVd(bad), /bad_params/);
    }
    assert.ok(!log.lines.some((l) => l.includes('{"a":1}')));
  });

  it('signAik: AIK_PURPOSES만, 서명 입력 utf8(ctx)‖msg, AIK는 RK에서 HKDF("aik")로 파생', async () => {
    const ks = new MemoryKeyStore();
    const rk = new Uint8Array(32).fill(7);
    ks.set(CRYPTO_KEY_ITEMS.rk, rk);
    const { c } = setup(ks);
    const { aik, vd } = await c.publicKeys();
    // 파생 고정값: HKDF-SHA256(ikm=0x07×32, salt=없음, info="aik", 32)
    assert.equal(Buffer.from(aikSeedFromRk(rk)).toString('hex'), '55a2e146044cdb42e85556e2c92343562f0887ba83d0da5a25f7f16e748e7a75');
    assert.deepEqual(aik, ed25519FromSeed(aikSeedFromRk(rk)).pub);
    assert.notDeepEqual(aik, vd);
    const msg = utf8('{"device_id":"d"}');
    for (const purpose of AIK_PURPOSES) assert.ok(verifyCtx(aik, purpose, msg, await c.signAik({ purpose, msg })), purpose);
    for (const purpose of ['SAX-dpop-v1', 'SAX-token-v1', 'SAX-acct-op-v2']) await assert.rejects(c.signAik({ purpose, msg }), /purpose_not_allowed/, purpose);
  });

  it('SIGNING.md §10.2 벡터: 시드 0x07×32 Ed25519로 기기 목록 항목 서명이 문서 값과 같다', async () => {
    const k = ed25519FromSeed(new Uint8Array(32).fill(7));
    assert.equal(Buffer.from(k.pub).toString('hex'), 'ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c');
    const jcs = '{"Sx":"CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk=","Vx":"CgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgo=","device_id":"dev-desktop-1","list_version":1,"registered_at":1762300800000,"role":"desktop"}';
    const { sign } = await import('node:crypto');
    const sig = sign(null, Buffer.from('SAX-devlist-v1' + jcs, 'utf8'), k.priv).toString('base64');
    assert.equal(sig, 'RgGhJJJEIu/YjYRPZqAkgKAU0zTfSmqvz4ubzpTDj3rAVUQb42DbYbSMLidmDKFYdkCnwkS5sRULRYOmRAd0Dw==');
  });

  it('허용 목록은 remote 패키지(서명하는 쪽 정본)와 같다', () => {
    assert.deepEqual([...AIK_PURPOSES].sort(), [...REMOTE_AIK].sort());
    assert.deepEqual([...VD_PURPOSES].sort(), [...REMOTE_VD].sort());
    for (const m of CRYPTO_METHODS) {
      assert.ok(!RPC_BY_PORT.engine.includes(m), `엔진 포트에 ${m}`);
      assert.ok(RPC_BY_PORT.control.includes(m), `control 포트에 ${m} 없음`);
      assert.ok(!RPC_BY_PORT.secretInput.includes(m), m);
    }
    assert.deepEqual(RPC_BY_PORT.engine.filter((m) => m.startsWith('crypto.')), [], '엔진 포트에 장기 키 연산이 없다');
  });

  it('noiseDH: X25519(Sd, 상대) = X25519(상대, Sd), 문맥·길이 검사, 낮은 차수 점 거부', async () => {
    const { c } = setup();
    const { noiseStatic } = await c.publicKeys();
    const peer = x25519FromSeed(new Uint8Array(32).fill(3));
    const mine = await c.noiseDH({ remotePub: peer.pub, ctx: 'SAX-pair-v1' });
    const theirs = new Uint8Array(diffieHellman({ privateKey: peer.priv, publicKey: createPublicKey({ key: Buffer.concat([SPKI_X, noiseStatic]), format: 'der', type: 'spki' }) }));
    assert.deepEqual(mine, theirs);
    for (const bad of [{ remotePub: peer.pub, ctx: 'SAX-env-v1' }, { remotePub: peer.pub.subarray(0, 31), ctx: 'SAX-pair-v1' }, { ctx: 'SAX-session-v1' }]) {
      await assert.rejects(c.noiseDH(bad), /bad_params/);
    }
    await assert.rejects(c.noiseDH({ remotePub: new Uint8Array(32), ctx: 'SAX-session-v1' }), /bad_point/);
  });

  it('hpkeOpen: Qd로 연다(info SAX-env-v1, aad 앞 SAX-env-v1), 형식이 다르면 bad_params, 위조는 open_failed', async () => {
    const { c, log } = setup();
    const { qd } = await c.publicKeys();
    const aad = new Uint8Array([...utf8('SAX-env-v1'), 0, 0, 0, 7]);
    const pt = utf8('{"intent":"x"}');
    const s = sealTo(qd, new Uint8Array(32).fill(9), utf8('SAX-env-v1'), aad, pt);
    assert.deepEqual(await c.hpkeOpen({ enc: s.enc, ct: s.ct, info: 'SAX-env-v1', aad }), pt);
    for (const bad of [
      { enc: s.enc, ct: s.ct, info: 'SAX-env-v2', aad }, { enc: s.enc, ct: s.ct, info: 'SAX-env-v1', aad: utf8('SAX-env-v0\u0000') },
      { enc: s.enc, ct: s.ct, info: 'SAX-env-v1', aad: utf8('SAX-env-v') }, { enc: s.enc.subarray(1), ct: s.ct, info: 'SAX-env-v1', aad },
      { enc: s.enc, ct: s.ct.subarray(0, 15), info: 'SAX-env-v1', aad },
    ]) await assert.rejects(c.hpkeOpen(bad), /bad_params/);
    const forged = s.ct.slice();
    forged[0]! ^= 1;
    await assert.rejects(c.hpkeOpen({ enc: s.enc, ct: forged, info: 'SAX-env-v1', aad }), /open_failed/);
    assert.ok(log.lines.some((l) => l.includes('vault.hpke_open_failed')));
    assert.ok(!log.lines.some((l) => l.includes('intent')));
  });

  it('키는 KeyStore에 남아 다시 띄워도 같다, 길이가 틀리면 덮지 않고 실패, 실패는 캐시하지 않는다', async () => {
    const ks = new MemoryKeyStore();
    const a = setup(ks);
    const k1 = await a.c.publicKeys();
    assert.equal(a.log.lines.filter((l) => l.includes('vault.key_created')).length, 5);
    const k2 = await setup(ks).c.publicKeys();
    assert.deepEqual(k1, k2);
    for (const v of Object.values(k1) as Uint8Array[]) assert.equal(v.length, 32);
    assert.equal(new Set((Object.values(k1) as Uint8Array[]).map((v) => Buffer.from(v).toString('hex'))).size, 5, '키마다 따로');
    const bad = new MemoryKeyStore();
    bad.set(CRYPTO_KEY_ITEMS.vd, new Uint8Array(31));
    const b = setup(bad);
    await assert.rejects(b.c.publicKeys(), /keystore_mismatch/);
    assert.equal((await bad.get(CRYPTO_KEY_ITEMS.vd, 31).catch(() => null))?.length, 31, '덮지 않았다');
    bad.set(CRYPTO_KEY_ITEMS.vd, new Uint8Array(32).fill(1));
    assert.deepEqual((await b.c.publicKeys()).vd, ed25519FromSeed(new Uint8Array(32).fill(1)).pub, '고친 뒤 다시 읽는다');
  });

  it('호출 감사: 연산·용도만 남기고, 한 시간 기대치를 넘으면 vault.crypto_rate_anomaly를 한 번', async () => {
    let t = 1_000_000;
    const { c, log } = setup(new MemoryKeyStore(), () => t);
    const msg = utf8('TEST-MSG-audit');
    for (let i = 0; i <= CRYPTO_RATE_PER_HOUR.signAik + 5; i++) await c.signAik({ purpose: 'SAX-acct-op-v1', msg });
    assert.equal(log.lines.filter((l) => l.includes('vault.crypto_rate_anomaly')).length, 1);
    assert.ok(log.lines.some((l) => l.includes('"op":"signAik"') && l.includes('"purpose":"SAX-acct-op-v1"')));
    assert.ok(!log.lines.some((l) => l.includes('TEST-MSG')));
    t += 3_600_001;
    await c.signAik({ purpose: 'SAX-acct-op-v1', msg });
    assert.equal(log.lines.filter((l) => l.includes('vault.crypto_rate_anomaly')).length, 1, '창이 지나면 셈을 새로 한다');
  });
});

describe('계정 루트 키 넘기기(ADR-048 결정 3, D08 §4.3)', () => {
  const info = RK_LINK_INFO;
  const aad = new Uint8Array(32).fill(7);

  it('쓰던 PC가 봉인한 RK를 새 PC가 넘겨받으면 AIK가 같아진다, 쓰던 RK는 보관 항목으로 옮긴다, 넘겨받기 키는 한 번만 쓴다', async () => {
    const t = 5_000_000;
    const oldPc = setup(new MemoryKeyStore(), () => t);
    const newKs = new MemoryKeyStore();
    const newPc = setup(newKs, () => t);
    const aikOld = (await oldPc.c.publicKeys()).aik;
    const before = await newPc.c.publicKeys();
    const rkBefore = (await newKs.get(CRYPTO_KEY_ITEMS.rk, 32))!;
    assert.notDeepEqual(before.aik, aikOld);
    const hx = await newPc.c.linkKey();
    const sealed = await oldPc.c.rkSeal({ recipient: hx, info, aad });
    assert.deepEqual([sealed.enc.length, sealed.ct.length], [32, 48]);
    assert.deepEqual(await newPc.c.rkImport({ ...sealed, info, aad, aikPub: aikOld }), aikOld);
    const after = await newPc.c.publicKeys();
    assert.deepEqual(after.aik, aikOld);
    // 기기 키는 그대로다(RK와 무관)
    assert.deepEqual([after.noiseStatic, after.vd, after.qd, after.kv], [before.noiseStatic, before.vd, before.qd, before.kv]);
    assert.deepEqual(await newKs.get(`${RK_PREV_ITEM}${t}`, 32), rkBefore);
    // 새 AIK로 서명한다
    const sig = await newPc.c.signAik({ purpose: 'SAX-devlist-v1', msg: utf8('x') });
    assert.ok(verifyCtx(aikOld, 'SAX-devlist-v1', utf8('x'), sig));
    // 넘겨받기 키는 지워졌다
    await assert.rejects(newPc.c.rkImport({ ...sealed, info, aad, aikPub: aikOld }), /no_link_key/);
    // 로그에는 결과만 남는다
    assert.ok(oldPc.log.lines.some((l) => l.includes('vault.rk_sealed')));
    assert.ok(newPc.log.lines.some((l) => l.includes('vault.rk_imported')));
    const rkHex = Buffer.from((await newKs.get(CRYPTO_KEY_ITEMS.rk, 32))!).toString('hex');
    for (const l of [...oldPc.log.lines, ...newPc.log.lines]) assert.ok(!l.includes(rkHex) && !l.includes(Buffer.from(hx).toString('hex')));
    // 다시 띄워도 넘겨받은 RK다
    assert.deepEqual((await setup(newKs).c.publicKeys()).aik, aikOld);
  });

  it('기대한 AIK와 다르거나, 다른 대조 해시·다른 키로 봉인됐거나, 형식이 다르면 아무것도 바꾸지 않는다', async () => {
    const oldPc = setup();
    const newKs = new MemoryKeyStore();
    const newPc = setup(newKs);
    const aikOld = (await oldPc.c.publicKeys()).aik;
    const mine = (await newPc.c.publicKeys()).aik;
    await assert.rejects(newPc.c.rkImport({ enc: new Uint8Array(32).fill(9), ct: new Uint8Array(48), info, aad, aikPub: aikOld }), /no_link_key/);
    const hx = await newPc.c.linkKey();
    const sealed = await oldPc.c.rkSeal({ recipient: hx, info, aad });
    // 서버가 기존 PC인 척 다른 RK를 봉인해 준 경우: AIK가 다르다
    const other = setup();
    await other.c.publicKeys();
    const evil = await other.c.rkSeal({ recipient: hx, info, aad });
    await assert.rejects(newPc.c.rkImport({ ...evil, info, aad, aikPub: aikOld }), /aik_mismatch/);
    await assert.rejects(newPc.c.rkImport({ ...sealed, info, aad: new Uint8Array(32).fill(8), aikPub: aikOld }), /open_failed/);
    const forged = sealed.ct.slice();
    forged[0]! ^= 1;
    await assert.rejects(newPc.c.rkImport({ enc: sealed.enc, ct: forged, info, aad, aikPub: aikOld }), /open_failed/);
    for (const bad of [
      { ...sealed, info: 'SAX-env-v1', aad, aikPub: aikOld }, { ...sealed, info, aad: aad.subarray(1), aikPub: aikOld },
      { enc: sealed.enc, ct: sealed.ct.subarray(1), info, aad, aikPub: aikOld }, { ...sealed, info, aad, aikPub: aikOld.subarray(1) }, { ...sealed, info, aad },
    ]) await assert.rejects(newPc.c.rkImport(bad), /bad_params/);
    assert.deepEqual((await newPc.c.publicKeys()).aik, mine);
    assert.equal(newPc.log.lines.filter((l) => l.includes('vault.rk_import_failed')).length, 3);
    // 넘겨받기 키를 다시 만들면 앞 키로 봉인한 것은 열리지 않는다
    await newPc.c.linkKey();
    await assert.rejects(newPc.c.rkImport({ ...sealed, info, aad, aikPub: aikOld }), /open_failed/);
    // 같은 RK를 다시 받으면 보관 항목을 만들지 않는다
    const again = setup(newKs);
    const hx2 = await again.c.linkKey();
    await again.c.rkImport({ ...(await oldPc.c.rkSeal({ recipient: hx2, info, aad })), info, aad, aikPub: aikOld });
    const third = new VaultCrypto({ keyStore: newKs, log: again.log, now: () => 777 });
    const hx3 = await third.linkKey();
    await third.rkImport({ ...(await oldPc.c.rkSeal({ recipient: hx3, info, aad })), info, aad, aikPub: aikOld });
    assert.equal(await newKs.get(`${RK_PREV_ITEM}777`, 32), null);
  });

  it('봉인은 24시간에 3번까지, 형식이 다르면 bad_params, 낮은 차수 점은 bad_point', async () => {
    let t = 1_000;
    const { c, log } = setup(new MemoryKeyStore(), () => t);
    const to = x25519FromSeed(new Uint8Array(32).fill(3)).pub;
    for (const bad of [{ recipient: to, info: 'SAX-env-v1', aad }, { recipient: to.subarray(1), info, aad }, { recipient: to, info, aad: new Uint8Array(31) }, { recipient: to, info }]) await assert.rejects(c.rkSeal(bad), /bad_params/);
    await assert.rejects(c.rkSeal({ recipient: new Uint8Array(32), info, aad }), /bad_point/);
    for (let i = 0; i < RK_SEALS_PER_DAY; i++) await c.rkSeal({ recipient: to, info, aad });
    await assert.rejects(c.rkSeal({ recipient: to, info, aad }), /rate_limited/);
    assert.ok(log.lines.some((l) => l.includes('vault.rk_seal_denied')));
    assert.equal(log.lines.filter((l) => l.includes('vault.rk_sealed')).length, RK_SEALS_PER_DAY);
    t += 86_400_001;
    await c.rkSeal({ recipient: to, info, aad });
  });

  it('@sax/remote 연결 프로토콜과 맞물린다: 6자리가 맞은 뒤 금고가 봉인하고, 새 PC 금고가 받아 같은 AIK로 서명한다', async () => {
    const oldPc = setup();
    const newPc = setup();
    const o = await oldPc.c.publicKeys();
    const n = await newPc.c.publicKeys();
    const aik: AikSigner = { publicKey: o.aik, sign: (purpose, msg) => oldPc.c.signAik({ purpose, msg }) };
    const oldId = '11111111-1111-4111-8111-111111111111';
    const newId = '22222222-2222-4222-8222-222222222222';
    const list = await initialDeviceList(aik, { deviceId: oldId, role: 'desktop', noisePub: o.noiseStatic, signPub: o.vd, registeredAt: 1 });
    const { hello, nonce } = pcLinkHello({ deviceId: newId, noisePub: n.noiseStatic, signPub: n.vd, linkPub: await newPc.c.linkKey() });
    const approver = new PcLinkApprover(hello, { deviceId: oldId, aikPub: o.aik });
    const shown = pcLinkReveal(hello, approver.challenge, nonce);
    assert.equal(approver.reveal(shown.reveal), true);
    assert.equal(approver.confirm(shown.sas), true);
    const grant = await approver.grant({ aik, deviceList: await approver.listWithNew(aik, list), sealRk: (recipient, inf, a) => oldPc.c.rkSeal({ recipient, info: new TextDecoder().decode(inf), aad: a }) });
    const chk = checkPcLinkGrant(hello, approver.challenge, shown.transcript, grant);
    assert.equal(chk.ok, true, JSON.stringify(chk.ok ? {} : chk));
    if (!chk.ok) return;
    assert.equal(new TextDecoder().decode(chk.info), CTX.pclinkRk);
    assert.equal(CTX.pclinkRk, RK_LINK_INFO);
    assert.deepEqual(await newPc.c.rkImport({ enc: chk.enc, ct: chk.ct, info: RK_LINK_INFO, aad: chk.aad, aikPub: chk.aikPub }), o.aik);
    // 새 PC가 넘겨받은 AIK로 목록을 서명하면 계정의 AIK로 검증된다
    const aik2: AikSigner = { publicKey: o.aik, sign: (purpose, msg) => newPc.c.signAik({ purpose, msg }) };
    const c2 = await issueCert(aik2, { device_id: newId, role: 'desktop', Sx: n.noiseStatic, Vx: n.vd, not_after: Date.now() + 86_400_000 });
    assert.ok(verifyCert(c2, o.aik));
  });
});

describe('계정 공유 기록 키(ADR-048 결정 5, D07 §10)', () => {
  const row = (dev: string, epoch = 0): ShareRowCore<'issue'> => ({
    v: 1, row_id: newShareRowId(), kind: 'issue', epoch, at: 1_800_000_000_000, dev, by: 'desktop',
    body: { doc: 'tax_invoice', approvalNo: '202611174100000012345678', writtenOn: '2026-11-17', buyerBizNo: '1234567890', buyerName: '가나다상사', supply: 1_000_000, tax: 100_000, how: 'app' },
  });
  const DEV = '00000000-0000-4000-8000-000000000001';

  it('상수가 @sax/remote와 같다', () => {
    assert.equal(`${SHARE_KEY_INFO_PREFIX}3`, shareKeyInfo(3));
    assert.equal(SHARE_SIGN_INFO, REMOTE_SHARE_SIGN_INFO);
    assert.equal(SHARE_SIGN_CONTEXT, CTX.share);
    assert.equal(SHARE_EPOCH_MAX, SHARE_MAX_EPOCH);
    assert.equal(SHARE_SIGN_MSG_MAX, SHARE_PAD_BUCKETS.at(-1));
  });

  it('shareKey는 RK에서 나온 K_share(e)와 Ws 공개키다. 금고가 서명한 줄을 다른 기기가 열고 확인한다', async () => {
    const ks = new MemoryKeyStore();
    const { c, log } = setup(ks);
    const k0 = await c.shareKey({ epoch: 0 });
    const rk = (await ks.get(CRYPTO_KEY_ITEMS.rk, 32))!;
    assert.deepEqual(k0.key, deriveShareKey(rk, 0));
    assert.deepEqual(k0.signPub, ed25519Public(deriveShareSignSeed(rk)));
    const k2 = await c.shareKey({ epoch: 2 });
    assert.deepEqual(k2.key, deriveShareKey(rk, 2));
    assert.notDeepEqual(k2.key, k0.key);
    assert.deepEqual(k2.signPub, k0.signPub);
    const pk = await c.publicKeys();
    for (const other of [pk.aik, pk.vd]) assert.notDeepEqual(k0.signPub, other);
    // 금고 서명으로 봉인한 줄을 공개키만 가진 쪽(폰)이 연다
    const r = row(DEV);
    const wire = await sealShareRow(k0.key, r, (msg) => c.signShare({ msg }));
    assert.deepEqual(openShareRow(k0.key, wire, { sharePub: k0.signPub, mobileSignPub: () => null }), { ok: true, row: r });
    assert.deepEqual(openShareRow(k0.key, wire, { sharePub: pk.aik, mobileSignPub: () => null }), { ok: false, reason: 'signature' });
    // 기록에는 연산 이름만 남는다
    assert.ok(log.lines.some((l) => l.includes('"op":"shareKey"')) && log.lines.some((l) => l.includes('"op":"signShare"')));
    assert.ok(!log.lines.some((l) => l.includes('1234567890') || l.includes('가나다상사')));
  });

  it('형식 밖 입력은 bad_params: 세대 범위, 빈·큰 메시지', async () => {
    const { c } = setup();
    for (const epoch of [-1, 1.5, SHARE_EPOCH_MAX + 1, '0', undefined]) await assert.rejects(c.shareKey({ epoch } as never), /bad_params/, String(epoch));
    assert.equal((await c.shareKey({ epoch: SHARE_EPOCH_MAX })).key.length, 32);
    for (const msg of [new Uint8Array(0), new Uint8Array(SHARE_SIGN_MSG_MAX + 1), 'x', undefined]) await assert.rejects(c.signShare({ msg } as never), /bad_params/);
    assert.equal((await c.signShare({ msg: new Uint8Array(SHARE_SIGN_MSG_MAX) })).length, 64);
  });

  it('계정 열쇠를 넘겨받은 새 PC는 같은 K_share와 Ws를 갖는다(쓰던 PC의 줄을 열고, 자기가 쓴 줄을 쓰던 PC가 확인한다)', async () => {
    const oldPc = setup();
    const newPc = setup();
    const before = await newPc.c.shareKey({ epoch: 1 });
    const want = await oldPc.c.shareKey({ epoch: 1 });
    assert.notDeepEqual(before.key, want.key);
    assert.notDeepEqual(before.signPub, want.signPub);
    const aad = new Uint8Array(32).fill(3);
    const sealed = await oldPc.c.rkSeal({ recipient: await newPc.c.linkKey(), info: RK_LINK_INFO, aad });
    await newPc.c.rkImport({ ...sealed, info: RK_LINK_INFO, aad, aikPub: (await oldPc.c.publicKeys()).aik });
    assert.deepEqual(await newPc.c.shareKey({ epoch: 1 }), want);
    const r = row(DEV, 1);
    const wire = await sealShareRow(want.key, r, (msg) => newPc.c.signShare({ msg }));
    assert.deepEqual(openShareRow((await oldPc.c.shareKey({ epoch: 1 })).key, wire, { sharePub: want.signPub, mobileSignPub: () => null }), { ok: true, row: r });
  });
});

const CRYPTO_METHODS = ['crypto.publicKeys', 'crypto.noiseDH', 'crypto.signVd', 'crypto.signAik', 'crypto.hpkeOpen', 'crypto.linkKey', 'crypto.rkSeal', 'crypto.rkImport', 'crypto.shareKey', 'crypto.signShare'] as const;

/** 금고 서비스 control 포트(main, VaultClient)로 만든 데스크톱 키(packages/remote DesktopKeys 모양). `engine`은 거부 확인용. */
async function vaultDesktop() {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'sax-crypto-'));
  const log = new FileEventLog(null, 'vault');
  const vault = new Vault({ paths: appPaths(root), log, keyStore: new MemoryKeyStore() });
  const eng = new MessageChannel();
  const ctl = new MessageChannel();
  vault.attachPort('engine', wrapPort(eng.port1, 'node'));
  vault.attachPort('control', wrapPort(ctl.port1, 'node'));
  const engine = new VaultClient(wrapPort(eng.port2, 'node'));
  const client = new VaultClient(wrapPort(ctl.port2, 'node'));
  const control = client;
  const pk = await client.rpc<VaultPublicKeys>('crypto.publicKeys');
  const vd: VdSigner = { publicKey: pk.vd, sign: (purpose, msg) => client.rpc<{ sig: Uint8Array }>('crypto.signVd', { purpose, msg }).then((r) => r.sig) };
  const aik: AikSigner = { publicKey: pk.aik, sign: (purpose, msg) => client.rpc<{ sig: Uint8Array }>('crypto.signAik', { purpose, msg }).then((r) => r.sig) };
  const close = async () => {
    await vault.shutdown();
    for (const c of [eng, ctl]) {
      c.port1.close();
      c.port2.close();
    }
    await fs.rm(root, { recursive: true, force: true });
  };
  return { pk, vd, aik, client, control, engine, log, close };
}

describe('받는 쪽 검증(금고 control 포트 경유)', () => {
  it('엔진 포트: crypto.* 열 개 모두 denied(vault.rpc_denied), 키 연산은 하지 않는다(RK 봉인도, 공유 기록 키도 못 부른다)', async () => {
    const d = await vaultDesktop();
    try {
      const before = d.log.lines.filter((l) => l.includes('vault.crypto_op')).length;
      const peer = x25519FromSeed(new Uint8Array(32).fill(6));
      const params: Record<(typeof CRYPTO_METHODS)[number], Record<string, unknown>> = {
        'crypto.publicKeys': {},
        'crypto.noiseDH': { remotePub: peer.pub, ctx: 'SAX-session-v1' },
        'crypto.signVd': { purpose: 'SAX-dpop-v1', msg: utf8('x') },
        'crypto.signAik': { purpose: 'SAX-acct-op-v1', msg: utf8('x') },
        'crypto.hpkeOpen': { enc: new Uint8Array(32), ct: new Uint8Array(32), info: 'SAX-env-v1', aad: utf8('SAX-env-v1\u0001') },
        'crypto.linkKey': {},
        'crypto.rkSeal': { recipient: peer.pub, info: RK_LINK_INFO, aad: new Uint8Array(32) },
        'crypto.rkImport': { enc: new Uint8Array(32).fill(9), ct: new Uint8Array(48), info: RK_LINK_INFO, aad: new Uint8Array(32), aikPub: new Uint8Array(32) },
        'crypto.shareKey': { epoch: 0 },
        'crypto.signShare': { msg: utf8('x') },
      };
      for (const m of CRYPTO_METHODS) {
        await assert.rejects(d.engine.rpc(m, params[m]), /vault: denied/, m);
        assert.ok(d.log.lines.some((l) => l.includes('vault.rpc_denied') && l.includes(m) && l.includes('"port":"engine"')), `${m} 거부 기록`);
      }
      assert.equal(d.log.lines.filter((l) => l.includes('vault.crypto_op')).length, before, '거부된 요청은 키 연산을 하지 않는다');
      // 같은 요청이 control 포트에서는 된다
      assert.deepEqual(await d.control.rpc('crypto.publicKeys'), d.pk);
      assert.equal(((await d.control.rpc('crypto.signVd', params['crypto.signVd'])) as { sig: Uint8Array }).sig.length, 64);
      assert.equal(((await d.control.rpc('crypto.signAik', params['crypto.signAik'])) as { sig: Uint8Array }).sig.length, 64);
      // 연결 연산의 결과 모양: {pub}·{enc, ct}·{aik}
      const link = await d.control.rpc<{ pub: Uint8Array }>('crypto.linkKey');
      assert.equal(link.pub.length, 32);
      const sealed = await d.control.rpc<{ enc: Uint8Array; ct: Uint8Array }>('crypto.rkSeal', { recipient: link.pub, info: RK_LINK_INFO, aad: new Uint8Array(32) });
      assert.deepEqual([Object.keys(sealed).sort(), sealed.enc.length, sealed.ct.length], [['ct', 'enc'], 32, 48]);
      assert.deepEqual(await d.control.rpc('crypto.rkImport', { ...sealed, info: RK_LINK_INFO, aad: new Uint8Array(32), aikPub: d.pk.aik }), { aik: d.pk.aik });
      // 공유 기록 키의 결과 모양: {key, signPub}·{sig}
      const sk = await d.control.rpc<{ key: Uint8Array; signPub: Uint8Array }>('crypto.shareKey', { epoch: 0 });
      assert.deepEqual([Object.keys(sk).sort(), sk.key.length, sk.signPub.length], [['key', 'signPub'], 32, 32]);
      assert.equal(((await d.control.rpc('crypto.signShare', params['crypto.signShare'])) as { sig: Uint8Array }).sig.length, 64);
    } finally {
      await d.close();
    }
  });

  it('키 연산이 실패하면 vault.rpc_failed 한 줄: 메서드·포트·사유 코드만(오류 문장은 남기지 않는다)', async () => {
    const d = await vaultDesktop();
    try {
      // 낮은 차수 점으로는 봉인하지 않는다. 부르는 쪽은 코드 없는 오류만 받으니 사유를 금고 로그에 남긴다
      await assert.rejects(d.control.rpc('crypto.rkSeal', { recipient: new Uint8Array(32), info: RK_LINK_INFO, aad: new Uint8Array(32) }), /bad_point/);
      await assert.rejects(d.control.rpc('crypto.rkSeal', { recipient: new Uint8Array(31), info: RK_LINK_INFO, aad: new Uint8Array(32) }), /bad_params/);
      const failed = d.log.lines.filter((l) => l.includes('"vault.rpc_failed"'));
      assert.equal(failed.length, 2);
      assert.ok(failed[0]!.includes('"method":"crypto.rkSeal"') && failed[0]!.includes('"port":"control"') && failed[0]!.includes('"error":"bad_point"'), failed[0]);
      assert.ok(failed[1]!.includes('"error":"bad_params"'), failed[1]);
      assert.ok(!d.log.lines.some((l) => l.includes('vault.rk_sealed')), '실패한 봉인은 봉인 기록이 없다');
      // 된 요청은 실패 줄을 남기지 않는다
      await d.control.rpc('crypto.publicKeys');
      assert.equal(d.log.lines.filter((l) => l.includes('"vault.rpc_failed"')).length, 2);
    } finally {
      await d.close();
    }
    // 런타임 오류는 Node 오류 코드만, 그 밖의 문장은 남기지 않는다
    assert.equal(rpcErrorCode(Object.assign(new Error('Unknown cipher'), { code: 'ERR_CRYPTO_UNKNOWN_CIPHER' })), 'ERR_CRYPTO_UNKNOWN_CIPHER');
    assert.equal(rpcErrorCode(new Error("ENOENT: no such file or directory, open '/Users/someone/x'")), 'error');
    assert.equal(rpcErrorCode(new Error('vault.keystore_mismatch')), 'vault.keystore_mismatch');
    assert.equal(rpcErrorCode(null), 'error');
  });

  it('공개키는 Uint8Array 32B 다섯 개, control 포트(main)로 부른다', async () => {
    const d = await vaultDesktop();
    try {
      assert.deepEqual(Object.keys(d.pk).sort(), ['aik', 'kv', 'noiseStatic', 'qd', 'vd']);
      for (const v of Object.values(d.pk)) assert.ok(v instanceof Uint8Array && v.length === 32);
      assert.deepEqual(await d.control.rpc('crypto.publicKeys'), d.pk);
      await assert.rejects(d.control.rpc('crypto.signAik', { purpose: 'SAX-dpop-v1', msg: new Uint8Array(1) }), /purpose_not_allowed/);
      // 결과 모양(NOTES §7): {shared}·{sig}·{pt}
      const peer = x25519FromSeed(new Uint8Array(32).fill(4));
      const dh = await d.client.rpc<{ shared: Uint8Array }>('crypto.noiseDH', { remotePub: peer.pub, ctx: 'SAX-session-v1' });
      assert.ok(dh.shared instanceof Uint8Array && dh.shared.length === 32);
      const aad = utf8('SAX-env-v1\u0001');
      const s = sealTo(d.pk.qd, new Uint8Array(32).fill(5), utf8('SAX-env-v1'), aad, utf8('TEST-PT'));
      assert.deepEqual(await d.client.rpc('crypto.hpkeOpen', { enc: s.enc, ct: s.ct, info: 'SAX-env-v1', aad }), { pt: utf8('TEST-PT') });
    } finally {
      await d.close();
    }
  });

  it('DPoP(SAX-dpop-v1): GatewayAuth.headers 모양(deviceAuthHeaders + 금고 signVd)이 서버 방식 검사를 통과한다', async () => {
    const d = await vaultDesktop();
    try {
      const token = 'sxd1.TEST-TOKEN';
      const htu = 'https://gateway.tex.laf-co.com/v1/model/answer';
      const now = Date.now();
      // model/egress #48: GatewayAuth.headers(req) → Authorization·DPoP. 서명은 금고 crypto.signVd{purpose:'SAX-dpop-v1'}.
      const auth = { headers: (req: { method: 'POST'; url: string }) => deviceAuthHeaders(token, d.vd, req.method, req.url, now) };
      const h = await auth.headers({ method: 'POST', url: htu });
      assert.equal(h.Authorization, `DPoP ${token}`);
      const [p, s, extra] = h.DPoP!.split('.');
      assert.ok(p && s && extra === undefined);
      const json = Buffer.from(p, 'base64url').toString('utf8');
      const proof = JSON.parse(json) as Record<string, unknown>;
      assert.equal(Object.keys(proof).sort().join(','), 'ath,htm,htu,iat,jti');
      assert.ok(edVerify(null, Buffer.from('SAX-dpop-v1' + json, 'utf8'), edPub(d.pk.vd), Buffer.from(s, 'base64url')), 'Vd 공개키로 SAX-dpop-v1‖JCS(proof) 검증');
      assert.equal(proof.htm, 'POST');
      assert.equal(proof.htu, htu);
      assert.equal(proof.iat, Math.floor(now / 1000));
      assert.equal(proof.ath, createHash('sha256').update(token).digest('base64url'));
      assert.ok(d.log.lines.some((l) => l.includes('"op":"signVd"') && l.includes('"purpose":"SAX-dpop-v1"')));
      assert.ok(!d.log.lines.some((l) => l.includes('TEST-TOKEN')));
    } finally {
      await d.close();
    }
  });

  it('AIK 기기 목록·인증서, Vd Kv 배포: remote 패키지가 금고 공개키로 검증한다', async () => {
    const d = await vaultDesktop();
    try {
      const now = Date.now();
      const list = await initialDeviceList(d.aik, { deviceId: '0b6a3f7e-2c1d-4e5f-9a8b-7c6d5e4f3a2b', role: 'desktop', noisePub: d.pk.noiseStatic, signPub: d.pk.vd, registeredAt: now });
      const ok = verifyDeviceList(list, d.pk.aik);
      assert.equal(ok.ok, true);
      assert.equal(verifyDeviceList(list, d.pk.vd).ok, false, '다른 키로는 안 된다');
      const cert = await issueCert(d.aik, { device_id: '0b6a3f7e-2c1d-4e5f-9a8b-7c6d5e4f3a2b', role: 'desktop', Sx: d.pk.noiseStatic, Vx: d.pk.vd, Kx: d.pk.kv, not_after: now + 86_400_000 });
      assert.ok(verifyCert(cert, d.pk.aik, now));
      const kvSig = await signKv(d.vd, d.pk.kv);
      assert.ok(verifyKv(d.pk.vd, d.pk.kv, kvSig));
    } finally {
      await d.close();
    }
  });

  it('클라우드 실제 검증기(services/shared verifyDpop, services/account entry·revoke·cert·opSigOk)가 금고 서명을 받는다', async () => {
    const d = await vaultDesktop();
    try {
      const now = Date.now();
      const aikPub = Buffer.from(d.pk.aik);
      const vdPub = Buffer.from(d.pk.vd);
      const sign = async (purpose: string, obj: unknown) =>
        Buffer.from(((await d.client.rpc('crypto.signAik', { purpose, msg: utf8(jcs(obj)) })) as { sig: Uint8Array }).sig).toString('base64');
      // DPoP: remote deviceAuthHeaders + 금고 Vd → 서버 verifyDpop
      const token = 'sxd1.TEST-TOKEN';
      const htu = 'https://account.tex.laf-co.com/v1/devices';
      const h = await deviceAuthHeaders(token, d.vd, 'POST', htu, now);
      const jti = new JtiCache();
      const check = { method: 'POST', htu, token, cnf: vdPub, now, jti, code: 'account.dpop_invalid' as const };
      const proof = verifyDpop(h.DPoP, check);
      assert.equal(proof.ath, athOf(token));
      assert.throws(() => verifyDpop(h.DPoP, check), '같은 jti는 다시 받지 않는다');
      const h2 = await deviceAuthHeaders(token, d.vd, 'POST', htu, now);
      assert.throws(() => verifyDpop(h2.DPoP, { ...check, cnf: aikPub, jti: new JtiCache() }), 'AIK 공개키로는 검증되지 않는다');
      assert.throws(() => verifyDpop(h2.DPoP, { ...check, token: 'sxd1.OTHER', jti: new JtiCache() }), '다른 토큰의 ath');
      // 기기 목록·인증서: remote가 금고 AIK로 만들고 서버 검증기가 받는다
      const list = await initialDeviceList(d.aik, { deviceId: '0b6a3f7e-2c1d-4e5f-9a8b-7c6d5e4f3a2b', role: 'desktop', noisePub: d.pk.noiseStatic, signPub: d.pk.vd, registeredAt: now });
      for (const e of list.entries) assert.ok(entrySigOk(aikPub, e as Parameters<typeof entrySigOk>[1]), 'SAX-devlist-v1');
      const cert = await issueCert(d.aik, { device_id: '0b6a3f7e-2c1d-4e5f-9a8b-7c6d5e4f3a2b', role: 'desktop', Sx: d.pk.noiseStatic, Vx: d.pk.vd, Kx: d.pk.kv, not_after: now + 86_400_000 });
      assert.ok(certSigOk(aikPub, cert as Parameters<typeof certSigOk>[1]), 'SAX-cert-v1');
      assert.ok(!certSigOk(vdPub, cert as Parameters<typeof certSigOk>[1]));
      // 폐기·계정 작업: 금고 signAik로 JCS(obj) 서명
      const rev = { device_id: '0b6a3f7e-2c1d-4e5f-9a8b-7c6d5e4f3a2b', revoked_at: now };
      assert.ok(revokeSigOk(aikPub, { ...rev, aikSig: await sign('SAX-revoke-v1', rev) }), 'SAX-revoke-v1');
      const op: AcctOp = { op: 'device.reactivate', account_id: 'acct-TEST', target: '0b6a3f7e-2c1d-4e5f-9a8b-7c6d5e4f3a2b', ts: now };
      assert.ok(opSigOk(aikPub, { op, aikSig: await sign('SAX-acct-op-v1', op) }, op.account_id, op.target, now), 'SAX-acct-op-v1');
      assert.ok(!opSigOk(aikPub, { op, aikSig: await sign('SAX-revoke-v1', op) }, op.account_id, op.target, now), '다른 맥락 서명은 받지 않는다');
    } finally {
      await d.close();
    }
  });
});
