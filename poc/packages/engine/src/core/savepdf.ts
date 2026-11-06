// save_pdf(M2-3, D02 §4 표·V-23, D05 §3.3, D07 §1): 발급 결과 PDF를 금고가 받아 staging에 두고, 엔진이 보관함으로 옮긴다.
// - 엔진은 PDF 바이트·원래 파일 이름·URL을 보지 않는다. 금고가 자기 세션에서 인쇄하거나 무장된 다운로드 1건을 받아
//   검사(15 MiB, %PDF- 머리, %%EOF 꼬리)를 통과하면 staging/<fileId>.pdf로 두고 fileId만 준다(금고 #164 계약).
//   엔진의 Page.printToPDF·Page/Browser.setDownloadBehavior는 중계가 거부한다(A-13).
// - 보관함 이동(docparse → 보관함, V-23 이름)은 포트 store가 한다. 파일 이름에 PII 없음({docType}_{yyyyMMdd}_{shortId}.pdf).
// - strategy print만 있다. original(다운로드 버튼)은 IR에 버튼 타깃이 없어 아직 못 한다. page_pdf·wallet도 아직 없다.
// - 저널에는 스텝 id·docType·사유 코드만(⑦). fileId·보관함 id는 남기지 않는다.
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
  /** staging의 fileId를 보관함으로 옮긴다(V-23: nameTemplate 또는 엔진 기본). 돌려주는 것은 보관함 문서 id(파일 경로 아님). */
  store(r: { runId: string; stepId: string; fileId: string; docType: string; nameTemplate?: string }): Promise<{ ok: true; documentId: string } | { ok: false; reason: string }>;
}

export interface SavePdfDeps {
  pdf: PdfPort;
  runId: string;
  /** 실행 값 참조($artifacts.pdf, D02 §4.2). 사후조건 {artifact:"pdf"}가 본다. */
  artifacts: Map<string, string>;
  journal(type: string, payload: Record<string, string | number | boolean>): void;
}

/** $artifacts.X 키. 사후조건 {artifact: "pdf"}·send_email.attach "$artifacts.pdf"(D02 §8). */
export const PDF_ARTIFACT = 'pdf';

export type SavePdfResult = { ok: true } | { ok: false; code: 'save_pdf.unsupported' | 'save_pdf.failed' };

/** save_pdf 한 번. 실패해도 예외를 내지 않는다(사유는 저널, 결과는 코드). */
export async function savePdf(d: SavePdfDeps, s: SavePdfStep): Promise<SavePdfResult> {
  if (s.strategy !== 'print') {
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
  // 사유는 금고·보관함의 열거 코드다. 모양이 다르면 남기지 않는다(⑦).
  d.journal('save_pdf.failed', { stepId: s.id, stage, reason: /^[a-z_]{1,40}$/.test(reason) ? reason : 'other' });
  return { ok: false, code: 'save_pdf.failed' };
}
