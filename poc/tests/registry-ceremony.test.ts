// 레지스트리 서명 의식 도구(services/registry/CEREMONY.md, 단독 모드 ADR-037, D09 §8.2, SIGNING.md §1~§4).
// 실제 키체인·Touch ID 대신 소프트웨어 가짜 키체인 백엔드: 시드는 백엔드 객체 안에만 있고 서명·공개키만 내준다(백업 내보내기만 예외).
// 확인
//  - 한 세대 12개 → TRUST_ROOT_JSON·루트 메타데이터 → 루트 2-of-3 → 폐기 목록·status·인덱스·릴리스가 게시 관문(verify*)과 엔진 accept*를 통과
//  - 모으기는 서로 다른 핀 키 2개 이상, 확인 코드·바뀐 문서·중복·폐기 키·다른 역할 거부
//  - 감싸기 규약 SAX-ceremony-wrap-v1 시험 벡터(Node = Swift 도우미, macOS에서 도우미를 빌드해 대조)
//  - 백업 SAX-ceremony-backup-v1(scrypt + ChaCha20-Poly1305): 왕복·틀린 암호·변조·약한 암호·약한 kdf, 들여오기 뒤 같은 키
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createECDH, createHash, createPrivateKey, randomBytes, sign as edSign } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { acceptIndex, trustRootsFromPin } from '@sax/engine';
import { acceptRevoked, acceptStatus, canonicalJson, type RegistryStatus, type RevokedKeys } from '@sax/engine/core';
import { countSignatures, verifyIndex, verifyRelease, verifyRevoked, verifyStatus } from '../services/registry/src/verify.ts';
import { main, SOLO_KEY_IDS, type CliDeps } from '../services/registry/src/ceremony/cli.ts';
import { attachTimestamp, buildTrust, collectSignatures, signWithBackend, type KeyRecord, type SignatureRecord, type TrustPin } from '../services/registry/src/ceremony/collect.ts';
import { confirmCode, prepare, quorumFor, signingBytes, type DocKind } from '../services/registry/src/ceremony/content.ts';
import { MacKeychainBackend, type KeyStoreBackend } from '../services/registry/src/ceremony/device.ts';
import { BACKUP_ALG, ed25519PubFromSeed, openBackup, sealBackup, unwrapSeed, WRAP_ALG, wrapSeed, type WrappedKey } from '../services/registry/src/ceremony/wrap.ts';

// ───────────── 가짜 키체인(단독 모드 백엔드) ─────────────
const PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
const edPriv = (seed: Buffer) => createPrivateKey({ key: Buffer.concat([PKCS8, seed]), format: 'der', type: 'pkcs8' });
class FakeKeychain implements KeyStoreBackend {
  private readonly seeds = new Map<string, Buffer>();
  signs: Array<{ keyId: string; confirm: string }> = [];
  exports = 0;
  describe() {
    return 'FAKE keychain';
  }
  async generate(keyId: string) {
    if (this.seeds.has(keyId)) throw new Error('ceremony.key_exists');
    const s = randomBytes(32);
    this.seeds.set(keyId, s);
    return ed25519PubFromSeed(s);
  }
  async list() {
    return [...this.seeds.keys()].sort();
  }
  async publicKey(keyId: string) {
    const s = this.seeds.get(keyId);
    if (!s) throw new Error('ceremony.key_missing');
    return ed25519PubFromSeed(s);
  }
  async sign(keyId: string, message: Buffer, confirm: string) {
    const s = this.seeds.get(keyId);
    if (!s) throw new Error('ceremony.key_missing');
    this.signs.push({ keyId, confirm });
    return edSign(null, message, edPriv(s));
  }
  async exportSeeds(keyIds: readonly string[]) {
    this.exports++;
    return keyIds.map((keyId) => ({ keyId, pub: ed25519PubFromSeed(this.seeds.get(keyId)!).toString('base64'), seed: Buffer.from(this.seeds.get(keyId)!) }));
  }
  async importSeed(keyId: string, seed: Buffer) {
    if (this.seeds.has(keyId)) throw new Error('ceremony.key_exists');
    this.seeds.set(keyId, Buffer.from(seed));
    return ed25519PubFromSeed(seed);
  }
}

const NOW = Date.parse('2026-11-07T06:00:00Z');
const ISO = (h: number) => new Date(Date.parse('2026-11-07T00:00:00Z') + h * 3_600_000).toISOString().replace('.000Z', 'Z');
const FAST_KDF = { N: 1 << 14, r: 8, p: 1 };
const PASS = '나무 바다 구름 시계 연필 사과 의자 강물';
const TS = { keyId: '', alg: 'ed25519', sig: '' };

