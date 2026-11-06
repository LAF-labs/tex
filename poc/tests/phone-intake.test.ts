// 폰 사진·현금 수신 엔진 명령(데스크톱 ③c 계약, 팀장 결정 2026-11-06): receipt.phoneHas·receipt.phoneStore·cash.phonePut.
// 핵심: 24시간 뒤 같은 msgId를 다시 받아도 영수증 1장, 고아 문서 0. 중복은 msgId로만 본다(SHA 아님). 경합·실패면 파일을 지운다.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { PhoneIntake } from '@sax/bundle';
import { CashSalesRepo, DocumentRepo, openDatabase, ProfileRepo, ReceiptRepo, syntheticBizNo, type Db } from '@sax/db';
import { COMMANDS, MAIN_ONLY, PAYROLL_MAIN_ONLY, PHONE_COMMANDS, READ_QUERIES, RUN_COMMANDS } from '@sax/engine/protocol';

const root = path.resolve(import.meta.dirname, '..');
const entry = fs.readFileSync(path.join(root, 'packages/engine/src/entry.ts'), 'utf8');
const T0 = Date.parse('2026-11-06T01:00:00.000Z');
const ULID = (n: number) => `01JC${String(n).padStart(22, '0')}`;
const jpeg = (extra = 'x') => new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(extra.repeat(64))]));
const offer = (o: Record<string, unknown> = {}) => ({ capturedAt: T0 - 3_600_000, width: 1200, height: 1600, ocrEngine: 'ios_vision', ownerConfirmed: true, candidates: { amount: 12_000 }, ...o });
type Store = { docId: string; duplicate: boolean };

let dir: string;
let vault: string;
let db: Db;
let profileId: string;
const intake = (o: Partial<ConstructorParameters<typeof PhoneIntake>[1]> = {}, at = T0) => new PhoneIntake(db, { vaultDir: vault, now: () => new Date(at), ...o });
const vaultFiles = () => (fs.existsSync(vault) ? fs.readdirSync(vault) : []);
const count = (sql: string, ...a: unknown[]) => db.prepare(sql).pluck().get(...a) as number;
const receipts = () => count('SELECT count(*) FROM receipts');
const receiptDocs = () => count("SELECT count(*) FROM documents WHERE doc_type = 'paper_receipt'");
const code = (p: Promise<unknown>, c: string) => assert.rejects(p, (e: Error & { code?: string }) => e.code === c, c);

before(() => {
  dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sax-phone-'));
  vault = path.join(dir, 'vault');
  db = openDatabase(path.join(dir, 'db.sqlite'), new Uint8Array(randomBytes(32)));
});
after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('폰 수신 명령 목록·배선', () => {
  it('main 전용 3개, 기존 목록과 겹치지 않고, entry.ts가 PhoneIntake(보관함 폴더)로 보낸다', () => {
    assert.deepEqual([...PHONE_COMMANDS], ['receipt.phoneHas', 'receipt.phoneStore', 'cash.phonePut']);
    const others = new Set<string>([...READ_QUERIES, ...COMMANDS, ...RUN_COMMANDS, ...MAIN_ONLY, ...PAYROLL_MAIN_ONLY]);
    for (const m of PHONE_COMMANDS) assert.ok(!others.has(m), m);
    assert.ok(entry.includes('phone = new PhoneIntake(db, { vaultDir: paths.vault });'));
    assert.ok(entry.includes('for (const m of PHONE) ALLOWED.add(m);'));
    assert.ok(entry.indexOf('if (PHONE.has(method))') < entry.indexOf('return data.handle(method, params);'));
  });

  it('사업자 프로필이 없으면 profile_required(아무것도 쓰지 않음)', async () => {
    await code(intake().handle('receipt.phoneStore', { msgId: ULID(1), pairId: 'pair-1', jpeg: jpeg(), offer: offer() }), 'profile_required');
    assert.deepEqual([receipts(), receiptDocs(), vaultFiles().length], [0, 0, 0]);
    profileId = new ProfileRepo(db).upsert({ kind: 'business', displayName: '가게', bizNo: syntheticBizNo(31), corpNo: null, repName: null, bizType: null, bizItem: null, address: null, email: null, signMethod: null }).id;
  });
});

