// PC 파일을 보관함에 넣기(08 D-05, D14 M6-2·M6-4): receipt.pcStore·bundle.attachFile. 파일을 열지 않고 머리 바이트·크기만, 고아 파일·문서 0, 같은 파일은 다시 쓰지 않음.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { BundleService, PC_FILE_MAX, PcFileIntake, type ItemStatus, type ReceiptView } from '@sax/bundle';
import { BundleRepo, ColumnCipher, deriveColumnKey, DocumentRepo, openDatabase, ProfileRepo, ReceiptRepo, syntheticBizNo, type BundleEntry, type Db } from '@sax/db';
import { COMMANDS, MAIN_ONLY, PAYROLL_MAIN_ONLY, PC_FILE_COMMANDS, PHONE_COMMANDS, READ_QUERIES, SETTLEMENT_COMMANDS } from '@sax/engine/protocol';

const root = path.resolve(import.meta.dirname, '..');
const entry = fs.readFileSync(path.join(root, 'packages/engine/src/entry.ts'), 'utf8');
const src = fs.readFileSync(path.join(root, 'packages/bundle/src/pc-file.ts'), 'utf8');

let dir: string;
let vault: string;
let db: Db;
let pc: PcFileIntake;
let svc: BundleService;
let profileId: string;
let otherProfile: string;
const call = <T = unknown>(m: string, p: Record<string, unknown>) => pc.handle(m, p) as Promise<T>;
const code = (m: string, p: Record<string, unknown>, c: string) => assert.rejects(call(m, p), (e: Error & { code?: string }) => e.code === c, `${m} → ${c}`);
const files = () => fs.readdirSync(vault).filter((f) => !f.startsWith('.'));
const docCount = () => db.prepare('SELECT count(*) FROM documents').pluck().get() as number;
const jpeg = (n = 64) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(n)]);
const pdf = () => Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(32)]);
const xlsx = () => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), randomBytes(32)]);
const hwp = () => Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), randomBytes(32)]);
const NOW = new Date('2026-11-09T01:00:00.000Z');

before(async () => {
  dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sax-pc-file-'));
  vault = path.join(dir, 'vault');
  const key = new Uint8Array(randomBytes(32));
  db = openDatabase(path.join(dir, 'db.sqlite'), key);
  pc = new PcFileIntake(db, { vaultDir: vault, now: () => NOW });
  svc = new BundleService(db, new ColumnCipher(deriveColumnKey(key)), { exportDir: path.join(dir, 'exports'), now: () => NOW });
  const profiles = new ProfileRepo(db);
  const base = { corpNo: null, repName: null, bizType: null, bizItem: null, address: null, email: null, signMethod: null };
  profileId = profiles.upsert({ kind: 'business', displayName: '가게', bizNo: syntheticBizNo(51), ...base }).id;
  otherProfile = profiles.upsert({ kind: 'personal', displayName: '개인', bizNo: null, ...base }).id;
  await svc.handle('bundle.ensureItems', { profileId, industries: ['restaurant'] });
});
after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('receipt.pcStore(종이 증빙)', () => {
  it('보관함 파일(이름에 PII 없음) + documents + receipts(pc_file, 읽기 후보 기록). 확인 전 목록에 보인다', async () => {
    const bytes = jpeg();
    const ocr = { kind: 'receipt', amount: { value: 15_000, confidence: 0.8 } };
    const r = await call<{ docId: string; duplicate: boolean }>('receipt.pcStore', { profileId, bytes, format: 'jpg', ocr });
    assert.equal(r.duplicate, false);
    const d = new DocumentRepo(db).get(r.docId)!;
    assert.deepEqual([d.profileId, d.docType, d.bytes, d.sha256], [profileId, 'paper_receipt', bytes.length, createHash('sha256').update(bytes).digest('hex')]);
    assert.match(path.basename(d.path), /^paper_receipt_20261109_[0-9A-Z]{4}\.jpg$/);
    assert.ok(fs.readFileSync(d.path).equals(bytes));
    assert.deepEqual([new ReceiptRepo(db).get(r.docId)!.source, new ReceiptRepo(db).get(r.docId)!.ocr], ['pc_file', ocr]);
    const list = (await svc.handle('db.query.receipt.list', { profileId, month: '2026-11' })) as { receipts: ReceiptView[]; unconfirmed: number };
    assert.ok(list.receipts.some((x) => x.docId === r.docId));
  });

  it('같은 파일을 다시 넣으면 새로 쓰지 않는다(파일·문서 그대로, 확인한 값 유지, 새 후보만 기록). 다른 프로필은 따로', async () => {
    const bytes = pdf();
    const first = await call<{ docId: string }>('receipt.pcStore', { profileId, bytes, format: 'pdf' });
    await svc.handle('receipt.confirm', { profileId, docId: first.docId, issuedOn: '2026-11-02', amount: 33_000 });
    const [n, f] = [docCount(), files().length];
    const again = await call<{ docId: string; duplicate: boolean }>('receipt.pcStore', { profileId, bytes, format: 'pdf', ocr: { amount: { value: 1 } } });
    assert.deepEqual(again, { docId: first.docId, duplicate: true });
    assert.deepEqual([docCount(), files().length], [n, f]);
    const rec = new ReceiptRepo(db).get(first.docId)!;
    assert.deepEqual([rec.amount, rec.ocr], [33_000, { amount: { value: 1 } }]);
    const theirs = await call<{ docId: string; duplicate: boolean }>('receipt.pcStore', { profileId: otherProfile, bytes, format: 'pdf' });
    assert.notEqual(theirs.docId, first.docId);
    assert.equal(theirs.duplicate, false);
  });

  it('형식·크기·인자 오류는 아무것도 남기지 않는다(머리 바이트가 말한 형식과 달라도 막는다)', async () => {
    const [n, f] = [docCount(), files().length];
    await code('receipt.pcStore', { profileId, bytes: pdf(), format: 'jpg' }, 'format_mismatch');
    await code('receipt.pcStore', { profileId, bytes: Buffer.from('MZ\x90\x00'), format: 'pdf' }, 'format_mismatch');
    await code('receipt.pcStore', { profileId, bytes: xlsx(), format: 'xlsx' }, 'bad_format');
    await code('receipt.pcStore', { profileId, bytes: new Uint8Array(0), format: 'jpg' }, 'input_size');
    await code('receipt.pcStore', { profileId, bytes: Buffer.concat([jpeg(0), Buffer.alloc(PC_FILE_MAX)]), format: 'jpg' }, 'input_size');
    await code('receipt.pcStore', { profileId, bytes: 'ffd8ff', format: 'jpg' }, 'input_size');
    await code('receipt.pcStore', { profileId, bytes: jpeg(), format: 'jpg', ocr: 'text' }, 'bad_ocr');
    await code('receipt.pcStore', { profileId, bytes: jpeg(), format: 'jpg', ocr: { t: 'x'.repeat(20_000) } }, 'bad_ocr');
    await code('receipt.pcStore', { profileId: 'nope', bytes: jpeg(), format: 'jpg' }, 'profile_not_found');
    assert.deepEqual([docCount(), files().length], [n, f]);
  });

  it('트랜잭션이 실패하면 롤백하고 새로 쓴 파일을 지운다(고아 파일·문서 0)', async () => {
    const broken = new PcFileIntake(db, { vaultDir: vault, now: () => NOW, beforeLink: () => { throw new Error('boom'); } });
    const [n, f] = [docCount(), files().length];
    await assert.rejects(broken.handle('receipt.pcStore', { profileId, bytes: jpeg(), format: 'jpg' }), /boom/);
    assert.deepEqual([docCount(), files().length], [n, f]);
    assert.deepEqual(fs.readdirSync(vault).filter((x) => x.startsWith('.pc-tmp-')), []);
  });
});

