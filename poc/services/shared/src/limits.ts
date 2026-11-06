// 한도 카운터와 한도 키 솔트(팀장 결정 2026-11-05 (가), D09 §4·D08 §8).
// 함수 인스턴스가 여럿이면 메모리 카운터는 인스턴스마다 따로 센다. 그래서 카운터와 KST 날짜별 무작위 솔트를 DB에 둔다.
// 솔트는 당일 행만 있고 날짜가 바뀌면 지운다: 지나간 날의 HMAC은 다시 계산할 수 없다(보호 성질 유지, 노출 면은 당일 DB로 넓어짐).
// 계정·기기 ID 키는 DB 솔트가 아니라 서버 비밀(LIMIT_ID_KEY) HMAC이다: DB만 읽어서는 다시 계산할 수 없다.
// 메모리 구현은 단일 인스턴스(로컬·시험)용이다.
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { hmacHex, kstDay } from './crypto.ts';
import type { Sql } from './sql.ts';

export const LIMITS_MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

/** D09 §1.1 가시성 표(한도 테이블) */
export const LIMITS_VISIBILITY = {
  lim_salts: { label: '솔트 용도(고정 문자열)', day: 'KST 날짜', salt: '당일 무작위 32바이트(다음 날 삭제)' },
  lim_windows: { k: '창 길이|용도:당일 솔트 HMAC', start_ms: '창 시작', n: '횟수', expires_at: '만료' },
  int_nonces: { nonce: '내부 호출 서명의 1회용 무작위 값(16바이트 b64url, 요청 내용·출처 없음)', expires_at: '서명 시각 + 60초(지나면 삭제)' },
} as const;

export interface Hit {
  ok: boolean;
  /** 이번 호출을 넣은 창 안 횟수(한도를 넘으면 한도 + 1) */
  n: number;
  /** 창이 끝날 때까지(초, 올림, Retry-After) */
  retryAfterSec: number;
}

/** 고정 창 카운터. 키는 이미 솔트 HMAC된 값만 넣는다(평문 IP·이메일·계정·기기 ID 금지). */
export interface Limiter {
  hit(key: string, limit: number, windowMs: number): Promise<Hit>;
  /** 올리지 않고 현재 창의 횟수만 본다(창이 없거나 지났으면 n = 0) */
  count(key: string, windowMs: number): Promise<{ n: number; retryAfterSec: number }>;
  reset(key: string, windowMs: number): Promise<void>;
  sweep(): Promise<void>;
}

/** 한도 키용 솔트 HMAC(hex 32자) */
export interface KeySalt {
  hash(value: string): Promise<string>;
}

const after = (start: number, windowMs: number, now: number) => Math.max(1, Math.ceil((start + windowMs - now) / 1000));

export class MemoryLimiter implements Limiter {
  private readonly windows = new Map<string, { start: number; n: number; ms: number }>();
  private readonly now: () => number;
  constructor(now: () => number) {
    this.now = now;
  }
  hit(key: string, limit: number, windowMs: number): Promise<Hit> {
    const now = this.now();
    const k = `${windowMs}|${key}`;
    let w = this.windows.get(k);
    if (!w || now - w.start >= windowMs) this.windows.set(k, (w = { start: now, n: 0, ms: windowMs }));
    if (w.n <= limit) w.n++;
    return Promise.resolve({ ok: w.n <= limit, n: w.n, retryAfterSec: after(w.start, windowMs, now) });
  }
  count(key: string, windowMs: number): Promise<{ n: number; retryAfterSec: number }> {
    const now = this.now();
    const w = this.windows.get(`${windowMs}|${key}`);
    if (!w || now - w.start >= windowMs) return Promise.resolve({ n: 0, retryAfterSec: 0 });
    return Promise.resolve({ n: w.n, retryAfterSec: after(w.start, windowMs, now) });
  }
  reset(key: string, windowMs: number): Promise<void> {
    this.windows.delete(`${windowMs}|${key}`);
    return Promise.resolve();
  }
  sweep(): Promise<void> {
    const now = this.now();
    for (const [k, w] of this.windows) if (now - w.start >= w.ms) this.windows.delete(k);
    return Promise.resolve();
  }
}

