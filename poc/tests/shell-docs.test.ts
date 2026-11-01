// 셸 문서함 공급자(PoC-8 후속): 엔진 보관함 항목 → 셸 서류, 데모 공급자(DocumentService 그대로), 엔진 공급자(RPC).
// 화면 흐름(가져오기 버튼·열기 암호·확인)은 Electron e2e(apps/desktop/src/shell-docs-e2e.ts)가 본다.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { formatBizNo, syntheticBizNo } from '@sax/db';
import type { DocumentView } from '@sax/engine';
import { demoDocsProvider, engineDocsProvider, toShellDoc, type Importer } from '../apps/desktop/src/shell-docs.ts';
import { PROFILES } from '../apps/desktop/src/shell-mock.ts';

const NOW = new Date('2026-11-10T03:00:00Z');
const tax = (biz: string) =>
  `발급번호 0123-457-5258-910\n납세증명서\n주민등록번호(사업자등록번호) ${formatBizNo(biz)}\n유효기간 2026년 11월 30일\n「국세징수법」 … 다른 체납액이 없음을 증명합니다.\n담당부서 민원봉사실\n2026년 11월 1일\n가나세무서장 직인`;
const pdf = () => new Uint8Array(Buffer.from(`%PDF-1.7\n% ${randomBytes(8).toString('hex')}\n%%EOF\n`));
/** vault-import.importPdf 흉내: 대화상자·docparse 없이 정해진 텍스트로 엔진 document.import를 부른다. */
const fakeImporter = (text: string, o: { password?: boolean } = {}): Importer => async (params, engine) => {
  if (o.password && params.password !== 'pw') return { status: params.password ? 'wrong_password' : 'needs_password', pickId: 'pick-1' };
  const extract = { text, pages: 1, totalPages: 1, hasTextLayer: true, scanned: false, ocrConfidence: null };
  const document = await engine('document.import', { bytes: pdf(), extract });
  return { status: 'imported', document, parse: { ms: 1, pages: 1, totalPages: 1, hasTextLayer: true, scanned: false, ocrConfidence: null } };
};

