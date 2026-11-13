// Supabase(관리형 PostgreSQL) 마이그레이션 내보내기. 서비스 마이그레이션 SQL을 그대로 쓰고 스키마·역할 구획만 더한다(공급사 중립: 출력은 평범한 PostgreSQL SQL).
// 한 PostgreSQL 안에서 서비스마다 스키마 + 로그인 역할을 나눈다. 역할은 자기 스키마의 행만 읽고 쓰고(DML), 다른 서비스 스키마·DDL 권한은 없다
// (D08 §8 분리 저장: 릴레이 역할은 계정 테이블을 읽을 수 없다). 한도 표는 서비스마다 별도 스키마 `<서비스>_limits`(팀장 결정 2026-11-05 (가)).
// 역할 비밀번호는 넣지 않는다. 사용자가 대시보드에서 정한다(services/deploy/README.md).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIMITS_MIGRATIONS_DIR } from './limits.ts';
import { subst } from './sql.ts';

export interface ExportService {
  /** 서비스 이름 = 스키마 이름 = schema_migrations의 service */
  name: string;
  migrationsDir: string;
  /** 이 단계에 넣는 마이그레이션 번호 범위(포함). 적용된 단계는 범위를 고정한다(새 번호가 그 단계 파일을 바꾸지 않게) */
  versions: { from: number; to: number };
}

interface ExportPhase {
  prefix: string;
  /** 역할·스키마 파일. 이미 있는 서비스의 증분 단계는 없다(null) */
  rolesFile: string | null;
  /** 첫 단계만 한도 표(<서비스>_limits)를 만든다. 증분 단계는 false */
  limits: boolean;
  services: readonly ExportService[];
}

const dirOf = (svc: string) => fileURLToPath(new URL(`../../${svc}/migrations/`, import.meta.url));
const svc = (name: string, from: number, to: number): ExportService => ({ name, migrationsDir: dirOf(name), versions: { from, to } });

/**
 * 내보내기 단계. **이미 적용된 단계의 파일은 바꾸지 않는다**(Supabase는 파일 이름으로 적용 여부를 기억한다): 새 서비스·새 마이그레이션은 새 단계로 더한다(증분).
 * 시험이 적용된 단계 파일의 다이제스트를 고정한다(services-deploy.test.ts).
 * - 2026110600: 계정·게이트웨이·릴레이·푸시(#135, 운영 tex-prod에 적용됨)
 * - 2026110601: 레지스트리 투명성 로그(#132 로그 DB, 팀장 결정 2026-11-06, #161 운영 적용)
 * - 2026110602: 계정 002 비밀번호 로그인·자동 로그인(ADR-038). 역할·한도 표는 이미 있다
 * - 2026110700: 계정 003 알림 메일 발송 큐(notice_outbox, ADR-038 (b)·(d))
 */
export const SUPABASE_PHASES: readonly ExportPhase[] = [
  { prefix: '2026110600', rolesFile: '20261106000000_sax_roles.sql', limits: true, services: [svc('account', 1, 1), svc('gateway', 1, 1), svc('relay', 1, 1), svc('push', 1, 1)] },
  { prefix: '2026110601', rolesFile: '20261106010000_sax_roles_registry.sql', limits: true, services: [svc('registry', 1, 1)] },
  { prefix: '2026110602', rolesFile: null, limits: false, services: [svc('account', 2, 2)] },
  { prefix: '2026110700', rolesFile: null, limits: false, services: [svc('account', 3, 3)] },
  { prefix: '2026111300', rolesFile: null, limits: false, services: [svc('gateway', 2, 2)] },
];

/** 함수·룸 호스트로 올리는 서비스 전부(이름마다 하나, 처음 나온 단계 순서) */
export const SUPABASE_SERVICES: readonly ExportService[] = SUPABASE_PHASES.flatMap((p) => p.services).filter((s, i, all) => all.findIndex((x) => x.name === s.name) === i);

export const roleOf = (svc: string) => `sax_${svc}`;
export const limitsSchemaOf = (svc: string) => `${svc}_limits`;

const HEADER = '-- 생성 파일: services/shared/src/supabase.ts(cd poc && node --conditions=development services/deploy/export-supabase.ts). 직접 고치지 않는다.\n';
const files = (dir: string) => fs.readdirSync(dir).filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f)).sort();