describe('bundle.attachFile(꾸러미 파일 칸)', () => {
  const item = (kind: string) => new BundleRepo(db).items(profileId).find((i) => i.kind === kind)!;

  it('그달 표시에 문서를 더한다: 표시가 없으면 ready, 있으면 상태 그대로. 원래 파일 이름은 경로 조각을 뺀 표시 이름으로만', async () => {
    const deliv = item('settlement_delivery');
    const a = await call<{ docId: string; period: string; entry: BundleEntry }>('bundle.attachFile', { profileId, itemId: deliv.id, month: '2026-10', bytes: xlsx(), format: 'xlsx', displayName: 'C:\\Users\\kim\\배민_10월.xlsx' });
    assert.deepEqual([a.period, a.entry.status, a.entry.docIds], ['2026-10', 'ready', [a.docId]]);
    const d = new DocumentRepo(db).get(a.docId)!;
    assert.deepEqual([d.docType, d.displayName], ['settlement_file', '배민_10월.xlsx'], '정산 품목은 settlement_file(D07 §2)');
    assert.match(path.basename(d.path), /^settlement_file_20261109_[0-9A-Z]{4}\.xlsx$/);
    await svc.handle('bundle.setEntry', { profileId, itemId: deliv.id, month: '2026-10', status: 'partial' });
    const b = await call<{ docId: string; entry: BundleEntry }>('bundle.attachFile', { profileId, itemId: deliv.id, month: '2026-10', bytes: pdf(), format: 'pdf' });
    assert.deepEqual([b.entry.status, b.entry.docIds], ['partial', [a.docId, b.docId]]);
    assert.equal(new DocumentRepo(db).get(b.docId)!.displayName, deliv.name, '이름을 안 주면 항목 이름');
    const st = ((await svc.handle('db.query.bundle.status', { profileId, month: '2026-10' })) as ItemStatus[]).find((s) => s.item.id === deliv.id)!;
    assert.deepEqual(st.docIds, [a.docId, b.docId]);
  });

  it('같은 파일은 다시 쓰지 않고 붙이기만(목록에 한 번), 분기 항목은 분기 기간, 한글(hwp) 파일', async () => {
    const q = (await svc.handle('bundle.addItem', { profileId, name: '임대차계약서', cadence: 'quarterly' })) as { id: string };
    const bytes = hwp();
    const one = await call<{ docId: string; period: string; entry: BundleEntry }>('bundle.attachFile', { profileId, itemId: q.id, month: '2026-11', bytes, format: 'hwp' });
    const [n, f] = [docCount(), files().length];
    const two = await call<{ docId: string; duplicate: boolean; entry: BundleEntry }>('bundle.attachFile', { profileId, itemId: q.id, month: '2026-11', bytes, format: 'hwp' });
    assert.deepEqual([one.period, two.duplicate, two.docId, two.entry.docIds], ['2026-Q4', true, one.docId, [one.docId]]);
    assert.deepEqual([docCount(), files().length], [n, f]);
  });

  it('앱이 세는 항목(카드, 급여를 쓰는 업체의 급여대장)·다른 프로필 항목·형식 오류는 막고 아무것도 남기지 않는다', async () => {
    const [n, f] = [docCount(), files().length];
    await code('bundle.attachFile', { profileId, itemId: item('card').id, month: '2026-10', bytes: pdf(), format: 'pdf' }, 'entry_derived');
    await svc.handle('payroll.setEnabled', { profileId, on: true });
    await code('bundle.attachFile', { profileId, itemId: item('payroll').id, month: '2026-10', bytes: pdf(), format: 'pdf' }, 'entry_derived');
    await svc.handle('payroll.setEnabled', { profileId, on: false });
    await svc.handle('bundle.ensureItems', { profileId: otherProfile, industries: [] });
    const theirs = new BundleRepo(db).items(otherProfile)[0]!;
    await code('bundle.attachFile', { profileId, itemId: theirs.id, month: '2026-10', bytes: pdf(), format: 'pdf' }, 'item_not_found');
    await code('bundle.attachFile', { profileId, itemId: item('payroll').id, month: '2026-13', bytes: pdf(), format: 'pdf' }, 'invalid_month');
    await code('bundle.attachFile', { profileId, itemId: item('payroll').id, month: '2026-10', bytes: pdf(), format: 'exe' }, 'bad_format');
    await code('bundle.attachFile', { profileId, itemId: item('payroll').id, month: '2026-10', bytes: jpeg(), format: 'png' }, 'format_mismatch');
    await code('bundle.attachFile', { profileId, itemId: item('payroll').id, month: '2026-10', bytes: pdf(), format: 'pdf', displayName: 'x'.repeat(101) }, 'bad_display_name');
    assert.deepEqual([docCount(), files().length], [n, f]);
    // 급여를 끈 업체의 급여대장은 파일 칸이다
    const ok = await call<{ entry: BundleEntry }>('bundle.attachFile', { profileId, itemId: item('payroll').id, month: '2026-10', bytes: pdf(), format: 'pdf' });
    assert.equal(ok.entry.status, 'ready');
  });
});

