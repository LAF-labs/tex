import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { CAP, RECEIPT_CHUNK, bizNoValid, checkPaperInvoice, makeReceiptOffer, paperDirection, ulid, validateEnvelope, type Envelope, type PaperInvoice } from '@sax/remote';
import { PhoneIntake } from '@sax/bundle';
import { openDatabase, ProfileRepo, ReceiptRepo, syntheticBizNo, type Db } from '@sax/db';
import { AccountantPack } from '../apps/desktop/src/accountant-pack.ts';
import { DESKTOP_CAPS } from '../apps/desktop/src/phone-link.ts';
import { offerParams } from '../apps/desktop/src/phone-receive.ts';
import { fakeJpeg } from './remote-support.ts';

const ME = '220-81-62517';
const OTHER = '124-81-00998';
const paper = (o: Partial<PaperInvoice> = {}): PaperInvoice => ({
  docKind: 'tax_invoice',
  direction: 'purchase',
  writtenOn: '2026-10-28',
  bookNo: '3',
  serialNo: '17',
  supplier: { bizNo: OTHER, name: '대한식자재', ceo: '김대표' },
  buyer: { bizNo: ME, name: '율무커피' },
  supplyAmount: 300_000,
  vatAmount: 30_000,
  total: 330_000,
  items: [
    { month: 10, day: 28, name: '원두 1kg', qty: 10, unitPrice: 20_000, supply: 200_000, vat: 20_000 },
    { month: 10, day: 28, name: '우유', qty: 50, unitPrice: 2_000, supply: 100_000, vat: 10_000 },
  ],
  receiptOrClaim: 'claim',
  fieldConfidence: { supplyAmount: 100, 'supplier.bizNo': 82 },
  ...o,
});
const env = (body: object): Envelope => ({ v: 1, type: 'receipt.offer', id: ulid(), pairId: ulid(), from: 'mobile', to: 'desktop', seq: 0, ts: Date.now(), ttl: 300, body }) as Envelope;

describe('paperInvoice 와이어(v1.7)', () => {
  it('스키마가 받는 모양, 고친 판(bizNo 형식·없는 칸·품목 21개)은 거부', () => {
    const jpeg = fakeJpeg(80_000);
    const o = makeReceiptOffer(jpeg, { capturedAt: 1, ocrEngine: 'ios_vision', ownerConfirmed: true, paperInvoice: paper() });
    assert.equal(o.chunkSize, RECEIPT_CHUNK);
    assert.equal(validateEnvelope(env(o)), true);
    assert.equal(validateEnvelope(env({ ...o, paperInvoice: { ...o.paperInvoice, supplier: { bizNo: '2208162517', name: 'x' } } })), false);
    assert.equal(validateEnvelope(env({ ...o, paperInvoice: { ...o.paperInvoice, memo: 'x' } })), false);
    assert.equal(validateEnvelope(env({ ...o, paperInvoice: { ...o.paperInvoice, items: Array.from({ length: 21 }, () => ({ name: 'a', supply: 1 })) } })), false);
    const noRc: Record<string, unknown> = { ...o.paperInvoice! };
    delete noRc.receiptOrClaim;
    assert.equal(validateEnvelope(env({ ...o, paperInvoice: noRc })), false, 'receiptOrClaim은 필수(모르면 null)');
    assert.equal(validateEnvelope(env({ ...o, paperInvoice: { ...o.paperInvoice, receiptOrClaim: null } })), true);
    assert.equal(validateEnvelope(env({ ...o, paperInvoice: { ...o.paperInvoice, fieldConfidence: { total: 0.5 } } })), false, '신뢰도는 0~100 정수');
  });

  it('PC가 hello에서 receipt.v2를 알린다', () => {
    assert.equal(CAP.receiptV2, 'receipt.v2');
    assert.ok(DESKTOP_CAPS.includes('receipt.v2') && DESKTOP_CAPS.includes('receipt.v1') && DESKTOP_CAPS.includes('cash.v1'));
  });
});

