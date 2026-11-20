import type { SavePdfStep } from './types.ts';

/** 금고 staging 파일 id(32 hex 무작위, 금고 #164). 이 모양이 아니면 받지 않는다(경로 주입 방어). */
export const STAGED_FILE_ID = /^[0-9a-f]{32}$/;

export type PdfFileResult = { ok: true; fileId: string } | { ok: false; reason: string };

/**
 * save_pdf 포트. RunService가 금고 엔진 포트 RPC·이벤트와 DocumentService에 잇는다. targetId(지금 포털 탭)는 포트 구현이 채운다.
 *
 * | 메서드 | 금고 RPC·이벤트(#164 protocol.ts "PDF 저장") |
 * |---|---|
 * | `print` | `pdf.print {runId, targetId, landscape?}` → `{ok:true, fileId} \| {ok:false, reason}` |
 * | `armDownload` | `download.arm {runId, targetId}` → `{armed:true} \| {armed:false, reason}` |
 * | `awaitDownload` | 이벤트 `download.completed{fileId}` 또는 `download.failed{reason}`(timeoutMs 안, 없으면 reason `timeout`) |
 * | `disarmDownload` | `download.disarm {}` |
 * | `store` | (금고 아님) `stagedPdfPath(staging, fileId)` → docparse → 보관함, staging 파일 지움 |
 *
 * 엔진에는 Page.downloadWillBegin·Page.downloadProgress가 오지 않는다(guid·원래 파일 이름).
 * armDownload·awaitDownload·disarmDownload는 strategy original(다운로드 버튼) 몫이다. 이 PR에서는 아직 쓰지 않는다.
 */
export interface PdfPort {
  print(r: { runId: string; stepId: string; landscape?: boolean }): Promise<PdfFileResult>;
  armDownload(r: { runId: string; stepId: string }): Promise<{ armed: true } | { armed: false; reason: string }>;
  awaitDownload(r: { runId: string; stepId: string; timeoutMs: number }): Promise<PdfFileResult>;
  disarmDownload(): Promise<void>;
  store(r: { runId: string; stepId: string; fileId: string; docType: string; nameTemplate?: string }): Promise<{ ok: true; documentId: string } | { ok: false; reason: string }>;
}

export interface SavePdfDeps {
  pdf: PdfPort;
  runId: string;
  artifacts: Map<string, string>;
  journal(type: string, payload: Record<string, string | number | boolean>): void;
}

/** $artifacts.X 키. 사후조건 {artifact: "pdf"}·send_email.attach "$artifacts.pdf"(D02 §8). */
export const PDF_ARTIFACT = 'pdf';

/** 이 엔진이 하는 save_pdf strategy(V-23a). */
export const SAVE_PDF_STRATEGIES: ReadonlySet<SavePdfStep['strategy']> = new Set(['print', 'page_pdf']);

export type SavePdfResult = { ok: true } | { ok: false; code: 'save_pdf.unsupported' | 'save_pdf.failed' };

/** save_pdf 한 번. 실패해도 예외를 내지 않는다(사유는 저널, 결과는 코드). */
export async function savePdf(d: SavePdfDeps, s: SavePdfStep): Promise<SavePdfResult> {
  if (!SAVE_PDF_STRATEGIES.has(s.strategy)) {
    d.journal('save_pdf.unsupported', { stepId: s.id, strategy: s.strategy });
    return { ok: false, code: 'save_pdf.unsupported' };
  }
  const p = await d.pdf.print({ runId: d.runId, stepId: s.id }).catch((): PdfFileResult => ({ ok: false, reason: 'port_error' }));
  if (!p.ok) return failed(d, s, 'print', p.reason);
  if (!STAGED_FILE_ID.test(p.fileId)) return failed(d, s, 'print', 'bad_file_id');
  const st = await d.pdf
    .store({ runId: d.runId, stepId: s.id, fileId: p.fileId, docType: s.docType, ...(s.nameTemplate !== undefined ? { nameTemplate: s.nameTemplate } : {}) })
    .catch(() => ({ ok: false as const, reason: 'port_error' }));
  if (!st.ok) return failed(d, s, 'store', st.reason);
  d.artifacts.set(PDF_ARTIFACT, st.documentId);
  d.journal('artifact.saved', { stepId: s.id, docType: s.docType, strategy: s.strategy });
  return { ok: true };
}

function failed(d: SavePdfDeps, s: SavePdfStep, stage: 'print' | 'store', reason: string): SavePdfResult {
  d.journal('save_pdf.failed', { stepId: s.id, stage, reason: /^[a-z_]{1,40}$/.test(reason) ? reason : 'other' });
  return { ok: false, code: 'save_pdf.failed' };
}
