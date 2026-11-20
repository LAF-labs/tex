import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { ColumnCipher, CounterpartyRepo, openDatabase, ProfileRepo, RunRepo, syntheticBizNo, type Db } from '@sax/db';
import { ShareError, ShareService, type ShareOutRow, type ShareStatus } from '@sax/engine';
import { COMMANDS, MAIN_ONLY, READ_QUERIES, SHARE_COMMANDS, SHARE_READ_QUERIES } from '@sax/engine/protocol';
import {
  AIK_PURPOSES, CTX, addDevice, deriveShareKey, deriveShareSignSeed, ed25519Keygen, ed25519Public, hkdfSha256, initialDeviceList, mergeShareIssues, mergeShareParties, newShareRowId,
  openShareRow, sealShareRow, softSigner, x25519Keygen, type DeviceListJson, type ShareKind, type ShareRowCore, type ShareRowWire,
} from '@sax/remote';
import type { DeviceAuth, SharePage, ShareServerRow, ShareVault } from '../apps/desktop/src/remote-ports.ts';
import { engineShareStore, ShareSync, type ShareDevice } from '../apps/desktop/src/share-sync.ts';

const opened: Array<{ db: Db; dir: string }> = [];
after(() => {
  for (const x of opened) {
    x.db.close();
    fs.rmSync(x.dir, { recursive: true, force: true });
  }
});

const approval = (i: number) => `2026111741000000${String(i).padStart(8, '0')}`;
const me = syntheticBizNo(1);
const aBiz = syntheticBizNo(2);
const bBiz = syntheticBizNo(3);
const cBiz = syntheticBizNo(4);
const dBiz = syntheticBizNo(5);
const NONE = { added: 0, updated: 0, removed: 0, kept: 0, skipped: 0 };

function pc(o: { name?: string } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sax-share-'));
  const db: Db = openDatabase(path.join(dir, 'db.sqlite'), new Uint8Array(randomBytes(32)));
  opened.push({ db, dir });
  const cipher = new ColumnCipher(new Uint8Array(randomBytes(32)));
  let now = new Date('2026-11-17T03:00:00Z');
  const pid = new ProfileRepo(db).upsert({ kind: 'business', displayName: '하늘상회', bizNo: me, corpNo: null, repName: '김하늘', bizType: null, bizItem: null, address: null, email: null, signMethod: null }).id;
  const cps = new CounterpartyRepo(db);
  const a = cps.create({ bizNo: aBiz, name: o.name ?? '(주)에이상사', repName: '이에이', email: 'a@example.com', source: 'manual' });
  cps.setItems(a.id, [{ name: '월 자문', unitPrice: 500_000, unit: '건' }]);
  const b = cps.create({ bizNo: bBiz, name: '비상사', source: 'manual' });
  const svc = new ShareService(db, cipher, { now: () => now });
  let runs = 0;
  const issued = (n: number, cpId: string, supply: number, tax: number, state: 'committed' | 'observed_manual' | 'in_doubt' = 'committed', ref: string | null = approval(n)) => {
    const runId = `run-${++runs}-${n}`;
    new RunRepo(db).create({ id: runId, playbookId: 'hometax.invoice.issue', playbookVersion: '1', packageDigest: 'd', profileId: pid, trigger: 'local', inputsHash: 'i' });
    db.prepare('UPDATE runs SET inputs_json_enc = ? WHERE id = ?').run(cipher.seal(JSON.stringify({ v: 1, counterpartyId: cpId, supply, tax }), `runs.inputs_json_enc|${runId}`), runId);
    db.prepare(`INSERT INTO irreversible_log (intent_id, step_id, attempt, run_id, business_key, playbook_id, inputs_hash, package_digest, action_hash, state, armed_at, device_id, verify_ref)
      VALUES (?, 's1', 1, ?, 'bk', 'hometax.invoice.issue', 'ih', 'pd', 'ah', ?, '2026-11-16T16:30:00Z', 'dev', ?)`).run(`i-${runId}`, runId, state, ref ? `${ref.slice(0, 8)}-${ref.slice(8, 16)}-${ref.slice(16)}` : null);
    return runId;
  };
  const hometax = (n: number, o2: { item?: string | null; supply?: number | null; kind?: 'sale' | 'purchase'; bizNo?: string | null } = {}) =>
    db.prepare(`INSERT INTO receivables (id, profile_id, kind, approval_no, cp_biz_no, cp_name, item, written_on, supply, tax, total, from_ledger, from_hometax, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, '비상사', ?, '2026-10-10', ?, 100000, 1100000, 0, 1, 't', 't')`).run(randomUUID(), pid, o2.kind ?? 'sale', approval(n), o2.bizNo === undefined ? bBiz : o2.bizNo, o2.item ?? null, o2.supply === undefined ? 1_000_000 : o2.supply);
  const pending = () => (svc.handle('db.query.share.pending', { limit: 200 }) as { rows: ShareOutRow[] }).rows;
  const status = () => svc.handle('db.query.share.status', {}) as ShareStatus;
  return {
    db, svc, pid, cps, a, b, issued, hometax, pending, status,
    tick: (ms = 60_000) => void (now = new Date(now.getTime() + ms)),
    rpc: async (m: string, p?: Record<string, unknown>) => svc.handle(m, p),
  };
}