describe('checkPaperInvoice·bizNoValid·paperDirection', () => {
  it('맞는 값은 빈 목록', () => {
    assert.deepEqual(checkPaperInvoice(paper()), []);
    assert.deepEqual(checkPaperInvoice(paper({ docKind: 'invoice', vatAmount: 0, total: 300_000, items: [{ name: '쌀', supply: 300_000 }] })), []);
    assert.deepEqual(checkPaperInvoice(paper({ items: undefined })), []);
  });
  it('합계·세액·품목 합·체크섬·같은 번호·날짜를 잡는다', () => {
    assert.deepEqual(checkPaperInvoice(paper({ total: 330_001 })), ['total']);
    assert.deepEqual(checkPaperInvoice(paper({ docKind: 'invoice' })), ['vatAmount']);
    assert.deepEqual(checkPaperInvoice(paper({ supplyAmount: 310_000, total: 340_000 })), ['items.supply']);
    assert.deepEqual(checkPaperInvoice(paper({ items: [{ name: 'a', supply: 300_000, vat: 1 }] })), ['items.vat']);
    assert.deepEqual(checkPaperInvoice(paper({ supplier: { bizNo: '123-45-67890', name: 'x' } })), ['supplier.bizNo']);
    assert.deepEqual(checkPaperInvoice(paper({ supplier: { bizNo: ME, name: 'x' } })), ['buyer.bizNo']);
    assert.deepEqual(checkPaperInvoice(paper({ writtenOn: '2026-02-30' })), ['writtenOn']);
    assert.throws(() => makeReceiptOffer(fakeJpeg(1000), { capturedAt: 1, ocrEngine: 'none', ownerConfirmed: true, paperInvoice: paper({ total: 1 }) }), /paper invoice total/);
  });
  it('체크섬은 @sax/db 규칙과 같다', async () => {
    const { isValidBizNo } = await import('@sax/db');
    for (let i = 0; i < 2000; i++) {
      const d = String(randomBytes(5).readUIntBE(0, 5) % 1e10).padStart(10, '0');
      assert.equal(bizNoValid(d), isValidBizNo(d), d);
    }
    assert.equal(bizNoValid('22081-62517'), false, '하이픈 자리가 틀리면 거부');
  });
  it('방향은 PC 사업자번호로 정한다(폰 값은 후보)', () => {
    assert.equal(paperDirection(paper({ direction: 'sales' }), ME), 'purchase');
    assert.equal(paperDirection(paper(), OTHER.replace(/-/g, '')), 'sales');
    assert.equal(paperDirection(paper(), '120-81-47521'), null);
    assert.equal(paperDirection(paper(), null), null);
  });
});

describe('PC 저장(phone-receive offerParams → 엔진 PhoneIntake)', () => {
  let dir: string;
  let db: Db;
  before(() => {
    dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sax-paper-'));
    db = openDatabase(path.join(dir, 'db.sqlite'), new Uint8Array(randomBytes(32)));
    new ProfileRepo(db).upsert({ kind: 'business', displayName: '율무커피', bizNo: syntheticBizNo(7), corpNo: null, repName: null, bizType: null, bizItem: null, address: null, email: null, signMethod: null });
  });
  after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('paperInvoice와 PC가 다시 본 결과(paperIssues)가 phone_ocr_json에, 문서 이름은 종이 세금계산서', async () => {
    const intake = new PhoneIntake(db, { vaultDir: path.join(dir, 'vault') });
    const jpeg = fakeJpeg(5000);
    jpeg[2] = 0xff;
    const good = makeReceiptOffer(jpeg, { capturedAt: Date.now(), ocrEngine: 'android_mlkit', ownerConfirmed: true, paperInvoice: paper() });
    const r = (await intake.handle('receipt.phoneStore', { msgId: good.msgId, pairId: 'p', jpeg, offer: offerParams(good) })) as { docId: string };
    const rec = new ReceiptRepo(db).get(r.docId)!;
    const ocr = rec.phoneOcr as { paperInvoice: PaperInvoice; paperIssues: string[] };
    assert.equal(ocr.paperInvoice.total, 330_000);
    assert.deepEqual(ocr.paperIssues, []);
    assert.equal(db.prepare('SELECT display_name FROM documents WHERE id = ?').pluck().get(r.docId), '종이 세금계산서');
    const bad = { ...good, msgId: ulid(), paperInvoice: { ...good.paperInvoice!, total: 1 } };
    const r2 = (await intake.handle('receipt.phoneStore', { msgId: bad.msgId, pairId: 'p', jpeg, offer: offerParams(bad) })) as { docId: string };
    assert.deepEqual((new ReceiptRepo(db).get(r2.docId)!.phoneOcr as { paperIssues: string[] }).paperIssues, ['total']);
  });
});

