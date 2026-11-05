// M1-4 레지스트리 신뢰(D03 §3.1·§7.1, D09 §8): Ed25519 2-of-3(서로 다른 핀 키), 폐기 목록(루트 2-of-3·24시간·축소 금지),
// keyEpoch 안 단조 버전(+1000), 타임스탬프 신선도 서명, issuedAt 미래 거부, 정책 수용(긴급 키·보류), status(하향 전용·72시간 긴급 만료),
// 투명성 로그 헤드 비교(RFC 9162 일관성 증명, E-14).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  acceptPolicy, acceptRevoked, acceptStatus, consistencyProof, contentBytes, countSignatures, effectiveStatus, headMismatch, merkleRoot,
  statusFreshness, verifyConsistency, versionProblem, type AcceptedPolicy, type AcceptedRevoked, type AcceptedStatus, type Policy, type RegistryStatus, type RevokedKeys,
} from '@sax/engine/core';
import { POLICY_EXAMPLE, sigOf, signTimestamped, testKeys } from './core-fixtures.ts';

const K = testKeys();
const H = 3_600_000;
const NOW = Date.parse('2026-10-28T12:00:00+09:00');
const iso = (t: number) => new Date(t).toISOString();
const fresh = { issuedAt: iso(NOW - H), expiresAt: iso(NOW + 23 * H) };

describe('countSignatures (2-of-3, 서로 다른 핀 키)', () => {
  const data = Buffer.from('payload');
  const keys = K.roots.packageKeys;
  it('서로 다른 두 키면 2', () => assert.equal(countSignatures(data, [sigOf(K.pkg[0]!, data), sigOf(K.pkg[1]!, data)], keys, new Set()).valid.length, 2));
  it('같은 키 두 번은 한 번만 센다', () => assert.equal(countSignatures(data, [sigOf(K.pkg[0]!, data), sigOf(K.pkg[0]!, data)], keys, new Set()).valid.length, 1));
  it('핀 고정되지 않은 키·다른 데이터의 서명·다른 역할 키는 세지 않는다', () => {
    const other = sigOf(K.pkg[1]!, Buffer.from('other'));
    const r = countSignatures(data, [sigOf(K.pkg[0]!, data), other, sigOf(K.pol[0]!, data), { ...sigOf(K.pol[1]!, data), keyId: 'pkg-3' }], keys, new Set());
    assert.deepEqual(r.valid, ['pkg-1']);
  });
  it('폐기 키의 서명은 세지 않고 따로 보고한다(registry.key_revoked)', () => {
    const r = countSignatures(data, [sigOf(K.pkg[0]!, data), sigOf(K.pkg[1]!, data)], keys, new Set(['pkg-2']));
    assert.deepEqual([r.valid, r.revoked], [['pkg-1'], ['pkg-2']]);
  });
  it('잘린 서명 문자열은 무효', () => assert.equal(countSignatures(data, [{ ...sigOf(K.pkg[0]!, data), sig: 'AAAA' }], keys, new Set()).valid.length, 0));
});

describe('versionProblem (같은 keyEpoch 안 단조, +1000)', () => {
  const s = { keyEpoch: 1, monotonic: 100 };
  it('처음은 무엇이든 받는다', () => assert.equal(versionProblem(null, s), null));
  it('같거나 작으면 롤백', () => {
    assert.equal(versionProblem(s, { keyEpoch: 1, monotonic: 100 }), 'registry.version_rollback');
    assert.equal(versionProblem(s, { keyEpoch: 1, monotonic: 99 }), 'registry.version_rollback');
  });
  it('+1000까지 받고 +1001은 registry.version_jump_rejected', () => {
    assert.equal(versionProblem(s, { keyEpoch: 1, monotonic: 1100 }), null);
    assert.equal(versionProblem(s, { keyEpoch: 1, monotonic: 1101 }), 'registry.version_jump_rejected');
  });
  it('새 keyEpoch는 그 세대의 첫 값, 옛 keyEpoch는 거부', () => {
    assert.equal(versionProblem(s, { keyEpoch: 2, monotonic: 1 }), null);
    assert.equal(versionProblem(s, { keyEpoch: 0, monotonic: 5000 }), 'registry.key_epoch_rollback');
  });
});

