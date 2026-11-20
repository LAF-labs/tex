import fs from 'node:fs/promises';
import { BrowserWindow, dialog } from 'electron';
import { DocparseError, parsePdfInSandbox, type PdfExtractRun } from './docparse.ts';
import { PickStore } from './pick-store.ts';

const MAX_INPUT = 15 * 1024 * 1024;
const MAX_PASSWORD = 256;
const picks = new PickStore();

export type EngineCall = (method: string, params: Record<string, unknown>) => Promise<unknown>;

export type ImportResult =
  | { status: 'imported'; document: unknown; parse: { ms: number; pages: number; totalPages: number; hasTextLayer: boolean; scanned: boolean; ocrConfidence: number | null } }
  | { status: 'needs_password' | 'wrong_password'; pickId: string }
  | null;

const extractOf = (x: PdfExtractRun) => ({ text: x.text, pages: x.pages, totalPages: x.totalPages, hasTextLayer: x.hasTextLayer, scanned: x.scanned, ocrConfidence: x.ocrConfidence });

export function cancelPick(id: unknown): void {
  picks.cancel(id);
}

async function readPicked(file: string): Promise<Uint8Array> {
  let fh: fs.FileHandle | null = null;
  try {
    fh = await fs.open(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
    const st = await fh.stat();
    if (!st.isFile() || st.size === 0 || st.size > MAX_INPUT) throw new Error('input_size');
    const buf = Buffer.alloc(MAX_INPUT + 1);
    let n = 0;
    for (let r; n < buf.length && (r = await fh.read(buf, n, buf.length - n, n)).bytesRead > 0; ) n += r.bytesRead;
    if (n === 0 || n > MAX_INPUT) throw new Error('input_size');
    return new Uint8Array(buf.subarray(0, n));
  } catch (e) {
    // eslint-disable-next-line preserve-caught-error
    throw new Error((e as Error).message === 'input_size' ? 'input_size' : 'read_failed');
  } finally {
    await fh?.close().catch(() => {});
  }
}

export async function pickFileBytes(filters: Electron.FileFilter[], parent?: BrowserWindow): Promise<Uint8Array | null> {
  const owner = parent ?? BrowserWindow.getFocusedWindow();
  const opts: Electron.OpenDialogOptions = { properties: ['openFile'], filters };
  const pick = await (owner ? dialog.showOpenDialog(owner, opts) : dialog.showOpenDialog(opts));
  if (pick.canceled || !pick.filePaths[0]) return null;
  return readPicked(pick.filePaths[0]);
}

export async function importPdf(params: Record<string, unknown>, engine: EngineCall, parent?: BrowserWindow): Promise<ImportResult> {
  if (typeof params.password === 'string' && params.password.length > MAX_PASSWORD) throw new Error('password_too_long');
  let bytes: Uint8Array;
  const pickId = typeof params.pickId === 'string' ? params.pickId : null;
  if (pickId) bytes = picks.retry(pickId, Date.now());
  else {
    const got = await pickFileBytes([{ name: 'PDF 문서', extensions: ['pdf'] }], parent);
    if (!got) return null;
    bytes = got;
  }
  const password = typeof params.password === 'string' && params.password ? params.password : undefined;
  try {
    const r = await importBytes(bytes, engine, password);
    if (pickId) picks.cancel(pickId);
    return r;
  } catch (e) {
    if (e instanceof DocparseError && (e.code === 'password_required' || e.code === 'password_incorrect')) {
      if (!pickId) return { status: e.code === 'password_required' ? 'needs_password' : 'wrong_password', pickId: picks.keep(bytes, Date.now()) };
      if (picks.wrong(pickId)) return { status: e.code === 'password_required' ? 'needs_password' : 'wrong_password', pickId };
      // eslint-disable-next-line preserve-caught-error
      throw new Error('pick_password_tries');
    }
    if (pickId) picks.cancel(pickId);
    throw e;
  }
}

export async function importBytes(bytes: Uint8Array, engine: EngineCall, password?: string): Promise<Extract<ImportResult, { status: 'imported' }>> {
  let x = await parsePdfInSandbox(bytes, { password });
  let document = await engine('document.import', { bytes, extract: extractOf(x) });
  if ((document as { needsOcr?: boolean } | null)?.needsOcr) {
    const y = await parsePdfInSandbox(bytes, { password, forceOcr: true }).catch(() => null);
    document = await engine('document.import', { bytes, extract: extractOf(y ?? x), altText: y ? x.text : null, final: true });
    if (y) x = (document as { textSource?: string } | null)?.textSource === 'ocr' ? { ...y, ms: x.ms + y.ms } : { ...x, ms: x.ms + y.ms };
  }
  return { status: 'imported', document, parse: { ms: x.ms, pages: x.pages, totalPages: x.totalPages, hasTextLayer: x.hasTextLayer, scanned: x.scanned, ocrConfidence: x.ocrConfidence } };
}
