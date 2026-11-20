import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  AIK_PURPOSES, CTX, SHARE_MAX_BODY_CHARS, SHARE_PAD_BUCKETS, VM_PURPOSES, addDevice, b64url, deriveShareKey, deriveShareSignSeed, ed25519Keygen, ed25519Public, fromB64url,
  hkdfSha256, initialDeviceList, latestShareRow, mergeShareIssues, mergeShareParties, newShareRowId, openShareRow, randomBytes, revokeDevice, sealShareRow, shareEpoch, shareKeyInfo, softSigner,
  x25519Keygen, xSeal, concat, utf8, jcsBytes, type ShareRowCore, type ShareSign, type ShareVerifyKeys,
  SHARE_KINDS, SHARE_MAX_EPOCH, SHARE_MOBILE_KINDS, SHARE_MONEY_OPEN_MAX, SHARE_PARTY_ITEMS_MAX, SHARE_TASK_TTL_MS, type ShareMoney,
  b64, decodeEnvelope, encodeEnvelope, makeShareKeyBody, readShareKeyBody, ulid, type Envelope, type ShareKeyBody,
} from '@sax/remote';
import { SHARE } from '../services/account/src/constants.ts';

function account() {
  const rk = randomBytes(32);
  const ws = softSigner(deriveShareSignSeed(rk), [CTX.share]);
  const pcSign: ShareSign = (m) => ws.sign(CTX.share, m);
  const pc = randomUUID();
  const phoneKey = ed25519Keygen();
  const phone = randomUUID();
  const vm = softSigner(phoneKey.secretKey, VM_PURPOSES);
  const phoneSign: ShareSign = (m) => vm.sign(CTX.share, m);
  const keys: ShareVerifyKeys = { sharePub: ed25519Public(deriveShareSignSeed(rk)), mobileSignPub: (id) => (id === phone ? phoneKey.publicKey : null) };
  return { rk, key: (e: number) => deriveShareKey(rk, e), pc, pcSign, phone, phoneSign, phoneKey, keys };
}
const issue = (a: ReturnType<typeof account>, over: Partial<ShareRowCore<'issue'>['body']> = {}, at = 1_800_000_000_000): ShareRowCore<'issue'> => ({
  v: 1, row_id: newShareRowId(), kind: 'issue', epoch: 0, at, dev: a.pc, by: 'desktop',
  body: { doc: 'tax_invoice', approvalNo: '202611174100000012345678', writtenOn: '2026-11-17', buyerBizNo: '1234567890', buyerName: '가나다상사', supply: 1_000_000, tax: 100_000, how: 'app', ...over },
});
const task = (a: ReturnType<typeof account>): ShareRowCore<'task'> => ({
  v: 1, row_id: newShareRowId(), kind: 'task', epoch: 0, at: 1_800_000_000_000, dev: a.phone, by: 'mobile',
  body: { do: 'tax_invoice.issue', buyerBizNo: '1234567890', supply: 1_000_000, tax: 100_000, item: '11월 용역' },
});
const pcRow = <K extends 'party' | 'self' | 'money'>(a: ReturnType<typeof account>, kind: K, body: ShareRowCore<K>['body'], at = 1_800_000_000_000, dev = a.pc): ShareRowCore<K> => ({
  v: 1, row_id: newShareRowId(), kind, epoch: 0, at, dev, by: 'desktop', body,
});
const moneyBody = (over: Partial<ShareMoney> = {}): ShareMoney => ({
  asOf: '2026-11-17T03:00:00.000Z', latestDay: '2026-11-16', stale: false,
  recv: {
    count: 3, total: 3_300_000, overdueCount: 1, overdueTotal: 1_100_000,
    oldest: { cp: '가나다상사', writtenOn: '2026-09-30', daysOver: 17 },
    top: [{ cp: '가나다상사', total: 2_200_000, count: 2 }, { cp: '라마바', total: 1_100_000, count: 1 }],
    open: ['202611174100000012345678', '202609304100000000000007'],
  },
  pay: { count: 1, total: 550_000, overdueCount: 0, overdueTotal: 0, top: [{ cp: '사아자', total: 550_000, count: 1 }] },
  cash: { month: '2026-11', through: '2026-11-16', complete: false, in: 4_000_000, out: 2_500_000, net: 1_500_000, balance: null, nextIn: 3_300_000, nextOut: 550_000 },
  ...over,
});