/**
 * DB 고정 창 카운터: 한 문장 upsert라 인스턴스가 여럿이어도 원자적이다. 창이 지났으면 1부터, 아니면 한도 + 1까지만 올린다.
 * SET의 식은 모두 갱신 전 행을 본다(PostgreSQL·SQLite 공통).
 */
export class SqlLimiter implements Limiter {
  private readonly db: Sql;
  private readonly now: () => number;
  constructor(db: Sql, now: () => number) {
    this.db = db;
    this.now = now;
  }
  async hit(key: string, limit: number, windowMs: number): Promise<Hit> {
    const now = this.now();
    const r = await this.db.one<{ start_ms: number | string; n: number | string }>(
      `INSERT INTO lim_windows (k, start_ms, n, expires_at) VALUES ($1, $2, 1, $3)
       ON CONFLICT (k) DO UPDATE SET
         n = CASE WHEN lim_windows.expires_at <= $2 THEN 1 WHEN lim_windows.n <= $4 THEN lim_windows.n + 1 ELSE lim_windows.n END,
         start_ms = CASE WHEN lim_windows.expires_at <= $2 THEN $2 ELSE lim_windows.start_ms END,
         expires_at = CASE WHEN lim_windows.expires_at <= $2 THEN $3 ELSE lim_windows.expires_at END
       RETURNING start_ms, n`,
      [`${windowMs}|${key}`, now, now + windowMs, limit],
    );
    const n = Number(r!.n);
    return { ok: n <= limit, n, retryAfterSec: after(Number(r!.start_ms), windowMs, now) };
  }
  async count(key: string, windowMs: number): Promise<{ n: number; retryAfterSec: number }> {
    const now = this.now();
    const r = await this.db.one<{ start_ms: number | string; n: number | string }>('SELECT start_ms, n FROM lim_windows WHERE k = $1 AND expires_at > $2', [`${windowMs}|${key}`, now]);
    return r ? { n: Number(r.n), retryAfterSec: after(Number(r.start_ms), windowMs, now) } : { n: 0, retryAfterSec: 0 };
  }
  async reset(key: string, windowMs: number): Promise<void> {
    await this.db.run('DELETE FROM lim_windows WHERE k = $1', [`${windowMs}|${key}`]);
  }
  /** 끝난 창과 지난 날 솔트 행(늦은 시계의 인스턴스가 자정 뒤 다시 만든 것 포함)을 지운다 */
  async sweep(): Promise<void> {
    const now = this.now();
    await this.db.run('DELETE FROM lim_windows WHERE expires_at <= $1', [now]);
    await this.db.run('DELETE FROM lim_salts WHERE day < $1', [kstDay(now)]);
  }
}

/** 메모리 당일 솔트(단일 인스턴스). 날짜가 바뀌면 새 솔트, 옛 솔트는 0으로 덮고 버린다. */
export class MemoryKeySalt implements KeySalt {
  private day = '';
  private salt: Buffer = Buffer.alloc(0);
  private readonly label: string;
  private readonly now: () => number;
  constructor(label: string, now: () => number) {
    this.label = label;
    this.now = now;
  }
  hash(value: string): Promise<string> {
    const d = kstDay(this.now());
    if (d !== this.day) {
      this.salt.fill(0);
      this.salt = randomBytes(32);
      this.day = d;
    }
    return Promise.resolve(hmacHex(this.salt, this.label, '\u0000', value).slice(0, 32));
  }
}

/**
 * DB 당일 솔트: (label, KST 날짜)마다 무작위 32바이트 한 행. 처음 쓰는 인스턴스가 만들고(동시 생성은 ON CONFLICT DO NOTHING 뒤 다시 읽어 하나로) 모두 같은 행을 쓴다.
 * 날짜가 바뀐 뒤 처음 읽을 때와 1분 sweep에서 지난 날 행을 지운다(자기 날짜보다 앞선 행만). 메모리에는 당일 값만 캐시한다.
 */
