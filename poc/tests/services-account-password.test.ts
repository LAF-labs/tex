// ADR-038 이메일·비밀번호 로그인과 자동 로그인(D09 §2.1·§10): 정책·해시·잠금·열거 방지·재설정·갱신 토큰 회전과 재사용 감지.
// DB는 node:sqlite 메모리, 메일은 모의. argon2id는 실제(Node 내장, m=64MiB) — 해시 수를 줄이려 잠금은 서비스 함수로 시험한다.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Logger, ServiceError, TokenIssuer, TokenVerifier, createServer, ed25519RawPublic, listen, looksSensitive, migrate, openSqlite, type Sql } from '../services/shared/src/index.ts';
import {
  ACCOUNT,
  AccountService,
  ARGON2ID,
  COMMON_PASSWORDS_FILE,
  CommonPasswords,
  HashGate,
  MIGRATIONS_DIR,
  MockMailSender,
  MockPaymentGateway,
  NOTICE,
  PASSWORD,
  PasswordHasher,
  accountRouter,
  argon2Available,
  buildAccount,
  checkPasswordPolicy,
  parsePepperKeys,
  withFloor,
  type NoticeKind,
  type PasswordDeps,
} from '../services/account/src/index.ts';

/** 알림 발송이 실패·지연되는 메일(실제 어댑터의 장애 흉내). 코드 메일은 그대로 */
class FlakyMail extends MockMailSender {
  failNotices = 0;
  /** 다시 보내도 같은 실패(어댑터의 retryable === false, 예: SES 주소 거부·설정 오류) */
  finalFail = false;
  hold: Promise<void> | null = null;
  calls = 0;
  failResets = 0;
  override async sendResetCode(to: string, code: string): Promise<void> {
    this.calls++;
    if (this.hold) await this.hold;
    if (this.failResets > 0) {
      this.failResets--;
      throw new Error('mail down');
    }
    return super.sendResetCode(to, code);
  }
  override async sendNotice(to: string, kind: NoticeKind): Promise<void> {
    this.calls++;
    if (this.hold) await this.hold;
    if (this.finalFail) throw Object.assign(new Error('mail.rejected'), { retryable: false });
    if (this.failNotices > 0) {
      this.failNotices--;
      throw new Error('mail down');
    }
    return super.sendNotice(to, kind);
  }
}
import { fileURLToPath } from 'node:url';
import { Clock, D, H, client, edKey, internalAuth } from './services-kit.ts';

const ORIGIN = 'https://account.test.invalid';
const RP = { rpId: 'account.test.invalid', origins: [ORIGIN] };
const hex32 = () => randomBytes(32).toString('hex');
const K1 = `k1:${hex32()}`;
const K2 = `k2:${hex32()}`;
const GOOD = 'correct horse battery staple';
const GOOD2 = 'another long passphrase 7';

const common = CommonPasswords.fromFile(fileURLToPath(COMMON_PASSWORDS_FILE));
const pwDeps = (keys = K1, events: string[] = []): PasswordDeps => ({ hasher: new PasswordHasher(parsePepperKeys(keys)!), common, onEvent: (n) => void events.push(n) });

interface Env {
  clock: Clock;
  db: Sql;
  mail: MockMailSender;
  svc: AccountService;
  server: Server;
  req: ReturnType<typeof client>;
  logs: string[];
  events: string[];
  /** 계정 서비스 이벤트(onEvent: 알림 큐 등) */
  svcEvents: string[];
  /** 응답과 따로 돌린 일(알림 큐 즉시 발송)을 모두 기다린다 */
  flush(): Promise<void>;
}

async function start(o: { passwords?: boolean; db?: Sql; keys?: string; clock?: Clock; mail?: MockMailSender } = {}): Promise<Env> {
  const clock = o.clock ?? new Clock();
  const db = o.db ?? openSqlite();
  await migrate(db, 'account', MIGRATIONS_DIR);
  const mail = o.mail ?? new MockMailSender();
  const deferred: Array<() => Promise<void>> = [];
  const svcEvents: string[] = [];
  const signKey = edKey().priv;
  const events: string[] = [];
  const svc = new AccountService({
    db,
    mail,
    payments: new MockPaymentGateway(),
    tokens: new TokenIssuer('k1', signKey),
    codeMacKey: Buffer.alloc(32, 7),
    rp: RP,
    publicOrigin: ORIGIN,
    billingReturnUrl: 'https://app.test.invalid/billing/done',
    passwords: o.passwords === false ? undefined : pwDeps(o.keys, events),
    onEvent: (n) => void svcEvents.push(n),
    defer: (t) => void deferred.push(t),
    now: clock.now,
  });
  const flush = async () => {
    while (deferred.length) await deferred.shift()!();
  };
  const logs: string[] = [];
  const router = accountRouter({ svc, verifier: new TokenVerifier({ k1: ed25519RawPublic(signKey) }), publicOrigin: ORIGIN, internal: internalAuth() });
  const server = createServer(router, { logger: new Logger('account', (l) => logs.push(l), clock.now) });
  return { clock, db, mail, svc, server, req: client(await listen(server)), logs, events, svcEvents, flush };
}

const bearer = (s: string) => ({ authorization: `Bearer ${s}` });

async function codeLogin(e: Env, email: string, remember = false): Promise<{ session: string; refreshToken?: string }> {
  const s = await e.req('POST', '/v1/auth/code', { body: { email } });
  const v = await e.req('POST', '/v1/auth/code/verify', { body: { loginId: s.json.loginId, code: e.mail.lastCode(email), ...(remember ? { remember: true } : {}) } });
  assert.equal(v.status, 200, v.text);
  return { session: v.json.session as string, refreshToken: v.json.refreshToken as string | undefined };
}

async function withPassword(e: Env, email: string, pw = GOOD): Promise<string> {
  const { session } = await codeLogin(e, email);
  const r = await e.req('PUT', '/v1/password', { headers: bearer(session), body: { password: pw } });
  assert.equal(r.status, 204, r.text);
  await e.flush(); // 설정 알림(password_set)은 발송 큐로 간다
  return session;
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (err) {
    assert.ok(err instanceof ServiceError, String(err));
    return (err as ServiceError).code;
  }
};

