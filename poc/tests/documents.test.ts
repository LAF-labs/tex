// PoC-8 보관함: 엔진이 PDF를 보관함 폴더에 쓰고 v1 documents 행으로 등록한다(D07 §1.3·§4). 임시 DB·임시 폴더만 쓴다.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import { DocumentRepo, formatBizNo, openDatabase, syntheticBizNo, type Db } from '@sax/db';
import { BizVerifier, DataService, type DocumentView } from '@sax/engine';
import { MAIN_ONLY } from '@sax/engine/protocol';
import { Egress } from '@sax/net';

const BIZ = syntheticBizNo(7);
const OTHER = syntheticBizNo(8);
const NOW = new Date('2026-11-10T03:00:00Z'); // 한국 시간 2026-11-10 12:00

const taxText = (biz = BIZ, valid = '2026년 11월 30일') =>
  `발급번호 0123-457-5258-910\n납세증명서\n주민등록번호(사업자등록번호) ${formatBizNo(biz)}\n유효기간 ${valid}\n「국세징수법」 … 다른 체납액이 없음을 증명합니다.\n담당부서 민원봉사실\n2026년 11월 1일\n가나세무서장 직인`;
const bizText = `발급번호 T123-472-2634-650\n사업자등록증명\n사업자등록번호 ${formatBizNo(BIZ)}\n개업일 2019년 04월 11일 사업자등록일 2019년 04월 14일\n위와 같이 증명합니다.\n2026년 10월 06일\n아자세무서장 (인)`;
/** 내용이 다른 가짜 PDF 바이트(엔진은 머리만 본다. 글자는 docparse가 준 텍스트로 받는다) */
const pdf = (tag: string) => new Uint8Array(Buffer.from(`%PDF-1.7\n% ${tag} ${randomBytes(8).toString('hex')}\n%%EOF\n`));
const extract = (text: string, o: { hasTextLayer?: boolean; scanned?: boolean; ocrConfidence?: number | null } = {}) => ({ text, pages: 1, totalPages: 1, hasTextLayer: o.hasTextLayer ?? true, scanned: o.scanned ?? false, ocrConfidence: o.ocrConfidence ?? null });

