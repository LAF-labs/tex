// 셸 문서함 공급자(PoC-8 후속). 셸은 보관함을 이 인터페이스로만 다룬다.
// 기본은 셸 엔진(PoC-6 엔진 호스트)의 RPC(db.query.documents.list, document.import, document.update, document.file)다.
// fixture 모드에서는 엔진이 임시 앱 폴더의 DB·보관함을 쓴다. e2e는 이 공급자를 감싸 보내는 값을 적는다.
import type { DocumentView } from '@sax/engine';
import type { Doc } from './shell-model.ts';
import type { EngineCall, ImportResult } from './vault-import.ts';

/** 문서함 가져오기 결과. imported면 셸 서류(doc)를 함께 준다. */
export type DocsImportResult = (Exclude<ImportResult, null> & { doc?: Doc }) | null;

export interface DocsProvider {
  list(): Promise<Doc[]>;
  /** PDF 고르기 → docparse 샌드박스 → 등록(vault-import.ts). 열기 암호는 pickId·password로 다시 부른다. */
  importPdf(params: Record<string, unknown>): Promise<DocsImportResult>;
  /** 사용자 확인·수정. 바뀐 칸만 보내고, 화면이 보여 준 값(seen)을 붙인다(DocumentService.update 의미, 다르면 stale). */
  update(id: string, patch: Record<string, unknown>, seen: unknown): Promise<Doc>;
  /** 보관함 파일 경로. main이 사용자 기본 뷰어로 열 때만 쓰고 렌더러에는 주지 않는다. */
  filePath(id: string): Promise<string>;
}

/** vault-import.importPdf와 같은 모양(시험은 대화상자 없이 바꿔 끼운다) */
export type Importer = (params: Record<string, unknown>, engine: EngineCall) => Promise<ImportResult>;

/** 엔진 보관함 항목 → 셸 서류. 보관함 서류는 vault 칸(만료일 출처·확인 필요·후보)을 가진다. */
export function toShellDoc(v: DocumentView): Doc {
  return {
    id: v.id,
    name: v.displayName,
    kind: v.docType === 'other' ? '직접 추가' : '증명서',
    docName: v.displayName,
    profile: 'business',
    issuedOn: v.issuedOn,
    expiresOn: v.expiresOn,
    // 앱이 발급(실행에서 저장) / 사용자가 고른 파일
    source: v.source === 'app' ? '앱이 발급' : '직접 추가',
    vault: {
      expirySource: v.expirySource,
      needsUser: v.needsUser,
      reasons: v.reasons,
      suggested: v.suggested,
      docType: v.docType,
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

/** 엔진 공급자: 엔진 호스트 RPC를 넘긴다(`(m, p) => host.rpc(m, p)`). */
export function engineDocsProvider(engine: EngineCall, importer: Importer): DocsProvider {
  return {
    list: async () => ((await engine('db.query.documents.list', {})) as DocumentView[]).map(toShellDoc),
    importPdf: async (params) => withDoc(await importer(params, engine)),
    update: async (id, patch, seen) => toShellDoc((await engine('document.update', { id, patch, seen })) as DocumentView),
    filePath: async (id) => ((await engine('document.file', { id })) as { path: string }).path,
  };
}

// 폴더 이름에 만든 프로세스 번호를 넣는다(sax-shell-docs-<pid>-XXXXXX). 표시 파일로 두면 Windows에서 뷰어가 PDF를 잡고 있을 때
// 지우기가 표시 파일만 지우고 멈춰, 남은 폴더를 다음 시작이 알아보지 못한다.
