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
