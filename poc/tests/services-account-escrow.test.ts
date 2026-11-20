import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { CTX, escrowClaimAad as remoteClaimAad, escrowStoreAad as remoteStoreAad } from '@sax/remote';
import { aikSeedFromRk, ed25519FromSeed, hpkeOpenBase, hpkeSealBase, RK_ESCROW_INFO as VAULT_INFO, x25519FromSeed } from '../packages/vault/src/index.ts';
import { escrowClaimAad, escrowStoreAad, hpkeOpen, hpkeSeal, KeyEscrow, RK_ESCROW_INFO } from '../services/account/src/escrow.ts';

const enc = new TextEncoder();
const account = () => {
  const rk = new Uint8Array(randomBytes(32));
  return { rk, aikPub: ed25519FromSeed(aikSeedFromRk(rk)).pub };
};

describe('계정 열쇠 보관(services/account/src/escrow.ts)', () => {
  it('글자와 aad는 PC(@sax/remote)·금고와 같다', () => {
    assert.equal(RK_ESCROW_INFO, CTX.rkEscrow);
    assert.equal(RK_ESCROW_INFO, VAULT_INFO);
    const aik = new Uint8Array(randomBytes(32));
    const hx = new Uint8Array(randomBytes(32));
    const id = '0b0e3f0a-6d1c-4c0e-9a51-1f1f6f0f3a11';
    assert.deepEqual(new Uint8Array(escrowStoreAad(aik)), remoteStoreAad(aik));
    assert.deepEqual(new Uint8Array(escrowClaimAad(aik, id, hx)), remoteClaimAad(aik, id, hx));
    assert.notDeepEqual(escrowClaimAad(aik, id, hx), escrowStoreAad(aik));
  });

  it('HPKE는 금고와 서로 열린다(양방향), aad·info가 다르면 열리지 않는다', () => {
    const r = x25519FromSeed(new Uint8Array(randomBytes(32)));
    const pt = new Uint8Array(randomBytes(32));
    const info = enc.encode(RK_ESCROW_INFO);
    const aad = new Uint8Array(randomBytes(32));
    const a = hpkeSealBase(r.pub, info, aad, pt);
    assert.deepEqual(new Uint8Array(hpkeOpen(r.priv, r.pub, a.enc, info, aad, a.ct)), pt);
    const b = hpkeSeal(r.pub, info, aad, pt);
    assert.equal(b.ct.length, 48);
    assert.deepEqual(hpkeOpenBase(r.priv, r.pub, new Uint8Array(b.enc), info, aad, new Uint8Array(b.ct)), pt);
    assert.throws(() => hpkeOpen(r.priv, r.pub, a.enc, info, new Uint8Array(32), a.ct), /open_failed/);
    assert.throws(() => hpkeOpen(r.priv, r.pub, a.enc, enc.encode('SAX-pclink-rk-v1'), aad, a.ct), /open_failed/);
    assert.throws(() => hpkeOpen(r.priv, r.pub, new Uint8Array(32), info, aad, a.ct), /open_failed/, '낮은 차수 점');
  });

  it('맡긴 열쇠가 그 계정의 것일 때만 받고, 새 PC의 넘겨받기 키로만 열리게 다시 봉인한다', () => {
    const e = new KeyEscrow(new Uint8Array(randomBytes(32)));
    const pub = new Uint8Array(Buffer.from(e.publicKey, 'base64'));
    const info = enc.encode(RK_ESCROW_INFO);
    const a = account();
    const other = account();
    const sealed = hpkeSealBase(pub, info, remoteStoreAad(a.aikPub), a.rk);
    assert.equal(e.holds(sealed.enc, sealed.ct, a.aikPub), true);
    assert.equal(e.holds(sealed.enc, sealed.ct, other.aikPub), false, '다른 계정의 줄에 끼워 넣지 못한다');
    const wrong = hpkeSealBase(pub, info, remoteStoreAad(a.aikPub), other.rk);
    assert.equal(e.holds(wrong.enc, wrong.ct, a.aikPub), false);
    assert.equal(new KeyEscrow(new Uint8Array(randomBytes(32))).holds(sealed.enc, sealed.ct, a.aikPub), false);

    const link = x25519FromSeed(new Uint8Array(randomBytes(32)));
    const id = '0b0e3f0a-6d1c-4c0e-9a51-1f1f6f0f3a11';
    const out = e.reseal(sealed.enc, sealed.ct, a.aikPub, id, link.pub)!;
    assert.deepEqual(hpkeOpenBase(link.priv, link.pub, new Uint8Array(out.enc), info, remoteClaimAad(a.aikPub, id, link.pub), new Uint8Array(out.ct)), a.rk);
    assert.throws(() => hpkeOpenBase(link.priv, link.pub, new Uint8Array(out.enc), info, remoteClaimAad(a.aikPub, '1b0e3f0a-6d1c-4c0e-9a51-1f1f6f0f3a11', link.pub), new Uint8Array(out.ct)), /open_failed/);
    const eve = x25519FromSeed(new Uint8Array(randomBytes(32)));
    assert.throws(() => hpkeOpenBase(eve.priv, eve.pub, new Uint8Array(out.enc), info, remoteClaimAad(a.aikPub, id, link.pub), new Uint8Array(out.ct)), /open_failed/);
    assert.equal(e.reseal(sealed.enc, sealed.ct, other.aikPub, id, link.pub), null);
  });

  it('KEY_ESCROW_KEY는 hex 64자여야 한다', () => {
    assert.throws(() => KeyEscrow.fromSeedHex('abc'), /config_KEY_ESCROW_KEY/);
    assert.match(KeyEscrow.fromSeedHex('11'.repeat(32)).publicKey, /^[A-Za-z0-9+/]{43}=$/);
  });
});
