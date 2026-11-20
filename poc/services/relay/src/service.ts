import { fail, kstDay, openAead, safeEqual, sealAead, sha256hex, type Sql } from '@sax/svc-shared';
import { RELAY, sizeBucket } from './constants.ts';

export interface OuterEnvelope {
  v: 1;
  kind: 'ENV';
  enc: string;
  ct: string;
}

export interface RelayDeps {
  db: Sql;
  queueKey: Buffer;
  now: () => number;
  onEvent?: (e: string) => void;
}

/** 32바이트 base64url(43자, 패딩 없음) */
export function raw32(v: unknown): Buffer | null {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(v)) return null;
  const b = Buffer.from(v, 'base64url');
  return b.length === 32 ? b : null;
}

export const mbxKeyOf = (mbxId: Buffer): string => sha256hex(Buffer.concat([Buffer.from('SAX-relay-mbx-v1\u0000'), mbxId]));
const tokHash = (tok: Buffer): string => sha256hex(Buffer.concat([Buffer.from('SAX-relay-tok-v1\u0000'), tok]));

export class RelayService {
  readonly now: () => number;
  private readonly d: RelayDeps;
  constructor(d: RelayDeps) {
    this.d = d;
    this.now = d.now;
  }

  async createMailbox(deviceId: string, o: { mbxId: string; tokRead: string; tokWrite: string; peer?: string }, alive: (peer: string) => Promise<boolean> = async () => true): Promise<void> {
    const id = raw32(o.mbxId);
    const r = raw32(o.tokRead);
    const w = raw32(o.tokWrite);
    if (!id || !r || !w || id.equals(r) || id.equals(w) || r.equals(w)) fail('request.param_rejected');
    const slots = o.peer ? await this.d.db.all<{ peer_dev: string }>('SELECT peer_dev FROM mailbox_slots WHERE owner_dev = $1', [deviceId]) : [];
    const gone: string[] = [];
    for (const s of slots) if (s.peer_dev !== o.peer && !(await alive(s.peer_dev))) gone.push(s.peer_dev);
    await this.d.db.tx(async (q) => {
      for (const p of gone) await q.run('DELETE FROM mailbox_slots WHERE owner_dev = $1 AND peer_dev = $2', [deviceId, p]);
      if (o.peer) {
        const mine = await q.all<{ peer_dev: string }>(`SELECT peer_dev FROM mailbox_slots WHERE owner_dev = $1${q.forUpdate}`, [deviceId]);
        if (!mine.some((x) => x.peer_dev === o.peer) && mine.length >= RELAY.mailboxesPerDevice) fail('relay.mailbox_limit');
      }
      const key = mbxKeyOf(id!);
      if (await q.one('SELECT 1 AS x FROM mailboxes WHERE mbx_key = $1', [key])) fail('request.param_rejected');
      await q.run('INSERT INTO mailboxes (mbx_key, read_hash, write_hash) VALUES ($1, $2, $3)', [key, tokHash(r!), tokHash(w!)]);
      if (o.peer) await q.run('INSERT INTO mailbox_slots (owner_dev, peer_dev) VALUES ($1, $2) ON CONFLICT (owner_dev, peer_dev) DO NOTHING', [deviceId, o.peer]);
    });
    if (gone.length) this.d.onEvent?.('mailbox_slot_freed');
    this.d.onEvent?.('mailbox_created');
  }

  async freePeer(peer: string): Promise<number> {
    return this.d.db.run('DELETE FROM mailbox_slots WHERE peer_dev = $1', [peer]);
  }

  async auth(mbxId: string, token: unknown, which: 'read' | 'write'): Promise<string> {
    const id = raw32(mbxId);
    const tok = raw32(token);
    if (!id || !tok) return fail('relay.mailbox_not_found');
    const key = mbxKeyOf(id);
    const row = await this.d.db.one<{ read_hash: string; write_hash: string }>('SELECT read_hash, write_hash FROM mailboxes WHERE mbx_key = $1', [key]);
    if (!row || !safeEqual(tokHash(tok), which === 'read' ? row.read_hash : row.write_hash)) return fail('relay.mailbox_not_found');
    return key;
  }

  async deleteMailbox(deviceId: string, key: string, peer?: string): Promise<void> {
    await this.d.db.tx(async (q) => {
      if ((await q.run('DELETE FROM mailboxes WHERE mbx_key = $1', [key])) !== 1) return;
      await q.run('DELETE FROM queue WHERE mbx_key = $1', [key]);
      await q.run('DELETE FROM mailbox_bundles WHERE mbx_key = $1', [key]);
      if (peer) await q.run('DELETE FROM mailbox_slots WHERE owner_dev = $1 AND peer_dev = $2', [deviceId, peer]);
    });
  }