describe('계정 공유 기록: 키와 세대', () => {
  it('K_share는 세대마다 다르고 RK에서만 나온다. Ws 시드는 K_share와 다르다', () => {
    const rk = randomBytes(32);
    assert.deepEqual(deriveShareKey(rk, 0), hkdfSha256(rk, 'share/v1/0', 32));
    assert.notDeepEqual(deriveShareKey(rk, 0), deriveShareKey(rk, 1));
    assert.notDeepEqual(deriveShareKey(rk, 0), deriveShareKey(randomBytes(32), 0));
    assert.notDeepEqual(deriveShareSignSeed(rk), deriveShareKey(rk, 0));
    assert.throws(() => shareKeyInfo(-1));
    assert.throws(() => shareKeyInfo(65));
    assert.throws(() => shareKeyInfo(1.5));
  });

  it('세대는 기기 목록의 폐기 레코드 수다. 기기를 끊으면 하나 오른다', async () => {
    const rk = randomBytes(32);
    const aik = softSigner(hkdfSha256(rk, 'aik', 32), AIK_PURPOSES);
    const dev = (role: 'desktop' | 'mobile') => ({ deviceId: randomUUID(), role, noisePub: x25519Keygen().publicKey, signPub: ed25519Keygen().publicKey, registeredAt: 1 });
    const pc = dev('desktop');
    const phone = dev('mobile');
    let list = await initialDeviceList(aik, pc);
    assert.equal(shareEpoch(list), 0);
    list = await addDevice(aik, list, phone);
    assert.equal(shareEpoch(list), 0);
    list = await revokeDevice(aik, list, phone.deviceId);
    assert.equal(shareEpoch(list), 1);
  });
});