describe('receipt.phoneHas·phoneStore', () => {
  it('받기 → 문서(paper_receipt)·영수증(phone_capture) 한 쌍과 보관함 파일 하나. SHA는 기록만', async () => {
    const svc = intake();
    assert.deepEqual(await svc.handle('receipt.phoneHas', { msgId: ULID(2) }), { has: false });
    const img = jpeg('a');
    const r = (await svc.handle('receipt.phoneStore', { msgId: ULID(2), pairId: 'pair-1', jpeg: img, offer: offer() })) as Store;
    assert.equal(r.duplicate, false);
    assert.deepEqual(await svc.handle('receipt.phoneHas', { msgId: ULID(2) }), { has: true });
    const doc = new DocumentRepo(db).get(r.docId)!;
    assert.deepEqual([doc.profileId, doc.docType, doc.sha256, doc.bytes], [profileId, 'paper_receipt', createHash('sha256').update(img).digest('hex'), img.length]);
    assert.match(path.basename(doc.path), /^paper_receipt_20261106_[0-9A-Z]{4}\.jpg$/);
    assert.ok(path.dirname(doc.path) === vault && fs.existsSync(doc.path));
    const rec = new ReceiptRepo(db).get(r.docId)!;
    assert.deepEqual([rec.source, rec.phoneMsgId], ['phone_capture', ULID(2)]);
    assert.deepEqual(rec.phoneOcr, { ocrEngine: 'ios_vision', ownerConfirmed: true, candidates: { amount: 12_000 } });
    assert.deepEqual([receipts(), receiptDocs(), vaultFiles().length], [1, 1, 1]);
  });

  it('24시간 뒤 같은 msgId(엔진 재기동) → 영수증 1장, 고아 문서 0, 파일 그대로', async () => {
    const first = new ReceiptRepo(db).list(profileId, '2026-01-01', '2026-12-31').find((x) => x.phoneMsgId === ULID(2))!;
    const later = intake({}, T0 + 24 * 3_600_000);
    const r = (await later.handle('receipt.phoneStore', { msgId: ULID(2), pairId: 'pair-1', jpeg: jpeg('a'), offer: offer() })) as Store;
    assert.deepEqual(r, { docId: first.docId, duplicate: true });
    assert.deepEqual([receipts(), receiptDocs(), vaultFiles().length], [1, 1, 1]);
    assert.equal(count("SELECT count(*) FROM documents d LEFT JOIN receipts r ON r.doc_id = d.id WHERE d.doc_type = 'paper_receipt' AND r.doc_id IS NULL"), 0, '고아 문서 0');
  });

  it('같은 사진이라도 msgId가 다르면 따로 받는다(SHA로 중복을 보지 않는다)', async () => {
    const r = (await intake().handle('receipt.phoneStore', { msgId: ULID(3), pairId: 'pair-1', jpeg: jpeg('a'), offer: offer() })) as Store;
    assert.equal(r.duplicate, false);
    assert.deepEqual([receipts(), receiptDocs(), vaultFiles().length], [2, 2, 2]);
  });

  it('같은 msgId가 동시에 두 번 와도 한 번만 쓴다', async () => {
    const svc = intake();
    const msg = { msgId: ULID(4), pairId: 'pair-1', jpeg: jpeg('b'), offer: offer() };
    const [a, b] = (await Promise.all([svc.handle('receipt.phoneStore', msg), svc.handle('receipt.phoneStore', msg)])) as Store[];
    assert.deepEqual([a!.duplicate, b!.duplicate].sort(), [false, true]);
    assert.equal(a!.docId, b!.docId);
    assert.deepEqual([receipts(), receiptDocs(), vaultFiles().length], [3, 3, 3]);
  });

  it('UNIQUE 경합(검사 뒤 다른 쪽이 같은 msgId를 넣음) → 롤백, 파일 0 증가, duplicate true', async () => {
    let rival = '';
    const svc = intake({
      afterDuplicateCheck: (msgId) => {
        rival = randomUUID();
        new DocumentRepo(db).insert({ id: rival, profileId, docType: 'paper_receipt', displayName: null, issuedAt: null, expiresAt: null, issuer: null, path: path.join(vault, 'rival.jpg'), bytes: 1, sha256: 'c'.repeat(64), meta: null, runId: null });
        new ReceiptRepo(db).add({ docId: rival, source: 'phone_capture', phoneMsgId: msgId });
      },
    });
    const files = vaultFiles().length;
    const r = (await svc.handle('receipt.phoneStore', { msgId: ULID(5), pairId: 'pair-1', jpeg: jpeg('c'), offer: offer() })) as Store;
    assert.deepEqual(r, { docId: rival, duplicate: true });
    assert.equal(vaultFiles().length, files, '파일 0 증가');
    assert.deepEqual([receipts(), receiptDocs()], [4, 4], '경합 상대 한 쌍만 늘고 우리 문서 행은 롤백');
  });

  it('트랜잭션이 실패하면 롤백하고 파일을 지운다(임시 파일도 남지 않음)', async () => {
    const before = [receipts(), receiptDocs(), vaultFiles().length];
    const svc = intake({ beforeReceiptInsert: () => { throw new Error('disk_full'); } });
    await assert.rejects(svc.handle('receipt.phoneStore', { msgId: ULID(6), pairId: 'pair-1', jpeg: jpeg('d'), offer: offer() }), /disk_full/);
    assert.deepEqual([receipts(), receiptDocs(), vaultFiles().length], before);
    assert.ok(!vaultFiles().some((f) => f.startsWith('.')), '임시 파일 없음');
    assert.deepEqual(await svc.handle('receipt.phoneHas', { msgId: ULID(6) }), { has: false }, '다시 받으면 저장된다');
  });

  it('입력 검사: msgId(ULID)·JPEG 머리·크기·offer 모양·pairId', async () => {
    const svc = intake();
    const ok = { msgId: ULID(7), pairId: 'pair-1', jpeg: jpeg(), offer: offer() };
    await code(svc.handle('receipt.phoneHas', { msgId: 'not-a-ulid' }), 'bad_msg_id');
    await code(svc.handle('receipt.phoneStore', { ...ok, msgId: 'x' }), 'bad_msg_id');
    await code(svc.handle('receipt.phoneStore', { ...ok, jpeg: new Uint8Array(Buffer.from('%PDF-1.7 not a jpeg')) }), 'not_jpeg');
    await code(svc.handle('receipt.phoneStore', { ...ok, jpeg: new Uint8Array(4 * 1024 * 1024 + 1).fill(0xff) }), 'input_size');
    await code(svc.handle('receipt.phoneStore', { ...ok, jpeg: 'base64' }), 'input_size');
    await code(svc.handle('receipt.phoneStore', { ...ok, offer: offer({ ocrEngine: 'tesseract' }) }), 'bad_offer');
    await code(svc.handle('receipt.phoneStore', { ...ok, offer: offer({ capturedAt: '2026-11-06' }) }), 'bad_offer');
    await code(svc.handle('receipt.phoneStore', { ...ok, offer: offer({ ownerConfirmed: 'yes' }) }), 'bad_offer');
    await code(svc.handle('receipt.phoneStore', { ...ok, pairId: '' }), 'bad_pair_id');
    await code(svc.handle('receipt.delete', {}), 'unknown_method');
    assert.deepEqual(await svc.handle('receipt.phoneHas', { msgId: ULID(7) }), { has: false });
  });
});

