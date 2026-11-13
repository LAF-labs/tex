// @sax/updater 검증(D14 M4-9, ADR-028): 정상·서명 불일치·만료·버전 역행·해시 불일치·채널 불일치와 그 주변.
// 키는 tests/fixtures/registry(엔진 PR #52) 고정 시드 규칙을 따른다: 32바이트를 한 값으로 채운 시드. 릴리스 키는 새로 release-1 = 0x61.
// 시드는 공개된 시험 값이라 운영에 쓰면 안 된다.
import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  checkBytes,
  decideUpdate,
  INITIAL_STATE,
  installGate,
  jcs,
  matchFeed,
  needsStaleNotice,
  parseManifest,
  releaseContent,
  renderLatestYml,
  rolloutBucket,
  rolloutId,
  rootChangeContent,
  verifyDownloadedFile,
  verifyRelease,
  type ReleaseManifest,
  type Revocation,
  type TrustRoot,
} from '../packages/updater/src/index.ts';

const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
const seedKey = (byte: number) => createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, Buffer.alloc(32, byte)]), format: 'der', type: 'pkcs8' });
const pubB64 = (byte: number) => (createPublicKey(seedKey(byte)).export({ format: 'der', type: 'spki' }) as Buffer).subarray(12).toString('base64');
const sigOf = (byte: number, keyId: string, content: unknown) => ({ keyId, alg: 'ed25519' as const, sig: sign(null, Buffer.from(jcs(content), 'utf8'), seedKey(byte)).toString('base64url') });

const SEEDS = { 'root-1': 0x11, 'root-2': 0x12, 'root-3': 0x13, 'release-1': 0x61 } as const;
const TRUST: TrustRoot = {
  keyEpoch: 1,
  keys: {
    root: { 'root-1': pubB64(0x11), 'root-2': pubB64(0x12), 'root-3': pubB64(0x13) },
    release: { 'release-1': pubB64(0x61) },
    // 기간 도장은 레지스트리 타임스탬프 키(샘플 timestamp-1 = 0x51)
    timestamp: { 'timestamp-1': pubB64(0x51) },
    // 다른 역할 키로 서명하면 세지 않아야 한다(package-1 = 0x21)
    package: { 'package-1': pubB64(0x21) },
  },
};
const FRESH: Revocation = { keyIds: new Set(), fresh: true };
const NOW = Date.parse('2026-11-05T06:00:00Z');
const INSTALLER = Buffer.from('MZ fake installer bytes for test');
const sha512 = (b: Uint8Array) => createHash('sha512').update(b).digest('base64');

type Unsigned = Omit<ReleaseManifest, 'signature' | 'timestamp'>;
function unsigned(over: Partial<Unsigned> = {}): Unsigned {
  return {
    channel: 'stable',
    version: '1.2.0',
    releaseDate: '2026-11-05T00:00:00.000Z',
    issuedAt: '2026-11-05T00:00:00.000Z',
    expiresAt: '2026-11-12T00:00:00.000Z',
    rolloutPercent: 100,
    files: [{ url: 'SovereignAX-Setup-1.2.0.exe', sha512: sha512(INSTALLER), size: INSTALLER.byteLength }],
    ...over,
  };
}
/** 사람(release 키)은 기간 칸을 뺀 내용에, 서버(timestamp 키)는 {contentDigest, issuedAt, expiresAt}에 서명한다 */
const stamp = (m: Omit<ReleaseManifest, 'timestamp'>, issuedAt = m.issuedAt, expiresAt = m.expiresAt): ReleaseManifest => {
  const { signature: _s, issuedAt: _i, expiresAt: _e, ...content } = m;
  const contentDigest = createHash('sha256').update(jcs(content)).digest('hex');
  return { ...m, issuedAt, expiresAt, timestamp: sigOf(0x51, 'timestamp-1', { contentDigest, issuedAt, expiresAt }) };
};
const signRelease = (u: Unsigned, byte = SEEDS['release-1'], keyId = 'release-1'): ReleaseManifest => {
  const { issuedAt: _i, expiresAt: _e, ...content } = u;
  return stamp({ ...u, signature: sigOf(byte, keyId, content) });
};
/** JSON 왕복(네트워크에서 받은 값처럼) */
const wire = (m: unknown): unknown => JSON.parse(JSON.stringify(m));
const base = (doc: unknown, over: Record<string, unknown> = {}) => ({ doc: wire(doc), channel: 'stable' as const, trust: TRUST, revocation: FRESH, highestSeen: null, now: NOW, ...over });
const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
  return 'ok';
};