export class SqlKeySalt implements KeySalt {
  private cache: { day: string; salt: Buffer } | null = null;
  private readonly db: Sql;
  private readonly label: string;
  private readonly now: () => number;
  constructor(db: Sql, label: string, now: () => number) {
    if (!/^[a-z0-9-]{1,32}$/.test(label)) throw new Error('salt_label');
    this.db = db;
    this.label = label;
    this.now = now;
  }
  private async current(): Promise<Buffer> {
    const day = kstDay(this.now());
    if (this.cache?.day === day) return this.cache.salt;
    this.cache?.salt.fill(0);
    this.cache = null;
    // 자기 날짜보다 **앞선** 행만 지운다. 시계가 조금 늦은 인스턴스가 자정 직후 막 기동해도 다른 인스턴스가 만든 새 날 행을 지우지 않는다
    await this.db.run('DELETE FROM lim_salts WHERE label = $1 AND day < $2', [this.label, day]);
    await this.db.run('INSERT INTO lim_salts (label, day, salt) VALUES ($1, $2, $3) ON CONFLICT (label, day) DO NOTHING', [this.label, day, randomBytes(32)]);
    const r = await this.db.one<{ salt: Buffer | Uint8Array }>('SELECT salt FROM lim_salts WHERE label = $1 AND day = $2', [this.label, day]);
    const salt = Buffer.from(r!.salt);
    this.cache = { day, salt };
    return salt;
  }
  async hash(value: string): Promise<string> {
    return hmacHex(await this.current(), this.label, '\u0000', value).slice(0, 32);
  }
}

/**
 * 계정·기기 ID 한도 키: HMAC(서버 비밀, 용도 ‖ KST 날짜 ‖ 값). 비밀은 환경 변수로만 주입되고 DB에 없다.
 * 날짜가 메시지에 들어가 키가 날마다 바뀐다(DB 카운터 행끼리 날을 넘어 이어지지 않음).
 */
export class SecretKeySalt implements KeySalt {
  private readonly secret: Buffer;
  private readonly label: string;
  private readonly now: () => number;
  constructor(secret: Buffer, label: string, now: () => number) {
    if (secret.length < 32) throw new Error('limit_id_key');
    this.secret = secret;
    this.label = label;
    this.now = now;
  }
  hash(value: string): Promise<string> {
    return Promise.resolve(hmacHex(this.secret, this.label, '\u0000', kstDay(this.now()), '\u0000', value).slice(0, 32));
  }
}

/** 한도 묶음: 카운터 + 키 솔트. DB가 있으면 DB, 없으면 메모리. */
export interface Limits {
  limiter: Limiter;
  /** IP·이메일처럼 계정 밖 식별자: KST 당일 무작위 솔트(DB 행 또는 메모리) */
  salt(label: string): KeySalt;
  /** 계정·기기 ID: 서버 비밀 HMAC(DB에 없는 키) */
  idSalt(label: string): KeySalt;
}

function cached(make: (label: string) => KeySalt): (label: string) => KeySalt {
  const m = new Map<string, KeySalt>();
  return (l) => m.get(l) ?? (m.set(l, make(l)), m.get(l)!);
}

export function sqlLimits(db: Sql, now: () => number, idKey: Buffer): Limits {
  return { limiter: new SqlLimiter(db, now), salt: cached((l) => new SqlKeySalt(db, l, now)), idSalt: cached((l) => new SecretKeySalt(idKey, l, now)) };
}

export function memoryLimits(now: () => number): Limits {
  return { limiter: new MemoryLimiter(now), salt: cached((l) => new MemoryKeySalt(l, now)), idSalt: cached((l) => new MemoryKeySalt(`id-${l}`, now)) };
}