const dev1 = randomUUID();
const inRow = <K extends ShareKind>(seq: number, kind: K, body: ShareRowCore<K>['body'], o: { at?: number; dev?: string; rowId?: string; by?: 'desktop' | 'mobile' } = {}) => ({
  seq,
  row: { v: 1 as const, row_id: o.rowId ?? newShareRowId(), kind, epoch: 0, at: o.at ?? 1_800_000_000_000, dev: o.dev ?? dev1, by: o.by ?? ('desktop' as const), body },
});
const bad = (f: () => unknown) => assert.throws(f, (e: unknown) => e instanceof ShareError && e.code === 'share.bad_request');

describe('계정 공유 기록 장부: 올릴 줄 모으기', () => {
  it('프로토콜: 공유 기록 메서드는 main 전용 목록(READ_QUERIES·COMMANDS 밖)에 따로 있다', () => {
    for (const m of [...SHARE_READ_QUERIES, ...SHARE_COMMANDS]) {
      assert.ok(!(READ_QUERIES as readonly string[]).includes(m) && !(COMMANDS as readonly string[]).includes(m) && !(MAIN_ONLY as readonly string[]).includes(m), m);
    }
    assert.throws(() => pc().svc.handle('share.nope', {}), (e: unknown) => e instanceof ShareError && e.code === 'share.unknown_method');
  });

  it('원장이 확인한 발급과 홈택스 목록의 매출 건이 승인번호마다 한 줄, 거래처·내 사업자가 한 줄씩. 다시 모아도 늘지 않는다', async () => {
    const p = pc();
    p.issued(1, p.a.id, 500_000, 50_000);
    p.issued(2, p.b.id, 300_000, 30_000, 'observed_manual');
    p.issued(3, p.a.id, 100_000, 10_000, 'in_doubt');
    p.issued(4, p.a.id, 100_000, 10_000, 'committed', null);
    p.hometax(1, { item: '컨설팅' });
    p.hometax(5, { item: '납품' });
    p.hometax(6, { supply: null });
    p.hometax(7, { kind: 'purchase' });
    p.hometax(8, { bizNo: null });
    assert.deepEqual(p.svc.handle('share.collect', {}), { issue: 3, party: 2, self: 1 });
    const rows = p.pending();
    const issues = rows.filter((r) => r.kind === 'issue').map((r) => r.body);
    assert.deepEqual(issues, [
      { approvalNo: approval(1), buyerBizNo: aBiz, buyerName: '(주)에이상사', doc: 'tax_invoice', how: 'app', supply: 500_000, tax: 50_000, writtenOn: '2026-11-17' },
      { approvalNo: approval(2), buyerBizNo: bBiz, buyerName: '비상사', doc: 'tax_invoice', how: 'manual', supply: 300_000, tax: 30_000, writtenOn: '2026-11-17' },
      { approvalNo: approval(5), buyerBizNo: bBiz, buyerName: '비상사', doc: 'tax_invoice', how: 'manual', item: '납품', supply: 1_000_000, tax: 100_000, writtenOn: '2026-10-10' },
    ]);
    assert.deepEqual(rows.filter((r) => r.kind === 'party').map((r) => r.body), [
      { bizNo: aBiz, email: 'a@example.com', items: [{ name: '월 자문', unit: '건', unitPrice: 500_000 }], name: '(주)에이상사', rep: '이에이' },
      { bizNo: bBiz, items: [], name: '비상사' },
    ]);
    assert.deepEqual(rows.filter((r) => r.kind === 'self').map((r) => r.body), [{ bizNo: me, name: '하늘상회', rep: '김하늘' }]);
    assert.ok(rows.every((r) => /^[A-Za-z0-9_-]{22}$/.test(r.rowId) && r.at === Date.parse('2026-11-17T03:00:00Z') && r.taskId === undefined));
    const key = new Uint8Array(randomBytes(32));
    for (const r of rows) await sealShareRow(key, { v: 1, row_id: r.rowId, kind: r.kind, epoch: 0, at: r.at, dev: dev1, by: 'desktop', body: r.body } as ShareRowCore, async () => new Uint8Array(64));
    p.tick();
    assert.deepEqual(p.svc.collect(), { issue: 0, party: 0, self: 0 });
    p.db.prepare(`UPDATE irreversible_log SET state = 'committed', verify_ref = ? WHERE state = 'in_doubt'`).run(approval(3));
    assert.deepEqual(p.svc.collect(), { issue: 1, party: 0, self: 0 });
    assert.equal(p.pending().length, 7);
  });

  it('거래처·내 사업자는 값이 바뀌었을 때만 새 줄. 지운 거래처는 내가 올린 적이 있을 때 "지움" 줄을 한 번 낸다', () => {
    const p = pc();
    assert.deepEqual(p.svc.collect(), { issue: 0, party: 2, self: 1 });
    p.tick();
    p.cps.setItems(p.a.id, [{ name: '월 자문', unitPrice: 550_000, unit: '건' }, { name: '교육', unitPrice: null, unit: null }]);
    p.db.prepare('UPDATE profiles SET rep_name = ? WHERE id = ?').run('박하늘', p.pid);
    assert.deepEqual(p.svc.collect(), { issue: 0, party: 1, self: 1 });
    p.tick();
    p.db.prepare('DELETE FROM counterparties WHERE id = ?').run(p.b.id);
    assert.deepEqual(p.svc.collect(), { issue: 0, party: 1, self: 0 });
    assert.deepEqual(p.pending().at(-1)!.body, { bizNo: bBiz, name: '비상사', removed: true });
    assert.deepEqual(p.svc.collect(), { issue: 0, party: 0, self: 0 });
    p.tick();
    p.cps.create({ bizNo: bBiz, name: '비상사', source: 'manual' });
    assert.deepEqual(p.svc.collect(), { issue: 0, party: 1, self: 0 });
    const parties = p.pending().filter((r) => r.kind === 'party').map((r) => ({ v: 1, row_id: r.rowId, kind: 'party', epoch: 0, at: r.at, dev: dev1, by: 'desktop', body: r.body }) as ShareRowCore<'party'>);
    assert.deepEqual(mergeShareParties(parties).map((r) => [r.body.bizNo, r.body.items?.length]).sort(), [[aBiz, 2], [bBiz, 0]].sort());
    const q = pc();
    q.db.prepare('UPDATE profiles SET display_name = biz_no').run();
    assert.equal(q.svc.collect().self, 0);
  });

  it('글 칸은 NFC로 맞추고 상한에서 자른다. 사업자번호가 10자리가 아닌 거래처는 올리지 않는다', () => {
    const p = pc({ name: `${'가'.normalize('NFD')}${'나'.repeat(150)}` });
    p.db.prepare(`INSERT INTO counterparties (id, biz_no, name, source) VALUES ('odd', '12345', '번호 없는 곳', 'manual')`).run();
    assert.equal(p.svc.collect().party, 2);
    const a = p.pending().find((r) => r.kind === 'party' && r.body.bizNo === aBiz)!.body as { name: string };
    assert.equal([...a.name].length, 100);
    assert.equal(a.name, a.name.normalize('NFC'));
  });
});