/** 레지스트리 서버의 타임스탬프 키(REGISTRY_LOG_SIGNING_KEY 시드, 서버 Cron이 자동 재서명). 시험에서는 소프트웨어 키. */
const SERVER_TS_SEED = Buffer.alloc(32, 0x51);
const serverTimestamp = (kind: DocKind, doc: unknown): SignatureRecord => {
  const p = prepare(kind, doc, 'timestamp');
  return { keyId: 'timestamp-1', alg: 'ed25519', sig: edSign(null, p.bytes, edPriv(SERVER_TS_SEED)).toString('base64url'), kind, part: 'timestamp', sha256: p.sha256 };
};

async function soloCeremony() {
  const kc = new FakeKeychain();
  const recs: KeyRecord[] = [];
  for (const keyId of SOLO_KEY_IDS) recs.push({ keyId, role: keyId.split('-')[0] as KeyRecord['role'], publicKey: (await kc.generate(keyId)).toString('base64'), holder: '단독 보유자', backend: 'macos-se' });
  recs.push({ keyId: 'timestamp-1', role: 'timestamp', publicKey: ed25519PubFromSeed(SERVER_TS_SEED).toString('base64'), holder: '레지스트리 서버(온라인)', backend: 'server-env' });
  const built = buildTrust(recs, 1, '2026-11-07T00:00:00Z', 'solo');
  const sign = (kind: DocKind, doc: unknown, keyId: string, part: 'content' | 'timestamp' = 'content') => {
    if (part === 'timestamp') return Promise.resolve(serverTimestamp(kind, doc));
    const p = prepare(kind, doc, part);
    const role = keyId.split('-')[0] as KeyRecord['role'];
    return signWithBackend(kc, { kind, part, bytes: p.bytes, role, keyId, confirm: confirmCode(p.sha256), expectedPublicKey: built.trust.keys[role]![keyId] });
  };
  return { kc, recs, ...built, sign };
}

