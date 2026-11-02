import type { Db } from './open.ts';

// 요청률 카운터(D03 §7, D07 rate_counters·clock_guard·cooldowns). 버킷 문자열(KST)과 kind는 엔진 정책이 정한다.
// 같은 kind의 버킷은 길이가 같아 사전순이 시간순이다. 값은 횟수와 시각뿐이다.

type Row = Record<string, unknown>;

export class RateRepo {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  count(portal: string, profileId: string, kind: string, bucket: string): number {
    const r = this.db.prepare('SELECT count FROM rate_counters WHERE portal = ? AND profile_id = ? AND kind = ? AND bucket = ?').get(portal, profileId, kind, bucket) as Row | undefined;
    return r ? Number(r.count) : 0;
  }

  /** from ≤ bucket ≤ to인 행의 합. */
  sum(portal: string, profileId: string, kind: string, from: string, to: string): number {
    const r = this.db.prepare('SELECT COALESCE(SUM(count), 0) AS n FROM rate_counters WHERE portal = ? AND profile_id = ? AND kind = ? AND bucket >= ? AND bucket <= ?').get(portal, profileId, kind, from, to) as Row;
    return Number(r.n);
  }

  /** 올린 뒤의 값. 부르는 쪽 트랜잭션 안이면 그 트랜잭션과 함께 커밋된다. */
  bump(portal: string, profileId: string, kind: string, bucket: string, by = 1): number {
    const r = this.db
      .prepare('INSERT INTO rate_counters (portal, profile_id, kind, bucket, count) VALUES (?, ?, ?, ?, ?) ON CONFLICT(portal, profile_id, kind, bucket) DO UPDATE SET count = count + excluded.count RETURNING count')
      .get(portal, profileId, kind, bucket, by) as Row;
    return Number(r.count);
  }

  set(portal: string, profileId: string, kind: string, bucket: string, n: number): void {
    this.db.prepare('INSERT INTO rate_counters (portal, profile_id, kind, bucket, count) VALUES (?, ?, ?, ?, ?) ON CONFLICT(portal, profile_id, kind, bucket) DO UPDATE SET count = excluded.count').run(portal, profileId, kind, bucket, n);
  }

  /** kind의 bucket < before 행을 지운다. */
  prune(portal: string, kind: string, before: string): number {
    return this.db.prepare('DELETE FROM rate_counters WHERE portal = ? AND kind = ? AND bucket < ?').run(portal, kind, before).changes;
  }

  /** 마지막으로 본 시각(ms). 시계 역행 판단에 쓴다. */
  lastSeen(): number | null {
    const r = this.db.prepare('SELECT last_seen_at FROM clock_guard WHERE id = 1').get() as Row | undefined;
    return r ? Date.parse(String(r.last_seen_at)) : null;
  }

  seen(ms: number): void {
    this.db.prepare('INSERT INTO clock_guard (id, last_seen_at) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at').run(new Date(ms).toISOString());
  }

  cooldown(portal: string): { until: number; reason: string } | null {
    const r = this.db.prepare('SELECT until, reason FROM cooldowns WHERE portal = ?').get(portal) as Row | undefined;
    return r ? { until: Date.parse(String(r.until)), reason: String(r.reason) } : null;
  }

  startCooldown(portal: string, until: number, reason: string): void {
    this.db.prepare('INSERT INTO cooldowns (portal, until, reason) VALUES (?, ?, ?) ON CONFLICT(portal) DO UPDATE SET until = excluded.until, reason = excluded.reason').run(portal, new Date(until).toISOString(), reason);
  }
}