describe('계정 공유 기록: 줄 봉인과 열기', () => {
  it('PC가 쓴 발급 기록을 다른 기기가 열고 Ws 서명을 확인한다. 본문은 버킷 크기로만 보인다', async () => {
    const a = account();
    const row = issue(a);
    const wire = await sealShareRow(a.key(0), row, a.pcSign);
    assert.deepEqual({ rowId: wire.rowId, kind: wire.kind, epoch: wire.epoch }, { rowId: row.row_id, kind: 'issue', epoch: 0 });
    assert.ok((SHARE_PAD_BUCKETS as readonly number[]).includes(fromB64url(wire.body).length - 40));
    assert.ok(wire.body.length <= SHARE_MAX_BODY_CHARS);
    assert.ok(!wire.body.includes('1234567890') && !Buffer.from(fromB64url(wire.body)).includes('가나다상사'));
    const got = openShareRow(a.key(0), wire, a.keys);
    assert.deepEqual(got, { ok: true, row });
    const small = await sealShareRow(a.key(0), { v: 1, row_id: newShareRowId(), kind: 'task_result', epoch: 0, at: 5, dev: a.pc, by: 'desktop', body: { taskRow: newShareRowId(), outcome: 'cancelled' } }, a.pcSign);
    assert.equal(fromB64url(small.body).length, SHARE_PAD_BUCKETS[0] + 40);
  });

  it('폰이 맡긴 일은 그 폰의 Vm으로 서명한다. 목록에 없는 폰의 줄은 signer로 끝난다', async () => {
    const a = account();
    const row = task(a);
    const wire = await sealShareRow(a.key(0), row, a.phoneSign);
    assert.deepEqual(openShareRow(a.key(0), wire, a.keys), { ok: true, row });
    assert.deepEqual(openShareRow(a.key(0), wire, { ...a.keys, mobileSignPub: () => null }), { ok: false, reason: 'signer' });
    assert.deepEqual(openShareRow(a.key(0), wire, { ...a.keys, mobileSignPub: () => ed25519Keygen().publicKey }), { ok: false, reason: 'signature' });
  });

  it('폰은 PC 줄을 지어낼 수 없다: K_share가 있어도 Ws 서명이 없으면 signature, 폰 이름으로 PC 종류를 쓰면 봉인부터 막힌다', async () => {
    const a = account();
    const forged = await sealShareRow(a.key(0), issue(a), a.phoneSign);
    assert.deepEqual(openShareRow(a.key(0), forged, a.keys), { ok: false, reason: 'signature' });
    await assert.rejects(sealShareRow(a.key(0), { ...issue(a), dev: a.phone, by: 'mobile' }, a.phoneSign), /row shape/);
    const core = { ...issue(a), dev: a.phone, by: 'mobile' as const };
    const sig = await a.phoneSign(jcsBytes(core));
    const padded = new Uint8Array(1024);
    const plain = jcsBytes({ core, sig: b64url(sig) });
    assert.ok(plain.length < 1024);
    padded.set(plain);
    padded[plain.length] = 0x80;
    const aad = concat(utf8(CTX.share), jcsBytes({ epoch: 0, kind: 'issue', row_id: core.row_id }));
    const wire = { rowId: core.row_id, kind: 'issue' as const, epoch: 0, body: b64url(xSeal(a.key(0), padded, aad)) };
    assert.deepEqual(openShareRow(a.key(0), wire, a.keys), { ok: false, reason: 'shape' });
  });

  it('서버가 바깥(종류·세대·줄 id)이나 본문을 바꾸면 열리지 않는다', async () => {
    const a = account();
    const wire = await sealShareRow(a.key(0), issue(a), a.pcSign);
    assert.deepEqual(openShareRow(a.key(0), { ...wire, kind: 'party' }, a.keys), { ok: false, reason: 'key' });
    assert.deepEqual(openShareRow(a.key(0), { ...wire, rowId: newShareRowId() }, a.keys), { ok: false, reason: 'key' });
    assert.deepEqual(openShareRow(a.key(0), { ...wire, epoch: 1 }, a.keys), { ok: false, reason: 'key' });
    const raw = fromB64url(wire.body);
    raw[40] ^= 1;
    assert.deepEqual(openShareRow(a.key(0), { ...wire, body: b64url(raw) }, a.keys), { ok: false, reason: 'key' });
    const other = await sealShareRow(a.key(0), issue(a, { approvalNo: '202611174100000099999999' }), a.pcSign);
    assert.deepEqual(openShareRow(a.key(0), { ...wire, body: other.body }, a.keys), { ok: false, reason: 'key' });
    for (const bad of ['', 'AAAA', '!!!', 'A'.repeat(SHARE_MAX_BODY_CHARS + 1)]) assert.equal(openShareRow(a.key(0), { ...wire, body: bad }, a.keys).ok, false);
  });

  it('세대가 오르면 끊긴 폰의 옛 키로는 새 줄을 열 수 없고, 옛 줄은 옛 키로 계속 열린다', async () => {
    const a = account();
    const old = await sealShareRow(a.key(0), issue(a), a.pcSign);
    const fresh = await sealShareRow(a.key(1), { ...issue(a, { approvalNo: '202611184100000000000001' }), epoch: 1 }, a.pcSign);
    assert.deepEqual(openShareRow(a.key(0), fresh, a.keys), { ok: false, reason: 'key' });
    assert.equal(openShareRow(a.key(1), fresh, a.keys).ok, true);
    assert.equal(openShareRow(a.key(0), old, a.keys).ok, true);
    const core = issue(a);
    await assert.rejects(sealShareRow(a.key(1), { ...core, epoch: 70 }, a.pcSign), /row shape/);
  });

  it('본문 규칙: 모르는 필드·형식 밖 값·너무 큰 입력은 봉인하지 않는다', async () => {
    const a = account();
    const bad: ShareRowCore[] = [
      issue(a, { approvalNo: 'x' }),
      issue(a, { approvalNo: '20261117-41000000-12345678' }),
      issue(a, { buyerBizNo: '123-45-67890' }),
      issue(a, { writtenOn: '2026/11/17' }),
      issue(a, { supply: 1.5 }),
      { ...issue(a), body: { ...issue(a).body, password: 'p' } as never },
      { ...task(a), body: { ...task(a).body, do: 'bank.transfer' as never } },
      { ...task(a), body: { ...task(a).body, supply: 0 } },
      { ...task(a), body: { ...task(a).body, supply: -1_000_000, tax: -100_000 } },
      { ...task(a), body: { ...task(a).body, note: 'x'.repeat(201) } },
      { ...task(a), body: { ...task(a).body, inputs: { memo: 'x' } } as never },
      { ...task(a), body: { ...task(a).body, writtenOn: '2026-11-01' } as never },
      { v: 1, row_id: newShareRowId(), kind: 'task_result', epoch: 0, at: 1, dev: a.pc, by: 'desktop', body: { taskRow: newShareRowId(), outcome: 'issued' } },
      { v: 1, row_id: newShareRowId(), kind: 'task_result', epoch: 0, at: 1, dev: a.pc, by: 'desktop', body: { taskRow: newShareRowId(), outcome: 'failed', code: '공급가액 1,000,000' } },
      { v: 1, row_id: newShareRowId(), kind: 'party', epoch: 0, at: 1, dev: a.pc, by: 'desktop', body: { bizNo: '1234567890', name: '' } },
      { ...issue(a), row_id: 'short' },
      { ...issue(a), dev: 'not-a-uuid' },
      { ...issue(a), at: 0 },
    ];
    for (const row of bad) await assert.rejects(sealShareRow(a.key(0), row, a.pcSign), /row shape/, JSON.stringify(row.body));
    await assert.rejects(sealShareRow(randomBytes(16), issue(a), a.pcSign), /key/);
    await assert.rejects(sealShareRow(a.key(0), issue(a), async () => new Uint8Array(10)), /signature/);
  });
});

