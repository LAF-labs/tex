// 셸 문서함 공급자(PoC-8 후속). 셸은 보관함을 이 인터페이스로만 다룬다.
// - 엔진 공급자: 엔진 RPC(db.query.documents.list, document.import, document.update). PoC-6이 셸에 엔진 호스트를 붙이면 이것을 넘긴다.
// - 데모 공급자: 엔진·금고가 없는 목업 셸(pnpm demo)에서 엔진 자리를 대신한다. 엔진의 보관함 코드(DocumentService)를
//   실행마다 새로 만드는 임시 폴더의 DB·보관함으로 그대로 돌려 판단(만료일·확인 필요)이 실제 앱과 같다.
//   main이 DB를 여는 것은 이 데모뿐이다(D01 §2.1의 예외, 목업). 앱 폴더는 쓰지 않고, 닫을 때 임시 폴더를 지운다.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, ProfileRepo, type Db } from '@sax/db';
import { DocumentService, type DocumentView } from '@sax/engine/documents';
import type { Doc, Profile } from './shell-mock.ts';
import type { EngineCall, ImportResult } from './vault-import.ts';

/** 문서함 가져오기 결과. imported면 셸 서류(doc)를 함께 준다. */
export type DocsImportResult = (Exclude<ImportResult, null> & { doc?: Doc }) | null;

export interface DocsProvider {
  list(): Promise<Doc[]>;
  /** PDF 고르기 → docparse 샌드박스 → 등록(vault-import.ts). 열기 암호는 pickId·password로 다시 부른다. */
  importPdf(params: Record<string, unknown>): Promise<DocsImportResult>;
  /** 사용자 확인·수정. 바뀐 칸만 보낸다(DocumentService.update 의미). */
  update(id: string, patch: Record<string, unknown>): Promise<Doc>;
  /** 보관함 파일 경로. main이 사용자 기본 뷰어로 열 때만 쓰고 렌더러에는 주지 않는다. */
  filePath(id: string): Promise<string>;
  close?(): void;
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

/** 엔진 공급자: PoC-6의 엔진 호스트 RPC를 넘긴다(`(m, p) => host.rpc(m, p)`). */
export function engineDocsProvider(engine: EngineCall, importer: Importer): DocsProvider {
  return {
    list: async () => ((await engine('db.query.documents.list', {})) as DocumentView[]).map(toShellDoc),
    importPdf: async (params) => withDoc(await importer(params, engine)),
    update: async (id, patch) => toShellDoc((await engine('document.update', { id, patch })) as DocumentView),
    filePath: async (id) => ((await engine('document.file', { id })) as { path: string }).path,
  };
}

/**
 * 데모 공급자: parent(기본 OS 임시 폴더) 아래에 실행마다 새 폴더를 만들어 DB(새 키)와 보관함을 두고 DocumentService를 그대로 쓴다.
 * 닫으면(close) 그 폴더를 지운다. 사업자 프로필은 셸 목업 프로필로 등록한다(사업자번호가 다른 서류는 '다른 사업자'로 확인을 받는다).
 */
export function demoDocsProvider(o: { parent?: string; profile: Profile; importer: Importer; now?: () => Date }): DocsProvider & { dir: string } {
  const dir = fs.mkdtempSync(path.join(o.parent ?? os.tmpdir(), 'sax-shell-docs-'));
  const db: Db = openDatabase(path.join(dir, 'docs-demo.sqlite'), new Uint8Array(randomBytes(32)));
  new ProfileRepo(db).upsert({ kind: 'business', displayName: o.profile.name, bizNo: o.profile.bizNo ?? null, corpNo: null, repName: o.profile.rep ?? null, bizType: null, bizItem: null, address: null, email: o.profile.email, signMethod: null });
  const svc = new DocumentService(db, () => path.join(dir, 'vault'), o.now);
  // 엔진 RPC 흉내: 데모 공급자가 받는 것은 가져오기 하나다(엔진 data-service의 document.import와 같은 인자).
  const engine: EngineCall = async (method, p) => {
    if (method !== 'document.import') throw new Error('unknown_method');
    return svc.import(p.bytes, p.extract, { altText: p.altText, final: p.final === true });
  };
  let closed = false;
  return {
    dir,
    list: async () => svc.list().map(toShellDoc),
    importPdf: async (params) => withDoc(await o.importer(params, engine)),
    update: async (id, patch) => toShellDoc(svc.update(id, patch)),
    filePath: (id) => svc.filePath(id),
    close: () => {
      if (closed) return;
      closed = true;
      db.close();
      fs.rmSync(dir, { recursive: true, force: true }); // 데모 DB·사용자가 고른 PDF 사본을 남기지 않는다(mkdtemp로 만든 이 폴더만)
    },
  };
}
