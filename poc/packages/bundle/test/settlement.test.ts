// 정산내역 넣기(D14 M6-5, J-01·J-02): settlement.store가 docparse 결과 요약만 남기고, 꾸러미 '정산·현금매출' 시트에 "파일에서 읽은 값"으로 적는다.
// 파일 칸 doc_type은 D07 §2(서버 색인을 끈 채 고정)를 따른다: 정산 settlement_file, 급여대장 payroll_ledger, 그 밖 bundle_file.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { configure, TextWriter, Uint8ArrayReader, ZipReader } from '@zip.js/zip.js';
import officeCrypto from 'officecrypto-tool';
import { BundleRepo, ColumnCipher, deriveColumnKey, DocumentRepo, openDatabase, ProfileRepo, syntheticBizNo, type BundleEntry, type Db } from '@sax/db';
import { attachDocType, BundleService, coversMonth, PcFileIntake, settlementSummary, type SettlementSummary } from '../src/index.ts';

configure({ useWebWorkers: false });

let dir: string;
let db: Db;
let pc: PcFileIntake;
let svc: BundleService;
let profileId: string;
const NOW = new Date('2026-11-09T01:00:00.000Z');
const call = <T = unknown>(m: string, p: Record<string, unknown>) => pc.handle(m, p) as Promise<T>;
const code = (m: string, p: Record<string, unknown>, c: string) => assert.rejects(call(m, p), (e: Error & { code?: string }) => e.code === c, `${m} → ${c}`);
const docCount = () => db.prepare('SELECT count(*) FROM documents').pluck().get() as number;
const xlsx = () => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), randomBytes(48)]);
const csv = () => Buffer.from(`일자,주문금액,수수료,정산금액\n2026-10-01,10000,1000,9000\n#${randomBytes(4).toString('hex')}\n`, 'utf8');

/** docparse SettlementResult 모양(extractor settlement-v1). 행·열 이름은 요약에 들어가지 않는다 */
function parsed(over: Record<string, unknown> = {}) {
  return {
    extractor: 'settlement-v1',
    channel: { value: 'delivery', confidence: 0.9, reason: null },
    platform: { value: 'baemin', confidence: 0.9, reason: null },
    profile: 'baemin-v1', estimated: true, sheet: '정산', headerRow: 1,
    columns: [{ role: 'gross', index: 1, header: '주문금액 김사장' }],
    period: { from: '2026-10-01', to: '2026-10-31' },
    rows: [{ date: '2026-10-01', gross: 10_000, fees: 1_000, payout: 9_000, vat: null, orderCount: 1 }],
    totals: { gross: 1_250_000, fees: 140_000, payout: 1_110_000, vat: null, rows: 87 },
    fileTotals: { gross: 1_250_000, fees: 140_000, payout: 1_110_000 },
    ...over,
  };
}

before(async () => {
  dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sax-settle-'));
  const key = new Uint8Array(randomBytes(32));
  db = openDatabase(path.join(dir, 'db.sqlite'), key);
  pc = new PcFileIntake(db, { vaultDir: path.join(dir, 'vault'), now: () => NOW });
  svc = new BundleService(db, new ColumnCipher(deriveColumnKey(key)), { exportDir: path.join(dir, 'exports'), now: () => NOW });
  profileId = new ProfileRepo(db).upsert({ kind: 'business', displayName: '가게', bizNo: syntheticBizNo(61), corpNo: null, repName: null, bizType: null, bizItem: null, address: null, email: null, signMethod: null }).id;
  await svc.handle('bundle.ensureItems', { profileId, industries: ['restaurant', 'online_seller'] });
});
after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const item = (kind: string) => new BundleRepo(db).items(profileId).find((i) => i.kind === kind)!;

describe('settlementSummary(요약만)', () => {
  it('플랫폼·기간·합계·행 수만 고르고, 파일 합계와 다르면 totalMismatch. 행·열 이름은 담지 않는다', () => {
    const s = settlementSummary(parsed(), { kind: 'settlement_delivery' });
    assert.deepEqual(s, { channel: 'delivery', platform: 'baemin', periodFrom: '2026-10-01', periodTo: '2026-10-31', gross: 1_250_000, fees: 140_000, payout: 1_110_000, vat: null, rows: 87, estimated: true, totalMismatch: false });
    assert.doesNotMatch(JSON.stringify(s), /김사장|orderCount/);
    assert.equal(settlementSummary(parsed({ fileTotals: { gross: 1_200_000, fees: null, payout: null } }), { kind: 'settlement_delivery' }).totalMismatch, true);
    assert.equal(settlementSummary(parsed({ platform: { value: null, confidence: 0, reason: 'not_found' }, fileTotals: null }), { kind: 'settlement_delivery' }).platform, null);
  });

  it('채널이 품목과 다르면 settlement_channel_mismatch, 모양이 틀리면 bad_settlement', () => {
    assert.throws(() => settlementSummary(parsed(), { kind: 'settlement_market' }), /settlement_channel_mismatch/);
    for (const bad of [null, {}, parsed({ extractor: 'receipt-v1' }), parsed({ totals: { gross: 1.5, rows: 1 } }), parsed({ platform: { value: 'amazon' } }), parsed({ period: { from: '2026-10-31', to: '2026-10-01' } })]) {
      assert.throws(() => settlementSummary(bad, { kind: 'settlement_delivery' }), /bad_settlement/);
    }
  });

  it('coversMonth: 기간이 그달을 다 덮어야 true, 못 읽었으면 false', () => {
    assert.equal(coversMonth({ periodFrom: '2026-09-28', periodTo: '2026-11-02' }, '2026-10-01', '2026-10-31'), true);
    assert.equal(coversMonth({ periodFrom: '2026-10-01', periodTo: '2026-10-15' }, '2026-10-01', '2026-10-31'), false);
    assert.equal(coversMonth({ periodFrom: null, periodTo: '2026-10-31' }, '2026-10-01', '2026-10-31'), false);
  });
});

