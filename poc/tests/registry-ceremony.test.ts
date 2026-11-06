// 레지스트리 서명 의식 도구(services/registry/CEREMONY.md, D09 §8.2, SIGNING.md §1~§4). 실제 YubiKey 대신 소프트웨어 가짜 장치:
// 슬롯 키는 장치 객체 안에서 만들고 밖으로 내주지 않는다(서명·공개키·증명서만). 증명서 사슬은 시험 CA(Ed25519)로 만든다.
// 확인: 공개키 수집·증명 검사(PIN·터치 ALWAYS) → TRUST_ROOT_JSON·루트 메타데이터 → 루트 2-of-3 → 폐기 목록·status·인덱스·릴리스 서명이
// 게시 관문(services/registry verify*)과 엔진 수용 함수를 통과한다. 정족수·잘못된 장치·확인 코드·문서 바뀜·중복·폐기 키는 거부한다.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign as edSign, X509Certificate, type KeyObject } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { acceptIndex, trustRootsFromPin } from '@sax/engine';
import { acceptRevoked, acceptStatus, type RegistryStatus, type RevokedKeys } from '@sax/engine/core';
import { verifyIndex, verifyRelease, verifyRevoked, verifyStatus } from '../services/registry/src/verify.ts';
import { certExtensions, verifyAttestation, YUBICO_OID } from '../services/registry/src/ceremony/attest.ts';
import { main, type CliDeps } from '../services/registry/src/ceremony/cli.ts';
import { attachTimestamp, buildTrust, collectSignatures, signWithDevice, type KeyRecord, type SignatureRecord, type TrustPin } from '../services/registry/src/ceremony/collect.ts';
import { confirmCode, prepare, signingBytes } from '../services/registry/src/ceremony/content.ts';
import { rawEd25519FromSpki, ROLE_SLOT, ykcs11KeyId, YubiKeyPiv, type PivSlot, type SigningDevice } from '../services/registry/src/ceremony/device.ts';