function rolesSql(services: readonly ExportService[]): string {
  const out = [HEADER, '-- 서비스별 로그인 역할(비밀번호 없음)과 스키마. 역할 비밀번호는 사용자가 SQL 편집기에서 ALTER ROLE … PASSWORD로 정한다.\n'];
  for (const s of services) {
    const role = roleOf(s.name);
    const lim = limitsSchemaOf(s.name);
    out.push(
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} LOGIN NOINHERIT; END IF; END $$;`,
      `CREATE SCHEMA IF NOT EXISTS ${s.name};`,
      `CREATE SCHEMA IF NOT EXISTS ${lim};`,
      `REVOKE ALL ON SCHEMA ${s.name}, ${lim} FROM PUBLIC;`,
      `GRANT USAGE ON SCHEMA ${s.name}, ${lim} TO ${role};`,
      `ALTER ROLE ${role} SET search_path = ${s.name}, ${lim};`,
      '',
    );
  }
  return out.join('\n');
}

function serviceSql(s: ExportService, withLimits: boolean): string {
  const role = roleOf(s.name);
  const lim = limitsSchemaOf(s.name);
  const all = files(s.migrationsDir);
  const own = all.filter((f) => Number(f.slice(0, 3)) >= s.versions.from && Number(f.slice(0, 3)) <= s.versions.to);
  // 범위 끝 번호의 파일이 있어야 한다(번호를 잘못 적으면 내보내기가 실패한다)
  if (own.length !== s.versions.to - s.versions.from + 1) throw new Error(`export_versions_${s.name}`);
  const limits = withLimits ? files(LIMITS_MIGRATIONS_DIR) : [];
  const out = [HEADER, `-- ${s.name}: 서비스 마이그레이션은 스키마 ${s.name}, 한도 표는 ${lim}. 기록은 ${s.name}.schema_migrations(상시 서버의 migrate와 같은 표).\n`, `SET search_path TO ${s.name};`, ''];
  for (const f of own) out.push(`-- ${s.name}/migrations/${f}`, subst(fs.readFileSync(path.join(s.migrationsDir, f), 'utf8'), 'pg').trim(), '');
  out.push('CREATE TABLE IF NOT EXISTS schema_migrations (service TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (service, version));');
  for (const f of own) out.push(`INSERT INTO schema_migrations (service, version) VALUES ('${s.name}', ${Number(f.slice(0, 3))}) ON CONFLICT DO NOTHING;`);
  if (limits.length) out.push('', `SET search_path TO ${lim};`, '');
  for (const f of limits) out.push(`-- shared/migrations/${f}`, subst(fs.readFileSync(path.join(LIMITS_MIGRATIONS_DIR, f), 'utf8'), 'pg').trim(), '');
  for (const f of limits) out.push(`INSERT INTO ${s.name}.schema_migrations (service, version) VALUES ('limits', ${Number(f.slice(0, 3))}) ON CONFLICT DO NOTHING;`);
  out.push(
    '',
    '-- 권한: 이 서비스 역할만 행을 읽고 쓴다(DDL 없음). Supabase API 역할(anon·authenticated)과 PUBLIC에는 아무것도 없다.',
    `REVOKE ALL ON ALL TABLES IN SCHEMA ${s.name}, ${lim} FROM PUBLIC;`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${s.name}, ${lim} TO ${role};`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${s.name}, ${lim} TO ${role};`,
    `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON ALL TABLES IN SCHEMA ${s.name}, ${lim} FROM anon, authenticated; END IF; END $$;`,
    'RESET search_path;',
    '',
  );
  return out.join('\n');
}

/** supabase/migrations/<시각>_<이름>.sql 목록. 시각은 고정(같은 입력이면 같은 출력, 시험이 저장소 파일과 대조한다). 단계마다 역할 파일 + 서비스 파일 */
export function exportSupabase(phases: readonly ExportPhase[] = SUPABASE_PHASES): { name: string; sql: string }[] {
  return phases.flatMap((p) => [
    ...(p.rolesFile ? [{ name: p.rolesFile, sql: rolesSql(p.services) }] : []),
    ...p.services.map((s, i) => ({ name: `${p.prefix}${String(i + 1).padStart(2, '0')}00_sax_${s.name}.sql`, sql: serviceSql(s, p.limits) })),
  ]);
}