const revoked = (o: Partial<RevokedKeys> = {}, signers = K.root.slice(0, 2)): RevokedKeys =>
  signTimestamped({ revoked: [{ keyId: 'pkg-9', role: 'package', revokedAt: iso(NOW - H) }], monotonic: 5, keyEpoch: 1, ...fresh, signatures: [], timestamp: { keyId: '', alg: 'ed25519', sig: '' }, ...o } as RevokedKeys, signers, K.ts);

describe('acceptRevoked (D09 §8.4)', () => {
  const ok = (r: RevokedKeys, current: AcceptedRevoked | null = null) => acceptRevoked(r, { roots: K.roots, current, now: NOW });
  it('루트 2-of-3 + 타임스탬프면 받는다', () => {
    const r = ok(revoked());
    assert.ok(r.ok && r.accepted.keyIds.has('pkg-9'));
  });
  it('루트 1개 서명·다른 역할 키 서명은 registry.signature_insufficient', () => {
    assert.deepEqual(ok(revoked({}, [K.root[0]!])), { ok: false, code: 'registry.signature_insufficient' });
    assert.deepEqual(ok(revoked({}, [K.pkg[0]!, K.pkg[1]!])), { ok: false, code: 'registry.signature_insufficient' });
  });
  it('revoked_keys.schema.json에 맞지 않으면(표에 없는 필드·중복 keyId) registry.schema_invalid', () => {
    assert.deepEqual(ok(revoked({ restore: ['pkg-9'] } as Partial<RevokedKeys>)), { ok: false, code: 'registry.schema_invalid' });
    assert.deepEqual(ok(revoked({ revoked: [{ keyId: 'pkg-9', role: 'package', revokedAt: iso(NOW - H) }, { keyId: 'pkg-9', role: 'package', revokedAt: iso(NOW - H) }] })), { ok: false, code: 'registry.schema_invalid' });
  });
  it('24시간 넘는 유효기간·미래 issuedAt·위조 타임스탬프는 거부', () => {
    assert.equal(ok(revoked({ issuedAt: iso(NOW), expiresAt: iso(NOW + 25 * H) })).ok, false);
    assert.deepEqual(ok(revoked({ issuedAt: iso(NOW + 10 * 60_000), expiresAt: iso(NOW + 20 * H) })), { ok: false, code: 'registry.issued_in_future' });
    const r = revoked();
    assert.deepEqual(ok({ ...r, timestamp: sigOf(K.ts, Buffer.from('x')) }), { ok: false, code: 'registry.timestamp_invalid' });
  });
  it('이미 만료된 재서명은 신선한 목록을 덮지 않는다(registry.expired_on_arrival)', () => {
    const first = ok(revoked());
    assert.ok(first.ok);
    assert.deepEqual(ok(revoked({ issuedAt: iso(NOW - 25 * H), expiresAt: iso(NOW - H) }), first.accepted), { ok: false, code: 'registry.expired_on_arrival' });
  });
  it('목록 축소는 거부(폐기는 되돌릴 수 없다), 같은 monotonic의 재서명은 받는다', () => {
    const first = ok(revoked());
    assert.ok(first.ok);
    assert.deepEqual(ok(revoked({ revoked: [], monotonic: 6 }), first.accepted), { ok: false, code: 'registry.revoked_shrunk' });
    assert.ok(ok(revoked({ issuedAt: iso(NOW), expiresAt: iso(NOW + 24 * H) }), first.accepted).ok, '내용 같은 신선도 재서명');
    assert.deepEqual(ok(revoked({ revoked: [{ keyId: 'pkg-9', role: 'package', revokedAt: iso(NOW - H) }, { keyId: 'pkg-8', role: 'package', revokedAt: iso(NOW - H) }] }), first.accepted), { ok: false, code: 'registry.version_rollback' }, '내용이 바뀌었는데 monotonic이 같음');
  });
  it('다른 keyEpoch는 registry.key_epoch_mismatch', () => assert.deepEqual(ok(revoked({ keyEpoch: 2 })), { ok: false, code: 'registry.key_epoch_mismatch' }));
  it('루트 키도 폐기된다: 이전 목록에 있는 루트 키의 서명은 다음 목록에서 세지 않는다', () => {
    const rootGone = [{ keyId: 'pkg-9', role: 'package' as const, revokedAt: iso(NOW - H) }, { keyId: 'root-1', role: 'root' as const, revokedAt: iso(NOW - H) }];
    const first = ok(revoked({ revoked: rootGone }));
    assert.ok(first.ok, '폐기 목록 자체가 root-1을 폐기해도 그 목록은 이전 목록 기준으로 센다');
    const next = { revoked: rootGone, monotonic: 6 };
    assert.deepEqual(ok(revoked(next, [K.root[0]!, K.root[1]!]), first.accepted), { ok: false, code: 'registry.signature_insufficient' });
    assert.ok(ok(revoked(next, [K.root[1]!, K.root[2]!]), first.accepted).ok);
  });
  it('타임스탬프 키도 폐기된다: 새 목록이 타임스탬프 키를 폐기하면 그 키의 신선도 서명은 받지 않는다', () => {
    assert.deepEqual(ok(revoked({ revoked: [{ keyId: 'ts-1', role: 'timestamp', revokedAt: iso(NOW - H) }] })), { ok: false, code: 'registry.timestamp_invalid' });
  });
});