describe('cash.phonePut', () => {
  it('늦은 enteredAt일 때만 바꾸고(source phone), 같은 메시지 재수신은 멱등', async () => {
    const svc = intake();
    const put = (o: Record<string, unknown>) => svc.handle('cash.phonePut', { msgId: ULID(20), day: '2026-11-05', amount: 150_000, enteredAt: T0, ...o });
    assert.deepEqual(await put({}), { applied: true });
    assert.deepEqual(await put({}), { applied: false }, '같은 메시지 다시');
    assert.deepEqual(await put({ msgId: ULID(21), amount: 90_000, enteredAt: T0 - 60_000 }), { applied: false }, '더 이른 입력은 무시');
    assert.deepEqual(await put({ msgId: ULID(22), amount: 170_000, enteredAt: T0 + 60_000 }), { applied: true });
    const cur = new CashSalesRepo(db).get(profileId, '2026-11-05')!;
    assert.deepEqual([cur.amount, cur.source, cur.enteredAt], [170_000, 'phone', new Date(T0 + 60_000).toISOString()]);
    await code(put({ day: '2026-11-31x' }), 'bad_day');
    await code(put({ amount: -1 }), 'bad_amount');
    await code(put({ enteredAt: 'now' }), 'bad_entered_at');
    await code(put({ msgId: 'x' }), 'bad_msg_id');
  });
});