test('키 시드 규칙이 엔진 샘플 묶음 trust.json과 같다(root-1 = 0x11)', () => {
  assert.equal(pubB64(0x11), '0EqyMnQrtKs6E2i9RhXk5tAiSrcaAWuvhSCjMsl3hzc=');
  assert.equal(pubB64(0x21), 'iEuIV/TqoWE8YVBNs01L6vNGUXoOMd483dTZtCAdnQs=');
});

test('엔진 샘플 묶음이 있으면 핀 키 모양을 그대로 받는다', (t) => {
  const p = path.join(import.meta.dirname, 'fixtures/registry/trust.json');
  if (!fs.existsSync(p)) return t.skip('tests/fixtures/registry는 엔진 PR #52 머지 뒤 생긴다');
  const trust = JSON.parse(fs.readFileSync(p, 'utf8')) as TrustRoot;
  // 샘플에 release-1(시드 0x61)이 있다(엔진 데이터 패키지 PR, 패키징 #76 요청): 샘플 핀 그대로 릴리스를 받는다
  assert.deepEqual(trust.keys.release, TRUST.keys.release);
  const doc = signRelease(unsigned());
  assert.equal(verifyRelease(base(doc, { trust })).releaseKeyId, 'release-1');
  // release 역할이 빠진 핀이면 어떤 릴리스도 서명 부족이다(fail-closed)
  const noRelease = { ...trust, keys: Object.fromEntries(Object.entries(trust.keys).filter(([role]) => role !== 'release')) } as TrustRoot;
  assert.equal(codeOf(() => verifyRelease(base(doc, { trust: noRelease }))), 'registry.signature_insufficient');
});

test('정상: 서명·만료·채널·버전이 맞으면 통과하고 download', () => {
  const doc = signRelease(unsigned());
  const v = verifyRelease(base(doc));
  assert.equal(v.releaseKeyId, 'release-1');
  assert.equal(v.manifest.version, '1.2.0');
  const d = decideUpdate({ ...base(doc), installedVersion: '1.1.0', state: INITIAL_STATE, deviceId: 'dev-a', transparency: 'verified' });
  assert.equal(d.action, 'download');
  if (d.action !== 'download') return;
  assert.equal(d.file.url, 'SovereignAX-Setup-1.2.0.exe');
  assert.equal(d.state.highestSeen?.version, '1.2.0');
  assert.equal(d.state.lastSuccessAt, NOW);
});