describe('단독 모드 의식: 키 → 핀 → 루트 2-of-3 → 운영 문서', () => {
  it('키체인 11개 + 서버 타임스탬프 1개(역할별 3·3·3·1·1·1), 엔진 trustRootsFromPin이 받는다, 메타데이터에 mode solo와 보유자 표', async () => {
    const c = await soloCeremony();
    assert.deepEqual(SOLO_KEY_IDS, ['root-1', 'root-2', 'root-3', 'package-1', 'package-2', 'package-3', 'policy-1', 'policy-2', 'policy-3', 'emergency-1', 'release-1']);
    assert.equal(c.metadata.holders.find((h) => h.keyId === 'timestamp-1')!.backend, 'server-env');
    assert.equal(trustRootsFromPin(c.trust).keyEpoch, 1);
    assert.equal(c.metadata.mode, 'solo');
    assert.deepEqual(c.metadata.holders.find((h) => h.keyId === 'policy-2'), { keyId: 'policy-2', role: 'policy', holder: '단독 보유자', backend: 'macos-se' });
    for (const ks of Object.values(c.trust.keys)) for (const b64 of Object.values(ks!)) assert.equal(Buffer.from(b64, 'base64').length, 32);
  });

  it('루트 메타데이터 root-1·root-3, 폐기 목록·status·인덱스·릴리스·긴급 status가 게시 관문과 엔진을 통과한다', async () => {
    const c = await soloCeremony();
    const tr = c.trust as never;
    const roots = trustRootsFromPin(c.trust);
    const meta = collectSignatures('trust_root', c.metadata as unknown as Record<string, unknown>, [await c.sign('trust_root', c.metadata, 'root-1'), await c.sign('trust_root', c.metadata, 'root-3')], c.trust);
    assert.deepEqual(meta.keyIds, ['root-1', 'root-3']);
    let rk: Record<string, unknown> = { revoked: [{ keyId: 'package-0', role: 'package', revokedAt: ISO(0) }], monotonic: 1, keyEpoch: 1, issuedAt: ISO(0), expiresAt: ISO(24), signatures: [], timestamp: TS };
    rk = collectSignatures('revoked_keys', rk, [await c.sign('revoked_keys', rk, 'root-1'), await c.sign('revoked_keys', rk, 'root-2')], c.trust).doc;
    rk = attachTimestamp('revoked_keys', rk, await c.sign('revoked_keys', rk, 'timestamp-1', 'timestamp'), c.trust);
    assert.doesNotThrow(() => verifyRevoked(rk as never, tr, null, NOW));
    const ar = acceptRevoked(rk as unknown as RevokedKeys, { roots, current: null, now: NOW });
    assert.equal(ar.ok, true, ar.ok ? '' : ar.code);
    let st: Record<string, unknown> = { monotonic: 1, keyEpoch: 1, issuedAt: ISO(0), expiresAt: ISO(48), portalModeCeiling: { hometax: 'auto' }, killPlaybooks: [], signatures: [], timestamp: TS };
    st = collectSignatures('status', st, [await c.sign('status', st, 'policy-2'), await c.sign('status', st, 'policy-3')], c.trust).doc;
    st = attachTimestamp('status', st, await c.sign('status', st, 'timestamp-1', 'timestamp'), c.trust);
    assert.doesNotThrow(() => verifyStatus(st as never, tr, new Set(), null, NOW));
    const as = acceptStatus(st as unknown as RegistryStatus, { roots, revoked: new Set(), current: null, now: NOW });
    assert.equal(as.ok, true, as.ok ? '' : as.code);
    // 인덱스(ADR-043): 내용은 패키지 키 2개, 신선도는 타임스탬프 키(운영은 서버가 붙인다)
    let ix: Record<string, unknown> = { channel: 'stable', monotonic: 1, keyEpoch: 1, issuedAt: ISO(0), expiresAt: ISO(48), entries: [], signatures: [], timestamp: TS };
    ix = collectSignatures('index', ix, [await c.sign('index', ix, 'package-1'), await c.sign('index', ix, 'package-3')], c.trust).doc;
    ix = attachTimestamp('index', ix, await c.sign('index', ix, 'timestamp-1', 'timestamp'), c.trust);
    assert.doesNotThrow(() => verifyIndex(ix as never, 'stable', tr, new Set(), null, NOW));
    assert.equal(acceptIndex(ix as never, { roots, revoked: new Set(), current: null, now: NOW }).ok, true);
    let rel: Record<string, unknown> = { channel: 'stable', version: '1.0.0', releaseDate: ISO(0), expiresAt: ISO(7 * 24), rolloutPercent: 100, files: [{ url: 'SovereignAX-Setup-1.0.0.exe', sha512: createHash('sha512').update('x').digest('base64'), size: 1 }], signature: TS };
    rel = collectSignatures('release', rel, [await c.sign('release', rel, 'release-1')], c.trust).doc;
    assert.doesNotThrow(() => verifyRelease(rel as never, 'stable', tr, new Set(), null, NOW));
    let em: Record<string, unknown> = { ...structuredClone(st), monotonic: 2, portalModeCeiling: { hometax: 'assisted' }, signatures: [], timestamp: TS };
    const er = collectSignatures('status', em, [await c.sign('status', em, 'emergency-1')], c.trust);
    assert.equal(er.role, 'emergency');
    em = attachTimestamp('status', er.doc, await c.sign('status', er.doc, 'timestamp-1', 'timestamp'), c.trust);
    const ae = acceptStatus(em as unknown as RegistryStatus, { roots, revoked: new Set(), current: as.ok ? as.accepted : null, now: NOW });
    assert.equal(ae.ok && ae.accepted.emergency, true);
    // 서명마다 Touch ID 창에 확인 코드가 간다. 타임스탬프는 서버가 하므로 키체인에 닿지 않는다
    assert.ok(c.kc.signs.length >= 10 && c.kc.signs.every((s) => /^[0-9a-f]{4}(-[0-9a-f]{4}){7}$/.test(s.confirm)));
    assert.ok(!c.kc.signs.some((s) => s.keyId === 'timestamp-1'));
  });
});

