// save_pdf 포트 구현(M2-3, D02 §4, D05 §3.3, D07 §1): 금고 #164 RPC·이벤트 + staging → 보관함. 가짜 금고·가짜 보관함, 실제 파일.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ValidationError } from '@sax/db';
import { VaultPdfPort, type DocumentView, type PdfDocuments, type PdfText, type PdfVault, type VaultPdfInput } from '@sax/engine';

type Json = Record<string, unknown>;
const PDF = new TextEncoder().encode('%PDF-1.7\n1 0 obj<<>>endobj\n%%EOF\n');
const TEXT = (o: Partial<PdfText> = {}): PdfText => ({ text: '납세증명서', pages: 1, totalPages: 1, hasTextLayer: true, scanned: false, ocrConfidence: null, ...o });
const fid = () => randomBytes(16).toString('hex');

class FakeVault implements PdfVault {
  calls: Array<[string, Json]> = [];
  answers: Record<string, unknown> = {};
  private ls = new Map<string, Set<(d: Json) => void>>();
  async rpc<T>(method: string, params: Json = {}): Promise<T> {
    this.calls.push([method, params]);
    const a = this.answers[method];
    if (a instanceof Error) throw a;
    return (a ?? {}) as T;
  }
  on(name: string, fn: (d: Json) => void) {
    let s = this.ls.get(name);
    if (!s) this.ls.set(name, (s = new Set()));
    s.add(fn);
    return () => s!.delete(fn);
  }
  emit(name: string, d: Json) {
    for (const f of [...(this.ls.get(name) ?? [])]) f(d);
  }
  listeners() {
    return [...this.ls.values()].reduce((n, s) => n + s.size, 0);
  }
}