test('서명 불일치: 내용 변조·다른 키·다른 역할 키·폐기 키·서명 형식', () => {
  const good = signRelease(unsigned());
  // 서명 뒤 파일 해시를 바꾼다
  const tampered = { ...good, files: [{ ...good.files[0]!, sha512: sha512(Buffer.from('evil')) }] };
  assert.equal(codeOf(() => verifyRelease(base(tampered))), 'registry.signature_insufficient');
  // 핀에 없는 키(0x62)로 release-1이라 주장
  assert.equal(codeOf(() => verifyRelease(base(signRelease(unsigned(), 0x62)))), 'registry.signature_insufficient');
  // 핀에 있지만 다른 역할(package-1)
  assert.equal(codeOf(() => verifyRelease(base(signRelease(unsigned(), 0x21, 'package-1')))), 'registry.signature_insufficient');
  // 폐기된 릴리스 키
  assert.equal(codeOf(() => verifyRelease(base(good, { revocation: { keyIds: new Set(['release-1']), fresh: true } }))), 'registry.key_revoked');
  // alg·서명 길이가 틀리면 모양 오류
  assert.equal(codeOf(() => verifyRelease(base({ ...good, signature: { ...good.signature, alg: 'rsa' } }))), 'update.manifest_invalid');
  assert.equal(codeOf(() => verifyRelease(base({ ...good, signature: { ...good.signature, sig: good.signature.sig.slice(1) } }))), 'update.manifest_invalid');
  // 결정은 보류 + 보안 이벤트
  const d = decideUpdate({ ...base(tampered), installedVersion: '1.1.0', state: INITIAL_STATE, deviceId: 'dev-a', transparency: 'verified' });
  assert.deepEqual([d.action, d.action === 'hold' && d.code, d.action === 'hold' && d.security], ['hold', 'registry.signature_insufficient', true]);
  assert.equal(d.state, INITIAL_STATE, '실패는 상태를 바꾸지 않는다');
});

test('만료·미래 발행·유효 기간 초과', () => {
  const doc = signRelease(unsigned());
  assert.equal(codeOf(() => verifyRelease(base(doc, { now: Date.parse('2026-11-12T00:00:00.000Z') }))), 'registry.expired');
  const future = signRelease(unsigned({ releaseDate: '2026-11-05T06:06:00.000Z', expiresAt: '2026-11-10T00:00:00.000Z' }));
  assert.equal(codeOf(() => verifyRelease(base(future))), 'registry.issued_in_future');
  // 5분 안 미래는 시계 오차로 받는다
  assert.ok(verifyRelease(base(signRelease(unsigned({ releaseDate: '2026-11-05T06:04:00.000Z' })))));
  const long = signRelease(unsigned({ expiresAt: '2026-11-19T00:00:00.001Z' }));
  assert.equal(codeOf(() => verifyRelease(base(long))), 'update.validity_too_long');
  const d = decideUpdate({ ...base(doc), now: Date.parse('2026-11-13T00:00:00Z'), installedVersion: '1.1.0', state: INITIAL_STATE, deviceId: 'd', transparency: 'verified' });
  assert.deepEqual([d.action, d.action === 'hold' && d.code, d.action === 'hold' && d.security], ['hold', 'registry.expired', false]);
});