describe('ADR-038 정책·해시', () => {
  it('길이는 NFKC 뒤 코드 포인트 10~128, 이메일·로컬 부분·서비스명 포함 거부, 흔한 목록 거부, 구성 규칙은 강제하지 않음', () => {
    const check = (pw: string, email = 'kim@example.com') => {
      try {
        checkPasswordPolicy(pw, email, common);
        return 'ok';
      } catch (err) {
        return (err as ServiceError).code;
      }
    };
    assert.equal(check('a'.repeat(9)), 'account.password_too_short');
    assert.equal(check('lanternfjord'), 'ok', '소문자만 10자 이상도 된다');
    assert.equal(check('abcdefghij'), 'account.password_breached');
    assert.equal(check('가'.repeat(10)), 'ok', '한글 10자(코드 포인트)');
    assert.equal(check('😀'.repeat(10)), 'ok', '이모지는 UTF-16 길이가 아니라 코드 포인트로 센다');
    assert.equal(check('xy'.repeat(64)), 'ok');
    assert.equal(check('x'.repeat(129)), 'account.password_too_long');
    // 전각 → 반각(NFKC): 같은 비밀번호로 본다
    assert.equal(check('ｋｉｍ-secret-pass'), 'account.password_contains_identity');
    assert.equal(check('xx KIM@EXAMPLE.COM yy'), 'account.password_contains_identity');
    assert.equal(check('my SovereignAX pass'), 'account.password_contains_identity');
    assert.equal(check('소버린비밀번호입니다요'), 'account.password_contains_identity');
    assert.equal(check('ab-secret-pass', 'ab@example.com'), 'ok', '로컬 부분이 3자 미만이면 보지 않는다');
    assert.equal(check('1234567890'), 'account.password_breached');
    assert.equal(check('1Q2W3E4R5T'), 'account.password_breached', '대소문자 무시');
    assert.equal(common.size, 96_525, '10만 줄 → NFKC 소문자 중복 제거');
  });

  it('흔한 목록은 SecLists 커밋 고정본(원본 그대로 gzip): 풀면 기록한 SHA-256(data/README.md)', () => {
    const raw = gunzipSync(fs.readFileSync(fileURLToPath(COMMON_PASSWORDS_FILE)));
    assert.equal(createHash('sha256').update(raw).digest('hex'), 'e30e15faecc8db2d3181c3126e3b2c0cd5c187af10a5e4e83babfa157edab188');
    assert.equal(raw.length, 781_959);
  });

  it('PASSWORD_PEPPER_KEYS 형식: kid:hex64 목록, 첫 키가 현재 키, 중복·형식 오류는 기동 거부', () => {
    assert.equal(parsePepperKeys(undefined), null);
    assert.equal(parsePepperKeys(''), null);
    const p = parsePepperKeys(`${K2},${K1}`)!;
    assert.equal(p.current, 'k2');
    assert.deepEqual([...p.keys.keys()], ['k2', 'k1']);
    for (const bad of ['k1', 'k1:abcd', `${K1},${K1}`, `k 1:${hex32()}`, `${K1},`]) assert.throws(() => parsePepperKeys(bad), /config_PASSWORD_PEPPER_KEYS/, bad);
  });

  it('argon2id(m=64MiB,t=3,p=1) + 페퍼: 저장값에 평문·페퍼가 없고, 다른 페퍼로는 맞지 않으며, 옛 키로 맞으면 재해시', { skip: !argon2Available() }, async () => {
    const pepper = parsePepperKeys(K1)!;
    const h1 = new PasswordHasher(pepper);
    const s = await h1.hash(GOOD);
    assert.equal(s.params, `a2id-v1:m${ARGON2ID.memoryKiB}:t3:p1:kk1`);
    assert.equal(ARGON2ID.memoryKiB, 65_536);
    assert.equal(Buffer.from(s.hash, 'base64url').length, 32);
    assert.equal(Buffer.from(s.salt, 'base64url').length, 16);
    const blob = JSON.stringify(s);
    assert.ok(!blob.includes(GOOD) && !blob.includes(pepper.keys.get('k1')!.toString('hex')));
    assert.notEqual((await h1.hash(GOOD)).hash, s.hash, '솔트가 계정·설정마다 다르다');
    assert.deepEqual(await h1.verify(GOOD, s), { ok: true, needsRehash: false });
    assert.deepEqual(await h1.verify(GOOD + ' ', s), { ok: false, needsRehash: false });
    assert.deepEqual(await h1.verify('ｃｏｒｒｅｃｔ horse battery staple', s), { ok: true, needsRehash: false }, 'NFKC 뒤 같은 입력');
    assert.deepEqual(await h1.verify(GOOD, null), { ok: false, needsRehash: false }, '없는 계정은 더미로 같은 일');
    // 같은 kid, 다른 페퍼 값(DB만 유출된 상황): 맞지 않는다
    assert.equal((await new PasswordHasher(parsePepperKeys(`k1:${hex32()}`)!).verify(GOOD, s)).ok, false);
    // 회전: 새 키가 현재, 옛 키는 검증만 → 맞으면 재해시 신호
    const h2 = new PasswordHasher(parsePepperKeys(`${K2},${K1}`)!);
    assert.deepEqual(await h2.verify(GOOD, s), { ok: true, needsRehash: true });
    // 옛 키를 뺐으면(모르는 kid) 더미로 돌고 실패
    assert.equal((await new PasswordHasher(parsePepperKeys(K2)!).verify(GOOD, s)).ok, false);
    // 검증은 레코드의 비용으로 한다: 다른 비용이면 다른 출력, 상한 밖·모르는 형식은 더미로 돌고 실패
    assert.equal((await h1.verify(GOOD, { ...s, params: 'a2id-v1:m32768:t3:p1:k1' })).ok, false);
    assert.equal((await h1.verify(GOOD, { ...s, params: 'a2id-v1:m9999999:t3:p1:k1' })).ok, false);
    assert.equal((await h1.verify(GOOD, { ...s, params: 'bcrypt' })).ok, false);
  });

  it('동시 해시 상한 + 대기 줄 상한(넘으면 429 policy.rate_limited)', async () => {
    const g = new HashGate(1, 1);
    let release!: () => void;
    const first = g.run(() => new Promise<void>((ok) => (release = ok)));
    const second = g.run(async () => 2);
    assert.equal(await code(g.run(async () => 3)), 'policy.rate_limited');
    release();
    await first;
    assert.equal(await second, 2);
    assert.equal(await g.run(async () => 4), 4);
  });

  it('응답 시각 하한: 성공·실패 모두 같은 하한까지 기다리고 실패는 그 뒤에 던진다', async () => {
    const waited: number[] = [];
    const sleep = async (ms: number) => void waited.push(ms);
    assert.equal(await withFloor(700, async () => 1, sleep), 1);
    await assert.rejects(withFloor(700, async () => Promise.reject(new Error('x')), sleep), /x/);
    assert.equal(waited.length, 2);
    for (const w of waited) assert.ok(w > 690 && w <= 700, String(w));
  });
});