describe('의식: 거부', () => {
  it('확인 코드가 다르면 백엔드에 넘기지 않는다, 핀과 공개키가 다르면 wrong_key, 역할 밖은 role_not_allowed', async () => {
    const c = await soloCeremony();
    const doc = { revoked: [], monotonic: 1, keyEpoch: 1, issuedAt: ISO(0), expiresAt: ISO(24), signatures: [] };
    const p = prepare('revoked_keys', doc);
    const base = { kind: 'revoked_keys' as const, part: 'content' as const, bytes: p.bytes, role: 'root' as const, keyId: 'root-1', confirm: confirmCode(p.sha256) };
    await assert.rejects(signWithBackend(c.kc, { ...base, confirm: '0000-0000-0000-0000-0000-0000-0000-0000' }), /confirm_mismatch/);
    assert.equal(c.kc.signs.length, 0);
    await assert.rejects(signWithBackend(c.kc, { ...base, expectedPublicKey: c.trust.keys.root!['root-2'] }), /wrong_key/);
    await assert.rejects(signWithBackend(c.kc, { ...base, role: 'package', keyId: 'package-1' }), /role_not_allowed/);
    await assert.rejects(signWithBackend(c.kc, { ...base, keyId: 'package-1' }), /role_not_allowed/);
    assert.equal(c.kc.signs.length, 0);
  });

  it('모으기: 서로 다른 핀 키 2개 미만·같은 키 두 번·폐기 키·4개·바뀐 문서·다른 문서·위조·keyEpoch·긴급과 정책 섞기', async () => {
    const c = await soloCeremony();
    const doc: Record<string, unknown> = { revoked: [], monotonic: 1, keyEpoch: 1, issuedAt: ISO(0), expiresAt: ISO(24), signatures: [] };
    const s1 = await c.sign('revoked_keys', doc, 'root-1');
    const s2 = await c.sign('revoked_keys', doc, 'root-2');
    const s3 = await c.sign('revoked_keys', doc, 'root-3');
    const col = (recs: SignatureRecord[], d = doc, rev = new Set<string>()) => () => collectSignatures('revoked_keys', d, recs, c.trust, rev);
    assert.throws(col([s1]), /quorum_short/);
    assert.throws(col([s1, s1]), /duplicate_signer/);
    assert.throws(col([s1, s2], doc, new Set(['root-2'])), /key_revoked/);
    assert.throws(col([s1, s2, s3, s1]), /too_many_signatures/);
    assert.equal(collectSignatures('revoked_keys', doc, [s1, s2, s3], c.trust).keyIds.length, 3);
    const other = await c.sign('index', { channel: 'stable', monotonic: 1, keyEpoch: 1, issuedAt: ISO(0), expiresAt: ISO(24), entries: [], signatures: [] }, 'package-1');
    assert.throws(col([s1, other]), /wrong_document/);
    assert.throws(col([s1, { ...s2, keyId: 'package-2' }]), /key_not_pinned/);
    assert.throws(col([s1, s2], { ...doc, monotonic: 2 }), /wrong_document/);
    assert.throws(col([s1, { ...s2, sig: Buffer.alloc(64, 1).toString('base64url') }]), /signature_invalid/);
    assert.throws(col([s1, s2], { ...doc, keyEpoch: 2 }), /key_epoch_mismatch/);
    const st: Record<string, unknown> = { monotonic: 1, keyEpoch: 1, issuedAt: ISO(0), expiresAt: ISO(48), portalModeCeiling: {}, killPlaybooks: [], signatures: [] };
    const e = await c.sign('status', st, 'emergency-1');
    const p1 = await c.sign('status', st, 'policy-1');
    assert.throws(() => collectSignatures('status', st, [e, p1], c.trust), /key_not_pinned/);
    assert.throws(() => attachTimestamp('revoked_keys', doc, s1, c.trust), /wrong_document/);
    assert.throws(() => attachTimestamp('manifest', doc, s1, c.trust), /no_timestamp/);
  });

  it('핀 만들기: 역할 개수·공개키 중복·keyId·backend, quorum 모드는 보유자 분리·릴리스 분리·YubiKey 증명을 본다', async () => {
    const c = await soloCeremony();
    const bad = (m: (r: KeyRecord[]) => KeyRecord[], why: RegExp, mode: 'solo' | 'quorum' = 'solo') => assert.throws(() => buildTrust(m(structuredClone(c.recs)), 1, 'x', mode), why);
    bad((r) => r.filter((x) => x.keyId !== 'root-3'), /root 2\/3/);
    bad((r) => r.map((x) => (x.keyId === 'policy-1' ? { ...x, publicKey: r.find((y) => y.keyId === 'package-1')!.publicKey } : x)), /같은 공개키/);
    bad((r) => r.map((x) => (x.keyId === 'policy-3' ? { ...x, keyId: 'root-9' } : x)), /keyId/);
    bad((r) => r.map((x) => (x.keyId === 'policy-3' ? { ...x, backend: 'usb' as never } : x)), /backend/);
    bad((r) => r.map((x) => (x.keyId === 'timestamp-1' ? { ...x, backend: 'macos-se' as const } : x)), /타임스탬프 키만 서버 비밀값/);
    bad((r) => r.map((x) => (x.keyId === 'package-2' ? { ...x, backend: 'server-env' as const } : x)), /타임스탬프 키만 서버 비밀값/);
    bad((r) => r, /root 보유자가 3명이 아님/, 'quorum');
    const q = (r: KeyRecord[]) => r.map((x) => ({ ...x, holder: x.role === 'release' ? '릴리스' : (['A', 'B', 'C'][Number(x.keyId.split('-')[1]) - 1] ?? 'A') }));
    assert.equal(buildTrust(q(structuredClone(c.recs)), 1, 'x', 'quorum').metadata.mode, 'quorum');
    bad((r) => q(r).map((x) => (x.keyId === 'release-1' ? { ...x, holder: 'C' } : x)), /릴리스 보유자가 운영 키를 가짐/, 'quorum');
    bad((r) => q(r).map((x) => (x.keyId === 'root-1' ? { ...x, backend: 'yubikey-piv' as const, attested: false } : x)), /장치 증명 없음/, 'quorum');
    assert.throws(() => buildTrust(c.recs, 0, 'x'), /keyEpoch/);
  });
});

