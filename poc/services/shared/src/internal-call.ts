// 서비스 간 내부 HTTP 호출 서명(팀장 결정 2026-11-06 #135 (1)). 같은 배포 안의 호출은 HTTP 없이 함수로 부르고(cloud 진입점),
// HTTP가 꼭 필요한 곳(함수 ↔ 룸 호스트)만 이 서명을 쓴다. 서명 범위: 메서드·경로(쿼리 포함)·본문 SHA-256·시각(±60초)·1회용 nonce.
// 키는 INTERNAL_CALL_KEY(32바이트 hex, 이름만 env에). 비교는 상수 시간. 실패는 모두 같은 401(어느 단계인지 알려 주지 않는다).
import { randomBytes } from 'node:crypto';
import { b64u, hmac, safeEqual, sha256hex } from './crypto.ts';
import { fail } from './errors.ts';
import type { Ctx } from './http.ts';
import type { Sql } from './sql.ts';

export const INTERNAL_CALL_CONTEXT = 'SAX-internal-call-v1';
/** 허용 시각 차(앞뒤 모두) */
export const INTERNAL_CALL_SKEW_MS = 60_000;
const SCHEME = 'SAX-Internal';

/** 서명 입력: 맥락 ‖ 메서드 ‖ 경로 ‖ sha256hex(본문) ‖ 시각 ‖ nonce (줄바꿈 구분. 경로 변수는 라우터가 안전 문자만 받는다) */
export function internalCallInput(method: string, path: string, body: Buffer | string, ts: number, nonce: string): string {
  return [INTERNAL_CALL_CONTEXT, method.toUpperCase(), path, sha256hex(body), String(ts), nonce].join('\n');
}

/** 1회용 nonce 저장소. 처음 보는 값이면 true(그리고 기록), 이미 쓴 값이면 false */
export interface NonceStore {
  claim(nonce: string, expiresAt: number, now: number): Promise<boolean>;
}

/** 한 프로세스 안에서만 1회용(시험·단일 인스턴스용) */
export class MemoryNonceStore implements NonceStore {
  private readonly seen = new Map<string, number>();
  async claim(nonce: string, expiresAt: number, now: number): Promise<boolean> {
    for (const [k, exp] of this.seen) if (exp <= now) this.seen.delete(k);
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, expiresAt);
    return true;
  }
}

/** DB 기록(여러 인스턴스가 같은 nonce를 두 번 받지 않는다). 표는 shared/migrations/002_internal_nonces.sql(한도 스키마) */
export class SqlNonceStore implements NonceStore {
  private readonly db: Sql;
  constructor(db: Sql) {
    this.db = db;
  }
  async claim(nonce: string, expiresAt: number, now: number): Promise<boolean> {
    await this.db.run('DELETE FROM int_nonces WHERE expires_at <= $1', [now]);
    return (await this.db.run('INSERT INTO int_nonces (nonce, expires_at) VALUES ($1, $2) ON CONFLICT (nonce) DO NOTHING', [nonce, expiresAt])) === 1;
  }
}

/** 받는 쪽: 내부 경로 처리기 첫 줄에서 `await internal.check(ctx)`. 내부 경로는 원문 본문을 보존해야 한다(라우트 옵션 raw: true). */
export interface InternalCheck {
  check(ctx: Pick<Ctx, 'method' | 'path' | 'query' | 'headers' | 'rawBody'>): Promise<void>;
}

export class InternalAuth implements InternalCheck {
  private readonly key: Buffer;
  private readonly nonces: NonceStore;
  private readonly now: () => number;
  constructor(o: { key: Buffer; nonces: NonceStore; now?: () => number }) {
    if (o.key.length < 32) throw new Error('config_INTERNAL_CALL_KEY');
    this.key = o.key;
    this.nonces = o.nonces;
    this.now = o.now ?? Date.now;
  }

  async check(ctx: Pick<Ctx, 'method' | 'path' | 'query' | 'headers' | 'rawBody'>): Promise<void> {
    const m = /^SAX-Internal ts=([0-9]{13}),nonce=([A-Za-z0-9_-]{22}),sig=([A-Za-z0-9_-]{43})$/.exec(String(ctx.headers.authorization ?? ''));
    if (!m) fail('account.unauthorized');
    const [, tsStr, nonce, sig] = m!;
    const ts = Number(tsStr);
    const now = this.now();
    if (Math.abs(now - ts) > INTERNAL_CALL_SKEW_MS) fail('account.unauthorized');
    const q = ctx.query.toString();
    const want = b64u(hmac(this.key, internalCallInput(ctx.method, q ? `${ctx.path}?${q}` : ctx.path, ctx.rawBody, ts, nonce!)));
    if (!safeEqual(want, sig!)) fail('account.unauthorized');
    // 서명이 맞은 뒤에만 nonce를 기록한다(서명 없는 요청으로 표를 채울 수 없게). 창이 끝난 뒤까지 둔다
    if (!(await this.nonces.claim(nonce!, ts + INTERNAL_CALL_SKEW_MS + 1, now))) fail('account.unauthorized');
  }
}

/** 보내는 쪽: `Authorization: SAX-Internal ts=…,nonce=…,sig=…` 값 */
export function signInternalCall(key: Buffer, method: string, path: string, body: Buffer | string = '', now = Date.now()): string {
  const nonce = b64u(randomBytes(16));
  return `${SCHEME} ts=${now},nonce=${nonce},sig=${b64u(hmac(key, internalCallInput(method, path, body, now, nonce)))}`;
}

/**
 * 내부 HTTP 클라이언트. 서명하는 경로는 받는 서비스가 보는 경로(`/internal/…`)다. base에 붙은 접두(`/api/internal` 등 재작성 규칙)는 서명에 넣지 않는다.
 * 리디렉션은 따라가지 않고, 기본 5초에서 끊는다. fetch는 주입한다(송신이 한 곳에 모이게).
 */
export class InternalClient {
  private readonly base: string;
  private readonly key: Buffer;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  constructor(o: { base: string; key: Buffer; fetchFn?: typeof fetch; now?: () => number; timeoutMs?: number }) {
    if (!/^https?:\/\/[^/?#]+(\/[^?#]*)?$/.test(o.base)) throw new Error('config_internal_base');
    this.base = o.base.replace(/\/$/, '');
    this.key = o.key;
    this.fetchFn = o.fetchFn ?? fetch;
    this.now = o.now ?? Date.now;
    this.timeoutMs = o.timeoutMs ?? 5000;
  }

  request(method: 'GET' | 'POST', path: string, json?: unknown, timeoutMs = this.timeoutMs): Promise<Response> {
    if (!path.startsWith('/internal/')) throw new Error('internal_path');
    const body = json === undefined ? '' : JSON.stringify(json);
    const headers: Record<string, string> = { authorization: signInternalCall(this.key, method, path, body, this.now()) };
    if (body) headers['content-type'] = 'application/json';
    return this.fetchFn(`${this.base}${path}`, { method, headers, body: body || undefined, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  }
}
