// 사업용 카드 내역 화면 데이터(08 D-04, D14 M6-3): db.query.card.list·card.setMemo·card.reattachMemo·card.deleteMemo.
// 그달 행·건별 메모, 마지막 최신화·n일 전(한국 날짜), 그달 덮임(이번 달은 오늘까지), 행이 바뀌어 떠 있는 메모("확인 필요")와 다시 잇기.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { BundleService, coverageOf, type CardMonthView } from '@sax/bundle';
import { CardRepo, ColumnCipher, openDatabase, ProfileRepo, RunRepo, syntheticBizNo, type CardTxnInput, type Db } from '@sax/db';
import { CARD_COMMANDS, CARD_READ_QUERIES, COMMANDS, MAIN_ONLY, READ_QUERIES } from '@sax/engine/protocol';

const root = path.resolve(import.meta.dirname, '..');
const entry = fs.readFileSync(path.join(root, 'packages/engine/src/entry.ts'), 'utf8');

let dir: string;
let db: Db;
let profileId: string;
let other: string;
// 지금: 2026-11-07 10:00 KST
let now = new Date('2026-11-07T01:00:00Z');
let svc: BundleService;
const code = (p: Promise<unknown>, c: string) => assert.rejects(p, (e: Error & { code?: string }) => e.code === c, c);
const view = async (month: string, pid = profileId) => (await svc.handle('db.query.card.list', { profileId: pid, month })) as CardMonthView;
const tx = (usedOn: string, amount: number, approvalNo: string | null, o: Partial<CardTxnInput> = {}): CardTxnInput => ({
  usedOn, amount, approvalNo, merchant: '가나식당', merchantBizNo: syntheticBizNo(80), cardLast4: '1234', supplyAmount: null, vatAmount: null, canceled: false, ...o,
});
/** [최신화] 한 번(H-12 실행 하나 = card_fetches 한 행) */
const fetch = (pid: string, runId: string, from: string, to: string, completedAt: string, rows: CardTxnInput[]) => {
  new RunRepo(db).create({ id: runId, playbookId: 'H-12', playbookVersion: '1', packageDigest: 'd', profileId: pid, trigger: 'local', inputsHash: 'i' });
  return new CardRepo(db).replaceRange({ runId, profileId: pid, rangeFrom: from, rangeTo: to, completedAt }, rows);
};