describe('감싸기 규약 SAX-ceremony-wrap-v1(부록 A)', () => {
  // 고정값: W = P-256 비밀 스칼라 0x11×32(Secure Enclave 대신), 임시 키 0x22×32, nonce 0x33×12, 시드 0x07×32, keyId root-1
  const VECTOR = '{"alg":"SAX-ceremony-wrap-v1","ct":"ozs0ERLB39bSVzrHX7TZJP223SkmVcvkz/zD9LFbgdhoBAlwVmPbO0gqvU2Pr8eh","epk":"BNZak5d8qj0bCBhS/1ennkZfFmBXcwS66tUF3TpIWJzzUBheiVNy32Ih6joTdVfkc/3bZ1XwW9UHw8Uz/OnJEoU=","keyId":"root-1","nonce":"MzMzMzMzMzMzMzMz","pub":"6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=","v":1}';
  const W = Buffer.alloc(32, 0x11);
  const wpub = () => {
    const e = createECDH('prime256v1');
    e.setPrivateKey(W);
    return e.getPublicKey();
  };
  const fixed = { ephemeral: Buffer.alloc(32, 0x22), nonce: Buffer.alloc(12, 0x33) };

  it('Node 참조 구현 = 시험 벡터, pub은 SIGNING.md §10.2 시드 0x07의 공개키', () => {
    const b = wrapSeed('root-1', Buffer.alloc(32, 7), wpub(), fixed);
    assert.equal(canonicalJson(b), VECTOR);
    assert.equal(Buffer.from(b.pub, 'base64').toString('hex').slice(0, 8), 'ea4a6c63');
    assert.deepEqual(unwrapSeed(b, W), Buffer.alloc(32, 7));
  });

  it('풀기 거부: 다른 W·바뀐 ct·다른 keyId(aad·info)·바뀐 epk·pub 불일치·모양 오류', () => {
    const b = wrapSeed('root-1', Buffer.alloc(32, 7), wpub(), fixed);
    assert.throws(() => unwrapSeed(b, Buffer.alloc(32, 0x12)), /unwrap_failed/);
    const ct = Buffer.from(b.ct, 'base64');
    ct[0] ^= 1;
    assert.throws(() => unwrapSeed({ ...b, ct: ct.toString('base64') }, W), /unwrap_failed/);
    assert.throws(() => unwrapSeed({ ...b, keyId: 'root-2' }, W), /unwrap_failed/);
    const other = wrapSeed('root-1', Buffer.alloc(32, 7), wpub(), { ...fixed, ephemeral: Buffer.alloc(32, 0x23) });
    assert.throws(() => unwrapSeed({ ...b, epk: other.epk }, W), /unwrap_failed/);
    assert.throws(() => unwrapSeed({ ...b, pub: wrapSeed('root-1', Buffer.alloc(32, 8), wpub(), fixed).pub }, W), /unwrap_failed/);
    assert.throws(() => unwrapSeed({ ...b, v: 2 } as unknown as WrappedKey, W), /blob_invalid/);
    assert.throws(() => unwrapSeed({ ...b, nonce: 'AAAA' }, W), /blob_invalid/);
    assert.throws(() => wrapSeed('../x', Buffer.alloc(32), wpub()), /wrap_invalid/);
    assert.notEqual(wrapSeed('root-1', Buffer.alloc(32, 7), wpub()).ct, wrapSeed('root-1', Buffer.alloc(32, 7), wpub()).ct, '임시 키·nonce는 매번 새로');
    assert.equal(WRAP_ALG, 'SAX-ceremony-wrap-v1');
  });

  it('Swift 도우미(macOS)를 빌드해 같은 벡터를 내는지 본다(키체인·Touch ID는 건드리지 않는다)', { skip: process.platform !== 'darwin' || !hasSwiftc(), timeout: 240_000 }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sax-keychain-'));
    try {
      const bin = path.join(dir, 'sax-keychain');
      execFileSync('swiftc', ['-O', path.resolve(import.meta.dirname, '../services/registry/src/ceremony/macos/sax-keychain.swift'), '-o', bin], { stdio: 'pipe' });
      assert.equal(execFileSync(bin, ['vector']).toString('utf8').trim(), VECTOR);
      // 잘못된 명령·keyId는 키체인에 닿기 전에 거부
      for (const a of [['bogus'], ['generate', '../x'], ['import', 'policy-x'], ['export']]) {
        let out = '';
        try {
          execFileSync(bin, a, { input: '' });
        } catch (e) {
          out = String((e as { stdout?: Buffer }).stdout ?? '');
        }
        assert.match(out, /"error":"ceremony\.usage"/, a.join(' '));
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

function hasSwiftc(): boolean {
  try {
    execFileSync('swiftc', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('백업 SAX-ceremony-backup-v1', () => {
  const entries = () =>
    ['root-1', 'policy-2'].map((keyId, i) => {
      const seed = Buffer.alloc(32, i + 1);
      return { keyId, pub: ed25519PubFromSeed(seed).toString('base64'), seed };
    });
  const fixed = { salt: Buffer.alloc(16, 9), nonce: Buffer.alloc(12, 8), kdf: FAST_KDF };

  it('왕복, 틀린 암호·변조(헤더·본문)·약한 암호·약한 kdf·빈 백업·공개키 불일치 거부', () => {
    const file = sealBackup(entries(), PASS, '2026-11-07T00:00:00Z', fixed);
    const o = JSON.parse(file) as Record<string, unknown>;
    assert.equal(o.alg, BACKUP_ALG);
    assert.ok(!file.includes(Buffer.alloc(32, 1).toString('base64')), '파일에 시드 평문 없음');
    const back = openBackup(file, PASS);
    assert.deepEqual(back.map((e) => [e.keyId, e.seed.equals(Buffer.alloc(32, e.keyId === 'root-1' ? 1 : 2))]), [['policy-2', true], ['root-1', true]]);
    assert.throws(() => openBackup(file, `${PASS}!`), /backup_open_failed/);
    assert.throws(() => openBackup(JSON.stringify({ ...o, createdAt: '2026-11-08T00:00:00Z' }), PASS), /backup_open_failed/, '헤더는 aad로 묶인다');
    const ct = Buffer.from(String(o.ct), 'base64');
    ct[3] ^= 1;
    assert.throws(() => openBackup(JSON.stringify({ ...o, ct: ct.toString('base64') }), PASS), /backup_open_failed/);
    assert.throws(() => openBackup(JSON.stringify({ ...o, kdf: { ...(o.kdf as object), N: 1024 } }), PASS), /backup_invalid/);
    assert.throws(() => openBackup('not json', PASS), /backup_invalid/);
    assert.throws(() => sealBackup(entries(), 'short pass', 'x', fixed), /passphrase_weak/);
    assert.throws(() => sealBackup(entries(), 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'x', fixed), /passphrase_weak/);
    assert.throws(() => sealBackup([], PASS, 'x'), /backup_empty/);
    assert.throws(() => sealBackup([{ ...entries()[0]!, pub: entries()[1]!.pub }], PASS, 'x', fixed), /backup_invalid/);
  });

  it('CLI: keygen-all → 루트 2-of-3 → backup-export(도우미 export 한 번) → backup-verify → 새 키체인에 backup-import → 같은 키', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sax-ceremony-cli-'));
    try {
      const a = new FakeKeychain();
      const b = new FakeKeychain();
      let mac = a;
      const lines: string[] = [];
      const asked: string[] = [];
      const deps: CliDeps = {
        backend: () => mac,
        passphrase: async (_p, confirm) => (asked.push(confirm ? 'twice' : 'once'), PASS),
        out: (l) => lines.push(l),
        env: { REGISTRY_LOG_SIGNING_KEY: SERVER_TS_SEED.toString('hex') },
        read: (f) => fs.readFileSync(f),
        write: (f, d) => fs.writeFileSync(f, d, { flag: 'wx' }),
        now: () => new Date(NOW),
      };
      const run = (...x: string[]) => main(x, deps);
      const p = (f: string) => path.join(dir, f);
      fs.mkdirSync(p('keys'));
      assert.equal(await run('keygen-all', '--holder', '단독 보유자', '--out-dir', p('keys')), 0);
      assert.equal(fs.readdirSync(p('keys')).length, 11, '타임스탬프 키는 만들지 않는다');
      await assert.rejects(run('keygen', '--key-id', 'timestamp-1', '--holder', 'x', '--out', p('ts-x.json')), /서버 비밀값/);
      // 타임스탬프 공개키는 서버 env 시드에서(시드는 출력·파일에 없다)
      assert.equal(await run('timestamp-pubkey', '--out', p('keys/timestamp-1.json')), 0);
      assert.ok(!lines.join('\n').includes(SERVER_TS_SEED.toString('hex')) && !fs.readFileSync(p('keys/timestamp-1.json'), 'utf8').includes(SERVER_TS_SEED.toString('hex')));
      await assert.rejects(main(['timestamp-pubkey', '--out', p('ts-bad.json')], { ...deps, env: { REGISTRY_LOG_SIGNING_KEY: 'zz' } }), /timestamp_seed_invalid/);
      await assert.rejects(main(['timestamp-pubkey', '--out', p('ts-bad.json')], { ...deps, env: {} }), /timestamp_seed_invalid/);
      const keyFiles = fs.readdirSync(p('keys')).map((f) => p(`keys/${f}`));
      assert.equal(keyFiles.length, 12);
      assert.equal(await run('trust', '--key-epoch', '1', '--mode', 'solo', '--out-trust', p('trust-root.json'), '--out-metadata', p('root-metadata.json'), ...keyFiles), 0);
      lines.length = 0;
      await run('prepare', '--kind', 'trust_root', p('root-metadata.json'));
      const code = lines.find((l) => l.startsWith('확인 코드'))!.split(' ')[2]!;
      for (const k of ['root-1', 'root-2']) assert.equal(await run('sign', '--kind', 'trust_root', '--key-id', k, '--confirm', code, '--trust', p('trust-root.json'), '--out', p(`sig-${k}.json`), p('root-metadata.json')), 0);
      assert.equal(await run('collect', '--kind', 'trust_root', '--trust', p('trust-root.json'), '--out', p('root-metadata.signed.json'), p('root-metadata.json'), p('sig-root-1.json'), p('sig-root-2.json')), 0);
      assert.equal(await run('check', '--kind', 'trust_root', '--trust', p('trust-root.json'), p('root-metadata.signed.json')), 0);
      assert.equal(await run('check', '--kind', 'trust_root', '--trust', p('trust-root.json'), p('root-metadata.json')), 2, '서명 없는 문서는 실패');
      await assert.rejects(run('sign', '--kind', 'trust_root', '--key-id', 'root-3', '--confirm', '0000-0000-0000-0000-0000-0000-0000-0000', '--trust', p('trust-root.json'), '--out', p('x.json'), p('root-metadata.json')), /confirm_mismatch/);
      assert.equal(await run('backup-export', '--out', p('backup.sax')), 0);
      assert.equal(a.exports, 1, 'Touch ID 한 번(도우미 export 한 번)');
      assert.equal(JSON.parse(fs.readFileSync(p('backup.sax'), 'utf8')).kdf.N, 1 << 17, '만들 때는 N = 2^17');
      assert.equal(await run('backup-verify', '--in', p('backup.sax'), '--trust', p('trust-root.json')), 0);
      assert.ok(lines.some((l) => /백업 열림: 키 11개, 핀과 같음/.test(l)));
      mac = b;
      assert.equal(await run('backup-import', '--in', p('backup.sax'), '--trust', p('trust-root.json')), 0);
      assert.deepEqual(await b.list(), [...SOLO_KEY_IDS].sort());
      const trust = JSON.parse(fs.readFileSync(p('trust-root.json'), 'utf8')) as TrustPin;
      for (const k of SOLO_KEY_IDS) assert.equal((await b.publicKey(k)).toString('base64'), trust.keys[k.split('-')[0] as 'root']![k]);
      await assert.rejects(run('backup-import', '--in', p('backup.sax')), /key_exists/, '덮지 않는다');
      const t2 = structuredClone(trust);
      t2.keys.root!['root-1'] = trust.keys.root!['root-2']!;
      fs.writeFileSync(p('trust2.json'), JSON.stringify(t2));
      await assert.rejects(run('backup-verify', '--in', p('backup.sax'), '--trust', p('trust2.json')), /backup_not_pinned/);
      assert.deepEqual(asked, ['twice', 'once', 'once', 'once', 'once']);
      await assert.rejects(run('backup-export', '--out', p('backup.sax')), /EEXIST/);
      assert.equal(await run('nope'), 64);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('macOS 키체인 백엔드(도우미 호출 인자)', () => {
  it('서명은 stdin에 메시지 base64, 인자에는 keyId·확인 코드만, 시드는 import stdin에만, 도우미 오류 코드는 그대로', async () => {
    const calls: Array<{ args: readonly string[]; stdin: string | null }> = [];
    const seed = Buffer.alloc(32, 5);
    const pub = ed25519PubFromSeed(seed).toString('base64');
    const be = new MacKeychainBackend({
      helper: '/x/sax-keychain',
      run: async (_h, args, stdin) => {
        calls.push({ args, stdin });
        if (args[0] === 'sign') return { code: 0, stdout: JSON.stringify({ keyId: args[1], sig: edSign(null, Buffer.from(stdin!, 'base64'), edPriv(seed)).toString('base64') }) };
        if (args[0] === 'pubkey' || args[0] === 'import' || args[0] === 'generate') return { code: 0, stdout: JSON.stringify({ keyId: args[1], pub }) };
        if (args[0] === 'export') return { code: 0, stdout: JSON.stringify({ keys: args.slice(1).map((keyId) => ({ keyId, pub, seed: seed.toString('base64') })) }) };
        return { code: 1, stdout: '{"error":"ceremony.key_missing"}' };
      },
    });
    const msg = Buffer.from('{"a":1}');
    const code = confirmCode(createHash('sha256').update(msg).digest('hex'));
    assert.equal((await be.sign('root-1', msg, code)).length, 64);
    assert.deepEqual(calls[0], { args: ['sign', 'root-1', code], stdin: msg.toString('base64') });
    assert.equal((await be.publicKey('root-1')).toString('base64'), pub);
    assert.equal((await be.importSeed('root-1', seed)).toString('base64'), pub);
    assert.deepEqual(calls.at(-1), { args: ['import', 'root-1'], stdin: seed.toString('base64') });
    assert.deepEqual((await be.exportSeeds(['root-1', 'root-2'])).map((e) => e.keyId), ['root-1', 'root-2']);
    for (const c of calls) for (const x of c.args) assert.ok(!x.includes(seed.toString('base64')), '시드가 인자에 없다');
    await assert.rejects(be.list(), /key_missing/);
    await assert.rejects(be.sign('../root', msg, code), /usage/);
    await assert.rejects(be.sign('root-1', Buffer.alloc(0), code), /message_size/);
    await assert.rejects(new MacKeychainBackend({ helper: 'x', run: async () => ({ code: 0, stdout: 'garbage' }) }).publicKey('root-1'), /helper_failed/);
    await assert.rejects(new MacKeychainBackend({ helper: 'x', run: async () => ({ code: 0, stdout: JSON.stringify({ keyId: 'root-2', pub }) }) }).publicKey('root-1'), /helper_failed/);
    await assert.rejects(new MacKeychainBackend({ helper: 'x', run: async () => Promise.reject(new Error('ENOENT')) }).publicKey('root-1'), /helper_missing/);
  });
});

// 공개된 keyEpoch 1 의식 산출물(2026-11-06, 단독 모드). 핀 PR의 근거를 저장소 안에서 다시 확인한다.
describe('keyEpoch 1 공개 산출물(services/registry/ceremony/keyepoch-1)', () => {
  const dir = path.resolve(import.meta.dirname, '../services/registry/ceremony/keyepoch-1');
  const read = <T>(f: string): T => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as T;
  const files = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(d, e.name)) : [path.join(d, e.name)]));

  it('trust-root.json SHA-256과 루트 메타데이터·폐기 목록 확인 코드가 PR에 적은 값과 같다', () => {
    assert.equal(createHash('sha256').update(fs.readFileSync(path.join(dir, 'trust-root.json'))).digest('hex'), 'de24c32c46e46ab81020d0a2aa684cba99ed4fed48a6c2d02d5c72fa08e793e7');
    assert.equal(confirmCode(createHash('sha256').update(signingBytes('trust_root', read('root-metadata.json'))).digest('hex')), 'b965-cdcd-6ef6-a183-97ea-f5ce-52dc-c5c4');
    assert.equal(confirmCode(createHash('sha256').update(signingBytes('revoked_keys', read('revoked_keys.json'))).digest('hex')), 'b40b-6342-09b4-db36-c4a1-e422-ae47-eddc');
  });

  it('루트 메타데이터: 핀 키와 같고, 서로 다른 루트 2개 서명이 게시 관문 규칙을 통과한다', () => {
    const trust = read<TrustPin>('trust-root.json');
    const meta = read<{ keyEpoch: number; mode: string; keys: unknown; signatures: unknown }>('root-metadata.signed.json');
    assert.equal(meta.keyEpoch, 1);
    assert.equal(meta.mode, 'solo');
    assert.deepEqual(meta.keys, trust.keys);
    const { valid } = countSignatures(signingBytes('trust_root', meta), meta.signatures, 'root', trust as never, new Set());
    assert.deepEqual(valid.sort(), ['root-1', 'root-2']);
    assert.ok(valid.length >= quorumFor('root'));
  });

  it('폐기 목록 첫 판: 루트 2개 서명은 맞고, timestamp는 아직 없다(서버 Cron이 붙인다)', () => {
    const trust = read<TrustPin>('trust-root.json');
    const rk = read<{ monotonic: number; signatures: unknown; timestamp?: unknown }>('revoked_keys.signed.json');
    assert.equal(rk.monotonic, 1);
    assert.equal(rk.timestamp, undefined);
    const { valid } = countSignatures(signingBytes('revoked_keys', rk), rk.signatures, 'root', trust as never, new Set());
    assert.deepEqual(valid.sort(), ['root-1', 'root-2']);
  });

  it('공개 파일뿐이다: 시드·감싼 키·백업·암호 필드가 없다', () => {
    const all = files(dir);
    assert.equal(all.length, 21);
    for (const f of all) {
      assert.match(f, /\.json$/);
      const text = fs.readFileSync(f, 'utf8');
      assert.doesNotMatch(text, /"(seed|privateKey|priv|secret|passphrase|wrapped|ct|epk|nonce|d)"\s*:/i, f);
    }
  });
});
