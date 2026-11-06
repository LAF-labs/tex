// 내부 호출 서명(INTERNAL_CALL_KEY HMAC, 팀장 결정 2026-11-06 #135 (1)): 서명 범위(메서드·경로·본문 해시·시각·nonce), ±60초, 1회용, 상수 시간 비교.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { INTERNAL_CALL_SKEW_MS, InternalAuth, InternalClient, LIMITS_MIGRATIONS_DIR, MemoryNonceStore, ServiceError, SqlNonceStore, migrate, openSqlite, signInternalCall } from '../services/shared/src/index.ts';

const key = randomBytes(32);
const T = Date.UTC(2026, 10, 6, 0, 0, 0);
const ctx = (method: string, path: string, body: string, authorization?: string) => {
  const u = new URL(path, 'http://x');
  return { method, path: u.pathname, query: u.searchParams, headers: { authorization }, rawBody: Buffer.from(body) };
};
const code = async (p: Promise<void>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof ServiceError ? `${e.status} ${e.code}` : String(e);
  }
};

describe('내부 호출 서명', () => {
  it('서명 범위 밖 변경은 모두 401: 메서드·경로·쿼리·본문·키·형식', async () => {
    const auth = new InternalAuth({ key, nonces: new MemoryNonceStore(), now: () => T });
    const path = '/internal/v1/rooms/r1/redeem';
    const body = JSON.stringify({ deviceId: 'd1' });
    const sig = () => signInternalCall(key, 'POST', path, body, T);
    assert.equal(await code(auth.check(ctx('POST', path, body))), '401 account.unauthorized', '서명 없음');
    assert.equal(await code(auth.check(ctx('POST', path, body, 'Internal old-shared-secret'))), '401 account.unauthorized', '옛 공유 비밀 형식');
    assert.equal(await code(auth.check(ctx('GET', path, body, sig()))), '401 account.unauthorized', '메서드');
    assert.equal(await code(auth.check(ctx('POST', '/internal/v1/rooms/r2/redeem', body, sig()))), '401 account.unauthorized', '경로');
    assert.equal(await code(auth.check(ctx('POST', `${path}?x=1`, body, sig()))), '401 account.unauthorized', '쿼리');
    assert.equal(await code(auth.check(ctx('POST', path, JSON.stringify({ deviceId: 'd2' }), sig()))), '401 account.unauthorized', '본문');
    assert.equal(await code(auth.check(ctx('POST', path, body, signInternalCall(randomBytes(32), 'POST', path, body, T)))), '401 account.unauthorized', '다른 키');
    assert.equal(await code(auth.check(ctx('POST', path, body, `${sig()}x`))), '401 account.unauthorized', '형식');
    assert.equal(await code(auth.check(ctx('POST', path, body, sig()))), 'ok');
    assert.equal(await code(auth.check(ctx('POST', `${path}?a=1`, body, signInternalCall(key, 'POST', `${path}?a=1`, body, T)))), 'ok', '쿼리도 서명 범위');
  });

  it('시각은 앞뒤 60초까지만, nonce는 한 번만(서명이 틀린 요청은 nonce를 쓰지 않는다)', async () => {
    let now = T;
    const auth = new InternalAuth({ key, nonces: new MemoryNonceStore(), now: () => now });
    const p = '/internal/v1/devices/d1';
    assert.equal(await code(auth.check(ctx('GET', p, '', signInternalCall(key, 'GET', p, '', T - INTERNAL_CALL_SKEW_MS - 1)))), '401 account.unauthorized', '오래된 ts');
    assert.equal(await code(auth.check(ctx('GET', p, '', signInternalCall(key, 'GET', p, '', T + INTERNAL_CALL_SKEW_MS + 1)))), '401 account.unauthorized', '미래 ts');
    assert.equal(await code(auth.check(ctx('GET', p, '', signInternalCall(key, 'GET', p, '', T - INTERNAL_CALL_SKEW_MS)))), 'ok', '경계 -60초');
    const sig = signInternalCall(key, 'GET', p, '', T);
    // 같은 nonce에 다른 서명(위조)은 401이고 nonce를 태우지 않는다 → 진짜 요청은 통과
    const forged = sig.replace(/sig=.*/, `sig=${'A'.repeat(43)}`);
    assert.equal(await code(auth.check(ctx('GET', p, '', forged))), '401 account.unauthorized');
    assert.equal(await code(auth.check(ctx('GET', p, '', sig))), 'ok');
    assert.equal(await code(auth.check(ctx('GET', p, '', sig))), '401 account.unauthorized', '재전송');
    now = T + INTERNAL_CALL_SKEW_MS + 2; // 창이 지나면 nonce 기록은 지워져도 시각 검사가 막는다
    assert.equal(await code(auth.check(ctx('GET', p, '', sig))), '401 account.unauthorized', '창 밖 재전송');
  });

  it('DB nonce 저장소는 인스턴스 사이에서 1회용이고 만료 행을 지운다', async () => {
    const db = openSqlite();
    await migrate(db, 'limits', LIMITS_MIGRATIONS_DIR);
    const a = new InternalAuth({ key, nonces: new SqlNonceStore(db), now: () => T });
    const b = new InternalAuth({ key, nonces: new SqlNonceStore(db), now: () => T });
    const p = '/internal/v1/devices/d1';
    const sig = signInternalCall(key, 'GET', p, '', T);
    assert.equal(await code(a.check(ctx('GET', p, '', sig))), 'ok');
    assert.equal(await code(b.check(ctx('GET', p, '', sig))), '401 account.unauthorized');
    const later = new SqlNonceStore(db);
    assert.equal(await later.claim('fresh-nonce-000000000a', T + 10, T + INTERNAL_CALL_SKEW_MS + 2), true);
    assert.deepEqual((await db.all<{ nonce: string }>('SELECT nonce FROM int_nonces')).map((r) => r.nonce), ['fresh-nonce-000000000a']);
    await db.close();
  });

  it('클라이언트는 /internal 경로만 서명해 보내고, 받는 서비스가 보는 경로(재작성 접두 제외)를 서명한다. 리디렉션은 따르지 않는다', async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => (sent.push({ url, init }), new Response('{}', { status: 200 }))) as unknown as typeof fetch;
    const c = new InternalClient({ base: 'https://tax.test.invalid/api/internal', key, fetchFn, now: () => T });
    await c.request('GET', '/internal/v1/devices/d1');
    assert.equal(sent[0]!.url, 'https://tax.test.invalid/api/internal/internal/v1/devices/d1');
    assert.equal(sent[0]!.init.redirect, 'error');
    const auth = new InternalAuth({ key, nonces: new MemoryNonceStore(), now: () => T });
    const h = sent[0]!.init.headers as Record<string, string>;
    assert.equal(await code(auth.check(ctx('GET', '/internal/v1/devices/d1', '', h.authorization))), 'ok');
    assert.throws(() => c.request('GET', '/v1/me'), /internal_path/);
    assert.throws(() => new InternalClient({ base: 'tax.test.invalid', key }), /config_internal_base/);
    assert.throws(() => new InternalAuth({ key: randomBytes(16), nonces: new MemoryNonceStore() }), /config_INTERNAL_CALL_KEY/);
  });
});