test('버전 역행: 본 것보다 낮은 버전, 같은 버전 다른 설치본, 설치본보다 낮거나 같으면 할 일 없음', () => {
  const v12 = signRelease(unsigned());
  const seen = verifyRelease(base(v12));
  const highestSeen = { version: '1.2.0', filesDigest: createHash('sha256').update(jcs(seen.manifest.files)).digest('hex') };
  const v11 = signRelease(unsigned({ version: '1.1.9' }));
  assert.equal(codeOf(() => verifyRelease(base(v11, { highestSeen }))), 'registry.version_rollback');
  // 같은 버전·같은 파일은 신선도 재발행(새 releaseDate·expiresAt)이라 받는다
  assert.ok(verifyRelease(base(signRelease(unsigned({ releaseDate: '2026-11-05T01:00:00.000Z' })), { highestSeen })));
  // 같은 버전에 다른 설치본은 거부
  const swapped = signRelease(unsigned({ files: [{ url: 'SovereignAX-Setup-1.2.0.exe', sha512: sha512(Buffer.from('other')), size: 5 }] }));
  assert.equal(codeOf(() => verifyRelease(base(swapped, { highestSeen }))), 'registry.version_rollback');
  // 설치본과 같거나 낮으면 none(다운그레이드 금지), 상태의 최고값은 낮아지지 않는다
  const d = decideUpdate({ ...base(v12), installedVersion: '1.2.0', state: INITIAL_STATE, deviceId: 'd', transparency: 'verified' });
  assert.deepEqual([d.action, d.action === 'none' && d.reason], ['none', 'up_to_date']);
  const d2 = decideUpdate({ ...base(v11), installedVersion: '1.0.0', state: { highestSeen, lastSuccessAt: NOW - 1 }, deviceId: 'd', transparency: 'verified' });
  assert.deepEqual([d2.action, d2.action === 'hold' && d2.code, d2.action === 'hold' && d2.security], ['hold', 'registry.version_rollback', true]);
  // 설치본보다 낮은 매니페스트는 롤백 기준(highestSeen)이 되지 않는다(CodeSolar #76)
  const low = decideUpdate({ ...base(v11), installedVersion: '1.2.0', state: INITIAL_STATE, deviceId: 'd', transparency: 'verified' });
  assert.deepEqual([low.action, low.state.highestSeen, low.state.lastSuccessAt], ['none', null, NOW]);
  const keep = decideUpdate({ ...base(v11), installedVersion: '1.2.0', state: { highestSeen, lastSuccessAt: null }, deviceId: 'd', transparency: 'verified' });
  assert.equal(keep.action, 'hold', '본 최고 버전보다 낮으면 여전히 롤백');
  assert.equal(codeOf(() => parseManifest(wire(signRelease(unsigned({ version: '1.2.0-beta.1' }))))), 'update.manifest_invalid');
});

test('채널 불일치: beta 매니페스트를 stable 구독자가 받지 않는다, 모르는 채널은 모양 오류', () => {
  const beta = signRelease(unsigned({ channel: 'beta' }));
  assert.equal(codeOf(() => verifyRelease(base(beta))), 'update.channel_mismatch');
  assert.ok(verifyRelease(base(beta, { channel: 'beta' })));
  const odd = signRelease({ ...unsigned(), channel: 'nightly' as 'stable' });
  assert.equal(codeOf(() => verifyRelease(base(odd))), 'update.manifest_invalid');
});