describe('보관함(DocumentService)', () => {
  let root: string;
  let vault: string;
  let db: Db;
  let svc: DataService;
  const call = <T>(m: string, p: Record<string, unknown> = {}) => svc.handle(m, p) as Promise<T>;

  before(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sax-vault-'));
  });
  after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });
  beforeEach(async () => {
    vault = await fsp.mkdtemp(path.join(root, 'v-'));
    db = openDatabase(path.join(vault, '..', `${path.basename(vault)}.sqlite`), new Uint8Array(randomBytes(32)));
    svc = new DataService(db, new BizVerifier(new Egress()), { vaultDir: vault, now: () => NOW });
  });
  afterEach(() => {
    mock.restoreAll();
    db.close();
  });
  const business = (biz = BIZ) => call('profile.upsert', { kind: 'business', displayName: '주식회사 가나다테크', bizNo: biz });
  /** 화면처럼 지금 저장값을 본 값(seen)으로 붙여 보낸다 */
  const upd = async (id: string, patch: Record<string, unknown>) => {
    const cur = (await call<DocumentView[]>('db.query.documents.list')).find((d) => d.id === id);
    return call<DocumentView>('document.update', { id, patch, seen: cur && { docType: cur.docType, issuedOn: cur.issuedOn, expiresOn: cur.expiresOn } });
  };

  it('사업자 프로필이 없으면 profile_required, 파일도 남지 않는다', async () => {
    await assert.rejects(call('document.import', { bytes: pdf('a'), extract: extract(taxText()) }), /profile_required/);
    assert.deepEqual(await fsp.readdir(vault), []);
  });

  it('납세증명서: 파일명에 PII 없음, 0600, sha256, 문서에서 읽은 만료일과 남은 날(한국 시간)', async () => {
    await business();
    const bytes = pdf('tax');
    const d = await call<DocumentView>('document.import', { bytes, extract: extract(taxText()) });
    assert.equal(d.docType, 'national_tax_cert');
    assert.equal(d.displayName, '납세증명서(국세)');
    assert.deepEqual([d.issuedOn, d.expiresOn, d.expirySource, d.daysLeft, d.needsUser], ['2026-11-01', '2026-11-30', 'document', 20, false]);
    assert.deepEqual([d.issuer, d.docNo, d.subjectBizNo, d.subjectMismatch, d.source, d.textSource], ['가나세무서장', '0123-457-5258-910', BIZ, false, 'import', 'text']);
    const files = await fsp.readdir(vault);
    assert.equal(files.length, 1);
    assert.match(files[0]!, /^national_tax_cert_20261101_[0-9A-HJKMNP-TV-Z]{4}\.pdf$/);
    const row = new DocumentRepo(db).get(d.id)!;
    assert.equal(row.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.deepEqual(new Uint8Array(await fsp.readFile(row.path)), bytes);
    if (process.platform !== 'win32') assert.equal((await fsp.stat(row.path)).mode & 0o777, 0o600);
    assert.ok(!JSON.stringify(row.meta).includes('국세징수법'), '원문 텍스트는 저장하지 않는다');
    assert.equal(!('path' in d), true, '렌더러 보기에 경로가 없다');
  });

  it('같은 파일을 다시 넣으면 새로 쓰지 않고 기존 항목(duplicate)', async () => {
    await business();
    const bytes = pdf('dup');
    const a = await call<DocumentView>('document.import', { bytes, extract: extract(taxText()) });
    const b = await call<DocumentView>('document.import', { bytes, extract: extract(taxText()) });
    assert.equal(b.id, a.id);
    assert.equal(b.duplicate, true);
    assert.equal((await fsp.readdir(vault)).length, 1);
  });

  it('사업자등록증명은 규칙표 추정(발급일 포함 90일), 목록은 최근 발급순', async () => {
    await business();
    await call('document.import', { bytes: pdf('biz'), extract: extract(bizText) });
    await call('document.import', { bytes: pdf('tax'), extract: extract(taxText()) });
    const list = await call<DocumentView[]>('db.query.documents.list');
    assert.deepEqual(list.map((d) => [d.docType, d.issuedOn, d.expiresOn, d.expirySource]), [
      ['national_tax_cert', '2026-11-01', '2026-11-30', 'document'],
      ['biz_registration_cert', '2026-10-06', '2027-01-03', 'rule'],
    ]);
  });

  it('다른 사업자 서류는 표시하고, OCR로 읽은 서류·범위 밖 유효기간은 확인을 요구한다', async () => {
    await business();
    const other = await call<DocumentView>('document.import', { bytes: pdf('o'), extract: extract(taxText(OTHER)) });
    assert.equal(other.subjectMismatch, true);
    const ocr = await call<DocumentView>('document.import', { bytes: pdf('ocr'), extract: extract(taxText(), { hasTextLayer: false, ocrConfidence: 88 }) });
    assert.deepEqual([ocr.needsUser, ocr.reasons, ocr.textSource, ocr.expiresOn], [true, ['read_by_ocr'], 'ocr', '2026-11-30']);
    const scan = await call<DocumentView>('document.import', { bytes: pdf('scan'), extract: extract(taxText(), { scanned: true }) });
    assert.deepEqual([scan.needsUser, scan.reasons, scan.textSource], [true, ['scanned_text_layer'], 'scan'], '스캐너가 덧입힌 글자 층도 원본으로 믿지 않는다');
    const far = await call<DocumentView>('document.import', { bytes: pdf('far'), extract: extract(taxText(BIZ, '2027년 1월 1일')) });
    assert.deepEqual([far.needsUser, far.expiresOn, far.expirySource, far.reasons], [true, '2026-11-30', 'rule', ['valid_until_out_of_range']]);
  });

  it('알아보지 못한 서류도 보관한다(종류 other, 만료 없음, 확인 필요)', async () => {
    await business();
    const d = await call<DocumentView>('document.import', { bytes: pdf('x'), extract: extract('지방세 납세증명서\n가나구청장') });
    assert.deepEqual([d.docType, d.kind, d.displayName, d.expiresOn, d.needsUser], ['other', 'localtax_cert', '지방세 납세증명서', null, true]);
    assert.match((await fsp.readdir(vault))[0]!, /^other_20261110_/);
  });

  // 화면(vault-panel.js)은 바뀐 칸만 보낸다. 엔진은 저장값과 같은 값을 '바뀌지 않음'으로도 본다(화면이 세 칸을 다 보내도 같은 결과).
  it('사용자 확인: 그대로 확인하면 추정이 확인함으로, 날짜를 넣으면 그 값, 종류·발급일을 바꾸면 규칙으로 다시', async () => {
    await business();
    const b = await call<DocumentView>('document.import', { bytes: pdf('b'), extract: extract(bizText) });
    const confirmed = await upd(b.id, {});
    assert.deepEqual([confirmed.expirySource, confirmed.needsUser, confirmed.expiresOn], ['user', false, '2027-01-03']);
    const set = await upd(b.id, { expiresOn: '2026-11-05' });
    assert.deepEqual([set.expiresOn, set.expirySource, set.daysLeft], ['2026-11-05', 'user', -5]);
    const re = await upd(b.id, { issuedOn: '2026-11-02' });
    assert.deepEqual([re.issuedOn, re.expiresOn, re.expirySource, re.needsUser, re.reasons], ['2026-11-02', '2027-01-30', 'rule', true, ['expiry_recomputed']], '다시 계산한 만료일은 보여 준 뒤 한 번 더 확인받는다');
    const reConfirmed = await upd(b.id, {});
    assert.deepEqual([reConfirmed.expiresOn, reConfirmed.expirySource, reConfirmed.needsUser], ['2027-01-30', 'user', false]);
    // 세 칸을 다 보내도(만료일은 저장값 그대로) 발급일만 바뀌었으면 규칙으로 다시 정한다
    const all = await upd(b.id, { docType: 'biz_registration_cert', issuedOn: '2026-10-06', expiresOn: '2027-01-30' });
    assert.deepEqual([all.issuedOn, all.expiresOn, all.expirySource], ['2026-10-06', '2027-01-03', 'rule']);
    const x = await call<DocumentView>('document.import', { bytes: pdf('x'), extract: extract('영수증'), final: true });
    const typed = await upd(x.id, { docType: 'national_tax_cert', issuedOn: '2026-11-03' });
    assert.deepEqual([typed.docType, typed.displayName, typed.expiresOn, typed.expirySource], ['national_tax_cert', '납세증명서(국세)', '2026-12-02', 'rule']);
    assert.deepEqual([typed.needsUser, typed.reasons], [true, ['valid_until_not_found', 'expiry_recomputed']], '다시 정한 추정값은 확인 필요를 그대로 둔다(지정납부기한으로 더 짧을 수 있다)');
    const toOther = await upd(typed.id, { docType: 'other' });
    assert.deepEqual([toOther.docType, toOther.expiresOn, toOther.needsUser], ['other', '2026-12-02', false], "'그 밖의 서류'로 고르면 만료일은 두고 확인한 것으로");
  });

  it('본 값(seen)이 없거나 저장값과 다르면 거부: 같은 수정을 다시 보내 재계산 값이 확인되지 않는다', async () => {
    await business();
    const b = await call<DocumentView>('document.import', { bytes: pdf('b'), extract: extract(bizText) });
    await assert.rejects(call('document.update', { id: b.id, patch: {} }), /seen_required/);
    await assert.rejects(call('document.update', { id: b.id, patch: {}, seen: { docType: b.docType, issuedOn: b.issuedOn } }), /seen_required/, '세 칸을 다 보내야 한다');
    const seen = { docType: b.docType, issuedOn: b.issuedOn, expiresOn: b.expiresOn };
    const first = await call<DocumentView>('document.update', { id: b.id, patch: { issuedOn: '2026-11-02' }, seen });
    assert.deepEqual([first.needsUser, first.reasons], [true, ['expiry_recomputed']]);
    // 확인을 두 번 눌러 같은 요청이 다시 오면: 이제 저장값과 같아 '확인'이 될 요청이지만, 본 값이 옛 값이라 거부한다
    await assert.rejects(call('document.update', { id: b.id, patch: { issuedOn: '2026-11-02' }, seen }), /stale/);
    await assert.rejects(call('document.update', { id: b.id, patch: {}, seen }), /stale/);
    const still = (await call<DocumentView[]>('db.query.documents.list')).find((d) => d.id === b.id)!;
    assert.deepEqual([still.needsUser, still.expirySource], [true, 'rule'], '재계산 값은 확인 필요로 남는다');
  });

  it('유효기간 후보가 여럿인 납세증명서: 규칙보다 이른 문서 후보를 잠정 만료일로, 그대로 확인해도 문서보다 늦지 않다', async () => {
    await business();
    const two = taxText().replace('유효기간 2026년 11월 30일', '유효기간 2026년 11월 30일\n유효기간 2026년 11월 5일');
    assert.notEqual(two, taxText());
    const d = await call<DocumentView>('document.import', { bytes: pdf('two'), extract: extract(two) });
    assert.deepEqual([d.expiresOn, d.expirySource, d.needsUser, d.reasons, d.suggested.validUntil], ['2026-11-05', 'document', true, ['valid_until_ambiguous'], '2026-11-05']);
    // 발급일을 첫 후보 뒤로 고치면, 쓸 수 있는 다음 후보(11-30)가 잠정 만료일·후보가 된다(규칙 12-05로 돌아가지 않는다)
    const moved = await upd(d.id, { issuedOn: '2026-11-06' });
    assert.deepEqual([moved.expiresOn, moved.expirySource, moved.needsUser, moved.suggested.validUntil], ['2026-11-30', 'document', true, '2026-11-30']);
    const back = await upd(d.id, { issuedOn: '2026-11-01' });
    assert.deepEqual([back.expiresOn, back.suggested.validUntil], ['2026-11-05', '2026-11-05']);
    const ok = await upd(d.id, {});
    assert.deepEqual([ok.expiresOn, ok.needsUser, ok.expirySource], ['2026-11-05', false, 'user'], '정하지 못한 후보를 확인하면 확인함');
  });

  it('OCR로 읽은 서류의 발급일만 고쳐도, OCR 유효기간을 문서 값으로 되살려 확정하지 않는다', async () => {
    await business();
    const ocrText = taxText(BIZ, '2026년 11월 30일').replace('2026년 11월 1일', '2026년 10월 20일');
    const d = await call<DocumentView>('document.import', { bytes: pdf('ocr-edit'), extract: extract(ocrText, { ocrConfidence: 80 }) });
    assert.deepEqual([d.expiresOn, d.expirySource, d.needsUser], ['2026-11-18', 'rule', true]);
    assert.ok(d.reasons.includes('valid_until_out_of_range') && d.reasons.includes('read_by_ocr'));
    const edited = await upd(d.id, { issuedOn: '2026-11-01' });
    assert.deepEqual([edited.expiresOn, edited.expirySource, edited.needsUser], ['2026-11-30', 'document', true]);
    assert.deepEqual(edited.reasons, ['read_by_ocr', 'expiry_recomputed']);
  });

  it('다른 사업자 서류·사업자번호를 못 읽은 서류는 확인을 받는다(수정해도 남고, 그대로 확인하면 지운다)', async () => {
    await business();
    const other = await call<DocumentView>('document.import', { bytes: pdf('other-biz'), extract: extract(taxText(OTHER)) });
    assert.deepEqual([other.subjectMismatch, other.needsUser, other.reasons], [true, true, ['subject_mismatch']]);
    const edited = await upd(other.id, { expiresOn: '2026-11-20' });
    assert.deepEqual([edited.needsUser, edited.reasons], [true, ['subject_mismatch']]);
    const ok = await upd(other.id, {});
    assert.deepEqual([ok.needsUser, ok.reasons, ok.subjectMismatch], [false, [], true]);
    const unread = await call<DocumentView>('document.import', { bytes: pdf('no-biz'), extract: extract(taxText().replace(formatBizNo(BIZ), '800101-*******')) });
    assert.deepEqual([unread.needsUser, unread.reasons], [true, ['subject_unverified']]);
  });

  it('발급일 없는 서류를 그대로 확인해도 만료 경고가 사라지게 두지 않는다', async () => {
    await business();
    const d = await call<DocumentView>('document.import', { bytes: pdf('no-issued'), extract: extract(bizText.replace('2026년 10월 06일', '')), final: true });
    assert.equal(d.issuedOn, null);
    const confirmed = await upd(d.id, {});
    assert.deepEqual([confirmed.needsUser, confirmed.reasons], [true, ['issued_on_missing']]);
    const cleared = await upd(d.id, { issuedOn: '2026-10-06' });
    const noExpiry = await upd(cleared.id, { expiresOn: null });
    assert.deepEqual([noExpiry.expiresOn, noExpiry.needsUser], [null, false], '사업자등록증명 만료일은 사용자가 지울 수 있다(법정 유효기간 없음)');
  });

  it('납세증명서 만료일을 비우면 확인 필요로 남고, 법정 상한(발급일+30일)을 넘으면 거부한다', async () => {
    await business();
    const d = await call<DocumentView>('document.import', { bytes: pdf('t'), extract: extract(taxText()) });
    const cleared = await upd(d.id, { expiresOn: null });
    assert.deepEqual([cleared.expiresOn, cleared.needsUser, cleared.reasons], [null, true, ['expires_on_missing']]);
    await assert.rejects(upd(d.id, { expiresOn: '2026-12-02' }), /expires_after_legal_max/);
    const ok = await upd(d.id, { expiresOn: '2026-12-01' });
    assert.equal(ok.expiresOn, '2026-12-01');
  });

  it('텍스트 층에서 핵심 칸을 못 뽑으면 저장하지 않고 OCR 다시 읽기를 청한다. final이면 나은 쪽으로 저장', async () => {
    await business();
    const header = '홈택스 출력 머리말 문구가 여기에 있습니다 페이지 1/1';
    const bytes = pdf('retry');
    const first = await call<{ needsOcr?: boolean }>('document.import', { bytes, extract: extract(header) });
    assert.deepEqual(first, { needsOcr: true });
    assert.deepEqual(await fsp.readdir(vault), [], '아직 쓰지 않는다');
    const d = await call<DocumentView>('document.import', { bytes, extract: extract(taxText(), { hasTextLayer: true, ocrConfidence: 85 }), altText: header, final: true });
    assert.deepEqual([d.docType, d.textSource, d.needsUser, d.reasons], ['national_tax_cert', 'ocr', true, ['read_by_ocr']]);
    // OCR이 낫지 않으면 처음 텍스트 층 결과
    const e = await call<DocumentView>('document.import', { bytes: pdf('retry2'), extract: extract('알아볼 수 없는 OCR 결과', { ocrConfidence: 40 }), altText: bizText, final: true });
    assert.deepEqual([e.docType, e.textSource, e.needsUser], ['biz_registration_cert', 'text', false]);
    // 알아본 지원 밖 서류는 다시 읽지 않는다
    const local = await call<DocumentView>('document.import', { bytes: pdf('local'), extract: extract('지방세 납세증명서\n가나구청장') });
    assert.equal(local.kind, 'localtax_cert');
  });

  it('같은 파일을 동시에 넣어도 한 건만 저장한다(가져오기는 한 번에 하나)', async () => {
    await business();
    const bytes = pdf('same');
    const [a, b] = await Promise.all([call<DocumentView>('document.import', { bytes, extract: extract(taxText()) }), call<DocumentView>('document.import', { bytes, extract: extract(taxText()) })]);
    assert.equal(a.id, b.id);
    assert.equal([a, b].filter((d) => d.duplicate).length, 1);
    assert.equal((await fsp.readdir(vault)).length, 1);
  });

  it('보관함 파일이 지워졌으면 같은 파일을 다시 넣을 때 되살린다', async () => {
    await business();
    const bytes = pdf('gone');
    const d = await call<DocumentView>('document.import', { bytes, extract: extract(taxText()) });
    const row = new DocumentRepo(db).get(d.id)!;
    await fsp.rm(row.path);
    const again = await call<DocumentView>('document.import', { bytes, extract: extract(taxText()) });
    assert.equal(again.duplicate, true);
    const path2 = new DocumentRepo(db).get(d.id)!.path;
    assert.deepEqual(new Uint8Array(await fsp.readFile(path2)), bytes);
  });

  it('잘못된 수정은 거부한다', async () => {
    await business();
    const d = await call<DocumentView>('document.import', { bytes: pdf('t'), extract: extract(taxText()) });
    await assert.rejects(upd(d.id, { expiresOn: '2026-02-30' }), /invalid_expires_on/);
    await assert.rejects(upd(d.id, { issuedOn: '11/01/2026' }), /invalid_issued_on/);
    await assert.rejects(upd(d.id, { docType: 'tax_invoice' }), /invalid_doc_type/);
    await assert.rejects(upd(d.id, { expiresOn: '2026-10-01' }), /expires_before_issued/);
    await assert.rejects(upd(d.id, { issuedOn: '2026-11-11' }), /issued_in_future/);
    await assert.rejects(upd('nope', {}), /not_found/);
  });

  it('입력 검사: 크기·PDF 머리·추출 모양', async () => {
    await business();
    await assert.rejects(call('document.import', { bytes: new Uint8Array(0), extract: extract(taxText()) }), /input_size/);
    await assert.rejects(call('document.import', { bytes: new TextEncoder().encode('hello'), extract: extract(taxText()) }), /not_pdf/);
    await assert.rejects(call('document.import', { bytes: 'x', extract: extract(taxText()) }), /input_size/);
    await assert.rejects(call('document.import', { bytes: pdf('e'), extract: { text: 1 } }), /bad_extract/);
    await assert.rejects(call('document.import', { bytes: pdf('e'), extract: { ...extract(taxText()), ocrConfidence: 'x' } }), /bad_extract/);
    await assert.rejects(call('document.import', { bytes: pdf('e'), extract: { ...extract(taxText()), scanned: undefined } }), /bad_extract/);
    await assert.rejects(call('document.import', { bytes: pdf('e'), extract: extract(taxText()), altText: 7, final: true }), /bad_extract/);
  });

  it('DB 등록이 실패하면 보관함에 쓴 파일을 지운다', async () => {
    await business();
    mock.method(DocumentRepo.prototype, 'insert', () => {
      throw new Error('disk full');
    });
    await assert.rejects(call('document.import', { bytes: pdf('f'), extract: extract(taxText()) }), /disk full/);
    assert.deepEqual(await fsp.readdir(vault), []);
  });

  it('지난 실행이 남긴 임시 파일을 지우고(같은 이름 폴더는 두고), 하드 링크를 못 거는 폴더는 복사로 넣는다', async () => {
    await business();
    await fsp.writeFile(path.join(vault, '.tmp-left-over'), 'x');
    await fsp.mkdir(path.join(vault, '.tmp-a-folder'));
    mock.method(fsp, 'link', async () => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    });
    const d = await call<DocumentView>('document.import', { bytes: pdf('l'), extract: extract(taxText()) });
    const files = (await fsp.readdir(vault)).filter((f) => f !== '.tmp-a-folder');
    assert.deepEqual(files.length, 1);
    assert.ok(!files[0]!.startsWith('.tmp-'));
    assert.equal(new DocumentRepo(db).get(d.id)!.path, path.join(vault, files[0]!));
  });

  it('이름을 붙인 뒤 임시 파일을 못 지워도(백신 잠금 등) 가져오기는 성공한다', async () => {
    await business();
    const realRm = fsp.rm.bind(fsp);
    mock.method(fsp, 'rm', async (p: string, o: unknown) => {
      if (path.basename(String(p)).startsWith('.tmp-')) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      return realRm(p, o as never);
    });
    const d = await call<DocumentView>('document.import', { bytes: pdf('busy'), extract: extract(taxText()) });
    assert.ok(new DocumentRepo(db).get(d.id));
  });

  it('같은 이름이 이미 있으면 덮어쓰지 않고 다른 이름으로', async () => {
    await business();
    let calls = 0;
    const real = fsp.link.bind(fsp);
    mock.method(fsp, 'link', async (a: string, b: string) => {
      if (calls++ === 0) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
      return real(a, b);
    });
    await call('document.import', { bytes: pdf('n'), extract: extract(taxText()) });
    assert.equal(calls, 2);
    assert.equal((await fsp.readdir(vault)).length, 1);
  });

  it('사용자 조정 유효 일수(validity_rules)를 쓴다', async () => {
    await business();
    db.prepare("INSERT INTO validity_rules (doc_type, default_days, rule, user_override_days) VALUES ('biz_registration_cert', 90, 'fixed_days', 30)").run();
    const d = await call<DocumentView>('document.import', { bytes: pdf('o'), extract: extract(bizText) });
    assert.equal(d.expiresOn, '2026-11-04');
  });
});

describe('main 경계: document.import·document.file은 렌더러가 부를 수 없다', () => {
  it('MAIN_ONLY에 두고 RENDERER_METHODS에서 뺀다(docparse 결과를 붙이는 명령, 보관함 파일 경로)', async () => {
    for (const m of ['bizcert.parse', 'document.file', 'document.import']) assert.ok(MAIN_ONLY.includes(m as never), m);
    const src = await fsp.readFile(path.resolve(import.meta.dirname, '../apps/desktop/src/main.ts'), 'utf8');
    const line = src.split('\n').find((l) => l.includes('const RENDERER_METHODS'))!;
    assert.match(line, /COMMANDS\.filter\(\(c\) => !MAIN_ONLY\.includes\(c\)\)/);
  });
});