describe('VaultPdfPort(save_pdf 포트, 금고 #164)', () => {
  let staging: string;
  before(async () => {
    staging = await fsp.mkdtemp(path.join(os.tmpdir(), 'sax-pdf-'));
  });
  after(async () => {
    await fsp.rm(staging, { recursive: true, force: true });
  });

  const mk = (o: Partial<VaultPdfInput> & { imports?: Array<DocumentView | { needsOcr: true } | Error> } = {}) => {
    const vault = new FakeVault();
    const extracts: Array<{ ocr: boolean }> = [];
    const imported: Array<{ extract: PdfText; opts: unknown }> = [];
    const queue = [...(o.imports ?? [{ id: 'doc-1' } as DocumentView])];
    const documents: PdfDocuments = {
      import: async (_b, extract, opts) => {
        imported.push({ extract, opts });
        const v = queue.shift()!;
        if (v instanceof Error) throw v;
        return v;
      },
    };
    const timers: Array<() => void> = [];
    const port = new VaultPdfPort({
      vault, targetId: () => 'T1', staging, documents,
      extract: async (_b, x) => (extracts.push(x), TEXT(x.ocr ? { text: 'OCR', ocrConfidence: 0.9 } : {})),
      setTimer: (fn) => (timers.push(fn), () => {}),
      ...o,
    });
    return { port, vault, extracts, imported, timers };
  };
  const stage = (id = fid(), bytes: Uint8Array = PDF) => (fs.writeFileSync(path.join(staging, `${id}.pdf`), bytes), id);

  it('print: pdf.print {runId, targetId(지금 탭), landscape?} → fileId, 거절은 금고 사유 코드', async () => {
    const { port, vault } = mk();
    vault.answers['pdf.print'] = { ok: true, fileId: 'a'.repeat(32) };
    assert.deepEqual(await port.print({ runId: 'r1', stepId: 's36' }), { ok: true, fileId: 'a'.repeat(32) });
    assert.deepEqual(vault.calls, [['pdf.print', { runId: 'r1', targetId: 'T1' }]]);
    await port.print({ runId: 'r1', stepId: 's36', landscape: true });
    assert.deepEqual(vault.calls[1], ['pdf.print', { runId: 'r1', targetId: 'T1', landscape: true }]);
    vault.answers['pdf.print'] = { ok: false, reason: 'secret_window_open' };
    assert.deepEqual(await port.print({ runId: 'r1', stepId: 's36' }), { ok: false, reason: 'secret_window_open' });
    vault.answers['pdf.print'] = { ok: false, reason: 'Bad Reason!' };
    assert.deepEqual(await port.print({ runId: 'r1', stepId: 's36' }), { ok: false, reason: 'print_failed' }, '열거 모양이 아닌 사유는 남기지 않는다');
  });

  it('download: 무장 뒤 첫 이벤트 1건만, 무장 전 이벤트(print의 download.completed)는 버린다', async () => {
    const { port, vault } = mk();
    vault.emit('download.completed', { fileId: 'b'.repeat(32) });
    assert.deepEqual(await port.awaitDownload({ runId: 'r1', stepId: 's', timeoutMs: 10 }), { ok: false, reason: 'not_armed' });
    vault.answers['download.arm'] = { armed: true };
    assert.deepEqual(await port.armDownload({ runId: 'r1', stepId: 's' }), { armed: true });
    assert.deepEqual(vault.calls.at(-1), ['download.arm', { runId: 'r1', targetId: 'T1' }]);
    assert.deepEqual(await port.armDownload({ runId: 'r1', stepId: 's' }), { armed: false, reason: 'already_armed' });
    const w = port.awaitDownload({ runId: 'r1', stepId: 's', timeoutMs: 60_000 });
    vault.emit('download.completed', { fileId: 'c'.repeat(32) });
    vault.emit('download.failed', { reason: 'canceled' });
    assert.deepEqual(await w, { ok: true, fileId: 'c'.repeat(32) });
    assert.equal(vault.listeners(), 0, '끝나면 듣기를 뗀다');
    await port.disarmDownload();
    assert.deepEqual(vault.calls.at(-1), ['download.disarm', {}]);
  });

  it('download: 이벤트가 await 전에 와도 받는다, failed는 사유, 시간 안에 없으면 timeout, 무장 거절이면 듣지 않는다', async () => {
    const { port, vault, timers } = mk();
    vault.answers['download.arm'] = { armed: true };
    await port.armDownload({ runId: 'r1', stepId: 's' });
    vault.emit('download.failed', { reason: 'not_pdf' });
    assert.deepEqual(await port.awaitDownload({ runId: 'r1', stepId: 's', timeoutMs: 10 }), { ok: false, reason: 'not_pdf' });
    await port.armDownload({ runId: 'r1', stepId: 's' });
    const w = port.awaitDownload({ runId: 'r1', stepId: 's', timeoutMs: 10 });
    timers.at(-1)!();
    assert.deepEqual(await w, { ok: false, reason: 'timeout' });
    vault.answers['download.arm'] = { armed: false, reason: 'target_not_exposed' };
    assert.deepEqual(await port.armDownload({ runId: 'r1', stepId: 's' }), { armed: false, reason: 'target_not_exposed' });
    assert.equal(vault.listeners(), 0);
  });

  it('store: staging 파일 → 추출 → 보관함, 문서 id를 돌려주고 staging 파일은 지운다', async () => {
    const { port, extracts, imported } = mk();
    const id = stage();
    assert.deepEqual(await port.store({ runId: 'r1', stepId: 's36', fileId: id, docType: 'tax_invoice' }), { ok: true, documentId: 'doc-1' });
    assert.deepEqual(extracts, [{ ocr: false }]);
    assert.equal(imported.length, 1);
    assert.equal(fs.existsSync(path.join(staging, `${id}.pdf`)), false);
  });

  it('store: needsOcr면 OCR로 다시 읽어 final·altText로 한 번 더(사용자 가져오기와 같은 길)', async () => {
    const { port, extracts, imported } = mk({ imports: [{ needsOcr: true }, { id: 'doc-2' } as DocumentView] });
    assert.deepEqual(await port.store({ runId: 'r1', stepId: 's36', fileId: stage(), docType: 'tax_invoice' }), { ok: true, documentId: 'doc-2' });
    assert.deepEqual(extracts, [{ ocr: false }, { ocr: true }]);
    assert.deepEqual(imported[1]!.opts, { altText: '납세증명서', final: true });
    assert.equal(imported[1]!.extract.text, 'OCR');
  });

  it('store: fileId 모양·없는 파일·링크·크기·보관함 거부는 사유 코드, 어느 경우에도 staging에 남기지 않는다', async () => {
    assert.deepEqual(await mk().port.store({ runId: 'r1', stepId: 's', fileId: '../x', docType: 'd' }), { ok: false, reason: 'bad_file_id' });
    assert.deepEqual(await mk().port.store({ runId: 'r1', stepId: 's', fileId: fid(), docType: 'd' }), { ok: false, reason: 'staged_missing' });
    const target = path.join(staging, 'outside.pdf');
    fs.writeFileSync(target, PDF);
    const link = fid();
    fs.symlinkSync(target, path.join(staging, `${link}.pdf`));
    assert.deepEqual(await mk().port.store({ runId: 'r1', stepId: 's', fileId: link, docType: 'd' }), { ok: false, reason: 'staged_unreadable' });
    assert.ok(fs.existsSync(target), '링크 대상은 지우지 않는다');
    assert.equal(fs.existsSync(path.join(staging, `${link}.pdf`)), false);
    const big = stage(fid(), new Uint8Array(64));
    assert.deepEqual(await mk({ maxBytes: 32 }).port.store({ runId: 'r1', stepId: 's', fileId: big, docType: 'd' }), { ok: false, reason: 'too_large' });
    const rej = stage();
    assert.deepEqual(await mk({ imports: [new ValidationError('profile_required')] }).port.store({ runId: 'r1', stepId: 's', fileId: rej, docType: 'd' }), { ok: false, reason: 'profile_required' });
    const boom = stage();
    assert.deepEqual(await mk({ imports: [new Error('/Users/x/secret path')] }).port.store({ runId: 'r1', stepId: 's', fileId: boom, docType: 'd' }), { ok: false, reason: 'import_failed' });
    assert.deepEqual(fs.readdirSync(staging), ['outside.pdf']);
  });
});
