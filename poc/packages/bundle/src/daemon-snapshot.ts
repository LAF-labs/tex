// 엔진 main 전용 읽기 질의 daemon.snapshot(D10 §3, 팀장 결정 2026-11-06). 응답은 @sax/daemon DaemonSnapshot 주석 예시(#100) 그대로다.
// 읽기 전용이다: 쓰기·실행·DB 키 노출이 없다. main은 DB 키가 없어서 데몬 입력을 엔진이 모아 준다.
// @sax/daemon 타입은 가져오지 않는다(daemon → engine → bundle 의존이라 순환이 생긴다). 같은 모양인지는 tests/daemon-snapshot.test.ts가 타입으로 확인한다.
import { daemonProfileInputs, DocumentRepo, ProfileRepo, type ColumnCipher, type DaemonProfileInputs, type Db, type DocumentRow } from '@sax/db';
import { missingReport, type MissingReport } from './month.ts';

/** 엔진이 가진 마지막 유효 정책에서 데몬이 쓰는 칸(@sax/engine core Policy의 expiresAt·daemon) */
export interface SnapshotPolicyLike {
  expiresAt: string;
  daemon: unknown;
}
/** 마지막 유효 레지스트리 status에서 데몬이 쓰는 칸 */
export interface SnapshotStatusLike {
  issuedAt: string;
  expiresAt: string;
}

/** 엔진이 정책·status를 넘기는 길. 아직 받은 적이 없으면 null(데몬은 DAEMON_POLICY_FALLBACK·stale로 다룬다) */
export interface DaemonSnapshotSources<P extends SnapshotPolicyLike = SnapshotPolicyLike, S extends SnapshotStatusLike = SnapshotStatusLike> {
  policy: () => P | null;
  status: () => S | null;
}

/** 서류는 데몬 만료 계산이 쓰는 칸만 낸다(@sax/daemon ExpiryDocInput). 보관함 경로·해시는 내지 않는다 */
export type SnapshotDocument = Pick<DocumentRow, 'id' | 'docType' | 'displayName' | 'issuedAt' | 'expiresAt' | 'meta'>;

/** @sax/daemon ProfileSnapshot과 같은 모양 */
export interface ProfileSnapshotRow extends DaemonProfileInputs {
  documents: SnapshotDocument[];
  missing: MissingReport | null;
}

export interface DaemonSnapshotResult<P extends SnapshotPolicyLike = SnapshotPolicyLike, S extends SnapshotStatusLike = SnapshotStatusLike> {
  policy: { expiresAt: P['expiresAt']; daemon: P['daemon'] } | null;
  status: { issuedAt: string; expiresAt: string } | null;
  profiles: ProfileSnapshotRow[];
}

const pad = (n: number): string => String(n).padStart(2, '0');
const addMonths = (month: string, n: number): string => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`;
};
const dayOf = (month: string, day: number): string => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${pad(Math.min(Math.max(1, Math.trunc(day)), last))}`;
};

/**
 * 오늘 알릴 꾸러미 달. @sax/daemon bundlePeriod와 같은 셈이다(순환 때문에 다시 적었고, 시험이 한 해 모든 날을 맞춰 본다).
 * 반기납부면 1·7월만, reminderDay부터 그달 말까지이고, 꾸러미 달은 알림 달의 전달이다. 알림 달이 아니면 null.
 */
export function bundleReminderPeriod(today: string, reminderDay: number, halfYear: boolean): string | null {
  const month = today.slice(0, 7);
  if (halfYear && !['01', '07'].includes(month.slice(5, 7))) return null;
  const remindOn = dayOf(month, Number.isFinite(reminderDay) ? reminderDay : 1);
  if (today < remindOn || today > dayOf(month, 31)) return null;
  return addMonths(month, -1);
}

/** 한국 날짜 'YYYY-MM-DD' */
export const kstToday = (now: Date): string => new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);

/**
 * 모든 프로필의 데몬 입력. 프로필이 없으면 profiles는 빈 배열이다.
 * - missing: 오늘이 꾸러미 알림 달이면 그 꾸러미 달의 missingReport, 아니면 null.
 *   한 프로필에서 계산이 실패하면(깨진 암호 컬럼 등) 그 프로필만 null로 두고 나머지는 낸다. 데몬은 null을 "아직 계산 못 함"으로 다룬다.
 * - payrollEnabled는 BundleService와 같은 규칙으로 받는다.
 */
export function daemonSnapshot<P extends SnapshotPolicyLike, S extends SnapshotStatusLike>(
  db: Db,
  cipher: ColumnCipher,
  src: DaemonSnapshotSources<P, S>,
  opts: { now: Date; payrollEnabled: (profileId: string) => boolean },
): DaemonSnapshotResult<P, S> {
  const today = kstToday(opts.now);
  const p = src.policy();
  const s = src.status();
  const docs = new DocumentRepo(db).list();
  const profiles = new ProfileRepo(db).list().map((prof): ProfileSnapshotRow => {
    const inputs = daemonProfileInputs(db, prof.id);
    const period = bundleReminderPeriod(today, inputs.settings.reminderDay, inputs.settings.halfYearWithholding);
    let missing: MissingReport | null = null;
    if (period) {
      try {
        missing = missingReport({ db, cipher, profileId: prof.id, month: period, payrollEnabled: opts.payrollEnabled(prof.id) });
      } catch {
        missing = null;
      }
    }
    return {
      ...inputs,
      documents: docs
        .filter((d) => d.profileId === prof.id)
        .map((d) => ({ id: d.id, docType: d.docType, displayName: d.displayName, issuedAt: d.issuedAt, expiresAt: d.expiresAt, meta: d.meta })),
      missing,
    };
  });
  return {
    // 데몬이 쓰는 칸만 고른다(서명·다른 정책 값은 내지 않는다)
    policy: p ? { expiresAt: p.expiresAt, daemon: p.daemon } : null,
    status: s ? { issuedAt: s.issuedAt, expiresAt: s.expiresAt } : null,
    profiles,
  };
}