describe('셸 문서함 공급자', () => {
  let root: string;
  before(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sax-shell-docs-'));
  });
  after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('데모 공급자: 목업 사업장 서류를 보관함에 넣고(문서에서 읽은 만료일) 셸 서류로 준다', async () => {
    const p = demoDocsProvider({ parent: root, profile: PROFILES.business, importer: fakeImporter(tax(PROFILES.business.bizNo!)), now: () => NOW });
    const dir = p.dir;
    try {
      assert.equal(path.dirname(dir), root, '데모 폴더는 parent 아래 새 폴더');
      const r = await p.importPdf({});
      assert.equal(r?.status, 'imported');
      const d = r!.status === 'imported' ? r!.doc! : null;
      assert.deepEqual([d?.name, d?.kind, d?.source, d?.issuedOn, d?.expiresOn], ['납세증명서(국세)', '증명서', '직접 추가', '2026-11-01', '2026-11-30']);
      assert.deepEqual([d?.vault?.expirySource, d?.vault?.needsUser, d?.vault?.docNo, d?.vault?.subjectMismatch], ['document', false, '0123-457-5258-910', false]);
      assert.equal((await p.list()).length, 1);
      const files = await fsp.readdir(path.join(dir, 'vault'));
      assert.equal(files.length, 1, '데모 보관함 폴더에 파일');
      assert.equal(await p.filePath(d!.id), path.join(dir, 'vault', files[0]!), 'filePath는 보관함 파일');
      await assert.rejects(p.filePath('nope'), /not_found/);
      await fsp.rm(path.join(dir, 'vault', files[0]!));
      await assert.rejects(p.filePath(d!.id), /file_missing/);
    } finally {
      p.close?.();
    }
    assert.equal(await fsp.access(dir).then(() => 'kept', () => 'gone'), 'gone', '닫으면 데모 폴더(DB·PDF 사본)를 지운다');
    p.close?.(); // 두 번 닫아도 된다
  });

  it('데모 공급자: 다른 사업자 서류는 확인 필요, 셸에서 그대로 확인하면 확인함. 실행마다 빈 보관함으로 시작한다', async () => {
    const first = demoDocsProvider({ parent: root, profile: PROFILES.business, importer: fakeImporter(tax(PROFILES.business.bizNo!)), now: () => NOW });
    await first.importPdf({});
    const p = demoDocsProvider({ parent: root, profile: PROFILES.business, importer: fakeImporter(tax(syntheticBizNo(5))), now: () => NOW });
    try {
      assert.notEqual(p.dir, first.dir);
      assert.equal((await p.list()).length, 0, '다른 실행의 데모 서류가 보이지 않는다');
      first.close?.();
      const r = await p.importPdf({});
      const d = r?.status === 'imported' ? r.doc! : null;
      assert.deepEqual([d?.vault?.needsUser, d?.vault?.reasons], [true, ['subject_mismatch']]);
      const ok = await p.update(d!.id, {});
      assert.deepEqual([ok.vault?.needsUser, ok.vault?.subjectMismatch, ok.vault?.expirySource], [false, true, 'document']);
      await assert.rejects(p.update(d!.id, { expiresOn: '2026-12-31' }), /expires_after_legal_max/);
    } finally {
      first.close?.();
      p.close?.();
    }
  });

  it('열기 암호 응답은 그대로 넘긴다(pickId로 다시 부른다)', async () => {
    const p = demoDocsProvider({ parent: root, profile: PROFILES.business, importer: fakeImporter(tax(PROFILES.business.bizNo!), { password: true }), now: () => NOW });
    try {
      assert.deepEqual(await p.importPdf({}), { status: 'needs_password', pickId: 'pick-1' });
      assert.deepEqual(await p.importPdf({ pickId: 'pick-1', password: 'x' }), { status: 'wrong_password', pickId: 'pick-1' });
      assert.equal((await p.importPdf({ pickId: 'pick-1', password: 'pw' }))?.status, 'imported');
    } finally {
      p.close?.();
    }
  });

  it('엔진 공급자: RPC 결과를 셸 서류로 바꾸고, 수정은 document.update로 보낸다', async () => {
    const view: DocumentView = {
      id: 'v1', displayName: '사업자등록증명', docType: 'biz_registration_cert', kind: 'biz_registration_cert', issuedOn: '2026-10-06', expiresOn: '2027-01-03', expirySource: 'rule',
      daysLeft: 54, needsUser: false, reasons: [], suggested: {}, issuer: '아자세무서장', docNo: null, subjectBizNo: '1234567891', subjectMismatch: false, source: 'app', textSource: 'text', bytes: 10, createdAt: '2026-11-10T00:00:00Z',
    };
    const calls: Array<[string, Record<string, unknown>]> = [];
    const engine = async (m: string, p: Record<string, unknown>) => {
      calls.push([m, p]);
      return m === 'db.query.documents.list' ? [view] : { ...view, expirySource: 'user' };
    };
    const p = engineDocsProvider(engine, async () => null);
    const [d] = await p.list();
    assert.deepEqual([d?.source, d?.kind, d?.vault?.expirySource], ['앱이 발급', '증명서', 'rule']);
    const u = await p.update('v1', { expiresOn: '2027-01-03' });
    assert.equal(u.vault?.expirySource, 'user');
    assert.deepEqual(calls[1], ['document.update', { id: 'v1', patch: { expiresOn: '2027-01-03' } }]);
    assert.equal(await p.importPdf({}), null, '고르기를 취소하면 null');
    const engine2 = async (m: string, q: Record<string, unknown>) => (calls.push([m, q]), { path: '/vault/x.pdf' });
    assert.equal(await engineDocsProvider(engine2, async () => null).filePath('v1'), '/vault/x.pdf');
    assert.deepEqual(calls.at(-1), ['document.file', { id: 'v1' }]);
    assert.equal(toShellDoc({ ...view, docType: 'other', source: 'import' }).kind, '직접 추가');
  });
});