describe('계정 공유 기록 장부: 올리기 상태와 받기', () => {
  it('pending은 만든 순서, sent·dropped는 다시 내지 않는다. 떨어진 줄과 같은 값으로 새 줄을 만들지도 않는다', () => {
    const p = pc();
    p.issued(1, p.a.id, 500_000, 50_000);
    p.svc.collect();
    const rows = p.pending();
    assert.deepEqual(rows.map((r) => r.kind), ['issue', 'party', 'party', 'self']);
    assert.equal((p.svc.handle('db.query.share.pending', { limit: 2 }) as { rows: unknown[] }).rows.length, 2);
    assert.equal((p.svc.handle('db.query.share.pending', {}) as { rows: unknown[] }).rows.length, 4);
    assert.deepEqual(p.svc.handle('share.sent', { rowId: rows[0]!.rowId, seq: 7 }), { ok: true });
    p.svc.handle('share.sent', { rowId: rows[1]!.rowId, seq: null });
    p.svc.handle('share.dropped', { rowId: rows[2]!.rowId, reason: 'shape' });
    p.svc.handle('share.dropped', { rowId: rows[0]!.rowId, reason: 'account.task_closed' });
    p.svc.handle('share.sent', { rowId: newShareRowId(), seq: 9 });
    assert.deepEqual(p.status(), { cursor: 0, out: { pending: 1, sent: 2, dropped: 1 }, in: { issue: 0, party: 0, self: 0, money: 0, task: 0, task_result: 0 } });
    assert.deepEqual(p.db.prepare('SELECT state, seq, reason FROM share_out ORDER BY rowid').all(), [
      { state: 'sent', seq: 7, reason: null }, { state: 'sent', seq: null, reason: null }, { state: 'dropped', seq: null, reason: 'shape' }, { state: 'pending', seq: null, reason: null },
    ]);
    assert.deepEqual(p.svc.collect(), { issue: 0, party: 0, self: 0 });
    for (const q of [{ limit: 0 }, { limit: 201 }, { limit: '5' }]) bad(() => p.svc.handle('db.query.share.pending', q));
    bad(() => p.svc.handle('share.sent', { rowId: 'x', seq: 1 }));
    bad(() => p.svc.handle('share.sent', { rowId: rows[3]!.rowId, seq: 0 }));
    bad(() => p.svc.handle('share.dropped', { rowId: rows[3]!.rowId, reason: 'Bad Reason' }));
    assert.deepEqual(p.svc.handle('share.resend', {}), { rows: 2 });
    assert.deepEqual(p.db.prepare('SELECT state, seq FROM share_out ORDER BY rowid').all(), [
      { state: 'pending', seq: null }, { state: 'pending', seq: null }, { state: 'dropped', seq: null }, { state: 'pending', seq: null },
    ]);
    assert.deepEqual(p.svc.handle('share.resend', {}), { rows: 0 });
  });

  it('받은 줄은 한 번만 넣는다. 받은 자리는 내려가지 않고, 돈 요약은 가장 늦은 한 장만 남는다', () => {
    const p = pc();
    const issue = { doc: 'tax_invoice' as const, approvalNo: approval(9), writtenOn: '2026-11-17', buyerBizNo: aBiz, buyerName: '(주)에이상사', supply: 10, tax: 1, how: 'app' as const };
    const money = (asOf: string) => ({ asOf, latestDay: null, stale: false, recv: { count: 1, total: 11, overdueCount: 0, overdueTotal: 0, oldest: null, top: [] }, pay: { count: null, total: null, overdueCount: null, overdueTotal: null, top: [] }, cash: null });
    const first = inRow(1, 'issue', issue);
    const m1 = inRow(2, 'money', money('2026-11-17T01:00:00.000Z'), { at: 200 });
    const m0 = inRow(3, 'money', money('2026-11-16T01:00:00.000Z'), { at: 100 });
    const task = inRow(4, 'task', { do: 'tax_invoice.issue', buyerBizNo: aBiz, supply: 1, tax: 0, item: '용역' }, { by: 'mobile', dev: randomUUID() });
    assert.deepEqual(p.svc.handle('share.apply', { rows: [first, m1], cursor: 2 }), { applied: 2, cursor: 2, parties: NONE });
    assert.deepEqual(p.svc.handle('share.apply', { rows: [first, m0, task], cursor: 4 }), { applied: 2, cursor: 4, parties: NONE });
    assert.deepEqual(p.svc.handle('share.apply', { rows: [], cursor: 1 }), { applied: 0, cursor: 4, parties: NONE });
    assert.deepEqual(p.svc.handle('db.query.share.cursor', {}), { cursor: 4 });
    assert.deepEqual(p.status().in, { issue: 1, party: 0, self: 0, money: 1, task: 1, task_result: 0 });
    assert.equal(JSON.parse(p.db.prepare(`SELECT body_json FROM share_in WHERE kind = 'money'`).pluck().get() as string).asOf, '2026-11-17T01:00:00.000Z');
    assert.deepEqual(p.db.prepare(`SELECT kind, ref, by_role FROM share_in ORDER BY seq`).all(), [
      { kind: 'issue', ref: approval(9), by_role: 'desktop' }, { kind: 'money', ref: '', by_role: 'desktop' }, { kind: 'task', ref: '', by_role: 'mobile' },
    ]);
    p.issued(9, p.a.id, 10, 1);
    assert.equal(p.svc.collect().issue, 0);
    for (const r of [
      { seq: 0, row: first.row }, { seq: 5, row: { ...first.row, row_id: 'short' } }, { seq: 5, row: { ...first.row, kind: 'note' } }, { seq: 5, row: { ...first.row, dev: 'pc' } },
      { seq: 5, row: { ...first.row, by: 'server' } }, { seq: 5, row: { ...first.row, body: [] } }, { seq: 5, row: { ...first.row, v: 2 } }, { seq: 5, row: { ...first.row, row_id: newShareRowId(), body: { ...issue, approvalNo: 5 } } },
      { seq: 5, row: { ...first.row, row_id: newShareRowId(), kind: 'self', body: { name: 'x'.repeat(20_001) } } }, null,
    ]) bad(() => p.svc.handle('share.apply', { rows: [inRow(5, 'issue', { ...issue, approvalNo: approval(10) }), r], cursor: 9 }));
    bad(() => p.svc.handle('share.apply', { rows: 'x', cursor: 9 }));
    bad(() => p.svc.handle('share.apply', { rows: [], cursor: -1 }));
    bad(() => p.svc.handle('share.apply', { rows: Array.from({ length: 201 }, (_, i) => inRow(10 + i, 'issue', issue)), cursor: 300 }));
    assert.deepEqual([p.status().cursor, p.status().in.issue], [4, 1]);
  });

  it('내가 올린 줄이 돌아오면 넣지 않고 순번만 채운다. 받은 거래처 값이 내 값과 같으면 다시 올리지 않는다(키 순서가 달라도)', () => {
    const p = pc();
    const theirs = inRow(1, 'party', { name: '(주)에이상사', rep: '이에이', items: [{ unitPrice: 500_000, unit: '건', name: '월 자문' }], email: 'a@example.com', bizNo: aBiz });
    p.svc.apply([theirs, inRow(2, 'self', { rep: '김하늘', name: '하늘상회', bizNo: me })], 2);
    assert.deepEqual(p.svc.collect(), { issue: 0, party: 1, self: 0 });
    const mine = p.pending();
    assert.deepEqual(mine.map((r) => r.body.bizNo), [bBiz]);
    const echo = { seq: 3, row: { v: 1 as const, row_id: mine[0]!.rowId, kind: 'party' as const, epoch: 0, at: mine[0]!.at, dev: dev1, by: 'desktop' as const, body: mine[0]!.body } };
    assert.deepEqual(p.svc.apply([echo], 3), { applied: 0, cursor: 3, parties: NONE });
    assert.deepEqual(p.db.prepare('SELECT state, seq FROM share_out').all(), [{ state: 'sent', seq: 3 }]);
    assert.deepEqual([p.pending().length, p.status().in.party], [0, 1]);
  });

  it('두 PC의 거래처 값이 다르면 먼저 올라온 값으로 맞추고 번갈아 올리지 않는다. 한쪽이 고치면 다른 쪽이 따라온다', () => {
    const a = pc();
    const b = pc({ name: '에이상사 주식회사' });
    let seq = 0;
    const carry = (from: ReturnType<typeof pc>, to: ReturnType<typeof pc>, dev: string) => {
      const rows = from.pending().map((r) => ({ seq: ++seq, row: { v: 1 as const, row_id: r.rowId, kind: r.kind, epoch: 0, at: r.at, dev, by: 'desktop' as const, body: r.body } }));
      for (const r of rows) from.svc.sent(r.row.row_id, r.seq);
      to.svc.apply(rows, seq);
      return rows.length;
    };
    const zero = { issue: 0, party: 0, self: 0 };
    const [da, db] = [randomUUID(), randomUUID()];
    a.svc.collect();
    assert.equal(carry(a, b, da), 3);
    assert.equal(b.cps.byBizNo(aBiz)!.name, '(주)에이상사');
    b.tick();
    assert.deepEqual(b.svc.collect(), zero);
    for (let i = 0; i < 3; i++) {
      a.tick();
      b.tick();
      assert.deepEqual([a.svc.collect(), b.svc.collect()], [zero, zero]);
    }
    a.tick(10 * 60_000);
    a.cps.update(a.a.id, { email: 'new@example.com' });
    assert.deepEqual(a.svc.collect(), { issue: 0, party: 1, self: 0 });
    assert.equal(carry(a, b, da), 1);
    assert.equal(b.cps.byBizNo(aBiz)!.email, 'new@example.com');
    assert.deepEqual(b.svc.collect(), zero);
    b.tick(30 * 60_000);
    b.cps.update(b.a.id, { address: '서울시 중구' });
    assert.deepEqual(b.svc.collect(), { issue: 0, party: 1, self: 0 });
    assert.equal(carry(b, a, db), 1);
    assert.deepEqual([a.cps.byBizNo(aBiz)!.address, a.cps.byBizNo(aBiz)!.email], ['서울시 중구', 'new@example.com']);
    a.tick(60 * 60_000);
    assert.deepEqual([a.svc.collect(), b.svc.collect()], [zero, zero]);
    const all = (b.db.prepare(`SELECT row_id, at, dev, body_json FROM share_in WHERE kind = 'party'`).all() as Array<{ row_id: string; at: number; dev: string; body_json: string }>)
      .map((r) => ({ v: 1, row_id: r.row_id, kind: 'party', epoch: 0, at: r.at, dev: r.dev, by: 'desktop', body: JSON.parse(r.body_json) }) as ShareRowCore<'party'>);
    assert.equal(mergeShareParties(all).find((r) => r.body.bizNo === aBiz)!.body.email, 'new@example.com');
  });
});

