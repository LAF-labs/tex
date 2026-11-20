import type { Db } from './open.ts';


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

  sum(portal: string, profileId: string, kind: string, from: string, to: string): number {
    const r = this.db.prepare('SELECT COALESCE(SUM(count), 0) AS n FROM rate_counters WHERE portal = ? AND profile_id = ? AND kind = ? AND bucket >= ? AND bucket <= ?').get(portal, profileId, kind, from, to) as Row;
    return Number(r.n);
  }

  bump(portal: string, profileId: string, kind: string, bucket: string, by = 1): number {
    const r = this.db
      .prepare('INSERT INTO rate_counters (portal, profile_id, kind, bucket, count) VALUES (?, ?, ?, ?, ?) ON CONFLICT(portal, profile_id, kind, bucket) DO UPDATE SET count = count + excluded.count RETURNING count')
      .get(portal, profileId, kind, bucket, by) as Row;
    return Number(r.count);
  }

  set(portal: string, profileId: string, kind: string, bucket: string, n: number): void {
    this.db.prepare('INSERT INTO rate_counters (portal, profile_id, kind, bucket, count) VALUES (?, ?, ?, ?, ?) ON CONFLICT(portal, profile_id, kind, bucket) DO UPDATE SET count = excluded.count').run(portal, profileId, kind, bucket, n);
  }

  prune(portal: string, kind: string, before: string): number {
    return this.db.prepare('DELETE FROM rate_counters WHERE portal = ? AND kind = ? AND bucket < ?').run(portal, kind, before).changes;
  }

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