// ───────────── 최소 X.509 작성기(시험 CA) ─────────────
const len = (n: number) => (n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff]);
const T = (tag: number, ...b: Uint8Array[]) => {
  const v = Buffer.concat(b);
  return Buffer.concat([Buffer.from([tag, ...len(v.length)]), v]);
};
const seq = (...b: Uint8Array[]) => T(0x30, ...b);
function oid(s: string) {
  const a = s.split('.').map(Number);
  const out = [a[0]! * 40 + a[1]!];
  for (const x of a.slice(2)) {
    const enc = [x & 0x7f];
    for (let v = Math.floor(x / 128); v > 0; v = Math.floor(v / 128)) enc.unshift((v & 0x7f) | 0x80);
    out.push(...enc);
  }
  return T(0x06, Buffer.from(out));
}
const name = (cn: string) => seq(T(0x31, seq(oid('2.5.4.3'), T(0x0c, Buffer.from(cn)))));
const gtime = (d: Date) => T(0x18, Buffer.from(d.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z'));
const ED = seq(oid('1.3.101.112'));
const ext = (o: string, value: Buffer, critical = false) => seq(oid(o), ...(critical ? [T(0x01, Buffer.from([0xff]))] : []), T(0x04, value));
function cert(o: { subject: string; issuer: string; pub: KeyObject; signer: KeyObject; ca: boolean; exts?: Buffer[]; from?: Date; to?: Date }): string {
  const exts = [...(o.ca ? [ext('2.5.29.19', seq(T(0x01, Buffer.from([0xff]))), true)] : []), ...(o.exts ?? [])];
  const tbs = seq(
    T(0xa0, T(0x02, Buffer.from([2]))),
    T(0x02, Buffer.from([0x01, Math.floor(Math.random() * 120)])),
    ED,
    name(o.issuer),
    seq(gtime(o.from ?? new Date('2024-01-01T00:00:00Z')), gtime(o.to ?? new Date('2099-01-01T00:00:00Z'))),
    name(o.subject),
    o.pub.export({ format: 'der', type: 'spki' }),
    ...(exts.length ? [T(0xa3, seq(...exts))] : []),
  );
  const der = seq(tbs, ED, T(0x03, Buffer.from([0]), edSign(null, tbs, o.signer)));
  return `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;
}

/** 시험 Yubico 사슬: 루트 → (중간) → 장치 f9. */
function testCa(withMid = false) {
  const root = generateKeyPairSync('ed25519');
  const mid = generateKeyPairSync('ed25519');
  const rootPem = cert({ subject: 'TEST Yubico PIV Root CA', issuer: 'TEST Yubico PIV Root CA', pub: root.publicKey, signer: root.privateKey, ca: true });
  const midPem = withMid ? cert({ subject: 'TEST Yubico PIV Attestation B 1', issuer: 'TEST Yubico PIV Root CA', pub: mid.publicKey, signer: root.privateKey, ca: true }) : null;
  return { root, mid, rootPem, midPem, withMid };
}

// ───────────── 가짜 YubiKey ─────────────
type Policy = { pin: number; touch: number };
class FakeYubiKey implements SigningDevice {
  readonly serial: number;
  private readonly keys = new Map<PivSlot, { priv: KeyObject; pub: KeyObject; policy: Policy }>();
  private readonly f9 = generateKeyPairSync('ed25519');
  private readonly f9Pem: string;
  private readonly ca: ReturnType<typeof testCa>;
  touches = 0;
  signed: Buffer[] = [];
  constructor(serial: number, ca: ReturnType<typeof testCa>) {
    this.serial = serial;
    this.ca = ca;
    const issuer = ca.withMid ? 'TEST Yubico PIV Attestation B 1' : 'TEST Yubico PIV Root CA';
    this.f9Pem = cert({ subject: `TEST YubiKey PIV Attestation ${serial}`, issuer, pub: this.f9.publicKey, signer: ca.withMid ? ca.mid.privateKey : ca.root.privateKey, ca: true });
  }
  /** ykman piv keys generate -a ED25519 --pin-policy … --touch-policy … */
  generate(slot: PivSlot, policy: Policy = { pin: 3, touch: 2 }) {
    const k = generateKeyPairSync('ed25519');
    this.keys.set(slot, { priv: k.privateKey, pub: k.publicKey, policy });
  }
  describe() {
    return `FAKE YubiKey #${this.serial}`;
  }
  private slot(s: PivSlot) {
    const k = this.keys.get(s);
    if (!k) throw new Error('slot_empty');
    return k;
  }
  async publicKey(s: PivSlot) {
    return rawEd25519FromSpki(this.slot(s).pub.export({ format: 'der', type: 'spki' }));
  }
  async sign(s: PivSlot, message: Buffer) {
    const k = this.slot(s);
    this.touches++;
    this.signed.push(Buffer.from(message));
    return edSign(null, message, k.priv);
  }
  async attestation(s: PivSlot) {
    const k = this.slot(s);
    const serialInt = T(0x02, Buffer.from([(this.serial >> 24) & 0xff, (this.serial >> 16) & 0xff, (this.serial >> 8) & 0xff, this.serial & 0xff]));
    const exts = [ext(YUBICO_OID.firmware, Buffer.from([5, 7, 4])), ext(YUBICO_OID.serial, serialInt), ext(YUBICO_OID.policy, Buffer.from([k.policy.pin, k.policy.touch]))];
    const attestation = cert({ subject: `YubiKey PIV Attestation ${s}`, issuer: `TEST YubiKey PIV Attestation ${this.serial}`, pub: k.pub, signer: this.f9.privateKey, ca: false, exts });
    return { attestation, intermediate: this.f9Pem };
  }
  /** 시험 전용: 개인키 바이트를 꺼내는 길이 없다는 것을 확인할 때 쓴다 */
  hasExport() {
    return Object.getOwnPropertyNames(Object.getPrototypeOf(this)).some((n) => /export|private|secret/i.test(n) && n !== 'hasExport');
  }
}

/** 의식 참가자: 보유자 A·B·C(각자 82 package·83 policy·84 root), A는 86 emergency(당직), 릴리스 보유자 R(85 release), 타임스탬프는 서버 HSM(소프트 키). */
async function ceremony(o: { withMid?: boolean } = {}) {
  const ca = testCa(o.withMid);
  const dev: Record<'A' | 'B' | 'C' | 'R', FakeYubiKey> = { A: new FakeYubiKey(30000001, ca), B: new FakeYubiKey(30000002, ca), C: new FakeYubiKey(30000003, ca), R: new FakeYubiKey(30000004, ca) };
  for (const h of ['A', 'B', 'C'] as const) for (const s of ['82', '83', '84'] as const) dev[h].generate(s);
  dev.A.generate('86');
  dev.R.generate('85');
  const ts = generateKeyPairSync('ed25519');
  const holderName = { A: '보유자 A(운영·당직)', B: '보유자 B(운영)', C: '보유자 C(운영)', R: '릴리스 보유자(비운영)' };
  const recs: KeyRecord[] = [];
  const add = async (h: keyof typeof dev, role: 'root' | 'package' | 'policy' | 'emergency' | 'release', keyId: string) => {
    const slot = ROLE_SLOT[role]!;
    const pub = await dev[h].publicKey(slot);
    const a = verifyAttestation({ ...(await dev[h].attestation(slot)), roots: [ca.rootPem], intermediates: ca.midPem ? [ca.midPem] : [], expectPublicKey: pub });
    recs.push({ keyId, role, publicKey: pub.toString('base64'), holder: holderName[h], slot, serial: a.serial, firmware: a.firmware, attested: true });
  };
  const idx = { A: 1, B: 2, C: 3 } as const;
  for (const h of ['A', 'B', 'C'] as const) for (const role of ['root', 'package', 'policy'] as const) await add(h, role, `${role}-${idx[h]}`);
  await add('A', 'emergency', 'emergency-1');
  await add('R', 'release', 'release-1');
  recs.push({ keyId: 'timestamp-1', role: 'timestamp', publicKey: rawEd25519FromSpki(ts.publicKey.export({ format: 'der', type: 'spki' })).toString('base64'), holder: '레지스트리 서버 HSM', slot: null, serial: null, firmware: null, attested: false });
  const built = buildTrust(recs, 1, '2026-11-07T00:00:00Z');
  const holderOf = (keyId: string): FakeYubiKey => (keyId === 'release-1' ? dev.R : keyId === 'emergency-1' ? dev.A : dev[(['A', 'B', 'C'] as const)[Number(keyId.split('-')[1]) - 1]!]);
  /** 보유자 서명(진행자가 읽은 확인 코드를 입력) */
  const holderSign = (kind: Parameters<typeof prepare>[0], doc: unknown, role: 'root' | 'package' | 'policy' | 'emergency' | 'release', keyId: string) => {
    const p = prepare(kind, doc);
    return signWithDevice(holderOf(keyId), { kind, part: 'content', bytes: p.bytes, role, keyId, confirm: confirmCode(p.sha256), expectedPublicKey: built.trust.keys[role]![keyId] });
  };
  /** 서버 HSM 타임스탬프(소프트) */
  const tsSign = (kind: Parameters<typeof prepare>[0], doc: unknown): SignatureRecord => {
    const p = prepare(kind, doc, 'timestamp');
    return { keyId: 'timestamp-1', alg: 'ed25519', sig: edSign(null, p.bytes, ts.privateKey).toString('base64url'), kind, part: 'timestamp', sha256: p.sha256 };
  };
  return { ca, dev, recs, ...built, holderSign, tsSign, holderOf };
}

const NOW = Date.parse('2026-11-07T06:00:00Z');
const ISO = (h: number) => new Date(Date.parse('2026-11-07T00:00:00Z') + h * 3_600_000).toISOString().replace('.000Z', 'Z');

describe('의식: 공개키 수집 → TRUST_ROOT_JSON → 루트 2-of-3 → 운영 문서', () => {
  it('핀 키는 역할별 3·3·3·1·1·1, 엔진 trustRootsFromPin이 받는다, 루트 메타데이터에 keyId → 보유자 역할 표', async () => {
    const c = await ceremony();
    assert.equal(c.trust.keyEpoch, 1);
    assert.deepEqual(Object.fromEntries(Object.entries(c.trust.keys).map(([r, k]) => [r, Object.keys(k!).length])), { root: 3, package: 3, policy: 3, emergency: 1, timestamp: 1, release: 1 });
    assert.equal(trustRootsFromPin(c.trust).rootKeys.size, 3);
    assert.deepEqual(c.metadata.holders.find((h) => h.keyId === 'root-2'), { keyId: 'root-2', role: 'root', holder: '보유자 B(운영)', slot: '84', serial: 30000002, attested: true });
    assert.equal(c.metadata.holders.find((h) => h.keyId === 'timestamp-1')!.attested, false);
    // 공개키는 원시 32바이트 표준 base64(trust.json·@sax/updater TrustRoot 모양)
    for (const ks of Object.values(c.trust.keys)) for (const b64 of Object.values(ks!)) assert.equal(Buffer.from(b64, 'base64').length, 32);
    // 가짜 장치에는 개인키를 꺼내는 메서드가 없다
    assert.equal(c.dev.A.hasExport(), false);
  });

  it('루트 메타데이터를 루트 2-of-3으로 서명한다(A·C), 같은 서명은 엔진·서버 셈으로도 2', async () => {
    const c = await ceremony();
    const a = await c.holderSign('trust_root', c.metadata, 'root', 'root-1');
    const b = await c.holderSign('trust_root', c.metadata, 'root', 'root-3');
    const r = collectSignatures('trust_root', c.metadata as unknown as Record<string, unknown>, [b, a], c.trust);
    assert.deepEqual(r.keyIds, ['root-1', 'root-3']);
    assert.equal(r.role, 'root');
    assert.equal(c.dev.A.touches + c.dev.C.touches, 2, '서명마다 장치 터치 1회');
    assert.equal(c.dev.B.touches, 0);
  });

  it('폐기 목록(루트 2-of-3 + 타임스탬프)·status(정책 2-of-3)·인덱스(패키지 2-of-3)·릴리스(릴리스 키 1)가 게시 관문과 엔진을 통과한다', async () => {
    const c = await ceremony();
    const tr = c.trust as never;
    const roots = trustRootsFromPin(c.trust);
    // 폐기 목록
    let rk: Record<string, unknown> = { revoked: [{ keyId: 'package-0', role: 'package', revokedAt: ISO(0) }], monotonic: 1, keyEpoch: 1, issuedAt: ISO(0), expiresAt: ISO(24), signatures: [], timestamp: { keyId: '', alg: 'ed25519', sig: '' } };
    rk = collectSignatures('revoked_keys', rk, [await c.holderSign('revoked_keys', rk, 'root', 'root-1'), await c.holderSign('revoked_keys', rk, 'root', 'root-2')], c.trust).doc;
    rk = attachTimestamp('revoked_keys', rk, c.tsSign('revoked_keys', rk), c.trust);
    assert.doesNotThrow(() => verifyRevoked(rk as never, tr, null, NOW));
    const ar = acceptRevoked(rk as unknown as RevokedKeys, { roots, current: null, now: NOW });
    assert.equal(ar.ok, true, ar.ok ? '' : ar.code);
    // status
    let st: Record<string, unknown> = { monotonic: 1, keyEpoch: 1, issuedAt: ISO(0), expiresAt: ISO(48), portalModeCeiling: { hometax: 'auto' }, killPlaybooks: [], signatures: [], timestamp: { keyId: '', alg: 'ed25519', sig: '' } };
    st = collectSignatures('status', st, [await c.holderSign('status', st, 'policy', 'policy-2'), await c.holderSign('status', st, 'policy', 'policy-3')], c.trust).doc;
    st = attachTimestamp('status', st, c.tsSign('status', st), c.trust);
    assert.doesNotThrow(() => verifyStatus(st as never, tr, new Set(), null, NOW));
    const as = acceptStatus(st as unknown as RegistryStatus, { roots, revoked: new Set(), current: null, now: NOW });
    assert.equal(as.ok, true, as.ok ? '' : as.code);
    // 인덱스
    let ix: Record<string, unknown> = { channel: 'stable', monotonic: 1, keyEpoch: 1, issuedAt: ISO(0), expiresAt: ISO(14 * 24), entries: [], signatures: [] };
    ix = collectSignatures('index', ix, [await c.holderSign('index', ix, 'package', 'package-1'), await c.holderSign('index', ix, 'package', 'package-3')], c.trust).doc;
    assert.doesNotThrow(() => verifyIndex(ix as never, 'stable', tr, new Set(), null, NOW));
    assert.equal(acceptIndex(ix as never, { roots, revoked: new Set(), current: null, now: NOW }).ok, true);
    // 릴리스(릴리스 보유자 장치)
    let rel: Record<string, unknown> = { channel: 'stable', version: '1.0.0', releaseDate: ISO(0), expiresAt: ISO(7 * 24), rolloutPercent: 100, files: [{ url: 'SovereignAX-Setup-1.0.0.exe', sha512: createHash('sha512').update('x').digest('base64'), size: 1 }], signature: { keyId: '', alg: 'ed25519', sig: '' } };
    rel = collectSignatures('release', rel, [await c.holderSign('release', rel, 'release', 'release-1')], c.trust).doc;
    assert.doesNotThrow(() => verifyRelease(rel as never, 'stable', tr, new Set(), null, NOW));
    assert.equal(c.dev.R.touches, 1);
    // 1인 긴급 키 status(보유자 A 슬롯 86)
    let em: Record<string, unknown> = { ...structuredClone(st), monotonic: 2, portalModeCeiling: { hometax: 'assisted' }, signatures: [], timestamp: { keyId: '', alg: 'ed25519', sig: '' } };
    const er = collectSignatures('status', em, [await c.holderSign('status', em, 'emergency', 'emergency-1')], c.trust);
    assert.equal(er.role, 'emergency');
    em = attachTimestamp('status', er.doc, c.tsSign('status', er.doc), c.trust);
    const ae = acceptStatus(em as unknown as RegistryStatus, { roots, revoked: new Set(), current: as.ok ? as.accepted : null, now: NOW });
    assert.equal(ae.ok && ae.accepted.emergency, true);
  });

  it('중간 인증서가 하나 더 있는 Yubico 사슬(5.7.4 이후 새 계층)도 잇는다', async () => {
    const c = await ceremony({ withMid: true });
    assert.equal(c.trust.keyEpoch, 1);
  });
});

describe('의식: 거부', () => {
  it('확인 코드가 다르면 장치에 넘기지 않는다, 다른 사람의 장치·슬롯이면 wrong_key, 역할에 맞지 않는 키는 role_not_allowed', async () => {
    const c = await ceremony();
    const p = prepare('revoked_keys', { revoked: [], monotonic: 1, keyEpoch: 1, issuedAt: ISO(0), expiresAt: ISO(24), signatures: [] });
    const before = c.dev.A.touches;
    await assert.rejects(signWithDevice(c.dev.A, { kind: 'revoked_keys', part: 'content', bytes: p.bytes, role: 'root', keyId: 'root-1', confirm: '0000-0000-0000-0000-0000-0000-0000-0000', expectedPublicKey: c.trust.keys.root!['root-1'] }), /confirm_mismatch/);
    assert.equal(c.dev.A.touches, before, '장치에 닿지 않았다');
    await assert.rejects(signWithDevice(c.dev.B, { kind: 'revoked_keys', part: 'content', bytes: p.bytes, role: 'root', keyId: 'root-1', confirm: confirmCode(p.sha256), expectedPublicKey: c.trust.keys.root!['root-1'] }), /wrong_key/);
    assert.equal(c.dev.B.touches, 0);
    await assert.rejects(signWithDevice(c.dev.A, { kind: 'revoked_keys', part: 'content', bytes: p.bytes, role: 'package', keyId: 'package-1', confirm: confirmCode(p.sha256) }), /role_not_allowed/);
    await assert.rejects(signWithDevice(c.dev.A, { kind: 'revoked_keys', part: 'content', bytes: p.bytes, role: 'root', keyId: 'package-1', confirm: confirmCode(p.sha256) }), /role_not_allowed/);
  });

  it('모으기: 1개·같은 키 두 번·다른 역할 키·폐기 키·4개·바뀐 문서·다른 문서 서명·위조 서명·keyEpoch 다름', async () => {
    const c = await ceremony();
    const doc: Record<string, unknown> = { revoked: [], monotonic: 1, keyEpoch: 1, issuedAt: ISO(0), expiresAt: ISO(24), signatures: [] };
    const s1 = await c.holderSign('revoked_keys', doc, 'root', 'root-1');
    const s2 = await c.holderSign('revoked_keys', doc, 'root', 'root-2');
    const s3 = await c.holderSign('revoked_keys', doc, 'root', 'root-3');
    const col = (recs: SignatureRecord[], d = doc, rev = new Set<string>()) => () => collectSignatures('revoked_keys', d, recs, c.trust, rev);
    assert.throws(col([s1]), /quorum_short/);
    assert.throws(col([s1, s1]), /duplicate_signer/);
    assert.throws(col([s1, s2], doc, new Set(['root-2'])), /key_revoked/);
    assert.throws(col([s1, s2, s3, s1]), /too_many_signatures/);
    assert.equal(collectSignatures('revoked_keys', doc, [s1, s2, s3], c.trust).keyIds.length, 3);
    const pkgSig = await c.holderSign('index', { channel: 'stable', monotonic: 1, keyEpoch: 1, issuedAt: ISO(0), expiresAt: ISO(24), entries: [], signatures: [] }, 'package', 'package-1');
    assert.throws(col([s1, pkgSig]), /wrong_document/);
    assert.throws(col([s1, { ...s2, keyId: 'package-2' }]), /key_not_pinned/);
    assert.throws(col([s1, s2], { ...doc, monotonic: 2 }), /wrong_document/, '서명 뒤 문서가 바뀌었다');
    const forged = { ...s2, sig: Buffer.alloc(64, 1).toString('base64url') };
    assert.throws(col([s1, forged]), /signature_invalid/);
    assert.throws(col([s1, s2], { ...doc, keyEpoch: 2 }), /key_epoch_mismatch/);
    // 긴급 키와 정책 키를 섞으면 받지 않는다
    const st: Record<string, unknown> = { monotonic: 1, keyEpoch: 1, issuedAt: ISO(0), expiresAt: ISO(48), portalModeCeiling: {}, killPlaybooks: [], signatures: [] };
    const e = await c.holderSign('status', st, 'emergency', 'emergency-1');
    const p1 = await c.holderSign('status', st, 'policy', 'policy-1');
    assert.throws(() => collectSignatures('status', st, [e, p1], c.trust), /key_not_pinned/);
    // 타임스탬프: 다른 키·내용 서명을 타임스탬프로 쓰면 거부
    assert.throws(() => attachTimestamp('revoked_keys', doc, s1, c.trust), /wrong_document/);
    assert.throws(() => attachTimestamp('index', doc, s1, c.trust), /no_timestamp/);
  });

  it('공개키 기록: 역할 개수·보유자 겹침·릴리스 보유자 분리·공개키 중복·증명 없음·keyId 모양', async () => {
    const c = await ceremony();
    const bad = (m: (r: KeyRecord[]) => KeyRecord[], why: RegExp) => assert.throws(() => buildTrust(m(structuredClone(c.recs)), 1, 'x'), why);
    bad((r) => r.filter((x) => x.keyId !== 'root-3'), /root 2\/3/);
    bad((r) => r.map((x) => (x.keyId === 'root-2' ? { ...x, holder: '보유자 A(운영·당직)' } : x)), /root 보유자가 3명이 아님/);
    bad((r) => r.map((x) => (x.keyId === 'release-1' ? { ...x, holder: '보유자 C(운영)' } : x)), /릴리스 보유자가 운영 키를 가짐/);
    bad((r) => r.map((x) => (x.keyId === 'policy-1' ? { ...x, publicKey: r.find((y) => y.keyId === 'package-1')!.publicKey } : x)), /같은 공개키/);
    bad((r) => r.map((x) => (x.keyId === 'package-2' ? { ...x, attested: false } : x)), /장치 증명 없음/);
    bad((r) => r.map((x) => (x.keyId === 'policy-3' ? { ...x, keyId: 'root-9' } : x)), /keyId/);
    bad((r) => r.map((x) => (x.keyId === 'policy-3' ? { ...x, publicKey: 'AAAA' } : x)), /publicKey/);
    assert.throws(() => buildTrust(c.recs, 0, 'x'), /keyEpoch/);
  });

  it('증명: PIN once·터치 cached는 거부, 남의 루트·f9 아닌 서명·공개키 다름·기간 밖', async () => {
    const ca = testCa();
    const d = new FakeYubiKey(1, ca);
    d.generate('84', { pin: 2, touch: 2 });
    d.generate('83', { pin: 3, touch: 3 });
    d.generate('82');
    const a84 = await d.attestation('84');
    const a83 = await d.attestation('83');
    assert.throws(() => verifyAttestation({ ...a84, roots: [ca.rootPem] }), /policy_not_always: pin=once/);
    assert.throws(() => verifyAttestation({ ...a83, roots: [ca.rootPem] }), /policy_not_always: pin=always touch=cached/);
    const ok = await d.attestation('82');
    assert.equal(verifyAttestation({ ...ok, roots: [ca.rootPem] }).pinPolicy, 'always');
    assert.throws(() => verifyAttestation({ ...ok, roots: [testCa().rootPem] }), /attestation_untrusted/);
    const other = new FakeYubiKey(2, ca);
    other.generate('82');
    const otherF9 = (await other.attestation('82')).intermediate;
    assert.throws(() => verifyAttestation({ attestation: ok.attestation, intermediate: otherF9, roots: [ca.rootPem] }), /attestation_untrusted/);
    assert.throws(() => verifyAttestation({ ...ok, roots: [ca.rootPem], expectPublicKey: Buffer.alloc(32, 7) }), /attestation_key_mismatch/);
    assert.throws(() => verifyAttestation({ ...ok, roots: [ca.rootPem], now: new Date('2100-01-01T00:00:00Z') }), /attestation_untrusted/);
    assert.throws(() => verifyAttestation({ ...ok, roots: [] }), /attestation_untrusted/);
    const r = verifyAttestation({ ...ok, roots: [ca.rootPem] });
    assert.equal(r.serial, 1);
    assert.equal(r.firmware, '5.7.4');
    assert.ok(certExtensions(Buffer.from(new X509Certificate(ok.attestation).raw)).has(YUBICO_OID.policy));
  });
});

describe('YubiKey PIV 어댑터(명령 인자)', () => {
  it('ykcs11 객체 id: 82→05 … 86→09', () => {
    assert.deepEqual((['82', '83', '84', '85', '86'] as const).map(ykcs11KeyId), ['05', '06', '07', '08', '09']);
  });

  it('서명은 pkcs11-tool EDDSA, PIN을 명령줄에 넘기지 않는다, 터미널을 붙인다, 임시 파일은 지운다', async () => {
    const calls: Array<{ cmd: string; args: readonly string[]; interactive: boolean }> = [];
    const k = generateKeyPairSync('ed25519');
    let tmpDir = '';
    const dev = new YubiKeyPiv({
      module: '/opt/yubico/libykcs11.dylib', serial: '30000001',
      run: async (cmd, args, o) => {
        calls.push({ cmd, args, interactive: o.interactive });
        if (cmd === 'pkcs11-tool') {
          const inp = args[args.indexOf('--input-file') + 1]!;
          tmpDir = path.dirname(inp);
          fs.writeFileSync(args[args.indexOf('--output-file') + 1]!, edSign(null, fs.readFileSync(inp), k.privateKey));
        } else fs.writeFileSync(args.at(-1)!, k.publicKey.export({ format: 'pem', type: 'spki' }));
        return { code: 0, stdout: '' };
      },
    });
    const msg = Buffer.from('{"a":1}');
    const sig = await dev.sign('84', msg);
    assert.equal(sig.length, 64);
    const pub = await dev.publicKey('84');
    assert.equal(pub.length, 32);
    const s = calls[0]!;
    assert.equal(s.cmd, 'pkcs11-tool');
    assert.equal(s.interactive, true);
    assert.deepEqual(s.args.slice(0, 10), ['--module', '/opt/yubico/libykcs11.dylib', '--token-label', 'YubiKey PIV #30000001', '--login', '--sign', '--mechanism', 'EDDSA', '--id', '07']);
    assert.ok(!s.args.some((a) => /pin/i.test(a)), 'PIN 인자 없음');
    assert.deepEqual(calls[1]!.args.slice(0, 6), ['--device', '30000001', 'piv', 'keys', 'export', '84']);
    assert.equal(calls[1]!.interactive, false);
    assert.equal(fs.existsSync(tmpDir), false, '임시 폴더를 지웠다');
    await assert.rejects(dev.sign('84', Buffer.alloc(0)), /message_size/);
    const failing = new YubiKeyPiv({ module: 'm', run: async () => ({ code: 1, stdout: '' }) });
    await assert.rejects(failing.sign('82', msg), /device_failed/);
  });
});

describe('CLI(가짜 장치로 의식 한 바퀴)', () => {
  it('pubkey → trust → prepare → sign → collect → timestamp → check', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sax-ceremony-cli-'));
    try {
      const ca = testCa();
      const devs: Record<string, FakeYubiKey> = { '1': new FakeYubiKey(1, ca), '2': new FakeYubiKey(2, ca), '3': new FakeYubiKey(3, ca), '4': new FakeYubiKey(4, ca) };
      for (const n of ['1', '2', '3']) for (const s of ['82', '83', '84'] as const) devs[n]!.generate(s);
      devs['1']!.generate('86');
      devs['4']!.generate('85');
      const lines: string[] = [];
      const p = (f: string) => path.join(dir, f);
      fs.writeFileSync(p('root.pem'), ca.rootPem);
      const ts = generateKeyPairSync('ed25519');
      fs.writeFileSync(p('ts.pem'), ts.publicKey.export({ format: 'pem', type: 'spki' }));
      const deps: CliDeps = {
        device: (o) => devs[o.serial ?? ''] ?? (() => { throw new Error('no device'); })(),
        out: (l) => lines.push(l),
        read: (f) => fs.readFileSync(f),
        write: (f, d) => fs.writeFileSync(f, d, { flag: 'wx' }),
        now: () => new Date(NOW),
      };
      const run = (...a: string[]) => main(a, deps);
      const holder = { '1': '보유자 A', '2': '보유자 B', '3': '보유자 C', '4': '릴리스 보유자' } as Record<string, string>;
      for (const n of ['1', '2', '3']) for (const role of ['root', 'package', 'policy']) assert.equal(await run('pubkey', '--role', role, '--key-id', `${role}-${n}`, '--holder', holder[n]!, '--serial', n, '--yubico-root', p('root.pem'), '--out', p(`${role}-${n}.json`)), 0);
      assert.equal(await run('pubkey', '--role', 'emergency', '--key-id', 'emergency-1', '--holder', holder['1']!, '--serial', '1', '--yubico-root', p('root.pem'), '--out', p('emergency-1.json')), 0);
      assert.equal(await run('pubkey', '--role', 'release', '--key-id', 'release-1', '--holder', holder['4']!, '--serial', '4', '--yubico-root', p('root.pem'), '--out', p('release-1.json')), 0);
      assert.equal(await run('pubkey', '--role', 'timestamp', '--key-id', 'timestamp-1', '--holder', '서버 HSM', '--pubkey-pem', p('ts.pem'), '--out', p('timestamp-1.json')), 0);
      const recFiles = fs.readdirSync(dir).filter((f) => /^(root|package|policy|emergency|release|timestamp)-\d\.json$/.test(f)).map(p);
      assert.equal(recFiles.length, 12);
      assert.equal(await run('trust', '--key-epoch', '1', '--out-trust', p('trust-root.json'), '--out-metadata', p('root-metadata.json'), ...recFiles), 0);
      assert.ok(lines.some((l) => /PIN always·터치 always/.test(l)));
      // 루트 메타데이터: 진행자가 확인 코드를 읽고, 보유자 1·3이 서명
      assert.equal(await run('prepare', '--kind', 'trust_root', p('root-metadata.json')), 0);
      const code = lines.find((l) => l.startsWith('확인 코드'))!.split(' ')[2]!;
      for (const n of ['1', '3']) assert.equal(await run('sign', '--kind', 'trust_root', '--role', 'root', '--key-id', `root-${n}`, '--confirm', code, '--trust', p('trust-root.json'), '--serial', n, '--out', p(`meta-sig-${n}.json`), p('root-metadata.json')), 0);
      // 보유자가 남의 장치를 꽂고 서명하려 하면 거부(공개키가 핀과 다름)
      await assert.rejects(run('sign', '--kind', 'trust_root', '--role', 'root', '--key-id', 'root-2', '--confirm', code, '--trust', p('trust-root.json'), '--serial', '3', '--out', p('meta-sig-x.json'), p('root-metadata.json')), /wrong_key/);
      assert.equal(await run('collect', '--kind', 'trust_root', '--trust', p('trust-root.json'), '--out', p('root-metadata.signed.json'), p('root-metadata.json'), p('meta-sig-1.json'), p('meta-sig-3.json')), 0);
      assert.equal(await run('check', '--kind', 'trust_root', '--trust', p('trust-root.json'), p('root-metadata.signed.json')), 0);
      assert.equal(await run('check', '--kind', 'trust_root', '--trust', p('trust-root.json'), p('root-metadata.json')), 2, '서명 없는 문서는 실패');
      // 폐기 목록 첫 판(루트 2 + 타임스탬프)
      fs.writeFileSync(p('revoked.json'), JSON.stringify({ revoked: [{ keyId: 'package-0', role: 'package', revokedAt: ISO(0) }], monotonic: 1, keyEpoch: 1, issuedAt: ISO(0), expiresAt: ISO(24), signatures: [], timestamp: { keyId: '', alg: 'ed25519', sig: '' } }));
      lines.length = 0;
      await run('prepare', '--kind', 'revoked_keys', p('revoked.json'));
      const rc = lines.find((l) => l.startsWith('확인 코드'))!.split(' ')[2]!;
      for (const n of ['1', '2']) await run('sign', '--kind', 'revoked_keys', '--role', 'root', '--key-id', `root-${n}`, '--confirm', rc, '--trust', p('trust-root.json'), '--serial', n, '--out', p(`rk-sig-${n}.json`), p('revoked.json'));
      assert.equal(await run('collect', '--kind', 'revoked_keys', '--trust', p('trust-root.json'), '--out', p('revoked.signed.json'), p('revoked.json'), p('rk-sig-1.json'), p('rk-sig-2.json')), 0);
      const tsBytes = prepare('revoked_keys', JSON.parse(fs.readFileSync(p('revoked.signed.json'), 'utf8')), 'timestamp');
      fs.writeFileSync(p('rk-ts.json'), JSON.stringify({ keyId: 'timestamp-1', alg: 'ed25519', sig: edSign(null, tsBytes.bytes, ts.privateKey).toString('base64url'), kind: 'revoked_keys', part: 'timestamp', sha256: tsBytes.sha256 }));
      assert.equal(await run('check', '--kind', 'revoked_keys', '--trust', p('trust-root.json'), p('revoked.signed.json')), 2, '타임스탬프 전에는 게시 관문 실패');
      assert.equal(await run('timestamp', '--kind', 'revoked_keys', '--trust', p('trust-root.json'), '--out', p('revoked.final.json'), p('revoked.signed.json'), p('rk-ts.json')), 0);
      assert.equal(await run('check', '--kind', 'revoked_keys', '--trust', p('trust-root.json'), p('revoked.final.json')), 0);
      // 덮어쓰기 거부(wx)
      await assert.rejects(run('collect', '--kind', 'revoked_keys', '--trust', p('trust-root.json'), '--out', p('revoked.signed.json'), p('revoked.json'), p('rk-sig-1.json'), p('rk-sig-2.json')), /EEXIST/);
      assert.equal(await run('nope'), 64);
      // 출력 어디에도 서명 입력 바이트·개인키가 없다(다이제스트·확인 코드만)
      assert.ok(!lines.join('\n').includes('package-0'));
      assert.equal(signingBytes('trust_root', JSON.parse(fs.readFileSync(p('root-metadata.json'), 'utf8'))).length > 0, true);
      const finalTrust = JSON.parse(fs.readFileSync(p('trust-root.json'), 'utf8')) as TrustPin;
      assert.equal(trustRootsFromPin(finalTrust).keyEpoch, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
