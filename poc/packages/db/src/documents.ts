// 보관함 문서 행(D07 §2 documents, v1 스키마 그대로). 파일 쓰기·메타 해석은 엔진(DocumentService)이 한다.
import { ValidationError } from './repo.ts';
import type { Db } from './open.ts';

export interface DocumentRow {
  id: string;
  profileId: string;
  docType: string;
  displayName: string | null;
  issuedAt: string | null;
  expiresAt: string | null;
  issuer: string | null;
  path: string;
  bytes: number;
  sha256: string;
  /** 종류별 추가 필드(발급번호·추출 이유 등). 로컬 전용 */
  meta: Record<string, unknown> | null;
  runId: string | null;
  createdAt: string;
}

export type DocumentPatch = Partial<Pick<DocumentRow, 'docType' | 'displayName' | 'issuedAt' | 'expiresAt' | 'issuer' | 'path' | 'meta'>>;

type Row = Record<string, unknown>;

const toDocument = (r: Row): DocumentRow => ({
  id: String(r.id),
  profileId: String(r.profile_id),
  docType: String(r.doc_type),
  displayName: (r.display_name as string) ?? null,
  issuedAt: (r.issued_at as string) ?? null,
  expiresAt: (r.expires_at as string) ?? null,
  issuer: (r.issuer as string) ?? null,
  path: String(r.path),
  bytes: Number(r.bytes),
  sha256: String(r.sha256),
  meta: r.meta_json ? (JSON.parse(String(r.meta_json)) as Record<string, unknown>) : null,
  runId: (r.run_id as string) ?? null,
  createdAt: String(r.created_at),
});

export class DocumentRepo {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  insert(d: Omit<DocumentRow, 'createdAt'>, createdAt: string = new Date().toISOString()): DocumentRow {
    this.db
      .prepare(`INSERT INTO documents (id, profile_id, doc_type, display_name, issued_at, expires_at, issuer, path, bytes, sha256, meta_json, run_id, created_at)
        VALUES (@id, @profileId, @docType, @displayName, @issuedAt, @expiresAt, @issuer, @path, @bytes, @sha256, @meta, @runId, @createdAt)`)
      .run({ ...d, meta: d.meta ? JSON.stringify(d.meta) : null, createdAt });
    return this.get(d.id)!;
  }

  get(id: string): DocumentRow | null {
    const r = this.db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
    return r ? toDocument(r as Row) : null;
  }

  bySha256(sha256: string): DocumentRow | null {
    const r = this.db.prepare('SELECT * FROM documents WHERE sha256 = ? ORDER BY created_at LIMIT 1').get(sha256);
    return r ? toDocument(r as Row) : null;
  }

  /** 최근 발급순(발급일 없으면 등록 시각) */
  list(): DocumentRow[] {
    return this.db.prepare('SELECT * FROM documents ORDER BY COALESCE(issued_at, substr(created_at, 1, 10)) DESC, created_at DESC').all().map((r) => toDocument(r as Row));
  }

  update(id: string, patch: DocumentPatch): DocumentRow {
    const cur = this.get(id);
    if (!cur) throw new ValidationError('not_found');
    const next = { ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as DocumentRow;
    this.db
      .prepare('UPDATE documents SET doc_type=?, display_name=?, issued_at=?, expires_at=?, issuer=?, path=?, meta_json=? WHERE id=?')
      .run(next.docType, next.displayName, next.issuedAt, next.expiresAt, next.issuer, next.path, next.meta ? JSON.stringify(next.meta) : null, id);
    return this.get(id)!;
  }

  /** 사용자가 바꾼 유효 일수(validity_rules.user_override_days). 행이 없으면 null. */
  overrideDays(docType: string): number | null {
    const r = this.db.prepare('SELECT user_override_days AS d FROM validity_rules WHERE doc_type = ?').get(docType) as { d: number | null } | undefined;
    return r?.d ?? null;
  }
}