describe('배선(추가만)', () => {
  it('main 전용(렌더러 목록 밖), 폰 명령과 따로, entry가 PcFileIntake로 보낸다(보관함 폴더는 엔진이 정한다)', () => {
    assert.deepEqual([...PC_FILE_COMMANDS], ['receipt.pcStore', 'bundle.attachFile']);
    const others = new Set<string>([...READ_QUERIES, ...COMMANDS, ...MAIN_ONLY, ...PAYROLL_MAIN_ONLY, ...PHONE_COMMANDS]);
    for (const m of PC_FILE_COMMANDS) assert.ok(!others.has(m), m);
    assert.match(entry, /pcFiles = new PcFileIntake\(db, \{ vaultDir: paths\.vault \}\);/);
    assert.match(entry, /if \(PC_FILE\.has\(method\)\) \{\n\s+if \(!pcFiles\) throw new Error\('db_not_ready'\);\n\s+return pcFiles\.handle\(method, params\);/);
  });

  it('settlement.store(M6-5)도 main 전용이고 PcFileIntake로 간다', () => {
    assert.deepEqual([...SETTLEMENT_COMMANDS], ['settlement.store']);
    const others = new Set<string>([...READ_QUERIES, ...COMMANDS, ...MAIN_ONLY, ...PAYROLL_MAIN_ONLY, ...PHONE_COMMANDS, ...PC_FILE_COMMANDS]);
    assert.ok(!others.has('settlement.store'));
    assert.match(entry, /for \(const m of SETTLEMENT_COMMANDS\) \{\n\s+PC_FILE\.add\(m\);\n\s+ALLOWED\.add\(m\);\n\}/);
  });

  it('파일을 읽거나 파싱하지 않고, 모델·네트워크·로그를 쓰지 않는다', () => {
    assert.doesNotMatch(src, /@sax\/model|@sax\/net|@sax\/docparse|\bfetch\(|console\.|\blog\.|readFile|parse(Receipt|Pdf|Image)/);
  });
});