describe('계정 공유 기록: 내 사업자·저장 품목·돈 요약', () => {
  it('내 사업자·품목이 있는 거래처·돈 요약을 PC가 쓰고 다른 기기가 연다. 폰 이름으로는 쓰지 못한다', async () => {
    const a = account();
    const rows: ShareRowCore[] = [
      pcRow(a, 'self', { bizNo: '1112233334', name: '율무상회', rep: '김율무' }),
      pcRow(a, 'party', { bizNo: '1234567890', name: '가나다상사', items: [{ name: '월 관리', unitPrice: 300_000, unit: '식' }, { name: '출장', unitPrice: null, unit: null }] }),
      pcRow(a, 'party', { bizNo: '1234567890', name: '가나다상사', items: [] }),
      pcRow(a, 'money', moneyBody()),
      pcRow(a, 'money', moneyBody({ latestDay: null, stale: true, cash: null, recv: { count: null, total: null, overdueCount: null, overdueTotal: null, oldest: null, top: [] }, pay: { count: null, total: null, overdueCount: null, overdueTotal: null, top: [] } })),
    ];
    for (const row of rows) {
      const wire = await sealShareRow(a.key(0), row, a.pcSign);
      assert.deepEqual(openShareRow(a.key(0), wire, a.keys), { ok: true, row }, row.kind);
      await assert.rejects(sealShareRow(a.key(0), { ...row, dev: a.phone, by: 'mobile' }, a.phoneSign), /row shape/, row.kind);
    }
  });

  it('수정세금계산서는 새 승인번호의 발급 기록이고 금액이 음수일 수 있다', async () => {
    const a = account();
    const row = issue(a, { approvalNo: '202611184100000000000009', supply: -1_000_000, tax: -100_000 });
    assert.deepEqual(openShareRow(a.key(0), await sealShareRow(a.key(0), row, a.pcSign), a.keys), { ok: true, row });
  });

  it('돈 요약은 가장 큰 승인번호 목록도 한 줄에 들어간다', async () => {
    const a = account();
    const open = Array.from({ length: SHARE_MONEY_OPEN_MAX }, (_, i) => `2026111741000000${String(i).padStart(8, '0')}`);
    const row = pcRow(a, 'money', moneyBody({ recv: { ...moneyBody().recv, count: 412, open } }));
    const wire = await sealShareRow(a.key(0), row, a.pcSign);
    assert.equal(fromB64url(wire.body).length, SHARE_PAD_BUCKETS.at(-1)! + 40);
    assert.deepEqual(openShareRow(a.key(0), wire, a.keys), { ok: true, row });
  });

  it('본문 규칙: 거래 내역·계좌 같은 모르는 필드, 0으로 채우지 않은 빈 값, 한도를 넘는 목록은 봉인하지 않는다', async () => {
    const a = account();
    const m = moneyBody();
    const item = { name: '월 관리', unitPrice: 300_000, unit: '식' };
    const bad: ShareRowCore[] = [
      pcRow(a, 'self', { bizNo: '111-22-33334', name: '율무상회' }),
      pcRow(a, 'self', { bizNo: '1112233334', name: '율무상회', address: '서울' } as never),
      pcRow(a, 'party', { bizNo: '1234567890', name: '가', items: Array.from({ length: SHARE_PARTY_ITEMS_MAX + 1 }, () => item) }),
      pcRow(a, 'party', { bizNo: '1234567890', name: '가', items: [{ ...item, unitPrice: -1 }] }),
      pcRow(a, 'party', { bizNo: '1234567890', name: '가', items: [{ name: '월 관리' } as never] }),
      pcRow(a, 'party', { bizNo: '1234567890', name: '가', items: [{ ...item, memo: 'x' } as never] }),
      pcRow(a, 'money', { ...m, asOf: '2026-11-17 12:00' }),
      pcRow(a, 'money', { ...m, latestDay: '어제' }),
      pcRow(a, 'money', { ...m, account: '110-123-456789' } as never),
      pcRow(a, 'money', { ...m, recv: { ...m.recv, total: undefined } } as never),
      pcRow(a, 'money', { ...m, recv: { ...m.recv, top: Array.from({ length: 6 }, () => m.recv.top[0]!) } }),
      pcRow(a, 'money', { ...m, recv: { ...m.recv, top: [{ ...m.recv.top[0]!, memo: '홍길동 입금' } as never] } }),
      pcRow(a, 'money', { ...m, recv: { ...m.recv, open: ['x'] } }),
      pcRow(a, 'money', { ...m, recv: { ...m.recv, open: [m.recv.open![0]!, m.recv.open![0]!] } }),
      pcRow(a, 'money', { ...m, recv: { ...m.recv, open: Array.from({ length: SHARE_MONEY_OPEN_MAX + 1 }, (_, i) => `2026111741000000${String(i).padStart(8, '0')}`) } }),
      pcRow(a, 'money', { ...m, recv: { ...m.recv, oldest: { cp: '가', writtenOn: '2026-09-30', daysOver: -1 } } }),
      pcRow(a, 'money', { ...m, pay: { ...m.pay, rows: [] } } as never),
      pcRow(a, 'money', { ...m, cash: { ...m.cash!, month: '2026-11-01' } }),
      pcRow(a, 'money', { ...m, cash: { ...m.cash!, balance: 1.5 } }),
      pcRow(a, 'money', { ...m, cash: { ...m.cash!, tx: [] } } as never),
      pcRow(a, 'money', { ...m, cash: undefined } as never),
    ];
    for (const row of bad) await assert.rejects(sealShareRow(a.key(0), row, a.pcSign), /row shape/, JSON.stringify(row.body).slice(0, 200));
  });
});