const policy = (f: (p: Policy) => void = () => {}, signers = K.pol.slice(0, 2)): Policy => {
  const p = structuredClone(POLICY_EXAMPLE) as unknown as Policy;
  p.issuedAt = fresh.issuedAt;
  p.expiresAt = fresh.expiresAt;
  f(p);
  return signTimestamped(p, signers, K.ts);
};

describe('acceptPolicy (C-26, E-04, E-05)', () => {
  const run = (p: Policy, current: AcceptedPolicy | null = null, o: { revoked?: string[]; hold?: boolean } = {}) =>
    acceptPolicy(p, { roots: K.roots, revoked: new Set(o.revoked ?? []), current, hold: o.hold ?? false, now: NOW });
  const base = () => {
    const r = run(policy());
    assert.ok(r.ok);
    return r.accepted;
  };
  it('정책 키 2-of-3이면 받고 상한 밖 필드는 클램프(CE-16)', () => {
    const r = run(policy((p) => (p.portalMode.gov24 = 'auto')));
    assert.ok(r.ok);
    assert.equal(r.accepted.policy.portalMode.gov24, 'postprocess');
    assert.equal(r.accepted.raw.portalMode.gov24, 'auto');
    assert.deepEqual(r.events, ['policy.clamped']);
  });
  it('서명 1개(긴급 키 아님)·패키지 키 서명은 registry.signature_insufficient', () => {
    assert.equal(run(policy(undefined, [K.pol[0]!])).ok, false);
    assert.deepEqual(run(policy(undefined, [K.pkg[0]!, K.pkg[1]!])), { ok: false, code: 'registry.signature_insufficient', events: [] });
  });
  it('폐기된 정책 키는 세지 않는다', () => assert.deepEqual(run(policy(), null, { revoked: ['pol-2'] }), { ok: false, code: 'registry.signature_insufficient', events: ['registry.key_revoked'] }));
  it('1인 긴급 키: 엄격하게 보수적이면 받고, 완화·현재 정책 없음이면 policy.rejected_not_conservative', () => {
    const cur = base();
    const down = run(policy((p) => { p.monotonic += 1; p.portalMode.hometax = 'assisted'; }, [K.emergency]), cur);
    assert.ok(down.ok && down.accepted.emergency);
    const up = run(policy((p) => { p.monotonic += 1; p.limits.hometax.runsPerDayPerProfile = 99; }, [K.emergency]), cur);
    assert.deepEqual(up, { ok: false, code: 'policy.rejected_not_conservative', events: ['policy.rejected_not_conservative'] });
    assert.equal(run(policy((p) => (p.portalMode.hometax = 'assisted'), [K.emergency])).ok, false);
  });
  it('타임스탬프 위조·72시간 초과·미래 issuedAt은 거부', () => {
    const p = policy();
    assert.equal(run({ ...p, timestamp: sigOf(K.ts, Buffer.from('x')) }).ok, false);
    assert.deepEqual(run(policy((q) => { q.issuedAt = iso(NOW); q.expiresAt = iso(NOW + 73 * H); })), { ok: false, code: 'policy.validity_too_long', events: [] });
    assert.deepEqual(run(policy((q) => { q.issuedAt = iso(NOW + 6 * 60_000); q.expiresAt = iso(NOW + 24 * H); })), { ok: false, code: 'policy.issued_in_future', events: [] });
  });
  it('타임스탬프가 본문을 덮지 않는다: 서명 뒤 issuedAt만 바꾸면 거부, 같은 내용 재서명은 받는다', () => {
    const cur = base();
    const p = policy();
    assert.equal(run({ ...p, expiresAt: iso(NOW + 30 * H) }).ok, false);
    const restamp = policy((q) => { q.issuedAt = iso(NOW); q.expiresAt = iso(NOW + 48 * H); });
    assert.ok(run(restamp, cur).ok);
  });
  it('내용이 바뀌었는데 monotonic 그대로면 롤백, +1001이면 점프 거부', () => {
    const cur = base();
    assert.deepEqual(run(policy((p) => (p.run.l2MaxAttempts = 2)), cur), { ok: false, code: 'registry.version_rollback', events: [] });
    assert.deepEqual(run(policy((p) => (p.monotonic += 1001)), cur), { ok: false, code: 'registry.version_jump_rejected', events: [] });
  });
  it('보류(헤드 불일치·폐기 목록 신선도 상실) 중에는 엄격하게 보수적인 정책만', () => {
    const cur = base();
    assert.deepEqual(run(policy((p) => { p.monotonic += 1; p.run.l2MaxAttempts = 2; }), cur, { hold: true }), { ok: false, code: 'registry.update_held', events: [] });
    assert.ok(run(policy((p) => { p.monotonic += 1; p.portalMode.hometax = 'assisted'; }), cur, { hold: true }).ok);
  });
  it('스키마 위반·다른 keyEpoch는 거부', () => {
    assert.equal(run(policy((p) => ((p.browser as { remoteDebuggingPort: string }).remoteDebuggingPort = 'allowed'))).ok, false);
    assert.deepEqual(run(policy((p) => (p.keyEpoch = 2))), { ok: false, code: 'registry.key_epoch_mismatch', events: [] });
  });
});

