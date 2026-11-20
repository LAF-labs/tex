import type { DocumentView } from '@sax/engine';
import type { Doc } from './shell-model.ts';
import type { EngineCall, ImportResult } from './vault-import.ts';

export type DocsImportResult = (Exclude<ImportResult, null> & { doc?: Doc }) | null;

export interface DocsProvider {
  list(): Promise<Doc[]>;
  importPdf(params: Record<string, unknown>): Promise<DocsImportResult>;
  update(id: string, patch: Record<string, unknown>, seen: unknown): Promise<Doc>;
  filePath(id: string): Promise<string>;
}

export type Importer = (params: Record<string, unknown>, engine: EngineCall) => Promise<ImportResult>;

export function toShellDoc(v: DocumentView): Doc {
  if (v.runId)
    return { id: v.id, name: v.displayName, kind: v.docType === 'tax_invoice' ? '세금계산서' : '증명서', docName: v.displayName, profile: 'business', issuedOn: v.issuedOn, expiresOn: v.expiresOn, source: '앱이 발급', runId: v.runId };
  return {
    id: v.id,
    name: v.displayName,
    kind: v.docType === 'other' ? '직접 추가' : '증명서',
    docName: v.displayName,
    profile: 'business',
    issuedOn: v.issuedOn,
    expiresOn: v.expiresOn,
    source: v.source === 'app' ? '앱이 발급' : '직접 추가',
    vault: {
      expirySource: v.expirySource,
      needsUser: v.needsUser,
      reasons: v.reasons,
      suggested: v.suggested,
      docType: v.docType as NonNullable<Doc['vault']>['docType'],
      textSource: v.textSource,
      docNo: v.docNo,
      issuer: v.issuer,
      subjectMismatch: v.subjectMismatch,
    },
  };
}

function withDoc(r: ImportResult): DocsImportResult {
  if (r?.status !== 'imported') return r;
  return { ...r, doc: toShellDoc(r.document as DocumentView) };
}

export function engineDocsProvider(engine: EngineCall, importer: Importer): DocsProvider {
  return {
    list: async () => ((await engine('db.query.documents.list', {})) as DocumentView[]).map(toShellDoc),
    importPdf: async (params) => withDoc(await importer(params, engine)),
    update: async (id, patch, seen) => toShellDoc((await engine('document.update', { id, patch, seen })) as DocumentView),
    filePath: async (id) => ((await engine('document.file', { id })) as { path: string }).path,
  };
}