describe('계정 공유 기록: 서버 상수와 같다', () => {
  it('종류·폰이 쓰는 종류·본문 길이·세대 상한·일의 유효 시간이 계정 서비스 SHARE와 같다', () => {
    assert.deepEqual([...SHARE_KINDS], [...SHARE.kinds]);
    assert.deepEqual([...SHARE_MOBILE_KINDS], [...SHARE.mobileKinds]);
    assert.equal(SHARE_MAX_BODY_CHARS, SHARE.maxBodyChars);
    assert.equal(SHARE_MAX_EPOCH, SHARE.maxEpoch);
    assert.equal(SHARE_TASK_TTL_MS, SHARE.taskTtlMs);
  });
});

describe('계정 공유 기록: 읽는 쪽 합치기', () => {
  it('발급 기록은 승인번호마다 한 건이다(두 PC가 같은 건을 올려도)', () => {
    const a = account();
    const first = issue(a);
    const again = { ...issue(a), dev: randomUUID() };
    const other = issue(a, { approvalNo: '202611174100000000000002' });
    assert.deepEqual(mergeShareIssues([first, again, other]), [first, other]);
  });

  it('거래처는 사업자번호마다 마지막에 쓴 값이 이긴다. 받은 순서와 무관하고, 지운 거래처는 빠진다', () => {
    const a = account();
    const party = (bizNo: string, name: string, at: number, dev = a.pc, removed?: true): ShareRowCore<'party'> => ({
      v: 1, row_id: newShareRowId(), kind: 'party', epoch: 0, at, dev, by: 'desktop', body: { bizNo, name, ...(removed ? { removed } : {}) },
    });
    const a1 = party('1234567890', '옛 이름', 10);
    const a2 = party('1234567890', '새 이름', 20);
    const b1 = party('2222222222', '둘째', 5);
    const c1 = party('3333333333', '지울 곳', 5);
    const c2 = party('3333333333', '지울 곳', 6, a.pc, true);
    const names = (rows: ShareRowCore<'party'>[]) => rows.map((r) => r.body.name).sort();
    assert.deepEqual(names(mergeShareParties([a1, a2, b1, c1, c2])), ['둘째', '새 이름']);
    assert.deepEqual(names(mergeShareParties([c2, b1, a2, c1, a1])), ['둘째', '새 이름']);
    const x = party('4444444444', 'ㄱ', 7, '00000000-0000-4000-8000-000000000001');
    const y = party('4444444444', 'ㄴ', 7, '00000000-0000-4000-8000-000000000002');
    assert.deepEqual(names(mergeShareParties([x, y])), ['ㄴ']);
    assert.deepEqual(names(mergeShareParties([y, x])), ['ㄴ']);
  });

  it('내 사업자와 돈 요약은 계정에서 마지막에 쓴 한 줄이다. 받은 순서와 무관하다', () => {
    const a = account();
    const other = '00000000-0000-4000-8000-000000000002';
    const s1 = pcRow(a, 'self', { bizNo: '1112233334', name: '옛 상호' }, 10);
    const s2 = pcRow(a, 'self', { bizNo: '1112233334', name: '새 상호' }, 20);
    assert.equal(latestShareRow([s1, s2])?.body.name, '새 상호');
    assert.equal(latestShareRow([s2, s1])?.body.name, '새 상호');
    assert.equal(latestShareRow<'self'>([]), null);
    const m1 = pcRow(a, 'money', moneyBody({ stale: true }), 30, '00000000-0000-4000-8000-000000000001');
    const m2 = pcRow(a, 'money', moneyBody({ stale: false }), 30, other);
    assert.equal(latestShareRow([m1, m2])?.dev, other);
    assert.equal(latestShareRow([m2, m1])?.dev, other);
  });
});