const status = (o: Partial<RegistryStatus> = {}, signers = K.pol.slice(0, 2)): RegistryStatus =>
  signTimestamped({ monotonic: 10, keyEpoch: 1, ...fresh, portalModeCeiling: { hometax: 'auto' }, killPlaybooks: [], signatures: [], timestamp: { keyId: '', alg: 'ed25519', sig: '' }, ...o } as RegistryStatus, signers, K.ts);

describe('acceptStatus (B-22, E-04, E-05)', () => {
  const run = (s: RegistryStatus, current: AcceptedStatus | null = null, now = NOW) => acceptStatus(s, { roots: K.roots, revoked: new Set(), current, now });
  const base = () => {
    const r = run(status());
    assert.ok(r.ok);
    return r.accepted;
  };
  it('정책 키 2-of-3이면 받는다', () => assert.ok(run(status()).ok));
  it('JCS로 직렬화할 수 없는 값(외톨이 서로게이트)은 던지지 않고 registry.schema_invalid', () => {
    const s = status();
    assert.deepEqual(run({ ...s, killPlaybooks: [] , portalModeCeiling: {}, timestamp: { ...s.timestamp, keyId: 'ts-\ud800' } }), { ok: false, code: 'registry.schema_invalid', events: [] });
    assert.deepEqual(acceptRevoked({ ...revoked(), revoked: [{ keyId: 'pkg-9', role: 'package', revokedAt: iso(NOW - H) }], timestamp: { keyId: '\udc00', alg: 'ed25519', sig: 'x' } } as RevokedKeys, { roots: K.roots, current: null, now: NOW }), { ok: false, code: 'registry.schema_invalid' });
  });
  it('이미 만료된 재서명은 신선한 status를 덮지 않는다(registry.expired_on_arrival)', () => {
    const cur = base();
    assert.deepEqual(run(status({ issuedAt: iso(NOW - 30 * H), expiresAt: iso(NOW - H) }), cur), { ok: false, code: 'registry.expired_on_arrival', events: [] });
  });
  it('폐기된 타임스탬프 키의 신선도 서명은 registry.timestamp_invalid', () =>
    assert.deepEqual(acceptStatus(status(), { roots: K.roots, revoked: new Set(['ts-1']), current: null, now: NOW }), { ok: false, code: 'registry.timestamp_invalid', events: [] }));
  it('직전 status가 없어도 엄격하게 보수적인 긴급 status는 받는다(첫 설치, 팀장 결정 2026-11-05)', () =>
    assert.ok(run(status({ portalModeCeiling: { hometax: 'assisted' } }, [K.emergency])).ok));
  it('status.schema.json에 맞지 않으면(표에 없는 필드·잘못된 플레이북 id) 서명 전에 registry.schema_invalid', () => {
    const r = run(status({ allowCaptchaAuto: true } as Partial<RegistryStatus>));
    assert.ok(!r.ok && r.code === 'registry.schema_invalid');
    const k = run(status({ killPlaybooks: ['../x'] }));
    assert.ok(!k.ok && k.code === 'registry.schema_invalid');
  });
  it('1인 긴급 키: 하향·kill 추가만', () => {
    const cur = base();
    assert.ok(run(status({ monotonic: 11, portalModeCeiling: { hometax: 'assisted' } }, [K.emergency]), cur).ok);
    assert.ok(run(status({ monotonic: 11, killPlaybooks: ['hometax.invoice.issue'] }, [K.emergency]), cur).ok);
    assert.equal(run(status({ monotonic: 11 }, [K.emergency]), cur).ok, false, '바뀐 것이 없으면 엄격하지 않다');
    const k = run(status({ monotonic: 11, killPlaybooks: ['hometax.invoice.cancel'] }), cur);
    assert.ok(k.ok);
    assert.equal(run(status({ monotonic: 12, killPlaybooks: [] }, [K.emergency]), k.accepted).ok, false, 'kill 해제는 긴급 키로 불가');
  });
  it('미래 issuedAt·48시간 넘는 유효기간은 거부', () => {
    assert.deepEqual(run(status({ issuedAt: iso(NOW + 6 * 60_000), expiresAt: iso(NOW + 24 * H) })), { ok: false, code: 'registry.issued_in_future', events: [] });
    assert.deepEqual(run(status({ issuedAt: iso(NOW), expiresAt: iso(NOW + 49 * H) })), { ok: false, code: 'registry.status_validity_too_long', events: [] });
  });
  it('긴급 하향은 내용 첫 발행 72시간 뒤 마지막 2-of-3 값으로 되돌린다(재서명으로 늘어나지 않음)', () => {
    const quorum = base();
    const e = run(status({ monotonic: 11, portalModeCeiling: { hometax: 'postprocess' } }, [K.emergency]), quorum);
    assert.ok(e.ok);
    const later = NOW + 47 * H;
    const re = run(status({ monotonic: 11, portalModeCeiling: { hometax: 'postprocess' }, issuedAt: iso(later), expiresAt: iso(later + 24 * H) }, [K.emergency]), e.accepted, later);
    assert.ok(re.ok, '타임스탬프 재서명');
    assert.equal(re.accepted.contentIssuedAt, e.accepted.contentIssuedAt);
    assert.equal(effectiveStatus(re.accepted, quorum, NOW + 71 * H)?.portalModeCeiling.hometax, 'postprocess');
    assert.equal(effectiveStatus(re.accepted, quorum, NOW + 73 * H)?.portalModeCeiling.hometax, 'auto');
  });
  it('status 나이: 48시간 넘으면 stale, 72시간 넘으면 데몬 정지, 없으면 데몬 정지', () => {
    const s = { issuedAt: iso(NOW), expiresAt: iso(NOW + 48 * H) };
    assert.equal(statusFreshness(s, NOW + 47 * H), 'fresh');
    assert.equal(statusFreshness({ issuedAt: iso(NOW), expiresAt: iso(NOW + 24 * H) }, NOW + 25 * H), 'stale', 'expiresAt이 48시간보다 먼저면 그때부터 stale');
    assert.equal(statusFreshness(s, NOW + 49 * H), 'stale');
    assert.equal(statusFreshness(s, NOW + 73 * H), 'daemon_stop');
    assert.equal(statusFreshness(null, NOW), 'daemon_stop');
  });
  it('서명 대상은 신선도 필드를 뺀 본문', () => {
    const s = status();
    assert.equal(contentBytes(s).toString(), contentBytes({ ...s, issuedAt: 'x', expiresAt: 'y', timestamp: 'z', signatures: [] }).toString());
  });
});

