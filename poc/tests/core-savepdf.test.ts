// save_pdf(M2-3, D02 §4 표·V-23, D05 §3.3): 금고 #164 계약(pdf.print → staging fileId) → 보관함. 엔진은 바이트·파일 이름을 보지 않는다.
// 실제 홈택스·금고·Chrome 없음: PdfPort 가짜로 본다.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PDF_ARTIFACT, SAVE_PDF_STRATEGIES, savePdf, STAGED_FILE_ID, type PdfFileResult, type PdfPort, type SavePdfStep, type StepOf } from '@sax/engine/core';
import { h01 } from './core-fixtures.ts';

const S32 = h01().playbook.steps.find((s) => s.id === 's32') as StepOf<'save_pdf'>;
const FID = 'a'.repeat(32);

function mk(o: { print?: PdfPort['print']; store?: PdfPort['store'] } = {}) {
  const calls: string[] = [];
  const stored: Array<Record<string, unknown>> = [];
  const journal: Array<[string, Record<string, unknown>]> = [];
  const pdf: PdfPort = {
    print: async (r) => (calls.push(`print ${r.runId} ${r.stepId}`), o.print ? o.print(r) : { ok: true, fileId: FID }),
    armDownload: async () => (calls.push('arm'), { armed: true }),
    awaitDownload: async () => (calls.push('await'), { ok: true, fileId: FID }),
    disarmDownload: async () => void calls.push('disarm'),
    store: async (r) => (calls.push('store'), stored.push(r), o.store ? o.store(r) : { ok: true, documentId: 'doc-1' }),
  };
  const artifacts = new Map<string, string>();
  const d = { pdf, runId: 'run-1', artifacts, journal: (t: string, p: Record<string, unknown>) => journal.push([t, p]) };
  return { d, calls, stored, journal, artifacts };
}

describe('save_pdf(M2-3, D02 §4, D05 §3.3, 금고 #164)', () => {
  it('골든 s32는 strategy print·docType tax_invoice·엔진 기본 파일명(V-23)', () => {
    assert.deepEqual([S32.type, S32.strategy, S32.docType, S32.nameTemplate], ['save_pdf', 'print', 'tax_invoice', undefined]);
  });

  it('print: 금고 pdf.print → staging fileId → 보관함 store(docType, 기본 이름) → $artifacts.pdf = 문서 id. 저널에 fileId·문서 id 없음(⑦)', async () => {
    const h = mk();
    assert.deepEqual(await savePdf(h.d, S32), { ok: true });
    assert.deepEqual(h.calls, ['print run-1 s32', 'store']);
    assert.deepEqual(h.stored, [{ runId: 'run-1', stepId: 's32', fileId: FID, docType: 'tax_invoice' }]);
    assert.equal(h.artifacts.get(PDF_ARTIFACT), 'doc-1');
    assert.deepEqual(h.journal, [['artifact.saved', { stepId: 's32', docType: 'tax_invoice', strategy: 'print' }]]);
    assert.ok(!JSON.stringify(h.journal).includes(FID) && !JSON.stringify(h.journal).includes('doc-1'));
  });

  it('nameTemplate(V-23)은 그대로 보관함에 넘긴다(검사는 로드 때 V-23·보관함 루트 확인은 store)', async () => {
    const h = mk();
    await savePdf(h.d, { ...S32, nameTemplate: 'invoices/{docType}_{yyyyMMdd}_{shortId}.pdf' } as SavePdfStep);
    assert.equal(h.stored[0]!.nameTemplate, 'invoices/{docType}_{yyyyMMdd}_{shortId}.pdf');
  });

  it('금고 거절(#164 reason: secret_window_open·busy·print_failed·too_large·not_pdf·target_not_exposed)·포트 예외 → save_pdf.failed, 보관함·$artifacts 없음', async () => {
    for (const reason of ['secret_window_open', 'busy', 'print_failed', 'too_large', 'not_pdf', 'target_not_exposed']) {
      const h = mk({ print: async () => ({ ok: false, reason }) });
      assert.deepEqual(await savePdf(h.d, S32), { ok: false, code: 'save_pdf.failed' });
      assert.deepEqual(h.calls, ['print run-1 s32']);
      assert.equal(h.artifacts.size, 0);
      assert.deepEqual(h.journal, [['save_pdf.failed', { stepId: 's32', stage: 'print', reason }]]);
    }
    const t = mk({ print: async () => Promise.reject(new Error('rpc')) });
    assert.equal((await savePdf(t.d, S32)).ok, false);
    assert.equal(t.journal[0]![1].reason, 'port_error');
  });

  it('fileId가 32 hex가 아니면(경로 주입 등) 받지 않는다: 보관함에 넘기지 않음', async () => {
    for (const fileId of ['../../etc/passwd', 'A'.repeat(32), 'a'.repeat(31), `${'a'.repeat(32)}.pdf`, '']) {
      assert.equal(STAGED_FILE_ID.test(fileId), false);
      const h = mk({ print: async (): Promise<PdfFileResult> => ({ ok: true, fileId }) });
      assert.deepEqual(await savePdf(h.d, S32), { ok: false, code: 'save_pdf.failed' });
      assert.deepEqual(h.calls, ['print run-1 s32'], fileId);
      assert.equal(h.journal[0]![1].reason, 'bad_file_id');
    }
  });

  it('보관함 저장 실패·예외 → save_pdf.failed, $artifacts 없음. 열거 코드가 아닌 사유는 저널에 남기지 않는다(other)', async () => {
    const h = mk({ store: async () => ({ ok: false, reason: 'not_pdf' }) });
    assert.deepEqual(await savePdf(h.d, S32), { ok: false, code: 'save_pdf.failed' });
    assert.equal(h.artifacts.size, 0);
    assert.deepEqual(h.journal, [['save_pdf.failed', { stepId: 's32', stage: 'store', reason: 'not_pdf' }]]);
    const x = mk({ store: async () => ({ ok: false, reason: '/Users/kim/Downloads/세금계산서.pdf' }) });
    await savePdf(x.d, S32);
    assert.equal(x.journal[0]![1].reason, 'other');
    const e = mk({ store: async () => Promise.reject(new Error('disk')) });
    await savePdf(e.d, S32);
    assert.equal(e.journal[0]![1].reason, 'port_error');
  });

  it('page_pdf도 금고 pdf.print(지금 포털 탭 Page.printToPDF)', async () => {
    const h = mk();
    assert.deepEqual(await savePdf(h.d, { ...S32, strategy: 'page_pdf' }), { ok: true });
    assert.deepEqual(h.calls, ['print run-1 s32', 'store']);
    assert.deepEqual([...SAVE_PDF_STRATEGIES].sort(), ['page_pdf', 'print']);
  });

  it('original·wallet은 없다(로드 때 V-23a 거부). 실행 시에도 금고를 부르지 않고 save_pdf.unsupported(재시도 없이 중단, FORCED_STOPS)', async () => {
    for (const strategy of ['original', 'wallet'] as const) {
      const h = mk();
      assert.deepEqual(await savePdf(h.d, { ...S32, strategy }), { ok: false, code: 'save_pdf.unsupported' });
      assert.deepEqual(h.calls, [], strategy);
    }
  });
});