describe('계정 공유 기록: 폰에 열쇠 주기(share.key, remote-envelope v1.9)', () => {
  const set = (a: ReturnType<typeof account>, epochs: number) => ({ signPub: a.keys.sharePub, keys: Array.from({ length: epochs }, (_, e) => a.key(e)) });
  const PAIR = ulid();
  const wire = (body: object) => decodeEnvelope(encodeEnvelope({ v: 1, type: 'share.key', id: ulid(), pairId: PAIR, from: 'desktop', to: 'mobile', seq: 1, ts: 1, ttl: 300, body } as Envelope)).body as ShareKeyBody;

  it('PC가 세대 0부터 지금 세대까지의 열쇠와 Ws 공개키를 주고, 폰은 그것으로 옛 줄과 새 줄을 열고 서명을 확인한다', async () => {
    const a = account();
    const old = await sealShareRow(a.key(0), issue(a), a.pcSign);
    const fresh = await sealShareRow(a.key(2), { ...issue(a, { approvalNo: '202611184100000000000001' }), epoch: 2 }, a.pcSign);
    const got = readShareKeyBody(wire(makeShareKeyBody(set(a, 3))));
    assert.ok(got);
    assert.equal(got.keys.length, 3);
    const verify: ShareVerifyKeys = { sharePub: got.signPub, mobileSignPub: () => null };
    assert.equal(openShareRow(got.keys[old.epoch]!, old, verify).ok, true);
    assert.equal(openShareRow(got.keys[fresh.epoch]!, fresh, verify).ok, true);
    assert.equal(got.keys[3], undefined);
  });

  it('모양이 다른 묶음은 받지 않는다: 세대가 빠지거나 0에서 시작하지 않거나 길이가 다르면 null, 만드는 쪽도 막는다', () => {
    const a = account();
    const body = makeShareKeyBody(set(a, 3));
    assert.equal(readShareKeyBody({ ...body, shareKeys: [body.shareKeys[0]!, body.shareKeys[2]!] }), null);
    assert.equal(readShareKeyBody({ ...body, shareKeys: body.shareKeys.slice(1) }), null);
    assert.equal(readShareKeyBody({ ...body, shareKeys: [] }), null);
    assert.equal(readShareKeyBody({ ...body, shareSignPub: b64(new Uint8Array(31)) }), null);
    assert.equal(readShareKeyBody({ ...body, shareKeys: [{ epoch: 0, shareKey: b64(new Uint8Array(16)) }] }), null);
    assert.equal(readShareKeyBody({ ...body, shareKeys: [{ epoch: 0, shareKey: '***' }] }), null);
    assert.throws(() => makeShareKeyBody({ signPub: a.keys.sharePub, keys: [] }), /key set shape/);
    assert.throws(() => makeShareKeyBody({ signPub: new Uint8Array(31), keys: [a.key(0)] }), /key set shape/);
    assert.throws(() => makeShareKeyBody({ signPub: a.keys.sharePub, keys: Array.from({ length: SHARE_MAX_EPOCH + 2 }, (_, e) => a.key(Math.min(e, SHARE_MAX_EPOCH))) }), /key set shape/);
    assert.equal(makeShareKeyBody(set(a, SHARE_MAX_EPOCH + 1)).shareKeys.length, 65);
  });

  it('이미 가진 열쇠와 견준다: 세대가 늘어난 같은 계정의 묶음만 받고, 다른 계정·바뀐 값·짧아진 묶음은 받지 않는다', () => {
    const a = account();
    const have = readShareKeyBody(makeShareKeyBody(set(a, 2)))!;
    assert.equal(readShareKeyBody(makeShareKeyBody(set(a, 2)), have)?.keys.length, 2);
    assert.equal(readShareKeyBody(makeShareKeyBody(set(a, 3)), have)?.keys.length, 3);
    assert.equal(readShareKeyBody(makeShareKeyBody(set(a, 1)), have), null, '세대는 내려가지 않는다');
    assert.equal(readShareKeyBody(makeShareKeyBody(set(account(), 3)), have), null, '다른 계정의 열쇠');
    const mixed = makeShareKeyBody({ signPub: a.keys.sharePub, keys: [a.key(0), randomBytes(32), a.key(2)] });
    assert.equal(readShareKeyBody(mixed, have), null, '가진 세대의 값이 다르다');
    assert.equal(readShareKeyBody(makeShareKeyBody({ ...set(a, 3), signPub: ed25519Keygen().publicKey }), have), null, '서명 키가 다르다');
  });
});
