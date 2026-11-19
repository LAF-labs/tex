// 우편함 저장: 우편함 ID·토큰 해시, 오프라인 의도 봉투 큐(72시간·160건·6 MiB), 번들 슬롯, 기기당 개수, 메타 통계(우편함 ID 없음).
// 우편함과 기기·계정은 같은 행에 두지 않는다. 기기 ID는 자리(mailbox_slots: 만든 PC, 이어진 폰)에만 있고 어느 우편함인지는 모른다(D08 §8).
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
  /** 큐·번들 저장 전 봉인 키(QUEUE_KEY) */
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

  /**
   * PC가 만든 32B 난수 우편함 ID·읽기·쓰기 토큰을 등록한다(서버는 해시만). 자리는 PC당 폰 3대(mailbox_slots).
   * peer: 이 우편함으로 이어질 폰의 기기 ID. 같은 폰을 다시 연결하면 자리를 더 쓰지 않는다.
   * alive: 계정 서비스에서 그 폰이 아직 쓰이는지(활성·연결 중). 아니면 그 자리를 비운다(끊은 폰의 우편함 지우기가 실패했어도 자리가 풀린다).
   * peer가 없는 예전 PC는 자리를 세지 않는다(v1 개수는 지우기가 실패하면 영영 남았다).
   */
  async createMailbox(deviceId: string, o: { mbxId: string; tokRead: string; tokWrite: string; peer?: string }, alive: (peer: string) => Promise<boolean> = async () => true): Promise<void> {
    const id = raw32(o.mbxId);
    const r = raw32(o.tokRead);
    const w = raw32(o.tokWrite);
    if (!id || !r || !w || id.equals(r) || id.equals(w) || r.equals(w)) fail('request.param_rejected');
    // 계정 서비스는 트랜잭션 밖에서 묻는다(네트워크)
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

  /** 계정 서비스가 폰을 끊거나 정지했다(정지 훅): 그 폰이 쓰던 자리를 비운다. 우편함 자체는 ID를 모르니 그대로다(토큰 없이는 못 쓴다). */
  async freePeer(peer: string): Promise<number> {
    return this.d.db.run('DELETE FROM mailbox_slots WHERE peer_dev = $1', [peer]);
  }

  /**
   * 우편함 토큰 확인. 우편함이 없거나 토큰이 틀리면 같은 코드(존재 오라클 없음).
   * 반환값은 우편함 키(sha256(ID)). 원래 ID는 저장하지 않는다.
   */
  async auth(mbxId: string, token: unknown, which: 'read' | 'write'): Promise<string> {
    const id = raw32(mbxId);
    const tok = raw32(token);
    if (!id || !tok) return fail('relay.mailbox_not_found');
    const key = mbxKeyOf(id);
    const row = await this.d.db.one<{ read_hash: string; write_hash: string }>('SELECT read_hash, write_hash FROM mailboxes WHERE mbx_key = $1', [key]);
    if (!row || !safeEqual(tokHash(tok), which === 'read' ? row.read_hash : row.write_hash)) return fail('relay.mailbox_not_found');
    return key;
  }

  /**
   * 우편함 삭제(재발급 mbx.reissue 뒤 옛 우편함, 기기 해제). 큐·번들도 함께.
   * peer를 주면(폰 해제) 그 폰의 자리도 비운다. 재발급은 같은 폰의 새 우편함이 자리를 이어 쓰므로 peer를 주지 않는다.
   */
  async deleteMailbox(deviceId: string, key: string, peer?: string): Promise<void> {
    await this.d.db.tx(async (q) => {
      // 동시에 같은 우편함을 지우면 둘 다 auth를 통과한다. 실제로 지운 쪽만 자리를 비운다
      if ((await q.run('DELETE FROM mailboxes WHERE mbx_key = $1', [key])) !== 1) return;
      await q.run('DELETE FROM queue WHERE mbx_key = $1', [key]);
      await q.run('DELETE FROM mailbox_bundles WHERE mbx_key = $1', [key]);
      if (peer) await q.run('DELETE FROM mailbox_slots WHERE owner_dev = $1 AND peer_dev = $2', [deviceId, peer]);
    });
  }

  /** 의도 봉투 넣기(폰 → PC). 바깥 {v, kind, enc, ct}만 보고 그대로 봉인해 둔다. */
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

  /**
   * 큐 읽기(한 쪽). `after`보다 큰 seq를 순서대로, 봉투 바이트 합이 `maxBytes`를 넘기 전까지 돌려준다(봉투 하나는 언제나).
   * 남은 봉투가 있으면 `more: true`다. 받는 쪽은 ACK한 뒤 다시 읽거나, ACK 전에 `after = 마지막 seq`로 다음 쪽을 읽는다.
   */
  async list(key: string, after = 0, maxBytes: number = RELAY.queuePageMaxBytes): Promise<{ envelopes: Array<{ seq: number; env: OuterEnvelope }>; more: boolean }> {
    // 봉인본을 다 읽기 전에 바이트(평문 길이 열)로 자른다: 쪽 하나만 복호화한다
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

  /** 만료되지 않은 봉투가 있는가(라이브 연결 때 알림용, 복호화 없음) */
  async hasPending(key: string): Promise<boolean> {
    return !!(await this.d.db.one('SELECT 1 AS x FROM queue WHERE mbx_key = $1 AND expires_at > $2 LIMIT 1', [key, this.now()]));
  }

  /** ACK{seq}: seq 이하를 지운다(D08 §7). */
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

  /** 메시지 메타 통계: (KST 일, 바깥 kind, 크기 버킷) 개수. 우편함 ID 없음. */
  async stat(kind: 'HS' | 'DATA' | 'ENV', bytes: number): Promise<void> {
    await this.d.db.run('INSERT INTO relay_stats (day, kind, size_bucket, n) VALUES ($1, $2, $3, 1) ON CONFLICT (day, kind, size_bucket) DO UPDATE SET n = relay_stats.n + 1', [kstDay(this.now()), kind, sizeBucket(bytes)]);
  }

  /** 릴레이 침해 대응(D09 §11): 큐 전면 폐기. 우편함 재발급은 PC가 라이브 세션에서 한다. */
  async purgeQueues(): Promise<number> {
    return this.d.db.run('DELETE FROM queue');
  }

  async sweep(): Promise<void> {
    const now = this.now();
    await this.d.db.run('DELETE FROM queue WHERE expires_at <= $1', [now]);
    await this.d.db.run('DELETE FROM relay_stats WHERE day < $1', [kstDay(now - RELAY.statsRetentionDays * 24 * 3600_000)]);
  }
}
