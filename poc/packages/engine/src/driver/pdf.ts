import fs from 'node:fs/promises';
import path from 'node:path';
import { ValidationError } from '@sax/db';
import { readRegularFile } from '@sax/platform';
import { STAGED_FILE_ID, type PdfFileResult, type PdfPort } from '../core/savepdf.ts';
import type { DocumentView, NeedsOcr, PdfText } from '../documents.ts';

type Json = Record<string, unknown>;

/** 금고 클라이언트에서 이 포트가 쓰는 부분(VaultClient). */
export interface PdfVault {
  rpc<T>(method: string, params?: Json): Promise<T>;
  on(name: string, fn: (data: Json) => void): () => void;
}

/** 보관함 가져오기(DocumentService.import 모양). */
export interface PdfDocuments {
  import(bytes: Uint8Array, extract: PdfText, opts?: { altText?: string; final?: boolean }): Promise<DocumentView | NeedsOcr>;
}

export interface VaultPdfInput {
  vault: PdfVault;
  targetId(): string;
  staging: string;
  documents: PdfDocuments;
  extract?(bytes: Uint8Array, o: { ocr: boolean }): Promise<PdfText>;
  artifact?(bytes: Uint8Array, o: { runId: string; docType: string }): Promise<{ id: string }>;
  maxBytes?: number;
  printTimeoutMs?: number;
  setTimer?: (fn: () => void, ms: number) => () => void;
}

const MAX_BYTES = 15 * 1024 * 1024;
/** 금고 Page.printToPDF는 대화상자 없이 끝난다. 이보다 오래 걸리면 기다리지 않는다(늦게 생긴 staging 파일은 금고가 쓸어 낸다). */
export const PRINT_TIMEOUT_MS = 60_000;
const REASON = /^[a-z_]{1,40}$/;
const code = (v: unknown, fallback: string) => (typeof v === 'string' && REASON.test(v) ? v : fallback);
const defaultTimer = (fn: () => void, ms: number) => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};

export class VaultPdfPort implements PdfPort {
  private readonly i: VaultPdfInput;
  private pending: { result: PdfFileResult | null; wake: (() => void) | null; off: () => void } | null = null;

  constructor(i: VaultPdfInput) {
    this.i = i;
  }

  async print(r: { runId: string; stepId: string; landscape?: boolean }): Promise<PdfFileResult> {
    let cancel = () => {};
    const timeout = new Promise<'timeout'>((resolve) => (cancel = (this.i.setTimer ?? defaultTimer)(() => resolve('timeout'), this.i.printTimeoutMs ?? PRINT_TIMEOUT_MS)));
    const call = this.i.vault.rpc<{ ok?: unknown; fileId?: unknown; reason?: unknown }>('pdf.print', {
      runId: r.runId, targetId: this.i.targetId(), ...(r.landscape !== undefined ? { landscape: r.landscape } : {}),
    });
    const res = await Promise.race([call, timeout]).finally(cancel);
    if (res === 'timeout') {
      call.catch(() => {});
      return { ok: false, reason: 'timeout' };
    }
    if (res?.ok === true && typeof res.fileId === 'string') return { ok: true, fileId: res.fileId };
    return { ok: false, reason: code(res?.reason, 'print_failed') };
  }

  async armDownload(r: { runId: string; stepId: string }): Promise<{ armed: true } | { armed: false; reason: string }> {
    if (this.pending) return { armed: false, reason: 'already_armed' };
    const slot: NonNullable<VaultPdfPort['pending']> = { result: null, wake: null, off: () => {} };
    const settle = (v: PdfFileResult) => {
      if (slot.result) return;
      slot.result = v;
      slot.wake?.();
    };
    const offs = [
      this.i.vault.on('download.completed', (d) => settle(typeof d.fileId === 'string' ? { ok: true, fileId: d.fileId } : { ok: false, reason: 'bad_event' })),
      this.i.vault.on('download.failed', (d) => settle({ ok: false, reason: code(d.reason, 'other') })),
    ];
    slot.off = () => offs.forEach((f) => f());
    this.pending = slot;
    const res = await this.i.vault.rpc<{ armed?: unknown; reason?: unknown }>('download.arm', { runId: r.runId, targetId: this.i.targetId() }).catch(() => ({ armed: false, reason: 'port_error' }));
    if (res?.armed === true) return { armed: true };
    this.clear();
    return { armed: false, reason: code(res?.reason, 'other') };
  }

  awaitDownload(r: { runId: string; stepId: string; timeoutMs: number }): Promise<PdfFileResult> {
    const slot = this.pending;
    if (!slot) return Promise.resolve({ ok: false, reason: 'not_armed' });
    return new Promise((resolve) => {
      const done = () => {
        cancel();
        const v = slot.result ?? { ok: false, reason: 'timeout' };
        if (this.pending === slot) this.clear();
        resolve(v);
      };
      const cancel = (this.i.setTimer ?? defaultTimer)(done, r.timeoutMs);
      if (slot.result) done();
      else slot.wake = done;
    });
  }

  async disarmDownload(): Promise<void> {
    this.clear();
    await this.i.vault.rpc('download.disarm', {});
  }

  async store(r: { runId: string; stepId: string; fileId: string; docType: string; nameTemplate?: string }): Promise<{ ok: true; documentId: string } | { ok: false; reason: string }> {
    if (!STAGED_FILE_ID.test(r.fileId)) return { ok: false, reason: 'bad_file_id' };
    const file = path.join(this.i.staging, `${r.fileId}.pdf`);
    try {
      const read = await readRegularFile(file, this.i.maxBytes ?? MAX_BYTES);
      if (!read.ok) {
        if (read.reason === 'missing') return { ok: false, reason: 'staged_missing' };
        if (read.reason === 'empty' || read.reason === 'too_large') return { ok: false, reason: 'too_large' };
        return { ok: false, reason: 'staged_unreadable' };
      }
      const bytes = read.bytes;
      if (this.i.artifact) return { ok: true, documentId: (await this.i.artifact(bytes, { runId: r.runId, docType: r.docType })).id };
      if (!this.i.extract) return { ok: false, reason: 'import_failed' };
      const extract = this.i.extract.bind(this.i);
      const text = await extract(bytes, { ocr: false });
      let v = await this.i.documents.import(bytes, text);
      if ('needsOcr' in v) v = await this.i.documents.import(bytes, await extract(bytes, { ocr: true }), { altText: text.text, final: true });
      if ('needsOcr' in v) return { ok: false, reason: 'import_failed' };
      return { ok: true, documentId: v.id };
    } catch (e) {
      return { ok: false, reason: e instanceof ValidationError ? code(e.code, 'import_failed') : 'import_failed' };
    } finally {
      await fs.rm(file, { force: true }).catch(() => {});
    }
  }

  private clear(): void {
    this.pending?.off();
    this.pending = null;
  }
}