describe('settlement.store', () => {
  it('보관함 파일 + settlement_file 문서(meta.settlement 요약) + 그달 표시. 그달을 다 덮으면 ready, 아니면 partial', async () => {
    const deliv = item('settlement_delivery');
    const r = await call<{ docId: string; period: string; entry: BundleEntry; summary: SettlementSummary }>('settlement.store', { profileId, itemId: deliv.id, month: '2026-10', bytes: xlsx(), format: 'xlsx', parsed: parsed(), displayName: '배민_정산_10월.xlsx' });
    assert.deepEqual([r.period, r.entry.status, r.entry.docIds, r.summary.gross], ['2026-10', 'ready', [r.docId], 1_250_000]);
    const d = new DocumentRepo(db).get(r.docId)!;
    assert.deepEqual([d.docType, d.displayName, (d.meta as { settlement: SettlementSummary }).settlement.payout], ['settlement_file', '배민_정산_10월.xlsx', 1_110_000]);
    assert.match(path.basename(d.path), /^settlement_file_20261109_[0-9A-Z]{4}\.xlsx$/);

    const market = item('settlement_market');
    const half = parsed({ channel: { value: 'market', confidence: 1, reason: null }, platform: { value: 'smartstore', confidence: 1, reason: null }, period: { from: '2026-10-01', to: '2026-10-15' } });
    const m = await call<{ entry: BundleEntry }>('settlement.store', { profileId, itemId: market.id, month: '2026-10', bytes: csv(), format: 'csv', parsed: half });
    assert.equal(m.entry.status, 'partial');
  });

  it('형식·품목·채널·결과 오류는 아무것도 남기지 않는다(csv라며 바이너리, 정산 아닌 품목, 엇갈린 채널)', async () => {
    const n = docCount();
    const deliv = item('settlement_delivery');
    await code('settlement.store', { profileId, itemId: deliv.id, month: '2026-10', bytes: Buffer.from([0x50, 0x4b, 0x03, 0x00, 0x00]), format: 'csv', parsed: parsed() }, 'format_mismatch');
    await code('settlement.store', { profileId, itemId: deliv.id, month: '2026-10', bytes: xlsx(), format: 'pdf', parsed: parsed() }, 'bad_format');
    await code('settlement.store', { profileId, itemId: item('payroll').id, month: '2026-10', bytes: xlsx(), format: 'xlsx', parsed: parsed() }, 'not_settlement_item');
    await code('settlement.store', { profileId, itemId: item('settlement_market').id, month: '2026-10', bytes: xlsx(), format: 'xlsx', parsed: parsed() }, 'settlement_channel_mismatch');
    await code('settlement.store', { profileId, itemId: deliv.id, month: '2026-10', bytes: xlsx(), format: 'xlsx', parsed: { extractor: 'x' } }, 'bad_settlement');
    await code('settlement.store', { profileId, itemId: 'nope', month: '2026-10', bytes: xlsx(), format: 'xlsx', parsed: parsed() }, 'item_not_found');
    assert.equal(docCount(), n);
  });

  it('파일 칸 doc_type은 D07 §2를 따른다: 정산 settlement_file, 급여대장(급여를 끈 업체) payroll_ledger, 3층 bundle_file', async () => {
    assert.deepEqual(['settlement_delivery', 'settlement_market', 'payroll', 'custom', 'paper_receipt'].map(attachDocType), ['settlement_file', 'settlement_file', 'payroll_ledger', 'bundle_file', 'bundle_file']);
    const pay = await call<{ docId: string }>('bundle.attachFile', { profileId, itemId: item('payroll').id, month: '2026-10', bytes: xlsx(), format: 'xlsx' });
    assert.equal(new DocumentRepo(db).get(pay.docId)!.docType, 'payroll_ledger');
  });
});

describe('꾸러미 내보내기: 정산·현금매출 시트', () => {
  it('정산 파일마다 플랫폼·기간·금액·수수료·입금액을 "파일에서 읽은 값"으로 적는다(형식 추정 표시), 요약 없는 파일은 예전처럼 한 줄', async () => {
    const r = (await svc.handle('bundle.export', { profileId, month: '2026-10' })) as { file: string; password: string; sheets: string[] };
    assert.ok(r.sheets.includes('정산·현금매출'));
    const parts = await new ZipReader(new Uint8ArrayReader(new Uint8Array(await officeCrypto.decrypt(fs.readFileSync(r.file), { password: r.password })))).getEntries();
    const all = (await Promise.all(parts.filter((p) => p.filename.endsWith('.xml')).map((p) => p.getData!(new TextWriter())))).join('\n');
    for (const s of ['배달앱 월별 정산내역(배달의민족)', '2026-10-01~2026-10-31', '파일에서 읽은 값, 형식 추정', '오픈마켓 월별 정산내역(스마트스토어)', '수수료', '입금액']) assert.ok(all.includes(s), s);
    for (const n of ['1250000', '140000', '1110000']) assert.match(all, new RegExp(`<v>${n}</v>|>${n}<`), n);
    assert.doesNotMatch(all, /김사장/, '파일 안 글자(열 이름)는 옮기지 않는다');
  });
});
