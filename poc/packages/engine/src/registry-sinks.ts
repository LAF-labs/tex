// 레지스트리 데이터 패키지를 받는 곳(D14 M6-10). 급여 시행일 표: 엔진 loadDataPackage(서명 2-of-3·bodyDigest·validatePackage·버전) →
// @sax/payroll applyRateTableUpdate → @sax/db RateTableRepo(한 트랜잭션, 실패면 기존 표 그대로).
import { RateTableRepo, type Db } from '@sax/db';
import { applyRateTableUpdate, RATE_TABLE_SCHEMAS, RATE_TABLES_PACKAGE_ID } from '@sax/payroll';
import type { DataSink } from './registry-sync.ts';

export function rateTableSink(db: Db): DataSink {
  const repo = new RateTableRepo(db);
  return {
    id: RATE_TABLES_PACKAGE_ID,
    schemas: RATE_TABLE_SCHEMAS,
    installed: () => {
      const k = repo.installedPackage(RATE_TABLES_PACKAGE_ID);
      return k ? { version: k.version, digest: k.digest } : null;
    },
    apply: (result) => {
      const u = applyRateTableUpdate(repo, result);
      return u.ok ? { ok: true } : { ok: false, code: u.code };
    },
  };
}