describe('세무사 꾸러미: 종이 세금계산서', () => {
  it('작성일 달의 것만, 원본 사진 + 매출·매입 표, 확인 필요는 빠진 것에', async () => {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sax-pack-'));
    try {
      const img = (n: number) => {
        const f = path.join(dir, `v${n}`);
        fs.writeFileSync(f, Buffer.from(fakeJpeg(3000, n)));
        return f;
      };
      const pack = new AccountantPack({
        past: async () => [],
        docs: async () => [],
        docFile: async () => {
          throw new Error('none');
        },
        receivables: async () => [],
        businessName: () => '율무커피',
        businessBizNo: () => ME,
        paperInvoices: async () => [
          { docId: 'd-purchase-0001', paper: paper(), file: img(1) },
          { docId: 'd-sales-0002', paper: paper({ supplier: { bizNo: ME, name: '율무커피' }, buyer: { bizNo: OTHER, name: '동네빵집' }, items: undefined }), file: img(2) },
          { docId: 'd-check-0003', paper: paper({ total: 1, writtenOn: '2026-10-30' }), file: null },
          { docId: 'd-nov-0004', paper: paper({ writtenOn: '2026-11-02' }), file: img(4) },
        ],
        outRoot: dir,
        now: () => new Date('2026-11-16T03:00:00Z'),
      });
      const s = await pack.make('2026-10');
      assert.deepEqual(s.paper.map((r) => [r.direction, r.writtenOn, r.issues]), [['purchase', '2026-10-28', []], ['sales', '2026-10-28', []], ['purchase', '2026-10-30', ['total']]]);
      const imgs = s.files.filter((f) => f.startsWith('종이 세금계산서/'));
      assert.equal(imgs.length, 2);
      assert.ok(imgs.some((f) => f.includes('_매입_대한식자재_')) && imgs.some((f) => f.includes('_매출_동네빵집_')), imgs.join());
      assert.deepEqual(fs.readFileSync(path.join(dir, '2026-10', imgs.find((f) => f.includes('매입'))!)), fs.readFileSync(path.join(dir, 'v1')), '원본 그대로');
      const csv = fs.readFileSync(path.join(dir, '2026-10', '종이 세금계산서 2026-10.csv'), 'utf8');
      assert.ok(csv.includes('매입,세금계산서,2026-10-28,124-81-00998,대한식자재,220-81-62517,율무커피,300000,30000,330000,청구,원두 1kg / 우유,있음,이상 없음'), csv);
      assert.ok(csv.includes('확인 필요(total)'));
      assert.ok(csv.includes('매출 합계,,,,,,,300000,30000,330000'));
      assert.ok(csv.includes('매입 합계,,,,,,,300001,30000,330001') || csv.includes('매입 합계'), '합계 줄');
      assert.ok(s.gaps.some((g) => g.kind === 'paper_check' && g.day === '2026-10-30'));
      assert.ok(fs.readFileSync(path.join(dir, '2026-10', '요약.txt'), 'utf8').includes('종이 세금계산서 3건(매출 1, 매입 2)'));
      assert.ok(fs.existsSync(path.join(dir, s.zipName)));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