  async enqueue(key: string, env: OuterEnvelope): Promise<{ seq: number }> {
    const bytes = Buffer.from(JSON.stringify({ v: env.v, kind: env.kind, enc: env.enc, ct: env.ct }), 'utf8');
    const now = this.now();
    const seq = await this.d.db.tx(async (q) => {
      const m = await q.one<{ next_seq: number }>(`SELECT next_seq FROM mailboxes WHERE mbx_key = $1${q.forUpdate}`, [key]);
      if (!m) return fail('relay.mailbox_not_found');
      const cur = await q.one<{ n: number; b: number | null }>('SELECT COUNT(*) AS n, SUM(bytes) AS b FROM queue WHERE mbx_key = $1 AND expires_at > $2', [key, now]);
      if (Number(cur?.n ?? 0) >= RELAY.queueMaxEnvelopes || Number(cur?.b ?? 0) + bytes.length > RELAY.queueMaxBytes) fail('relay.queue_full');
      const s = Number(m.next_seq);
      await q.run('INSERT INTO queue (mbx_key, seq, sealed, bytes, expires_at) VALUES ($1, $2, $3, $4, $5)', [key, s, sealAead(this.d.queueKey, `SAX-relay-q-v1|${key}|${s}`, bytes), bytes.length, now + RELAY.queueTtlMs]);
      await q.run('UPDATE mailboxes SET next_seq = $1 WHERE mbx_key = $2', [s + 1, key]);
      return s;
    });
    await this.stat('ENV', bytes.length);
    return { seq };
  }

  async list(key: string, after = 0, maxBytes: number = RELAY.queuePageMaxBytes): Promise<{ envelopes: Array<{ seq: number; env: OuterEnvelope }>; more: boolean }> {
    const rows = await this.d.db.all<{ seq: number; bytes: number }>('SELECT seq, bytes FROM queue WHERE mbx_key = $1 AND expires_at > $2 AND seq > $3 ORDER BY seq', [key, this.now(), after]);
    let used = 0;
    let n = 0;
    while (n < rows.length && (n === 0 || used + Number(rows[n]!.bytes) <= maxBytes)) used += Number(rows[n++]!.bytes);
    const out: Array<{ seq: number; env: OuterEnvelope }> = [];
    if (n > 0) {
      const sealed = await this.d.db.all<{ seq: number; sealed: Buffer }>('SELECT seq, sealed FROM queue WHERE mbx_key = $1 AND seq > $2 AND seq <= $3 ORDER BY seq', [key, after, Number(rows[n - 1]!.seq)]);
      for (const r of sealed) {
        const pt = openAead(this.d.queueKey, `SAX-relay-q-v1|${key}|${Number(r.seq)}`, r.sealed);
        if (pt) out.push({ seq: Number(r.seq), env: JSON.parse(pt.toString('utf8')) as OuterEnvelope });
        else this.d.onEvent?.('queue_unseal_failed');
      }
    }
    return { envelopes: out, more: n < rows.length };
  }

  async hasPending(key: string): Promise<boolean> {
    return !!(await this.d.db.one('SELECT 1 AS x FROM queue WHERE mbx_key = $1 AND expires_at > $2 LIMIT 1', [key, this.now()]));
  }

  async ack(key: string, seq: number): Promise<number> {
    return this.d.db.run('DELETE FROM queue WHERE mbx_key = $1 AND seq <= $2', [key, seq]);
  }

  async putBundle(key: string, bundle: Buffer): Promise<void> {
    if (!bundle.length || bundle.length > RELAY.bundleMaxBytes) fail('request.param_rejected');
    const sealed = sealAead(this.d.queueKey, `SAX-relay-b-v1|${key}`, bundle);
    await this.d.db.run('INSERT INTO mailbox_bundles (mbx_key, sealed) VALUES ($1, $2) ON CONFLICT (mbx_key) DO UPDATE SET sealed = excluded.sealed', [key, sealed]);
  }

  async getBundle(key: string): Promise<Buffer | null> {
    const r = await this.d.db.one<{ sealed: Buffer }>('SELECT sealed FROM mailbox_bundles WHERE mbx_key = $1', [key]);
    return r ? openAead(this.d.queueKey, `SAX-relay-b-v1|${key}`, r.sealed) : null;
  }

  async stat(kind: 'HS' | 'DATA' | 'ENV', bytes: number): Promise<void> {
    await this.d.db.run('INSERT INTO relay_stats (day, kind, size_bucket, n) VALUES ($1, $2, $3, 1) ON CONFLICT (day, kind, size_bucket) DO UPDATE SET n = relay_stats.n + 1', [kstDay(this.now()), kind, sizeBucket(bytes)]);
  }

  async purgeQueues(): Promise<number> {
    return this.d.db.run('DELETE FROM queue');
  }

  async sweep(): Promise<void> {
    const now = this.now();
    await this.d.db.run('DELETE FROM queue WHERE expires_at <= $1', [now]);
    await this.d.db.run('DELETE FROM relay_stats WHERE day < $1', [kstDay(now - RELAY.statsRetentionDays * 24 * 3600_000)]);
  }
}