describe('ADR-038 비밀번호 로그인', { skip: !argon2Available() }, () => {
  let e: Env;
  beforeEach(async () => (e = await start()));
  afterEach(() => e.server.close());

  it('구성되지 않으면 비밀번호 경로는 404, 다른 로그인은 그대로', async () => {
    const off = await start({ passwords: false });
    try {
      const { session } = await codeLogin(off, 'off@example.com');
      assert.equal((await off.req('POST', '/v1/auth/password', { body: { email: 'off@example.com', password: GOOD } })).status, 404);
      assert.equal((await off.req('PUT', '/v1/password', { headers: bearer(session), body: { password: GOOD } })).status, 404);
      assert.equal((await off.req('POST', '/v1/auth/password/reset', { body: { email: 'off@example.com' } })).status, 404);
      assert.equal((await off.req('GET', '/v1/me', { headers: bearer(session) })).status, 200);
    } finally {
      off.server.close();
    }
  });

  it('설정(최근 로그인 세션) → 비밀번호 로그인 → authMethod password, 설정 알림 메일, DB에 평문 없음', async () => {
    const s = await withPassword(e, 'pw@example.com');
    assert.ok(e.mail.outbox.some((m) => m.to === 'pw@example.com' && m.kind === 'password_set'));
    const r = await e.req('POST', '/v1/auth/password', { body: { email: 'PW@example.com ', password: GOOD } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.expiresInSec, 3600);
    assert.equal(r.json.refreshToken, undefined);
    assert.equal((await e.req('GET', '/v1/me', { headers: bearer(r.json.session as string) })).json.authMethod, 'password');
    const row = (await e.db.one<Record<string, unknown>>('SELECT * FROM pw_creds'))!;
    assert.ok(!JSON.stringify(row).includes(GOOD));
    assert.match(String(row.params), /^a2id-v1:m65536:t3:p1:kk1$/);
    // 정책은 서버가 판정
    assert.equal((await e.req('PUT', '/v1/password', { headers: bearer(s), body: { password: 'short', currentPassword: GOOD } })).json.error, 'account.password_too_short');
    assert.equal((await e.req('PUT', '/v1/password', { headers: bearer(s), body: { password: '1234567890', currentPassword: GOOD } })).json.error, 'account.password_breached');
    assert.equal((await e.req('PUT', '/v1/password', { headers: bearer(s), body: { password: 'xx pw@example.com yy', currentPassword: GOOD } })).json.error, 'account.password_contains_identity');
    assert.equal((await e.req('PUT', '/v1/password', { headers: bearer(s), body: { password: GOOD, extra: 1 } })).status, 400);
    assert.equal((await e.req('PUT', '/v1/password', { body: { password: GOOD } })).json.error, 'account.unauthorized');
    for (const l of e.logs) assert.ok(!looksSensitive(l) && !l.includes(GOOD), l);
  });

  it('만들기·삭제는 10분 안의 코드·패스키·비밀번호 로그인만. 갱신 세션과 루프백 교환으로는 최근 로그인을 새로 만들지 못한다', async () => {
    const { session, refreshToken } = await codeLogin(e, 'reauth@example.com', true);
    e.clock.advance(PASSWORD.reauthMaxAgeMs + 1);
    assert.equal((await e.req('PUT', '/v1/password', { headers: bearer(session), body: { password: GOOD } })).json.error, 'account.reauth_required');
    const rf = await e.req('POST', '/v1/auth/refresh', { body: { refreshToken } });
    assert.equal(rf.status, 200);
    assert.equal((await e.req('PUT', '/v1/password', { headers: bearer(rf.json.session as string), body: { password: GOOD } })).json.error, 'account.reauth_required', '갱신 세션');
    // 9분 된 세션으로 루프백 인가 → 교환 세션은 원래 인증 시각을 잇는다
    const fresh = (await codeLogin(e, 'reauth@example.com')).session;
    e.clock.advance(9 * 60_000);
    const verifier = randomBytes(32).toString('base64url');
    const a = await e.req('POST', '/v1/oauth/authorize', {
      headers: bearer(fresh),
      body: { client_id: 'sax-desktop', redirect_uri: 'http://127.0.0.1:51234/cb', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state: randomBytes(16).toString('base64url') },
    });
    const t = await e.req('POST', '/v1/oauth/token', { body: { grant_type: 'authorization_code', code: new URL(a.json.redirect as string).searchParams.get('code'), code_verifier: verifier, redirect_uri: 'http://127.0.0.1:51234/cb', client_id: 'sax-desktop' } });
    assert.equal(t.status, 200, t.text);
    e.clock.advance(2 * 60_000);
    assert.equal((await e.req('PUT', '/v1/password', { headers: bearer(t.json.session as string), body: { password: GOOD } })).json.error, 'account.reauth_required', '교환 세션');
    const now = (await codeLogin(e, 'reauth@example.com')).session;
    assert.equal((await e.req('PUT', '/v1/password', { headers: bearer(now), body: { password: GOOD } })).status, 204);
    assert.equal((await e.req('DELETE', '/v1/password', { headers: bearer(now) })).status, 204);
    assert.equal(await e.db.one('SELECT 1 AS x FROM pw_creds'), undefined);
  });

  it('열거 방지: 없는 이메일·비밀번호 없는 계정·틀림·잠금은 같은 상태·본문이고 모두 하한(700ms) 뒤에 온다', async () => {
    await withPassword(e, 'en@example.com');
    await codeLogin(e, 'nopw@example.com');
    // 잠금 계정
    await withPassword(e, 'lock@example.com');
    for (let i = 0; i < PASSWORD.maxFails; i++) await code(e.svc.passwordLogin('lock@example.com', 'wrong password ' + i));
    let verifies = 0;
    const hasher = (e.svc as unknown as { d: { passwords: PasswordDeps } }).d.passwords.hasher;
    const orig = hasher.verify.bind(hasher);
    hasher.verify = async (...a) => (verifies++, orig(...a));
    const cases = [
      { email: 'ghost@example.com', password: GOOD },
      { email: 'nopw@example.com', password: GOOD },
      { email: 'en@example.com', password: 'wrong but long' },
      { email: 'lock@example.com', password: GOOD },
    ];
    const seen = new Set<string>();
    for (const c of cases) {
      const t0 = performance.now();
      const r = await e.req('POST', '/v1/auth/password', { body: c });
      const ms = performance.now() - t0;
      assert.equal(r.status, 401, c.email);
      seen.add(r.text);
      assert.ok(ms >= PASSWORD.responseFloorMs - 5, `${c.email} ${ms}ms`);
    }
    assert.equal(seen.size, 1, [...seen].join(' | '));
    assert.deepEqual(JSON.parse([...seen][0]!), { error: 'account.credentials_invalid' });
    assert.equal(verifies, cases.length, '모든 경우에 argon2id를 한 번 돈다(더미 포함)');
    // 재설정 요청도 계정 유무와 같은 모양
    const r1 = await e.req('POST', '/v1/auth/password/reset', { body: { email: 'ghost@example.com' } });
    const r2 = await e.req('POST', '/v1/auth/password/reset', { body: { email: 'en@example.com' } });
    assert.equal(r1.status, 200);
    assert.deepEqual(Object.keys(r1.json).sort(), Object.keys(r2.json).sort());
    await e.flush();
    assert.equal(e.mail.lastResetCode('ghost@example.com'), undefined);
    assert.ok(e.mail.lastResetCode('en@example.com'));
  });

  it('계정당 5회 연속 실패 → 15분 잠금(맞아도 실패), 잠금 알림 1회, 다음 잠금은 30분, 코드 로그인은 그대로', async () => {
    await withPassword(e, 'lk@example.com');
    const login = (pw: string) => code(e.svc.passwordLogin('lk@example.com', pw));
    for (let i = 0; i < 4; i++) assert.equal(await login('nope nope ' + i), 'account.credentials_invalid');
    assert.equal(await login(GOOD), 'ok', '성공하면 실패 수가 0으로');
    for (let i = 0; i < 5; i++) assert.equal(await login('nope nope ' + i), 'account.credentials_invalid');
    assert.equal(await login(GOOD), 'account.credentials_invalid', '잠금 중에는 맞아도 같은 실패');
    assert.equal(await login('nope again'), 'account.credentials_invalid');
    // 알림은 응답 경로에서 보내지 않는다: 큐에 하나, 응답 뒤 일이 돌아야 메일이 나간다
    assert.equal(e.mail.outbox.filter((m) => m.kind === 'password_locked').length, 0);
    assert.equal((await e.db.all('SELECT * FROM notice_outbox')).length, 1);
    await e.flush();
    assert.equal(e.mail.outbox.filter((m) => m.kind === 'password_locked').length, 1);
    assert.equal((await e.db.all('SELECT * FROM notice_outbox')).length, 0);
    assert.deepEqual(e.events.filter((x) => x === 'account.password_locked'), ['account.password_locked']);
    // 잠금은 비밀번호 수단만
    await codeLogin(e, 'lk@example.com');
    e.clock.advance(15 * 60_000 - 1);
    assert.equal(await login(GOOD), 'account.credentials_invalid');
    e.clock.advance(1);
    for (let i = 0; i < 5; i++) await login('nope nope ' + i);
    await e.flush();
    assert.equal(e.mail.outbox.filter((m) => m.kind === 'password_locked').length, 2);
    e.clock.advance(30 * 60_000 - 1);
    assert.equal(await login(GOOD), 'account.credentials_invalid', '두 번째 잠금은 30분');
    e.clock.advance(1);
    assert.equal(await login(GOOD), 'ok');
    assert.equal(await e.db.one('SELECT 1 AS x FROM pw_locks'), undefined, '성공하면 잠금 단계도 지운다');
    // 상한 24시간
    const acc = (await e.db.one<{ id: string }>('SELECT id FROM accounts WHERE email = $1', ['lk@example.com']))!.id;
    await e.db.run('INSERT INTO pw_locks (account_id, fails, locked_until, lock_level, updated_at) VALUES ($1, 4, NULL, 20, $2)', [acc, e.clock.now()]);
    await login('nope');
    const l = (await e.db.one<{ locked_until: number }>('SELECT locked_until FROM pw_locks WHERE account_id = $1', [acc]))!;
    assert.equal(Number(l.locked_until) - e.clock.now(), 24 * H);
    // 하루 조용하면 정리
    e.clock.advance(PASSWORD.lockDecayMs + 1);
    await e.svc.sweep();
    assert.equal(await e.db.one('SELECT 1 AS x FROM pw_locks'), undefined);
  });

  it('잠금 알림 발송 큐: 메일이 멈추거나 실패해도 로그인 응답은 같은 401·같은 하한, 알림은 사라지지 않고 정리 때 다시 보낸다', async () => {
    const mail = new FlakyMail();
    const f = await start({ mail });
    try {
      await withPassword(f, 'q@example.com');
      mail.calls = 0; // 설정 알림(password_set)은 세지 않는다
      const pwReq = () => f.req('POST', '/v1/auth/password', { body: { email: 'q@example.com', password: 'nope nope x' } });
      for (let i = 0; i < 4; i++) assert.equal((await pwReq()).status, 401);
      // 다섯 번째(잠금): 메일이 영영 응답하지 않아도 응답은 하한 근처에서 같은 401이다
      let release!: () => void;
      mail.hold = new Promise<void>((ok) => (release = ok));
      mail.failNotices = 1;
      const t0 = performance.now();
      const r = await pwReq();
      const ms = performance.now() - t0;
      assert.deepEqual([r.status, r.json], [401, { error: 'account.credentials_invalid' }]);
      assert.ok(ms < PASSWORD.responseFloorMs + 400, `${ms}ms`);
      assert.equal(mail.calls, 0, '응답 경로에서 메일을 부르지 않는다');
      // 응답 뒤 일: 메일 실패 → 행은 남고 5분 뒤로
      const run = f.flush();
      release();
      await run;
      assert.equal(mail.calls, 1);
      const row = (await f.db.one<{ attempts: number; next_at: number }>('SELECT attempts, next_at FROM notice_outbox'))!;
      assert.deepEqual([Number(row.attempts), Number(row.next_at) - f.clock.now()], [1, NOTICE.retryBaseMs]);
      assert.ok(f.svcEvents.includes('account.notice_retry.password_locked'));
      // 기한 전 정리는 보내지 않고, 기한이 지나면 정리(cron)가 보낸다
      mail.hold = null;
      await f.svc.sweep();
      assert.equal(mail.outbox.filter((m) => m.kind === 'password_locked').length, 0);
      f.clock.advance(NOTICE.retryBaseMs);
      await f.svc.sweep();
      assert.deepEqual(mail.outbox.filter((m) => m.kind === 'password_locked').map((m) => m.to), ['q@example.com']);
      assert.equal((await f.db.all('SELECT * FROM notice_outbox')).length, 0);
      assert.ok(f.svcEvents.includes('account.notice_sent.password_locked'));
      // 이벤트는 이름·종류만(주소·ID 없음)
      for (const ev of f.svcEvents) assert.ok(!ev.includes('@') && !looksSensitive(ev), ev);
    } finally {
      f.server.close();
    }
  });

  it('발송 큐: 동시에 도는 두 처리자도 한 번만 보내고, 계속 실패하면 상한(8회) 뒤 버린다, 다시 보내도 같은 실패는 바로 버린다, 계정을 지우면 행도 지운다', async () => {
    const mail = new FlakyMail();
    const f = await start({ mail });
    try {
      await withPassword(f, 'c@example.com');
      mail.calls = 0; // 설정 알림(password_set)은 세지 않는다
      for (let i = 0; i < 5; i++) await code(f.svc.passwordLogin('c@example.com', 'nope nope ' + i));
      f.events.length = 0;
      // 응답 뒤 일과 cron이 겹친다
      await Promise.all([f.flush(), f.svc.drainNotices(), f.svc.drainNotices()]);
      assert.equal(mail.outbox.filter((m) => m.kind === 'password_locked').length, 1);
      assert.equal(mail.calls, 1);
      // 계속 실패: 5분 × 2^(n-1), 상한 6시간, 8번째 실패에서 버림
      const acc = (await f.db.one<{ id: string }>('SELECT id FROM accounts WHERE email = $1', ['c@example.com']))!.id;
      await f.db.run("INSERT INTO notice_outbox (id, account_id, kind, created_at, attempts, next_at) VALUES ('x1', $1, 'password_locked', $2, 0, $2)", [acc, f.clock.now()]);
      mail.failNotices = 100;
      const waits: number[] = [];
      for (let i = 0; i < NOTICE.maxAttempts; i++) {
        await f.svc.drainNotices();
        const r = await f.db.one<{ next_at: number }>("SELECT next_at FROM notice_outbox WHERE id = 'x1'");
        if (!r) break;
        waits.push(Number(r.next_at) - f.clock.now());
        f.clock.advance(Number(r.next_at) - f.clock.now());
      }
      assert.deepEqual(waits, [1, 2, 4, 8, 16, 32, 64].map((k) => Math.min(k * NOTICE.retryBaseMs, NOTICE.retryMaxMs)));
      assert.equal(await f.db.one("SELECT 1 AS x FROM notice_outbox WHERE id = 'x1'"), undefined);
      assert.ok(f.svcEvents.includes('account.notice_dropped.password_locked'));
      // 다시 보내도 같은 실패(retryable === false)는 첫 시도에서 버린다
      mail.failNotices = 0;
      mail.finalFail = true;
      f.svcEvents.length = 0;
      await f.db.run("INSERT INTO notice_outbox (id, account_id, kind, created_at, attempts, next_at) VALUES ('x3', $1, 'password_locked', $2, 0, $2)", [acc, f.clock.now()]);
      assert.deepEqual(await f.svc.drainNotices(), { sent: 0, failed: 1 });
      assert.equal(await f.db.one("SELECT 1 AS x FROM notice_outbox WHERE id = 'x3'"), undefined);
      assert.deepEqual(f.svcEvents.filter((e) => e.startsWith('account.notice_')), ['account.notice_dropped.password_locked']);
      mail.finalFail = false;
      // 계정 삭제(ON DELETE CASCADE)면 큐 행도 사라진다
      await f.db.run("INSERT INTO notice_outbox (id, account_id, kind, created_at, attempts, next_at) VALUES ('x2', $1, 'password_locked', $2, 0, $2)", [acc, f.clock.now()]);
      await f.db.run('DELETE FROM accounts WHERE id = $1', [acc]);
      assert.equal(await f.db.one("SELECT 1 AS x FROM notice_outbox WHERE id = 'x2'"), undefined);
    } finally {
      f.server.close();
    }
  });

  it('정지 계정은 맞아도 같은 실패', async () => {
    await withPassword(e, 'sus@example.com');
    await e.db.run("UPDATE accounts SET status = 'frozen' WHERE email = $1", ['sus@example.com']);
    assert.equal(await code(e.svc.passwordLogin('sus@example.com', GOOD)), 'account.credentials_invalid');
  });

  it('페퍼 회전: 새 키를 앞에 두면 옛 키 해시로 로그인되고 그때 새 키로 재해시된다', async () => {
    await withPassword(e, 'rot@example.com');
    const e2 = await start({ db: e.db, keys: `${K2},${K1}`, clock: e.clock });
    try {
      assert.equal(await code(e2.svc.passwordLogin('rot@example.com', GOOD)), 'ok');
      assert.match(String((await e.db.one<{ params: string }>('SELECT params FROM pw_creds'))!.params), /:kk2$/);
      assert.deepEqual(e2.events, ['account.password_rehashed']);
      assert.equal(await code(e2.svc.passwordLogin('rot@example.com', GOOD)), 'ok');
      assert.deepEqual(e2.events, ['account.password_rehashed']);
    } finally {
      e2.server.close();
    }
  });
});

describe('계정 설정 비밀번호 재인증(사용자 확정 2026-11-09, ADR-038)', { skip: !argon2Available() }, () => {
  let e: Env;
  beforeEach(async () => (e = await start()));
  afterEach(() => e.server.close());

  const put = (session: string, body: Record<string, unknown>) => e.req('PUT', '/v1/password', { headers: bearer(session), body });
  const me = async (session: string) => (await e.req('GET', '/v1/me', { headers: bearer(session) })).json as { hasPassword: boolean; reauthUntil: number | null; authMethod: string };
  const reauth = async (session: string, email: string) => {
    const r = await e.req('POST', '/v1/auth/reauth', { headers: bearer(session) });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.expiresInSec, 600);
    return { reauthId: r.json.reauthId as string, code: e.mail.lastReauthCode(email)! };
  };

  it('만들기: 10분 지난 세션·갱신 세션은 reauth_required → 이메일 코드 재인증으로 이 세션의 auth_at 갱신 → 만들기 허용, 새 세션은 없다', async () => {
    const { session, refreshToken } = await codeLogin(e, 'mk@example.com', true);
    assert.equal((await me(session)).hasPassword, false);
    e.clock.advance(PASSWORD.reauthMaxAgeMs + 1);
    assert.equal((await put(session, { password: GOOD })).json.error, 'account.reauth_required');
    const before = (await e.db.one<{ n: number }>('SELECT COUNT(*) AS n FROM sessions'))!.n;
    const { reauthId, code: c } = await reauth(session, 'mk@example.com');
    assert.match(c, /^\d{6}$/);
    assert.ok(!e.mail.outbox.some((m) => m.kind === 'code' && m.code === c), '로그인 코드 메일이 아니다');
    // 틀린 코드 → code_invalid, 맞으면 200 + 이 세션이 최근 인증
    assert.equal((await e.req('POST', '/v1/auth/reauth/verify', { headers: bearer(session), body: { reauthId, code: c === '000000' ? '000001' : '000000' } })).json.error, 'account.code_invalid');
    const v = await e.req('POST', '/v1/auth/reauth/verify', { headers: bearer(session), body: { reauthId, code: c } });
    assert.equal(v.status, 200, v.text);
    assert.equal(v.json.authAt, e.clock.now());
    assert.equal(v.json.reauthMaxAgeSec, 600);
    assert.equal((await e.db.one<{ n: number }>('SELECT COUNT(*) AS n FROM sessions'))!.n, before, '새 세션 없음');
    assert.equal((await me(session)).reauthUntil, e.clock.now() + PASSWORD.reauthMaxAgeMs);
    // 코드는 한 번만
    assert.equal((await e.req('POST', '/v1/auth/reauth/verify', { headers: bearer(session), body: { reauthId, code: c } })).json.error, 'account.code_invalid');
    assert.equal((await put(session, { password: GOOD })).status, 204);
    await e.flush();
    assert.ok(e.mail.outbox.some((m) => m.to === 'mk@example.com' && m.kind === 'password_set'), '알림은 큐로 보낸다');
    assert.equal((await me(session)).hasPassword, true);
    // 갱신 세션은 auth_at이 지금이어도 최근 인증이 아니다 → 재인증하면 된다(방식이 email_code로 바뀐다)
    await e.req('DELETE', '/v1/password', { headers: bearer(session) });
    const rf = await e.req('POST', '/v1/auth/refresh', { body: { refreshToken } });
    const rs = rf.json.session as string;
    assert.equal((await me(rs)).reauthUntil, null);
    assert.equal((await put(rs, { password: GOOD })).json.error, 'account.reauth_required');
    const r2 = await reauth(rs, 'mk@example.com');
    assert.equal((await e.req('POST', '/v1/auth/reauth/verify', { headers: bearer(rs), body: r2 })).status, 200);
    assert.equal((await me(rs)).authMethod, 'email_code');
    assert.equal((await put(rs, { password: GOOD })).status, 204);
    for (const l of e.logs) assert.ok(!looksSensitive(l) && !l.includes(GOOD), l);
  });

  it('재인증 코드는 요청한 세션에만 결속: 다른 세션·로그인 검증으로는 쓸 수 없고, 5회 틀리면 폐기, 10분 만료, 세션 없이는 401', async () => {
    const a = (await codeLogin(e, 'rb@example.com')).session;
    const b = (await codeLogin(e, 'rb@example.com')).session;
    const r = await reauth(a, 'rb@example.com');
    assert.equal((await e.req('POST', '/v1/auth/reauth/verify', { headers: bearer(b), body: r })).json.error, 'account.code_invalid', '같은 계정 다른 세션');
    const other = (await codeLogin(e, 'rb2@example.com')).session;
    assert.equal((await e.req('POST', '/v1/auth/reauth/verify', { headers: bearer(other), body: r })).json.error, 'account.code_invalid', '다른 계정');
    assert.equal((await e.req('POST', '/v1/auth/code/verify', { body: { loginId: r.reauthId, code: r.code } })).json.error, 'account.code_invalid', '로그인 검증');
    // 위 시도들이 시도 횟수를 쌓았다(다른 세션 1 + 로그인 검증 1). 남은 시도 안에서는 원래 세션이 아직 쓸 수 있다
    assert.equal((await e.req('POST', '/v1/auth/reauth/verify', { headers: bearer(a), body: r })).status, 200);
    // 5회 틀리면 폐기
    const r3 = await reauth(a, 'rb@example.com');
    const wrong = r3.code === '111111' ? '222222' : '111111';
    for (let i = 0; i < 4; i++) assert.equal((await e.req('POST', '/v1/auth/reauth/verify', { headers: bearer(a), body: { reauthId: r3.reauthId, code: wrong } })).json.error, 'account.code_invalid');
    assert.equal((await e.req('POST', '/v1/auth/reauth/verify', { headers: bearer(a), body: { reauthId: r3.reauthId, code: wrong } })).json.error, 'account.code_locked');
    assert.equal((await e.req('POST', '/v1/auth/reauth/verify', { headers: bearer(a), body: r3 })).json.error, 'account.code_invalid');
    // 만료
    const r4 = await reauth(a, 'rb@example.com');
    e.clock.advance(ACCOUNT.loginCodeTtlMs + 1);
    assert.equal((await e.req('POST', '/v1/auth/reauth/verify', { headers: bearer(a), body: r4 })).json.error, 'account.code_invalid');
    // 보내기 한도는 로그인 코드와 같은 이메일 묶음(로그인 2 + 재인증 3 = 5회/시)
    assert.equal((await e.req('POST', '/v1/auth/reauth', { headers: bearer(a) })).json.error, 'policy.rate_limited');
    assert.equal((await e.req('POST', '/v1/auth/code', { body: { email: 'rb@example.com' } })).json.error, 'policy.rate_limited');
    assert.equal((await e.req('POST', '/v1/auth/reauth')).json.error, 'account.unauthorized');
    assert.equal((await e.req('POST', '/v1/auth/reauth/verify', { headers: bearer(a), body: { ...r4, extra: 1 } })).status, 400);
  });

  it('바꾸기: 현재 비밀번호 필수(없으면 400, 잠금 횟수에 안 듦), 틀리면 403·하한·로그인과 같은 5회 잠금, 잠금 중에는 맞아도 실패', async () => {
    const s = await withPassword(e, 'ch@example.com');
    e.clock.advance(PASSWORD.reauthMaxAgeMs + 1); // 바꾸기는 최근 인증을 따로 보지 않는다(현재 비밀번호가 재인증)
    assert.equal((await put(s, { password: GOOD2 })).json.error, 'account.current_password_required');
    assert.equal(await e.db.one('SELECT 1 AS x FROM pw_locks'), undefined, '필수 누락은 실패로 세지 않는다');
    const t0 = performance.now();
    const w = await put(s, { password: GOOD2, currentPassword: 'wrong wrong 1' });
    assert.equal(w.status, 403);
    assert.equal(w.json.error, 'account.current_password_invalid');
    assert.ok(performance.now() - t0 >= PASSWORD.responseFloorMs - 5, '응답 시각 하한');
    // 로그인 실패와 같은 카운터: 로그인 3번 + 바꾸기 1번 더 = 5번째에서 잠금
    for (let i = 0; i < 3; i++) await code(e.svc.passwordLogin('ch@example.com', 'nope nope ' + i));
    assert.equal((await put(s, { password: GOOD2, currentPassword: 'wrong wrong 2' })).json.error, 'account.current_password_invalid');
    const lock = (await e.db.one<{ locked_until: number | null }>('SELECT locked_until FROM pw_locks'))!;
    assert.equal(Number(lock.locked_until), e.clock.now() + PASSWORD.lockBaseMs);
    assert.ok(e.events.includes('account.password_locked'));
    assert.equal((await e.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM notice_outbox WHERE kind = 'password_locked'"))!.n, 1);
    // 잠금 중: 맞아도 같은 실패, 로그인도 잠겨 있다
    assert.equal((await put(s, { password: GOOD2, currentPassword: GOOD })).json.error, 'account.current_password_invalid');
    assert.equal(await code(e.svc.passwordLogin('ch@example.com', GOOD)), 'account.credentials_invalid');
    // 정책 오류도 같은 하한(현재 비밀번호를 대조하기 전에 거른다)
    const t1 = performance.now();
    assert.equal((await put(s, { password: 'short', currentPassword: GOOD })).json.error, 'account.password_too_short');
    assert.ok(performance.now() - t1 >= PASSWORD.responseFloorMs - 5);
    // 잠금이 풀리면 맞는 현재 비밀번호로 바꾼다
    e.clock.advance(PASSWORD.lockBaseMs);
    assert.equal((await put(s, { password: GOOD2, currentPassword: GOOD })).status, 200);
    assert.equal(await e.db.one('SELECT 1 AS x FROM pw_locks'), undefined, '바꾸면 잠금 행도 지운다');
    assert.equal(await code(e.svc.passwordLogin('ch@example.com', GOOD)), 'account.credentials_invalid');
    assert.ok((await e.svc.passwordLogin('ch@example.com', GOOD2)).session);
  });

  it('바꾼 뒤: 이 세션만 남고 그 계정의 옛 갱신 토큰 계보는 모두 폐기, 이 기기에는 새 계보의 갱신 토큰(password)을 준다, 다른 계정은 그대로, 알림은 큐', async () => {
    const s = await withPassword(e, 'rv@example.com');
    const other = await codeLogin(e, 'rv@example.com', true);
    const mine = await e.svc.issueRefresh((await e.db.one<{ id: string }>("SELECT id FROM accounts WHERE email = 'rv@example.com'"))!.id, 'email_code');
    const stranger = await codeLogin(e, 'st@example.com', true);
    e.mail.outbox.length = 0;
    const families = (await e.db.all<{ family_id: string }>('SELECT family_id FROM refresh_tokens')).map((r) => r.family_id);
    const ch = await put(s, { password: GOOD2, currentPassword: GOOD });
    assert.equal(ch.status, 200, ch.text);
    assert.match(ch.json.refreshToken as string, /^sxa1\.[A-Za-z0-9_-]{43}$/);
    assert.equal(ch.json.refreshExpiresInSec, ACCOUNT.refreshTtlMs / 1000);
    assert.deepEqual(Object.keys(ch.json).sort(), ['refreshExpiresInSec', 'refreshToken']);
    // 새 계보 하나(처음 토큰, auth_method password)만 이 계정에 남는다
    const acc = (await e.db.one<{ id: string }>("SELECT id FROM accounts WHERE email = 'rv@example.com'"))!.id;
    const rows = await e.db.all<{ family_id: string; parent_hash: string | null; auth_method: string; token_hash: string }>('SELECT family_id, parent_hash, auth_method, token_hash FROM refresh_tokens WHERE account_id = $1', [acc]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.auth_method, 'password');
    assert.equal(rows[0]!.parent_hash, null);
    assert.ok(!families.includes(rows[0]!.family_id), '새 계보');
    assert.ok(!JSON.stringify(rows).includes(ch.json.refreshToken as string), '평문 없음');
    assert.equal((await e.req('GET', '/v1/me', { headers: bearer(s) })).status, 200, '이 세션은 남는다');
    assert.equal((await e.req('GET', '/v1/me', { headers: bearer(other.session) })).status, 401, '다른 세션 폐기');
    assert.equal((await e.req('POST', '/v1/auth/refresh', { body: { refreshToken: other.refreshToken } })).status, 401, '다른 기기 갱신 토큰 폐기');
    assert.equal((await e.req('POST', '/v1/auth/refresh', { body: { refreshToken: mine } })).status, 401, '이 기기의 옛 계보도 폐기');
    // 이 기기만 새 토큰으로 갱신된다. 다른 기기가 옛 토큰을 다시 내도(재사용 감지 대상 아님: 행이 없다) 새 계보는 살아 있다
    const r1 = await e.req('POST', '/v1/auth/refresh', { body: { refreshToken: ch.json.refreshToken } });
    assert.equal(r1.status, 200, r1.text);
    assert.equal((await e.req('POST', '/v1/auth/refresh', { body: { refreshToken: other.refreshToken } })).status, 401);
    const r2 = await e.req('POST', '/v1/auth/refresh', { body: { refreshToken: r1.json.refreshToken } });
    assert.equal(r2.status, 200, '회전한 새 토큰으로 계속 갱신');
    assert.equal((await e.req('GET', '/v1/me', { headers: bearer(r2.json.session as string) })).status, 200);
    assert.equal((await e.req('GET', '/v1/me', { headers: bearer(stranger.session) })).status, 200, '다른 계정은 그대로');
    assert.equal((await e.req('POST', '/v1/auth/refresh', { body: { refreshToken: stranger.refreshToken } })).status, 200);
    // 알림: 응답 경로에서 보내지 않고 큐에 넣는다 → 즉시 시도(defer)에서 나간다
    assert.ok(!e.mail.outbox.some((m) => m.kind === 'password_set'), '응답 전에는 보내지 않았다');
    await e.flush();
    assert.deepEqual(e.mail.outbox.filter((m) => m.kind === 'password_set').map((m) => m.to), ['rv@example.com']);
    assert.ok(e.events.includes('account.password_changed'));
    // 만들기(처음)는 다른 세션을 건드리지 않는다
    const fresh = await codeLogin(e, 'mk2@example.com');
    const second = await codeLogin(e, 'mk2@example.com');
    const mk = await put(fresh.session, { password: GOOD });
    assert.equal(mk.status, 204, '만들기는 갱신 토큰을 주지 않는다');
    assert.equal((await e.req('GET', '/v1/me', { headers: bearer(second.session) })).status, 200);
    for (const l of e.logs) assert.ok(!looksSensitive(l) && !l.includes(GOOD) && !l.includes(GOOD2), l);
  });
});

describe('ADR-038 재설정(이메일 코드)', { skip: !argon2Available() }, () => {
  let e: Env;
  beforeEach(async () => (e = await start()));
  afterEach(() => e.server.close());

  it('코드가 맞으면 새 비밀번호 저장, 다른 세션·갱신 토큰 전부 폐기, 알림, 새 세션. 정책 실패는 코드를 남기고 코드는 1회용', async () => {
    const old = await withPassword(e, 'rs@example.com');
    const kept = await codeLogin(e, 'rs@example.com', true);
    // 잠긴 계정도 재설정으로 푼다
    for (let i = 0; i < 5; i++) await code(e.svc.passwordLogin('rs@example.com', 'nope nope ' + i));
    const st = await e.req('POST', '/v1/auth/password/reset', { body: { email: 'rs@example.com' } });
    assert.equal(st.status, 200);
    assert.equal(st.json.expiresInSec, 600);
    const resetId = st.json.resetId as string;
    await e.flush();
    const c = e.mail.lastResetCode('rs@example.com')!;
    const wrong = c === '000000' ? '000001' : '000000';
    assert.equal((await e.req('POST', '/v1/auth/password/reset/verify', { body: { resetId, code: wrong, password: GOOD2 } })).json.error, 'account.code_invalid');
    assert.equal((await e.req('POST', '/v1/auth/password/reset/verify', { body: { resetId, code: c, password: 'short' } })).json.error, 'account.password_too_short');
    const ok = await e.req('POST', '/v1/auth/password/reset/verify', { body: { resetId, code: c, password: GOOD2, remember: true } });
    assert.equal(ok.status, 200, ok.text);
    assert.ok(String(ok.json.refreshToken).startsWith('sxa1.'));
    assert.equal((await e.req('POST', '/v1/auth/password/reset/verify', { body: { resetId, code: c, password: GOOD2 } })).json.error, 'account.code_invalid', '1회용');
    for (const s of [old, kept.session]) assert.equal((await e.req('GET', '/v1/me', { headers: bearer(s) })).json.error, 'account.unauthorized');
    assert.equal((await e.req('POST', '/v1/auth/refresh', { body: { refreshToken: kept.refreshToken } })).json.error, 'account.unauthorized');
    assert.equal((await e.req('GET', '/v1/me', { headers: bearer(ok.json.session as string) })).status, 200);
    assert.ok(e.mail.outbox.some((m) => m.kind === 'password_reset'));
    assert.equal(await code(e.svc.passwordLogin('rs@example.com', GOOD)), 'account.credentials_invalid');
    assert.equal(await code(e.svc.passwordLogin('rs@example.com', GOOD2)), 'ok', '잠금도 풀렸다');
  });

  it('재설정 코드 메일은 응답 경로 밖(ADR-038 (e) ①): 메일이 멈추거나 실패해도 계정 유무와 같은 200·같은 하한, 실패는 이벤트 이름만, 다시 요청하면 새 코드', async () => {
    const mail = new FlakyMail();
    const f = await start({ mail });
    try {
      await withPassword(f, 'rm@example.com');
      mail.calls = 0;
      let release!: () => void;
      mail.hold = new Promise<void>((ok) => (release = ok));
      mail.failResets = 1;
      const timed = async (email: string) => {
        const t0 = performance.now();
        const r = await f.req('POST', '/v1/auth/password/reset', { body: { email } });
        return { r, ms: performance.now() - t0 };
      };
      const a = await timed('rm@example.com');
      const b = await timed('ghost-rm@example.com');
      for (const x of [a, b]) {
        assert.equal(x.r.status, 200);
        assert.ok(x.ms >= PASSWORD.responseFloorMs - 5 && x.ms < PASSWORD.responseFloorMs + 400, `${x.ms}ms`);
      }
      assert.deepEqual(Object.keys(a.r.json).sort(), Object.keys(b.r.json).sort());
      assert.equal(mail.calls, 0, '응답 경로에서 메일을 부르지 않는다');
      const run = f.flush();
      release();
      await run;
      assert.equal(mail.calls, 1, '계정 없는 주소로는 보내지 않는다');
      assert.equal(mail.lastResetCode('rm@example.com'), undefined, '첫 발송은 실패');
      assert.deepEqual(f.svcEvents.filter((x) => x.startsWith('account.reset_mail')), ['account.reset_mail_failed']);
      // 큐(DB)에 코드 평문이 없다: 재설정 행은 HMAC뿐, 알림 큐에 행 없음
      assert.equal((await f.db.all('SELECT * FROM notice_outbox')).length, 0);
      // 다시 요청하면 새 코드가 간다
      mail.hold = null;
      const again = await f.req('POST', '/v1/auth/password/reset', { body: { email: 'rm@example.com' } });
      await f.flush();
      const c = mail.lastResetCode('rm@example.com')!;
      assert.ok(c);
      const ok = await f.req('POST', '/v1/auth/password/reset/verify', { body: { resetId: again.json.resetId, code: c, password: GOOD2 } });
      assert.equal(ok.status, 200, ok.text);
    } finally {
      f.server.close();
    }
  });

  it('5회 틀리면 코드 폐기(code_locked), 10분 만료', async () => {
    await withPassword(e, 'rs2@example.com');
    const st = await e.req('POST', '/v1/auth/password/reset', { body: { email: 'rs2@example.com' } });
    await e.flush();
    const c = e.mail.lastResetCode('rs2@example.com')!;
    const wrong = c === '000000' ? '000001' : '000000';
    for (let i = 0; i < 4; i++) assert.equal((await e.req('POST', '/v1/auth/password/reset/verify', { body: { resetId: st.json.resetId, code: wrong, password: GOOD2 } })).json.error, 'account.code_invalid');
    assert.equal((await e.req('POST', '/v1/auth/password/reset/verify', { body: { resetId: st.json.resetId, code: wrong, password: GOOD2 } })).json.error, 'account.code_locked');
    assert.equal((await e.req('POST', '/v1/auth/password/reset/verify', { body: { resetId: st.json.resetId, code: c, password: GOOD2 } })).json.error, 'account.code_invalid');
    const st2 = await e.req('POST', '/v1/auth/password/reset', { body: { email: 'rs2@example.com' } });
    await e.flush();
    e.clock.advance(PASSWORD.resetCodeTtlMs);
    assert.equal((await e.req('POST', '/v1/auth/password/reset/verify', { body: { resetId: st2.json.resetId, code: e.mail.lastResetCode('rs2@example.com'), password: GOOD2 } })).json.error, 'account.code_invalid');
    const row = await e.db.one<Record<string, unknown>>('SELECT * FROM reset_codes');
    assert.ok(!row || !JSON.stringify(row).includes(e.mail.lastResetCode('rs2@example.com')!), '코드 평문 없음');
  });

  it('재설정 메일 한도: 이메일당 시간 5회', async () => {
    for (let i = 0; i < PASSWORD.resetSendsPerEmailHour; i++) assert.equal((await e.req('POST', '/v1/auth/password/reset', { body: { email: 'lim@example.com' } })).status, 200);
    assert.equal((await e.req('POST', '/v1/auth/password/reset', { body: { email: 'lim@example.com' } })).status, 429);
  });
});

describe('ADR-038 (f) 자동 로그인: 갱신 토큰', () => {
  let e: Env;
  beforeEach(async () => (e = await start({ passwords: argon2Available() })));
  afterEach(() => e.server.close());

  it('remember면 갱신 토큰, 쓸 때마다 회전, 이전 토큰 재사용이면 계정 세션·갱신 토큰 전부 폐기 + 알림', async () => {
    const first = await codeLogin(e, 'rf@example.com', true);
    assert.match(first.refreshToken!, /^sxa1\.[A-Za-z0-9_-]{43}$/);
    const other = await codeLogin(e, 'rf@example.com', true);
    const r1 = await e.req('POST', '/v1/auth/refresh', { body: { refreshToken: first.refreshToken } });
    assert.equal(r1.status, 200, r1.text);
    assert.notEqual(r1.json.refreshToken, first.refreshToken);
    assert.equal(r1.json.refreshExpiresInSec, 30 * 24 * 3600);
    assert.equal((await e.req('GET', '/v1/me', { headers: bearer(r1.json.session as string) })).json.authMethod, 'refresh');
    // 이전(회전된) 토큰이 다시 오면: 복제로 본다
    assert.equal((await e.req('POST', '/v1/auth/refresh', { body: { refreshToken: first.refreshToken } })).json.error, 'account.unauthorized');
    for (const s of [first.session, other.session, r1.json.session as string]) assert.equal((await e.req('GET', '/v1/me', { headers: bearer(s) })).json.error, 'account.unauthorized');
    for (const t of [r1.json.refreshToken, other.refreshToken]) assert.equal((await e.req('POST', '/v1/auth/refresh', { body: { refreshToken: t } })).json.error, 'account.unauthorized');
    assert.ok(e.mail.outbox.some((m) => m.to === 'rf@example.com' && m.kind === 'sessions_revoked'));
    assert.equal(await e.db.one('SELECT 1 AS x FROM refresh_tokens'), undefined);
    const stored = JSON.stringify(await e.db.all('SELECT * FROM refresh_tokens'));
    assert.ok(!stored.includes(first.refreshToken!.slice(5)));
  });

  it('30일 미사용 만료(회전마다 새로 30일), 끄기는 계보 전체 폐기, 모르는 토큰·형식 오류는 401·400', async () => {
    let t = (await codeLogin(e, 'ex@example.com', true)).refreshToken!;
    for (let i = 0; i < 3; i++) {
      e.clock.advance(29 * D);
      const r = await e.req('POST', '/v1/auth/refresh', { body: { refreshToken: t } });
      assert.equal(r.status, 200, `${i} ${r.text}`);
      t = r.json.refreshToken as string;
    }
    e.clock.advance(ACCOUNT.refreshTtlMs);
    assert.equal((await e.req('POST', '/v1/auth/refresh', { body: { refreshToken: t } })).json.error, 'account.unauthorized');
    const a = (await codeLogin(e, 'ex@example.com', true)).refreshToken!;
    const a2 = (await e.req('POST', '/v1/auth/refresh', { body: { refreshToken: a } })).json.refreshToken as string;
    assert.equal((await e.req('POST', '/v1/auth/refresh/revoke', { body: { refreshToken: a } })).status, 204, '이전 토큰으로도 계보를 끈다');
    assert.equal((await e.req('POST', '/v1/auth/refresh', { body: { refreshToken: a2 } })).json.error, 'account.unauthorized');
    assert.equal((await e.req('POST', '/v1/auth/refresh/revoke', { body: { refreshToken: 'sxa1.' + 'A'.repeat(43) } })).status, 204);
    assert.equal((await e.req('POST', '/v1/auth/refresh', { body: { refreshToken: 'sxa1.' + 'A'.repeat(43) } })).json.error, 'account.unauthorized');
    assert.equal((await e.req('POST', '/v1/auth/refresh', { body: { refreshToken: 'sxs1.' + 'A'.repeat(43) } })).status, 400);
    // 만료 정리
    e.clock.advance(ACCOUNT.refreshTtlMs + 1);
    await e.svc.sweep();
    assert.equal(await e.db.one('SELECT 1 AS x FROM refresh_tokens'), undefined);
  });

  it('모든 기기에서 로그아웃: 계정 세션·갱신 토큰 전부(이 세션 포함)', async () => {
    const a = await codeLogin(e, 'all@example.com', true);
    const b = await codeLogin(e, 'all@example.com', true);
    const other = await codeLogin(e, 'someone@example.com', true);
    assert.equal((await e.req('POST', '/v1/auth/logout-all', { headers: bearer(a.session) })).status, 204);
    for (const s of [a.session, b.session]) assert.equal((await e.req('GET', '/v1/me', { headers: bearer(s) })).json.error, 'account.unauthorized');
    assert.equal((await e.req('POST', '/v1/auth/refresh', { body: { refreshToken: b.refreshToken } })).json.error, 'account.unauthorized');
    assert.equal((await e.req('GET', '/v1/me', { headers: bearer(other.session) })).status, 200, '다른 계정은 그대로');
    assert.equal((await e.req('POST', '/v1/auth/refresh', { body: { refreshToken: other.refreshToken } })).status, 200);
  });
});

describe('ADR-038 마이그레이션 002', () => {
  it('기존 세션은 옮겨지고(auth_at = created_at) 새 방식 값을 받는다', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sax-acct-mig-'));
    try {
      fs.copyFileSync(path.join(MIGRATIONS_DIR, '001_init.sql'), path.join(dir, '001_init.sql'));
      const db = openSqlite();
      await migrate(db, 'account', dir);
      await db.run("INSERT INTO accounts (id, email, status, created_at) VALUES ('a1', 'm@example.com', 'active', 1)");
      await db.run("INSERT INTO sessions (token_hash, account_id, auth_method, created_at, expires_at) VALUES ('h1', 'a1', 'passkey', 5, 99)");
      assert.deepEqual(await migrate(db, 'account', MIGRATIONS_DIR), [2, 3]);
      assert.deepEqual({ ...(await db.one('SELECT token_hash, account_id, auth_method, created_at, auth_at, expires_at FROM sessions'))! }, { token_hash: 'h1', account_id: 'a1', auth_method: 'passkey', created_at: 5, auth_at: 5, expires_at: 99 });
      await db.run("INSERT INTO sessions (token_hash, account_id, auth_method, created_at, auth_at, expires_at) VALUES ('h2', 'a1', 'refresh', 1, 1, 2)");
      await assert.rejects(db.run("INSERT INTO sessions (token_hash, account_id, auth_method, created_at, auth_at, expires_at) VALUES ('h3', 'a1', 'magic', 1, 1, 2)"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('buildAccount: PASSWORD_PEPPER_KEYS가 다른 비밀과 같으면 기동 거부, 없으면 비밀번호 경로만 닫힌다', async () => {
    const base = {
      SAX_SQLITE_FILE: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sax-acct-env-')), 'a.db'),
      TOKEN_SIGNING_SEED: hex32(),
      INTERNAL_CALL_KEY: hex32(),
      CODE_MAC_KEY: hex32(),
      LIMIT_ID_KEY: hex32(),
      ACCOUNT_PUBLIC_ORIGIN: ORIGIN,
      WEBAUTHN_RP_ID: RP.rpId,
      WEBAUTHN_ORIGINS: ORIGIN,
      BILLING_RETURN_URL: 'https://app.test.invalid/b',
      PG_PROVIDER: 'mock',
      MAIL_PROVIDER: 'mock',
    };
    await assert.rejects(buildAccount({ ...base, PASSWORD_PEPPER_KEYS: `k1:${base.CODE_MAC_KEY}` }), /config_PASSWORD_PEPPER_KEYS/);
    await assert.rejects(buildAccount({ ...base, PASSWORD_PEPPER_KEYS: 'k1:zz' }), /config_PASSWORD_PEPPER_KEYS/);
    const off = await buildAccount(base);
    assert.equal(off.svc.passwordsEnabled, false);
    await off.db.close();
    const on = await buildAccount({ ...base, PASSWORD_PEPPER_KEYS: K1 });
    assert.equal(on.svc.passwordsEnabled, argon2Available());
    await on.db.close();
  });
});