before(() => {
  dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sax-cardview-'));
  db = openDatabase(path.join(dir, 'db.sqlite'), new Uint8Array(randomBytes(32)));
  const pr = new ProfileRepo(db);
  profileId = pr.upsert({ kind: 'business', displayName: '하늘상회', bizNo: syntheticBizNo(81), corpNo: null, repName: '김하늘', bizType: null, bizItem: null, address: null, email: null, signMethod: null }).id;
  other = pr.upsert({ kind: 'personal', displayName: '김하늘', bizNo: null, corpNo: null, repName: null, bizType: null, bizItem: null, address: null, email: null, signMethod: null }).id;
  svc = new BundleService(db, new ColumnCipher(new Uint8Array(32)), { exportDir: path.join(dir, 'exports'), now: () => now });
});
after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('db.query.card.list', () => {
  it('최신화 전: 행 0, lastFetch null, 덮임 none', async () => {
    const v = await view('2026-10');
    assert.deepEqual([v.rows.length, v.lastFetch, v.daysSinceFetch, v.coverage, v.detachedMemos], [0, null, null, 'none', []]);
  });

  it('그달 행(사용일 순)·메모, 마지막 최신화 n일 전(한국 날짜), 지난달 전체 조회면 full', async () => {
    // 11-04 23:30 KST(= 11-04 14:30Z)에 10월 전체 조회
    fetch(profileId, 'run-oct', '2026-10-01', '2026-10-31', '2026-11-04T14:30:00Z', [tx('2026-10-20', 33_000, 'A1'), tx('2026-10-05', 12_000, 'A2'), tx('2026-10-05', 12_000, null)]);
    const v = await view('2026-10');
    assert.deepEqual(v.rows.map((r) => [r.usedOn, r.amount, r.approvalNo]), [['2026-10-05', 12_000, 'A2'], ['2026-10-05', 12_000, null], ['2026-10-20', 33_000, 'A1']]);
    assert.deepEqual([v.daysSinceFetch, v.coverage], [3, 'full']);
    assert.equal(v.lastFetch?.completedAt, '2026-11-04T14:30:00Z');
    const r = v.rows[2]!;
    const m = (await svc.handle('card.setMemo', { profileId, txnId: r.id, memo: '거래처 점심' })) as { id: string };
    assert.deepEqual((await view('2026-10')).rows[2]!.memo, { id: m.id, text: '거래처 점심', updatedAt: (await view('2026-10')).rows[2]!.memo!.updatedAt });
  });

  it('덮임: 이번 달은 오늘까지만 본다, 구간 사이가 비면 partial, 다음 달은 none', async () => {
    fetch(profileId, 'run-nov-a', '2026-11-01', '2026-11-03', '2026-11-03T03:00:00Z', []);
    assert.equal((await view('2026-11')).coverage, 'partial', '11-04~11-07이 빈다');
    fetch(profileId, 'run-nov-b', '2026-11-04', '2026-11-07', '2026-11-07T00:30:00Z', []);
    const v = await view('2026-11');
    assert.deepEqual([v.coverage, v.daysSinceFetch], ['full', 0]);
    assert.equal((await view('2026-12')).coverage, 'none');
    assert.equal(coverageOf([{ rangeFrom: '2026-09-01', rangeTo: '2026-09-10' }, { rangeFrom: '2026-09-12', rangeTo: '2026-09-30' }], '2026-09-01', '2026-09-30'), 'partial');
    assert.equal(coverageOf([{ rangeFrom: '2026-08-20', rangeTo: '2026-09-15' }, { rangeFrom: '2026-09-16', rangeTo: '2026-10-02' }], '2026-09-01', '2026-09-30'), 'full');
  });

  it('행이 바뀌어 메모가 뜨면 확인 필요로 보이고(사용일·금액), 고른 행에 다시 잇거나 지운다', async () => {
    // 10월을 다시 조회: A1(33,000) 건이 금액 정정되어 키가 바뀐다 → 그 메모는 떠 있다
    const r = fetch(profileId, 'run-oct-2', '2026-10-01', '2026-10-31', '2026-11-07T00:40:00Z', [tx('2026-10-05', 12_000, 'A2'), tx('2026-10-05', 12_000, null), tx('2026-10-20', 30_000, 'A1')]);
    assert.equal(r.unmatchedMemos, 1);
    let v = await view('2026-10');
    assert.equal(v.rows.find((x) => x.approvalNo === 'A1')!.memo, null);
    assert.deepEqual(v.detachedMemos.map((d) => [d.text, d.usedOn, d.amount]), [['거래처 점심', '2026-10-20', 33_000]]);
    assert.deepEqual((await view('2026-09')).detachedMemos, [], '다른 달 화면에는 보이지 않는다');
    const memoId = v.detachedMemos[0]!.id;
    const target = v.rows.find((x) => x.approvalNo === 'A1')!;
    await svc.handle('card.reattachMemo', { profileId, memoId, txnId: target.id });
    v = await view('2026-10');
    assert.equal(v.rows.find((x) => x.approvalNo === 'A1')!.memo?.text, '거래처 점심');
    assert.deepEqual(v.detachedMemos, []);
    // 다시 조회해도 새 키로 이어진다
    fetch(profileId, 'run-oct-3', '2026-10-01', '2026-10-31', '2026-11-07T00:50:00Z', [tx('2026-10-20', 30_000, 'A1')]);
    assert.equal((await view('2026-10')).rows[0]!.memo?.text, '거래처 점심');
    await code(svc.handle('card.reattachMemo', { profileId, memoId, txnId: (await view('2026-10')).rows[0]!.id }), 'memo_not_detached');
  });

  it('다시 잇기: 이미 메모가 있는 행이면 memo_exists(덮어쓰지 않음), 떠 있는 메모는 지울 수 있다', async () => {
    fetch(profileId, 'run-sep', '2026-09-01', '2026-09-30', '2026-11-07T00:55:00Z', [tx('2026-09-03', 5_000, 'S1'), tx('2026-09-04', 7_000, 'S2')]);
    let v = await view('2026-09');
    await svc.handle('card.setMemo', { profileId, txnId: v.rows[0]!.id, memo: '주차' });
    await svc.handle('card.setMemo', { profileId, txnId: v.rows[1]!.id, memo: '택배' });
    fetch(profileId, 'run-sep-2', '2026-09-01', '2026-09-30', '2026-11-07T00:56:00Z', [tx('2026-09-03', 5_000, 'S1')]);
    v = await view('2026-09');
    const lost = v.detachedMemos.find((d) => d.text === '택배')!;
    await code(svc.handle('card.reattachMemo', { profileId, memoId: lost.id, txnId: v.rows[0]!.id }), 'memo_exists');
    assert.equal((await view('2026-09')).rows[0]!.memo?.text, '주차');
    assert.deepEqual(await svc.handle('card.deleteMemo', { profileId, memoId: lost.id }), { deleted: true });
    assert.deepEqual((await view('2026-09')).detachedMemos, []);
    assert.deepEqual(await svc.handle('card.deleteMemo', { profileId, memoId: lost.id }), { deleted: false });
  });

  it('프로필 경계: 다른 프로필의 행·메모는 고칠 수 없다(not_found), 인자 검사', async () => {
    fetch(other, 'run-other', '2026-10-01', '2026-10-31', '2026-11-07T00:00:00Z', [tx('2026-10-10', 9_000, 'P1')]);
    const theirs = (await view('2026-10', other)).rows[0]!;
    await code(svc.handle('card.setMemo', { profileId, txnId: theirs.id, memo: 'x' }), 'not_found');
    await code(svc.handle('card.reattachMemo', { profileId, memoId: 'nope', txnId: theirs.id }), 'not_found');
    assert.equal((await view('2026-10')).rows.some((r) => r.id === theirs.id), false);
    await code(svc.handle('card.setMemo', { profileId, txnId: (await view('2026-10')).rows[0]!.id, memo: 3 }), 'bad_memo');
    await code(svc.handle('card.setMemo', { profileId, txnId: (await view('2026-10')).rows[0]!.id, memo: 'x'.repeat(501) }), 'memo_too_long');
    await code(svc.handle('db.query.card.list', { profileId, month: '2026-13' }), 'bad_month');
    await code(svc.handle('db.query.card.list', { profileId: 'nope', month: '2026-10' }), 'profile_not_found');
  });

  it('메모를 빈 글로 저장하면 지운다', async () => {
    fetch(profileId, 'run-aug', '2026-08-01', '2026-08-31', '2026-11-07T00:57:00Z', [tx('2026-08-08', 4_000, 'G1')]);
    const id = (await view('2026-08')).rows[0]!.id;
    await svc.handle('card.setMemo', { profileId, txnId: id, memo: '문구' });
    await svc.handle('card.setMemo', { profileId, txnId: id, memo: '  ' });
    assert.equal((await view('2026-08')).rows[0]!.memo, null);
  });

  it('조회는 DB에 쓰지 않는다', async () => {
    now = new Date('2026-11-10T01:00:00Z');
    const before = db.prepare('SELECT total_changes()').pluck().get();
    const v = await view('2026-10');
    assert.equal(v.daysSinceFetch, 3);
    assert.equal(db.prepare('SELECT total_changes()').pluck().get(), before);
  });
});

describe('배선(추가만)', () => {
  it('카드 질의·명령은 main 전용(렌더러 목록 밖), entry가 BundleService로 보낸다', () => {
    assert.deepEqual([...CARD_READ_QUERIES], ['db.query.card.list']);
    assert.deepEqual([...CARD_COMMANDS], ['card.setMemo', 'card.reattachMemo', 'card.deleteMemo']);
    const renderer = new Set<string>([...READ_QUERIES, ...COMMANDS, ...MAIN_ONLY]);
    for (const m of [...CARD_READ_QUERIES, ...CARD_COMMANDS]) assert.ok(!renderer.has(m), m);
    assert.match(entry, /for \(const m of \[\.\.\.CARD_READ_QUERIES, \.\.\.CARD_COMMANDS\]\) \{\n\s+PAYROLL\.add\(m\);\n\s+ALLOWED\.add\(m\);\n\}/);
  });
});
