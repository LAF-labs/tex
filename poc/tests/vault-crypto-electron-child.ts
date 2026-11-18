// Electron 런타임에서 금고 키 연산이 도는지 본다. tests/vault-crypto-electron.test.ts가 ELECTRON_RUN_AS_NODE=1로 띄운다(시험 파일이 아니다).
// 금고는 Electron utilityProcess에서 돈다. Electron의 node:crypto는 BoringSSL이라 Node(OpenSSL)에 있는 암호가 없을 수 있다:
// 2026-11-17 새 PC 연결이 crypto.rkSeal의 createCipheriv('chacha20-poly1305')에서 "Unknown cipher"로 멈췄다(Node에서 도는 시험은 통과했다).
import assert from 'node:assert/strict';
import { FileEventLog } from '@sax/platform';
import { hpkeOpenBase, hpkeSealBase, MemoryKeyStore, RK_ESCROW_INFO, RK_LINK_INFO, VaultCrypto, x25519FromSeed } from '@sax/vault';

assert.ok(process.versions.electron, 'Electron 런타임이 아니다');
const utf8 = (s: string) => new TextEncoder().encode(s);
const pc = () => new VaultCrypto({ keyStore: new MemoryKeyStore(), log: new FileEventLog(null, 'vault') });

// 1) HPKE 단발 봉인·개봉
const r = x25519FromSeed(new Uint8Array(32).fill(3));
const sealed = hpkeSealBase(r.pub, utf8('info'), utf8('aad'), utf8('TEST-PT'));
assert.deepEqual(hpkeOpenBase(r.priv, r.pub, sealed.enc, utf8('info'), utf8('aad'), sealed.ct), utf8('TEST-PT'));

// 2) 새 PC 연결: 새 PC의 넘겨받기 키 → 쓰던 PC가 계정 열쇠 봉인 → 새 PC가 연다. 두 PC의 AIK가 같아진다
const oldPc = pc();
const newPc = pc();
const aikOld = (await oldPc.publicKeys()).aik;
assert.notDeepEqual((await newPc.publicKeys()).aik, aikOld);
const aad = new Uint8Array(32).fill(5);
const rk = await oldPc.rkSeal({ recipient: await newPc.linkKey(), info: RK_LINK_INFO, aad });
assert.deepEqual([rk.enc.length, rk.ct.length], [32, 48]);
assert.deepEqual(await newPc.rkImport({ ...rk, info: RK_LINK_INFO, aad, aikPub: aikOld }), aikOld);
assert.deepEqual((await newPc.publicKeys()).aik, aikOld);
// 2-1) 계정 열쇠 맡기기(ADR-050): 같은 연산, info만 다르다. 세 번째 PC가 계정 서비스 대신 선 키로 봉인한 것을 받는다
const thirdPc = pc();
const esc = await oldPc.rkSeal({ recipient: await thirdPc.linkKey(), info: RK_ESCROW_INFO, aad });
await assert.rejects(thirdPc.rkImport({ ...esc, info: RK_LINK_INFO, aad, aikPub: aikOld }), /open_failed/);
assert.deepEqual(await thirdPc.rkImport({ ...esc, info: RK_ESCROW_INFO, aad, aikPub: aikOld }), aikOld);

// 3) 우편함 큐 개봉(폰이 PC의 Q_D로 봉인한 것)
const envAad = utf8('SAX-env-v1\u0001');
const q = hpkeSealBase((await oldPc.publicKeys()).qd, utf8('SAX-env-v1'), envAad, utf8('QUEUED'));
assert.deepEqual(await oldPc.hpkeOpen({ enc: q.enc, ct: q.ct, info: 'SAX-env-v1', aad: envAad }), utf8('QUEUED'));

// 4) 나머지 키 연산도 이 런타임에서 돈다
assert.equal((await oldPc.noiseDH({ remotePub: r.pub, ctx: 'SAX-session-v1' })).length, 32);
assert.equal((await oldPc.signVd({ purpose: 'SAX-dpop-v1', msg: utf8('x') })).length, 64);
assert.equal((await oldPc.signAik({ purpose: 'SAX-acct-op-v1', msg: utf8('x') })).length, 64);
assert.equal((await oldPc.shareKey({ epoch: 0 })).key.length, 32);
assert.equal((await oldPc.signShare({ msg: utf8('x') })).length, 64);

process.stdout.write(`vault-crypto-electron ok ${process.versions.electron}\n`);