describe('투명성 로그 헤드 비교 (RFC 9162, E-14)', () => {
  const leaves = Array.from({ length: 13 }, (_, i) => Buffer.from(`entry-${i}`));
  const head = (n: number) => ({ treeSize: n, rootHash: merkleRoot(leaves.slice(0, n)).toString('hex') });
  it('RFC 9162 빈 트리 해시', () => assert.equal(merkleRoot([]).toString('hex'), createHash('sha256').digest('hex')));
  it('모든 m < n ≤ 13에서 일관성 증명이 검증된다', () => {
    for (let n = 2; n <= 13; n++) for (let m = 1; m < n; m++) assert.ok(verifyConsistency(head(m), head(n), consistencyProof(m, leaves.slice(0, n))), `${m}→${n}`);
  });
  it('빈 트리(m = 0)에서의 증명은 빈 배열이고 검증된다, m > n은 던진다(Bugbot #52 4차)', () => {
    for (let n = 0; n <= 5; n++) {
      assert.deepEqual(consistencyProof(0, leaves.slice(0, n)), []);
      assert.ok(verifyConsistency(head(0), head(n), []), `0→${n}`);
    }
    assert.throws(() => consistencyProof(4, leaves.slice(0, 3)), /consistency_bad_size/);
  });
  it('변조된 증명·다른 트리는 실패', () => {
    const p = consistencyProof(5, leaves.slice(0, 11));
    p[0] = Buffer.alloc(32);
    assert.equal(verifyConsistency(head(5), head(11), p), false);
    const forked = [...leaves.slice(0, 3), Buffer.from('evil'), ...leaves.slice(4, 11)];
    const fh = { treeSize: 11, rootHash: merkleRoot(forked).toString('hex') };
    assert.equal(verifyConsistency(head(5), fh, consistencyProof(5, forked)), false);
  });
  it('headMismatch: 같은 크기에서 다른 루트, 크기가 다른데 증명 없음/틀림이면 불일치', () => {
    assert.equal(headMismatch(head(7), head(7), null), false);
    assert.equal(headMismatch(head(7), { treeSize: 7, rootHash: '00'.repeat(32) }, null), true);
    assert.equal(headMismatch(head(7), head(9), null), true);
    assert.equal(headMismatch(head(7), head(9), consistencyProof(7, leaves.slice(0, 9))), false);
    assert.equal(headMismatch(head(9), head(7), consistencyProof(7, leaves.slice(0, 9))), false, '미러가 뒤처져도 증명이 맞으면 일치');
  });
});