describe('계정 공유 기록 장부: 받은 거래처를 이 PC 거래처 목록에 반영', () => {
  const last = (p: ReturnType<typeof pc>) => p.pending().at(-1)!.body;

  it('처음 받는 거래처는 더한다. 고친 적 없는 거래처는 받은 값으로 바꾸고, 지움이면 지운다. 받은 값은 다시 올리지 않는다', () => {
    const p = pc();
    let r = p.svc.apply([inRow(1, 'party', { bizNo: cBiz, name: '씨상사', rep: '최씨', email: 'c@example.com', items: [{ name: '납품', unitPrice: null, unit: null }] }, { at: 1000 })], 1);
    assert.deepEqual(r.parties, { ...NONE, added: 1 });
    let c = p.cps.byBizNo(cBiz)!;
    assert.deepEqual([c.name, c.repName, c.email, c.verifiedAt, c.useCount, c.source], ['씨상사', '최씨', 'c@example.com', null, 0, 'manual']);
    assert.deepEqual(p.cps.getItems(c.id), [{ name: '납품', unitPrice: null, unit: null }]);
    assert.deepEqual(p.svc.collect(), { issue: 0, party: 2, self: 1 });
    assert.ok(p.pending().every((x) => x.body.bizNo !== cBiz));
    p.cps.setVerification(c.id, 'status:01');
    r = p.svc.apply([inRow(2, 'party', { bizNo: cBiz, name: '씨상사 주식회사', rep: '최씨', items: [] }, { at: 2000 })], 2);
    assert.deepEqual(r.parties, { ...NONE, updated: 1 });
    c = p.cps.byBizNo(cBiz)!;
    assert.deepEqual([c.name, c.email, c.verifiedStatus, p.cps.getItems(c.id).length], ['씨상사 주식회사', null, null, 0]);
    r = p.svc.apply([inRow(3, 'party', { bizNo: cBiz, name: '옛 상호', items: [] }, { at: 1500 })], 3);
    assert.deepEqual([r.parties, p.cps.byBizNo(cBiz)!.name], [NONE, '씨상사 주식회사']);
    r = p.svc.apply([inRow(4, 'party', { bizNo: cBiz, name: '씨상사 주식회사', removed: true }, { at: 3000 })], 4);
    assert.deepEqual([r.parties, p.cps.byBizNo(cBiz)], [{ ...NONE, removed: 1 }, null]);
    p.tick();
    assert.equal(p.svc.collect().party, 0);
    r = p.svc.apply([inRow(5, 'party', { bizNo: cBiz, name: '씨상사', items: [] }, { at: 4000 })], 5);
    assert.deepEqual([r.parties, p.cps.byBizNo(cBiz)!.name], [{ ...NONE, added: 1 }, '씨상사']);
    assert.equal(p.svc.collect().party, 0);
  });

  it('이 PC에서 고치고 아직 올리지 않은 거래처는 그대로 두고 그 값을 올린다. 이 PC에서 지운 거래처는 받아서 넣은 것이어도 "지움" 줄을 한 번 낸다', () => {
    const p = pc();
    p.svc.apply([inRow(1, 'party', { bizNo: cBiz, name: '씨상사', items: [] }, { at: 1000 }), inRow(2, 'party', { bizNo: dBiz, name: '디상사', items: [] }, { at: 1000 })], 2);
    p.svc.collect();
    const c = p.cps.byBizNo(cBiz)!;
    p.cps.update(c.id, { email: 'mine@example.com' });
    let r = p.svc.apply([inRow(3, 'party', { bizNo: cBiz, name: '씨상사', address: '부산', items: [] }, { at: 2000 })], 3);
    assert.deepEqual(r.parties, { ...NONE, kept: 1 });
    assert.deepEqual([p.cps.byBizNo(cBiz)!.email, p.cps.byBizNo(cBiz)!.address], ['mine@example.com', null]);
    p.tick();
    assert.equal(p.svc.collect().party, 1);
    assert.deepEqual(last(p), { bizNo: cBiz, name: '씨상사', email: 'mine@example.com', items: [] });
    p.cps.delete(p.cps.byBizNo(dBiz)!.id);
    r = p.svc.apply([inRow(4, 'party', { bizNo: dBiz, name: '디상사', rep: '정디', items: [] }, { at: 2500 })], 4);
    assert.deepEqual([r.parties, p.cps.byBizNo(dBiz)], [{ ...NONE, kept: 1 }, null]);
    p.tick();
    assert.equal(p.svc.collect().party, 1);
    assert.deepEqual(last(p), { bizNo: dBiz, name: '디상사', removed: true });
    p.tick();
    assert.equal(p.svc.collect().party, 0);
  });

  it('처음 만난 거래처가 이 PC에도 있으면 받은 값으로 바꾸되 받은 줄에 없는 칸은 남기고 합친 값을 올린다. 처음 만났는데 "지움"이면 지우지 않는다', () => {
    const p = pc();
    const r = p.svc.apply([
      inRow(1, 'party', { bizNo: aBiz, name: '에이상사 주식회사', address: '부산', items: [] }, { at: 1000 }),
      inRow(2, 'party', { bizNo: bBiz, name: '비상사', removed: true }, { at: 1000 }),
    ], 2);
    assert.deepEqual(r.parties, { ...NONE, updated: 1, kept: 1 });
    const a = p.cps.byBizNo(aBiz)!;
    assert.deepEqual([a.name, a.repName, a.address, a.email], ['에이상사 주식회사', '이에이', '부산', 'a@example.com']);
    assert.deepEqual(p.cps.getItems(a.id), [{ name: '월 자문', unitPrice: 500_000, unit: '건' }]);
    assert.equal(p.cps.byBizNo(bBiz)!.name, '비상사');
    assert.deepEqual(p.svc.collect(), { issue: 0, party: 2, self: 1 });
    const out = p.pending().filter((x) => x.kind === 'party').map((x) => x.body);
    assert.deepEqual(out.find((x) => x.bizNo === aBiz), { bizNo: aBiz, name: '에이상사 주식회사', rep: '이에이', address: '부산', email: 'a@example.com', items: [{ name: '월 자문', unitPrice: 500_000, unit: '건' }] });
    assert.deepEqual(out.find((x) => x.bizNo === bBiz), { bizNo: bBiz, name: '비상사', items: [] });
  });

  it('시계가 느린 PC에서 고쳐도 묻히지 않는다: 새 줄의 시각은 그 거래처의 가장 늦은 줄보다 뒤다', () => {
    const p = pc();
    const future = new Date('2026-11-17T03:00:00Z').getTime() + 3 * 3_600_000;
    p.svc.apply([inRow(1, 'party', { bizNo: cBiz, name: '씨상사', items: [] }, { at: future })], 1);
    p.svc.collect();
    p.cps.update(p.cps.byBizNo(cBiz)!.id, { email: 'late@example.com' });
    p.tick();
    assert.equal(p.svc.collect().party, 1);
    const mine = p.pending().at(-1)!;
    assert.deepEqual([mine.body.email, mine.at], ['late@example.com', future + 1]);
  });

  it('이 PC 규칙 밖의 값(사업자번호 검증, 메일 모양, 품목 모양)과 폰이 쓴 거래처 줄은 넣지 않는다', () => {
    const p = pc();
    const before = p.cps.list().length;
    const r = p.svc.apply([
      inRow(1, 'party', { bizNo: '1234567890', name: '검증 숫자가 틀린 곳', items: [] }, { at: 1000 }),
      inRow(2, 'party', { bizNo: cBiz, name: '씨상사', email: 'not-an-email', items: [] }, { at: 1000 }),
      inRow(3, 'party', { bizNo: dBiz, name: '디상사', items: [{ name: '', unitPrice: null, unit: null }] }, { at: 1000 }),
      inRow(4, 'party', { bizNo: syntheticBizNo(6), name: '폰이 쓴 곳', items: [] }, { at: 1000, by: 'mobile', dev: randomUUID() }),
    ], 4);
    assert.deepEqual(r.parties, { ...NONE, skipped: 3 });
    assert.equal(p.cps.list().length, before);
    assert.equal(p.status().cursor, 4);
  });
});

