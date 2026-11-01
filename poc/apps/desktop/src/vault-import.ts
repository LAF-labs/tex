// 보관함 가져오기(PoC-8): 사용자가 고른 PDF → docparse 샌드박스 추출 → 엔진 등록(D17 §1.3: 사용자가 고른 파일만 파싱한다).
// main은 DB를 열지 않고, 파일 내용·경로를 로그에 남기지 않는다. 열기 암호는 이 작업에만 쓰고 저장하지 않는다.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { dialog } from 'electron';
import { DocparseError, parsePdfInSandbox } from './docparse.ts';

const MAX_INPUT = 15 * 1024 * 1024;
/** 암호를 물은 뒤 다시 고르지 않게 고른 파일을 잠시 기억한다(한 번만 쓴다). */
const PICK_TTL_MS = 5 * 60_000;
const picks = new Map<string, { file: string; at: number }>();

export type EngineCall = (method: string, params: Record<string, unknown>) => Promise<unknown>;

export type ImportResult =
  | { status: 'imported'; document: unknown; parse: { ms: number; pages: number; totalPages: number; hasTextLayer: boolean; ocrConfidence: number | null } }
  | { status: 'needs_password' | 'wrong_password'; pickId: string }
  | null;

function takePick(id: string): string {
  const now = Date.now();
  for (const [k, v] of picks) if (now - v.at > PICK_TTL_MS) picks.delete(k);
  const p = picks.get(id);
  picks.delete(id);
  if (!p) throw new Error('pick_expired');
  return p.file;
}

/** pickId 없이 부르면 파일 고르기부터. 암호가 필요하면 pickId를 돌려주고, 같은 pickId와 password로 다시 부른다. 고르기를 취소하면 null. */
export async function importPdf(params: Record<string, unknown>, engine: EngineCall): Promise<ImportResult> {
  let file: string;
  if (typeof params.pickId === 'string') file = takePick(params.pickId);
  else {
    const pick = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'PDF 문서', extensions: ['pdf'] }] });
    if (pick.canceled || !pick.filePaths[0]) return null;
    file = pick.filePaths[0];
  }
  const st = await fs.stat(file);
  if (!st.isFile() || st.size === 0 || st.size > MAX_INPUT) throw new Error('input_size');
  const bytes = new Uint8Array(await fs.readFile(file));
  const password = typeof params.password === 'string' && params.password ? params.password : undefined;
  try {
    const x = await parsePdfInSandbox(bytes, { password });
    const document = await engine('document.import', { bytes, extract: { text: x.text, pages: x.pages, totalPages: x.totalPages, hasTextLayer: x.hasTextLayer, ocrConfidence: x.ocrConfidence } });
    return { status: 'imported', document, parse: { ms: x.ms, pages: x.pages, totalPages: x.totalPages, hasTextLayer: x.hasTextLayer, ocrConfidence: x.ocrConfidence } };
  } catch (e) {
    if (e instanceof DocparseError && (e.code === 'password_required' || e.code === 'password_incorrect')) {
      const pickId = randomUUID();
      picks.set(pickId, { file, at: Date.now() });
      return { status: e.code === 'password_required' ? 'needs_password' : 'wrong_password', pickId };
    }
    throw e;
  }
}
