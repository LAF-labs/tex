// 보관함 가져오기(PoC-8): 사용자가 고른 PDF → docparse 샌드박스 추출 → 엔진 등록(D17 §1.3: 사용자가 고른 파일만 파싱한다).
// main은 DB를 열지 않고, 파일 내용·경로를 로그·오류에 남기지 않는다. 열기 암호는 이 작업에만 쓰고 저장하지 않는다.
// (Phase 1: 열기 암호도 비밀 입력 창으로 받을지 정한다. 지금은 메인 UI 렌더러 → main → docparse 문자열이다.)
import fs from 'node:fs/promises';
import { BrowserWindow, dialog } from 'electron';
import { DocparseError, parsePdfInSandbox, type PdfExtractRun } from './docparse.ts';
import { PickStore } from './pick-store.ts';

const MAX_INPUT = 15 * 1024 * 1024;
const MAX_PASSWORD = 256;
/** 암호를 물은 뒤 다시 고르지 않게, 고른 파일의 바이트를 잠시 든다(첫 선택부터 5분, 틀린 암호 5회면 닫음, 최대 2건). 경로는 들지 않는다. */
const picks = new PickStore();

export type EngineCall = (method: string, params: Record<string, unknown>) => Promise<unknown>;

export type ImportResult =
  | { status: 'imported'; document: unknown; parse: { ms: number; pages: number; totalPages: number; hasTextLayer: boolean; scanned: boolean; ocrConfidence: number | null } }
  | { status: 'needs_password' | 'wrong_password'; pickId: string }
  | null;

const extractOf = (x: PdfExtractRun) => ({ text: x.text, pages: x.pages, totalPages: x.totalPages, hasTextLayer: x.hasTextLayer, scanned: x.scanned, ocrConfidence: x.ocrConfidence });

/** 암호 입력을 그만두면 들고 있던 바이트를 0으로 덮어 버린다. */
export function cancelPick(id: unknown): void {
  picks.cancel(id);
}

/** 연 핸들 하나로 확인하고 읽는다(확인 뒤 파일이 바뀌는 틈 없음). 일반 파일만, 15MB까지. 오류에 경로를 싣지 않는다. */
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
    // 원래 오류(경로가 들어 있다)를 cause로 붙이지 않는다. ipcMain이 처리기 오류를 cause까지 출력한다.
    // eslint-disable-next-line preserve-caught-error
    throw new Error((e as Error).message === 'input_size' ? 'input_size' : 'read_failed');
  } finally {
    await fh?.close().catch(() => {});
  }
}

/**
 * pickId 없이 부르면 파일 고르기부터. 암호가 필요하면 pickId를 돌려주고, 같은 pickId와 password로 다시 부른다. 고르기를 취소하면 null.
 * 대화상자는 parent(메인 창)에 붙인 모달이다. 없으면 앞에 있는 창.
 */
export async function importPdf(params: Record<string, unknown>, engine: EngineCall, parent?: BrowserWindow): Promise<ImportResult> {
  // 입력 검사를 먼저 한다. 들고 있던 바이트를 꺼낸 뒤 검사에 걸리면 사용자가 파일을 다시 골라야 한다.
  if (typeof params.password === 'string' && params.password.length > MAX_PASSWORD) throw new Error('password_too_long');
  let bytes: Uint8Array;
  const pickId = typeof params.pickId === 'string' ? params.pickId : null;
  if (pickId) bytes = picks.retry(pickId, Date.now());
  else {
    // 메인 창에 붙여 모달로 연다(고르는 동안 다른 화면으로 옮겨 가지 않게)
    const owner = parent ?? BrowserWindow.getFocusedWindow();
    const opts: Electron.OpenDialogOptions = { properties: ['openFile'], filters: [{ name: 'PDF 문서', extensions: ['pdf'] }] };
    const pick = await (owner ? dialog.showOpenDialog(owner, opts) : dialog.showOpenDialog(opts));
    if (pick.canceled || !pick.filePaths[0]) return null;
    bytes = await readPicked(pick.filePaths[0]);
  }
  const password = typeof params.password === 'string' && params.password ? params.password : undefined;
  try {
    let x = await parsePdfInSandbox(bytes, { password });
    let document = await engine('document.import', { bytes, extract: extractOf(x) });
    if ((document as { needsOcr?: boolean } | null)?.needsOcr) {
      // 텍스트 층에서 핵심 칸을 못 뽑았다(머리말만 글자인 그림 PDF 등). OCR로 다시 읽어 엔진이 둘 중 나은 쪽을 고른다.
      // OCR이 실패해도 처음 결과로 저장한다(확인 필요로 남는다).
      const y = await parsePdfInSandbox(bytes, { password, forceOcr: true }).catch(() => null);
      document = await engine('document.import', { bytes, extract: extractOf(y ?? x), altText: y ? x.text : null, final: true });
      // 엔진이 고른 쪽의 읽기 정보를 보여 준다(OCR이 낫지 않으면 처음 텍스트 층)
      if (y) x = (document as { textSource?: string } | null)?.textSource === 'ocr' ? { ...y, ms: x.ms + y.ms } : { ...x, ms: x.ms + y.ms };
    }
    if (pickId) picks.cancel(pickId);
    return { status: 'imported', document, parse: { ms: x.ms, pages: x.pages, totalPages: x.totalPages, hasTextLayer: x.hasTextLayer, scanned: x.scanned, ocrConfidence: x.ocrConfidence } };
  } catch (e) {
    if (e instanceof DocparseError && (e.code === 'password_required' || e.code === 'password_incorrect')) {
      if (!pickId) return { status: e.code === 'password_required' ? 'needs_password' : 'wrong_password', pickId: picks.keep(bytes, Date.now()) };
      // 다시 시도한 암호가 틀림: 같은 pickId로 남긴다(만료는 첫 선택 기준). 5번째면 닫는다.
      if (picks.wrong(pickId)) return { status: e.code === 'password_required' ? 'needs_password' : 'wrong_password', pickId };
      // 코드만 보낸다(docparse 오류는 렌더러에 보낼 것이 없다).
      // eslint-disable-next-line preserve-caught-error
      throw new Error('pick_password_tries');
    }
    if (pickId) picks.cancel(pickId);
    throw e;
  }
}