class FakeServer {
  rows: ShareServerRow[] = [];
  next = 1;
  client() {
    return {
      putShareRow: async (auth: DeviceAuth, row: ShareRowWire): Promise<{ seq: number }> => {
        const h = await auth('PUT', 'u');
        const seq = this.next++;
        this.rows.push({ seq, rowId: row.rowId, kind: row.kind, epoch: row.epoch, deviceId: h.dev!, at: 1, body: row.body });
        return { seq };
      },
      shareRows: async (_auth: DeviceAuth, after: number): Promise<SharePage> => ({ rows: this.rows.filter((r) => r.seq > after).slice(0, 200), head: this.next - 1, epoch: 0, more: false }),
    };
  }
}

describe('계정 공유 기록: 장부에서 장부로', () => {
  it('PC 두 대: 한쪽에서 발급한 기록·거래처·내 사업자가 다른 쪽 장부에 들어가고, 서버에는 봉인문만 있다. 다시 맞춰도 줄이 늘지 않는다', async () => {
    const rk = new Uint8Array(randomBytes(32));
    const aik = softSigner(hkdfSha256(rk, 'aik', 32), AIK_PURPOSES);
    const ws = softSigner(deriveShareSignSeed(rk), [CTX.share]);
    const ids = [randomUUID(), randomUUID()];
    const entry = (deviceId: string) => ({ deviceId, role: 'desktop' as const, noisePub: x25519Keygen().publicKey, signPub: ed25519Keygen().publicKey, registeredAt: 1 });
    const list: DeviceListJson = await addDevice(aik, await initialDeviceList(aik, entry(ids[0]!)), entry(ids[1]!));
    const vault: ShareVault = { key: async (e) => ({ key: deriveShareKey(rk, e), signPub: ed25519Public(deriveShareSignSeed(rk)) }), sign: (m) => ws.sign(CTX.share, m) };
    const server = new FakeServer();
    const logs: Array<Record<string, unknown>> = [];
    const side = (i: number, p: ReturnType<typeof pc>) => {
      const dev: ShareDevice = { deviceId: ids[i]!, deviceList: list, auth: async () => ({ dev: ids[i]! }), clearToken: () => undefined };
      return new ShareSync({ client: server.client(), device: () => dev, vault: async () => vault, store: engineShareStore(p.rpc), collect: () => p.rpc('share.collect'), log: (_n, d) => logs.push(d) });
    };
    const a = pc();
    const b = pc();
    a.issued(1, a.a.id, 500_000, 50_000);
    const [sa, sb] = [side(0, a), side(1, b)];
    assert.deepEqual(await sa.sync(), { state: 'ok', pulled: 0, applied: 0, rejected: {}, pushed: 4, dropped: 0, parties: 0 });
    assert.deepEqual(await sb.sync(), { state: 'ok', pulled: 4, applied: 4, rejected: {}, pushed: 0, dropped: 0, parties: 0 });
    assert.deepEqual(b.status(), { cursor: 4, out: { pending: 0, sent: 0, dropped: 0 }, in: { issue: 1, party: 2, self: 1, money: 0, task: 0, task_result: 0 } });
    const got = JSON.parse(b.db.prepare(`SELECT body_json FROM share_in WHERE kind = 'issue'`).pluck().get() as string);
    assert.deepEqual([got.approvalNo, got.buyerBizNo, got.supply, got.how], [approval(1), aBiz, 500_000, 'app']);
    const blob = JSON.stringify(server.rows);
    for (const s of [approval(1), aBiz, me, '에이상사', '하늘상회']) assert.ok(!blob.includes(s), s);
    b.hometax(1);
    b.hometax(2, { item: '납품' });
    assert.deepEqual(await sb.sync(), { state: 'ok', pulled: 0, applied: 0, rejected: {}, pushed: 1, dropped: 0, parties: 0 });
    assert.deepEqual(await sa.sync(), { state: 'ok', pulled: 5, applied: 5, rejected: {}, pushed: 0, dropped: 0, parties: 0 });
    assert.deepEqual(a.status(), { cursor: 5, out: { pending: 0, sent: 4, dropped: 0 }, in: { issue: 1, party: 0, self: 0, money: 0, task: 0, task_result: 0 } });
    for (const s of [sa, sb, sa]) assert.deepEqual([(await s.sync()).pushed, server.rows.length], [0, 5]);
    const opened = server.rows.map((r) => openShareRow(deriveShareKey(rk, 0), r, { sharePub: ed25519Public(deriveShareSignSeed(rk)), mobileSignPub: () => null }));
    const issues = mergeShareIssues(opened.flatMap((o) => (o.ok && o.row.kind === 'issue' ? [o.row as ShareRowCore<'issue'>] : [])));
    assert.deepEqual(issues.map((r) => r.body.approvalNo).sort(), [approval(1), approval(2)]);
    b.tick();
    b.cps.create({ bizNo: cBiz, name: '씨상사', email: 'c@example.com', source: 'manual' });
    assert.equal((await sb.sync()).pushed, 1);
    assert.equal(a.cps.byBizNo(cBiz), null);
    assert.deepEqual(await sa.sync(), { state: 'ok', pulled: 1, applied: 1, rejected: {}, pushed: 0, dropped: 0, parties: 1 });
    assert.deepEqual([a.cps.byBizNo(cBiz)!.name, a.cps.byBizNo(cBiz)!.email], ['씨상사', 'c@example.com']);
    assert.equal((await sb.sync()).parties, 0);
    assert.ok(logs.every((d) => !JSON.stringify(d).includes(approval(1).slice(0, 12))), '로그에는 개수만');
  });

  it('장부가 준비되지 않았으면(엔진 오류) 동기화는 failed로 끝나고 던지지 않는다', async () => {
    const rk = new Uint8Array(randomBytes(32));
    const aik = softSigner(hkdfSha256(rk, 'aik', 32), AIK_PURPOSES);
    const id = randomUUID();
    const entry = (deviceId: string) => ({ deviceId, role: 'desktop' as const, noisePub: x25519Keygen().publicKey, signPub: ed25519Keygen().publicKey, registeredAt: 1 });
    const list = await addDevice(aik, await initialDeviceList(aik, entry(id)), entry(randomUUID()));
    const dev: ShareDevice = { deviceId: id, deviceList: list, auth: async () => ({ dev: id }), clearToken: () => undefined };
    const vault: ShareVault = { key: async (e) => ({ key: deriveShareKey(rk, e), signPub: ed25519Public(deriveShareSignSeed(rk)) }), sign: async () => new Uint8Array(64) };
    const down = new ShareSync({ client: new FakeServer().client(), device: () => dev, vault: async () => vault, store: engineShareStore(async () => { throw new Error('db_not_ready'); }) });
    assert.deepEqual([(await down.sync()).state, (await down.sync()).code], ['failed', 'share.failed']);
    const odd = new ShareSync({ client: new FakeServer().client(), device: () => dev, vault: async () => vault, store: engineShareStore(async () => ({})) });
    assert.equal((await odd.sync()).code, 'share.store_failed');
  });
});