test('해시 불일치: 받은 파일 크기·sha512가 매니페스트와 다르면 설치하지 않는다', async () => {
  const doc = signRelease(unsigned());
  const file = verifyRelease(base(doc)).manifest.files[0]!;
  checkBytes(INSTALLER, file);
  assert.equal(codeOf(() => checkBytes(Buffer.from(INSTALLER).fill(0x41, 0, 1), file)), 'update.digest_mismatch');
  assert.equal(codeOf(() => checkBytes(INSTALLER.subarray(1), file)), 'update.size_mismatch');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sax-updater-'));
  try {
    const ok = path.join(dir, 'ok.exe');
    const bad = path.join(dir, 'bad.exe');
    const longer = path.join(dir, 'long.exe');
    fs.writeFileSync(ok, INSTALLER);
    fs.writeFileSync(bad, Buffer.from(INSTALLER).fill(0x42, 3, 4));
    fs.writeFileSync(longer, Buffer.concat([INSTALLER, Buffer.from('x')]));
    assert.deepEqual(await verifyDownloadedFile(ok, file), { ok: true });
    assert.deepEqual(await verifyDownloadedFile(bad, file), { ok: false, code: 'update.digest_mismatch' });
    assert.deepEqual(await verifyDownloadedFile(longer, file), { ok: false, code: 'update.size_mismatch' });
    assert.deepEqual(await verifyDownloadedFile(path.join(dir, 'missing.exe'), file), { ok: false, code: 'update.digest_mismatch' });
    assert.deepEqual(await verifyDownloadedFile(dir, file), { ok: false, code: 'update.size_mismatch' }, '폴더는 파일이 아니다');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('electron-updater 피드 대조: 검증한 매니페스트와 다른 latest.yml 값은 거부', () => {
  const v = verifyRelease(base(signRelease(unsigned())));
  const f = v.manifest.files[0]!;
  assert.deepEqual(matchFeed(v, { version: '1.2.0', files: [{ url: f.url, sha512: f.sha512, size: f.size }], path: f.url, sha512: f.sha512 }), { ok: true });
  assert.equal(matchFeed(v, { version: '1.2.1', files: [{ url: f.url, sha512: f.sha512 }] }).ok, false);
  assert.equal(matchFeed(v, { version: '1.2.0', files: [{ url: f.url, sha512: sha512(Buffer.from('x')) }] }).ok, false);
  assert.equal(matchFeed(v, { version: '1.2.0', files: [{ url: 'other.exe', sha512: f.sha512 }] }).ok, false);
  assert.equal(matchFeed(v, { version: '1.2.0', files: [{ url: f.url, sha512: f.sha512, size: f.size + 1 }] }).ok, false);
  assert.equal(matchFeed(v, { version: '1.2.0', files: [{ url: f.url, sha512: f.sha512 }], sha512: sha512(Buffer.from('y')) }).ok, false);
  // 우리가 만드는 latest.yml은 같은 값만 담는다
  const yml = renderLatestYml(v.manifest);
  assert.match(yml, /^version: 1\.2\.0\n/);
  assert.ok(yml.includes(`path: ${f.url}\nsha512: ${f.sha512}\n`));
});

test('뿌리 변경 릴리스(ADR-028 결정 3)는 루트 2-of-3이 있어야 한다', () => {
  const withRoot = (signers: Array<keyof typeof SEEDS>, keyEpoch = 2, changes: Array<'keyEpoch' | 'allowlist' | 'ceiling'> = ['keyEpoch']) => {
    const u = unsigned({ rootChange: { keyEpoch, changes, signatures: [] } });
    const rootContent = rootChangeContent({ ...u, signature: { keyId: 'x', alg: 'ed25519', sig: '' }, timestamp: { keyId: 'x', alg: 'ed25519', sig: '' } });
    const sigs = signers.map((k) => sigOf(SEEDS[k], k, rootContent));
    return signRelease({ ...u, rootChange: { keyEpoch, changes, signatures: sigs } });
  };
  const ok = verifyRelease(base(withRoot(['root-1', 'root-2'])));
  assert.deepEqual(ok.rootKeyIds.sort(), ['root-1', 'root-2']);
  assert.equal(codeOf(() => verifyRelease(base(withRoot(['root-1'])))), 'update.root_change_unsigned');
  assert.equal(codeOf(() => verifyRelease(base(withRoot(['root-1', 'root-1'])))), 'update.root_change_unsigned', '같은 키 두 번은 1개');
  assert.equal(codeOf(() => verifyRelease(base(withRoot(['root-1', 'release-1'])))), 'update.root_change_unsigned', '릴리스 키는 루트가 아니다');
  // keyEpoch를 바꾼다면서 지금 세대 그대로, 안 바꾼다면서 다른 세대
  assert.equal(codeOf(() => verifyRelease(base(withRoot(['root-1', 'root-2'], 1)))), 'update.root_change_unsigned');
  assert.equal(codeOf(() => verifyRelease(base(withRoot(['root-1', 'root-2'], 2, ['allowlist'])))), 'update.root_change_unsigned');
  assert.ok(verifyRelease(base(withRoot(['root-2', 'root-3'], 1, ['allowlist', 'ceiling']))));
  // 폐기된 루트 키 때문에 모자라면 key_revoked
  assert.equal(codeOf(() => verifyRelease(base(withRoot(['root-1', 'root-2']), { revocation: { keyIds: new Set(['root-2']), fresh: true } }))), 'registry.key_revoked');
  // 루트 서명 뒤 릴리스 내용을 바꾸면 릴리스 서명이 먼저 깨진다
  const m = withRoot(['root-1', 'root-2']);
  assert.equal(codeOf(() => verifyRelease(base({ ...m, rolloutPercent: 50 }))), 'registry.signature_insufficient');
  assert.notEqual(jcs(releaseContent(m)), jcs(rootChangeContent(m)));
});

test('기간은 서버 도장: 기간만 다시 찍어도 사람 서명은 그대로, 도장 위조·폐기된 타임스탬프 키는 거부(부장 결정 2026-11-13)', () => {
  const doc = signRelease(unsigned());
  const later = stamp(doc, '2026-11-11T00:00:00.000Z', '2026-11-18T00:00:00.000Z');
  assert.equal(verifyRelease(base(later, { now: Date.parse('2026-11-15T00:00:00Z') })).releaseKeyId, 'release-1');
  assert.equal(codeOf(() => verifyRelease(base({ ...doc, expiresAt: '2026-11-13T00:00:00.000Z' }))), 'registry.timestamp_invalid');
  assert.equal(codeOf(() => verifyRelease(base(doc, { revocation: { keyIds: new Set(['timestamp-1']), fresh: true } }))), 'registry.timestamp_invalid');
  const d = decideUpdate({ ...base({ ...doc, expiresAt: '2026-11-13T00:00:00.000Z' }), installedVersion: '1.1.0', state: INITIAL_STATE, deviceId: 'd', transparency: 'verified' });
  assert.deepEqual([d.action, d.action === 'hold' && d.security], ['hold', true]);
  // Blob 공개 주소(https 절대 주소)는 받고, http·쿼리·인코딩은 거부한다
  const blob = 'https://abc123.public.blob.vercel-storage.com/releases/stable/SovereignAX-1.2.0-arm64.zip';
  assert.equal(verifyRelease(base(signRelease(unsigned({ files: [{ url: blob, sha512: sha512(INSTALLER), size: INSTALLER.byteLength }] })))).manifest.files[0]!.url, blob);
  for (const url of ['http://abc123.public.blob.vercel-storage.com/a.zip', `${blob}?x=1`, 'https://abc123.public.blob.vercel-storage.com/a%20b.zip', 'https://x/a.zip']) {
    assert.equal(codeOf(() => parseManifest(wire(signRelease(unsigned({ files: [{ url, sha512: sha512(INSTALLER), size: 1 }] }))))), 'update.manifest_invalid', url);
  }
});

test('폐기 목록 신선도를 잃으면 새 릴리스를 받지 않는다(D09 §8.4)', () => {
  const doc = signRelease(unsigned());
  assert.equal(codeOf(() => verifyRelease(base(doc, { revocation: { keyIds: new Set(), fresh: false } }))), 'registry.revocation_stale');
});

test('모양: 모르는 필드·경로가 든 파일 이름·중복 파일·빈 파일 목록은 거부', () => {
  const g = signRelease(unsigned());
  for (const bad of [
    { ...g, extra: 1 },
    { ...g, files: [{ ...g.files[0]!, url: '../evil.exe' }] },
    { ...g, files: [{ ...g.files[0]!, url: 'a\nb' }] },
    { ...g, files: [{ ...g.files[0]!, url: '.hidden.exe' }] },
    { ...g, files: [g.files[0]!, g.files[0]!] },
    { ...g, files: [] },
    { ...g, files: [{ ...g.files[0]!, extra: true }] },
    { ...g, files: [{ ...g.files[0]!, size: 0 }] },
    { ...g, releaseDate: '2026-11-05 00:00:00' },
    { ...g, rolloutPercent: 101 },
    null,
    [],
  ]) {
    assert.equal(codeOf(() => verifyRelease(base(bad))), 'update.manifest_invalid', JSON.stringify(bad)?.slice(0, 80));
  }
});

test('투명성 로그 확인 전에는 받지 않는다(ADR-028 결정 2), 롤아웃 차례가 아니면 기다린다', () => {
  const doc = signRelease(unsigned());
  const run = (over: Record<string, unknown>) => decideUpdate({ ...base(doc), installedVersion: '1.1.0', state: INITIAL_STATE, deviceId: 'dev-a', transparency: 'verified', ...over });
  const un = run({ transparency: 'unverified' });
  assert.deepEqual([un.action, un.action === 'hold' && un.code], ['hold', 'update.transparency_unverified']);
  assert.equal(un.state.lastSuccessAt, null, '로그 미확인은 확인 성공이 아니다');
  assert.equal(un.state.highestSeen?.version, '1.2.0', '서명이 맞은 버전은 롤백 기준으로 올린다');
  const mm = run({ transparency: 'head_mismatch' });
  assert.deepEqual([mm.action, mm.action === 'hold' && mm.code, mm.action === 'hold' && mm.security], ['hold', 'registry.head_mismatch', true]);
  assert.equal(run({ transparency: 'unverified', policy: { requireTransparency: false } }).action, 'download');
  // 롤아웃: 0%면 아무도, 버킷 < 비율인 기기만
  const zero = decideUpdate({ ...base(signRelease(unsigned({ rolloutPercent: 0 }))), installedVersion: '1.1.0', state: INITIAL_STATE, deviceId: 'dev-a', transparency: 'verified' });
  assert.deepEqual([zero.action, zero.action === 'none' && zero.reason], ['none', 'rollout_wait']);
  const b = rolloutBucket(rolloutId('1.2.0'), 'dev-a');
  assert.ok(b >= 0 && b < 100);
  const at = (pct: number) => decideUpdate({ ...base(signRelease(unsigned({ rolloutPercent: pct }))), installedVersion: '1.1.0', state: INITIAL_STATE, deviceId: 'dev-a', transparency: 'verified' }).action;
  assert.equal(at(b), 'none');
  assert.equal(at(b + 1 > 100 ? 100 : b + 1), 'download');
  // 버킷은 API.md 공식 그대로(고정 값)
  const h = createHash('sha256').update('SAX-rollout-v1\0sax-desktop@1.2.0\0dev-a').digest();
  assert.equal(b, h.readUInt32BE(0) % 100);
});

test('설치 시점: 실행 중·커밋 구간·데몬 실행 중에는 미룬다, 14일 미확인 알림', () => {
  assert.deepEqual(installGate({ runActive: false, commitZone: false, daemonRunning: false }), { install: true });
  assert.deepEqual(installGate({ runActive: true, commitZone: true, daemonRunning: true }), { install: false, reason: 'commit_zone' });
  assert.deepEqual(installGate({ runActive: true, commitZone: false, daemonRunning: false }), { install: false, reason: 'run_active' });
  assert.deepEqual(installGate({ runActive: false, commitZone: false, daemonRunning: true }), { install: false, reason: 'daemon_running' });
  const day = 24 * 3600_000;
  assert.equal(needsStaleNotice({ highestSeen: null, lastSuccessAt: NOW - 14 * day }, 0, NOW), false);
  assert.equal(needsStaleNotice({ highestSeen: null, lastSuccessAt: NOW - 14 * day - 1 }, 0, NOW), true);
  assert.equal(needsStaleNotice(INITIAL_STATE, NOW - day, NOW), false, '처음이면 설치 시각부터 센다');
});

test('업데이터 소스는 송신 모듈·Electron·자식 프로세스를 쓰지 않는다(순수 검증 계층)', () => {
  const dir = path.join(import.meta.dirname, '../packages/updater/src');
  const allowed = new Set(['node:crypto', 'node:fs', 'node:fs/promises']);
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/from '([^']+)'/g)) {
      const spec = m[1]!;
      assert.ok(spec.startsWith('./') || allowed.has(spec), `${f}: ${spec}`);
    }
    assert.doesNotMatch(src, /\bimport\(|\brequire\(|\bfetch\(/, f);
  }
});
